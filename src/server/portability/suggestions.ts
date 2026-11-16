import { CONTENT_FIELDS, SUGGESTION_STATES, type SuggestionKind } from "../knowledge/suggestions.js";
import { suggestionsOnSql } from "../knowledge/version-suggestions.js";
import { ticketKeySql } from "../work/tickets.js";
import { iso, type ExportContext } from "./export-context.js";
import { date, integer, isUuid, oneOf, refuse, text } from "./fields.js";
import { isRecord } from "./format.js";
import type { ImportContext } from "./import-context.js";
import type { ImportedTickets } from "./tickets.js";

/**
 * Suggestions (ADR 0014), in the frontmatter of the item they belong to as `suggestions`, oldest first, left
 * out when there are none: each with its id, base Version, whole proposed content, reasoning, the Agent that
 * made it, the Ticket it came from, and where it stands. Their ids are kept, as Agents may have noted them.
 */

/** The item a Suggestion is on: a Document, Term or Decision by id, or the Guidance of a Project (null for the Workspace's). */
export type SuggestedItem = { kind: "document" | "term" | "decision"; id: string } | { kind: "guidance"; projectId: string | null };


interface SuggestionRow {
  id: string;
  base_version: number;
  content: Record<string, unknown>;
  reasoning: string;
  at: Date;
  actor_user_id: string;
  actor_agent_id: string;
  actor_session_id: string | null;
  source_ticket: string | null;
  state: (typeof SUGGESTION_STATES)[number];
  with_edits: boolean | null;
  result_version: number | null;
  reason: string | null;
  decided_at: Date | null;
  decided_by_user_id: string | null;
}

/** The frontmatter field holding the Suggestions on `item`. */
export async function suggestionsToExport(ctx: ExportContext, item: SuggestedItem) {
  const [where, params] = suggestionsOnSql(item.kind === "guidance" ? { ...item, workspaceId: ctx.scope.workspaceId } : item);
  const { rows } = await ctx.db.query<SuggestionRow>(
    `SELECT s.*, ${ticketKeySql("tp", "t")} AS source_ticket
     FROM suggestions s LEFT JOIN tickets t ON t.id = s.source_ticket_id LEFT JOIN projects tp ON tp.id = t.project_id
     WHERE ${where} ORDER BY s.at, s.id`,
    params,
  );
  if (rows.length === 0) return { suggestions: undefined };
  return {
    suggestions: rows.map((s) => ({
      id: s.id,
      baseVersion: s.base_version,
      content: s.content,
      reasoning: s.reasoning,
      at: iso(s.at),
      by: ctx.agentActor(s),
      sourceTicket: s.source_ticket ?? undefined,
      state: s.state,
      acceptedWithEdits: s.with_edits ?? undefined,
      resultVersion: s.result_version ?? undefined,
      decidedAt: s.decided_at === null ? undefined : iso(s.decided_at),
      decidedBy: s.decided_by_user_id === null ? undefined : ctx.user(s.decided_by_user_id)!,
      reason: s.reason ?? undefined,
    })),
  };
}

/**
 * Imports the Suggestions `data.suggestions` holds onto the imported `item` (in Project `projectId`, null for
 * the Workspace), once its Versions are in. Each keeps its id unless this installation already has it.
 */
export async function importSuggestions(ctx: ImportContext, item: SuggestedItem, projectId: string | null, data: Record<string, unknown>, where: string): Promise<void> {
  const entries = data.suggestions ?? [];
  if (!Array.isArray(entries) || !entries.every(isRecord)) refuse(`${where} suggestions must be a list`);
  for (const [i, s] of entries.entries()) {
    const at = `${where} suggestions[${i}]`;
    const by = await ctx.actor(s.by, `${at} by`);
    if (by.kind !== "agent") refuse(`${at} by must name an Agent: only Agents make Suggestions`);
    const state = oneOf(s.state, SUGGESTION_STATES, `${at} state`);
    const content = contentOf(item.kind, s.content, `${at} content`);
    const decided = state !== "open";
    const decidedBy = decided ? await ctx.userId(s.decidedBy, `${at} decidedBy`) : null;
    const withEdits = state === "accepted" ? (typeof s.acceptedWithEdits === "boolean" ? s.acceptedWithEdits : refuse(`${at} acceptedWithEdits must be true or false`)) : null;
    const id = isUuid(s.id) && !(await taken(ctx, s.id)) ? s.id : null;
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO suggestions (id, workspace_id, kind, document_id, term_id, decision_id, project_id, base_version, content, reasoning, at,
         actor_user_id, actor_agent_id, actor_session_id, state, with_edits, result_version, reason, decided_at, decided_by_user_id)
       VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
      [
        id,
        ctx.workspaceId,
        item.kind,
        item.kind === "document" ? item.id : null,
        item.kind === "term" ? item.id : null,
        item.kind === "decision" ? item.id : null,
        projectId,
        integer(s.baseVersion, `${at} baseVersion`),
        JSON.stringify(content),
        text(s.reasoning, `${at} reasoning`),
        date(s.at, `${at} at`),
        by.userId,
        by.agentId,
        by.sessionId,
        state,
        withEdits,
        state === "accepted" ? integer(s.resultVersion, `${at} resultVersion`) : null,
        state === "rejected" ? text(s.reason, `${at} reason`) : null,
        decided ? date(s.decidedAt, `${at} decidedAt`) : null,
        decidedBy,
      ],
    );
    if (s.sourceTicket !== undefined && s.sourceTicket !== null) {
      const ticketKey = typeof s.sourceTicket === "string" ? s.sourceTicket : refuse(`${at} sourceTicket must be a Ticket key`);
      ctx.suggestionSources.push({ suggestionId: rows[0]!.id, ticketKey });
    }
  }
}

/** Links each imported Suggestion to the Ticket it came from, if that Ticket came in with this import. */
export async function storeSuggestionSources(ctx: ImportContext, tickets: ImportedTickets): Promise<void> {
  for (const { suggestionId, ticketKey } of ctx.suggestionSources) {
    const ticketId = tickets.ids.get(ticketKey.toUpperCase());
    if (ticketId) await ctx.db.query("UPDATE suggestions SET source_ticket_id = $2 WHERE id = $1", [suggestionId, ticketId]);
  }
}

async function taken(ctx: ImportContext, id: string): Promise<boolean> {
  return (await ctx.db.query("SELECT 1 FROM suggestions WHERE id = $1", [id])).rows.length > 0;
}

const NAMES = { document: "Document", term: "Term", decision: "Decision" } as const;

/** A Suggestion's content as an export holds it: exactly the fields its kind holds, each of the right type. */
function contentOf(kind: SuggestionKind, value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) refuse(`${where} must be a mapping`);
  const fields = CONTENT_FIELDS[kind];
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const v = value[field];
    const ok = field === "avoid" ? Array.isArray(v) && v.every((w) => typeof w === "string") : field === "group" ? v === null || typeof v === "string" : typeof v === "string";
    if (!ok) refuse(`${where} ${field} must be ${field === "avoid" ? "a list of words" : "text"}`);
    content[field] = v;
  }
  const stray = Object.keys(value).find((f) => !fields.includes(f));
  if (stray) refuse(`${where} holds ${stray}, which a Suggestion on ${kind === "guidance" ? "Guidance" : `a ${NAMES[kind]}`} doesn't`);
  return content;
}
