import { applyRedactions, sameRedaction, type Redaction } from "../transcripts/redact.js";
import {
  afterUpload,
  changedItems,
  findForUpdate,
  listTranscripts,
  redactionsOf,
  storeRedactions,
  storeTranscript,
  textToKeep,
  type Upload,
} from "../transcripts/transcripts.js";
import { iso, type ExportContext } from "./export-context.js";
import { date, integer, list, refuse, text, type File } from "./fields.js";
import type { ImportContext } from "./import-context.js";

/**
 * `transcripts/<n>.md`: the Workspace's Transcripts, numbered from 1 in the order they were first uploaded, in a Workspace
 * export only. The frontmatter names the Agent and its Agent Sessions by their ids in `people.md`, with the client's chat id;
 * the body is the latest text. `<n>.earlier/<k>.md` hold, as they are, the texts a later upload didn't continue, oldest first.
 * The Tickets (by key), Documents (by path), Terms (by name, after their Project's key), Decisions (by key) and Artifacts
 * (by path) the Sessions changed are listed for whoever reads the files; an import links them again through the Sessions. The
 * texts are as stored: scrubbed and with the Owner's hand redactions applied. `redactions` lists those, without the passages, so the import keeps redacting re-uploads.
 */

/**
 * Writes every Transcript of the Workspace. Run after the Documents and Artifacts, so it can name them by path, and before
 * `people.md`.
 */
export async function exportTranscripts(ctx: ExportContext): Promise<void> {
  const transcripts = await listTranscripts(ctx.db, ctx.scope.workspaceId, "oldest");
  for (const [i, t] of transcripts.entries()) {
    const n = i + 1;
    for (const id of t.sessionIds) ctx.usedSessions.add(id);
    const items = await changedItems(ctx.db, t.sessionIds);
    const redactions = await redactionsOf(ctx.db, t.id);
    ctx.add(
      `transcripts/${n}.md`,
      {
        agent: ctx.agent(t.agentId),
        chatId: t.chatId,
        createdAt: iso(t.createdAt),
        updatedAt: iso(t.updatedAt),
        sessions: t.sessionIds,
        tickets: items.tickets.map((ticket) => ticket.key),
        documents: items.documents.flatMap((d) => ctx.documentPaths.get(d.id) ?? []),
        terms: items.terms.map((t) => (t.project_key === null ? t.name : `${t.project_key}: ${t.name}`)),
        decisions: items.decisions.map((d) => d.key),
        artifacts: items.artifacts.flatMap((a) => ctx.artifactPaths.get(a.id) ?? []),
        ...(redactions.length > 0 && { redactions }),
      },
      t.markdown,
    );
    for (const [k, earlier] of t.earlier.entries()) ctx.folder.set(`transcripts/${n}.earlier/${k + 1}.md`, earlier);
  }
}

/** Imports `transcripts/`, after `people.md` and every record its Sessions changed, linking each to the Sessions as imported here. */
export async function importTranscripts(ctx: ImportContext): Promise<void> {
  for (const [n, file] of ctx.numbered("transcripts")) {
    const where = file.path;
    const agent = ctx.agent(file.data.agent, `${where} agent`);
    const chatId = text(file.data.chatId, `${where} chatId`);
    const sessions = file.data.sessions ?? [];
    if (!Array.isArray(sessions)) refuse(`${where} sessions must be a list of Agent Session ids`);
    const sessionIds = sessions.map((s) => ctx.sessionIds.get(String(s)) ?? refuse(`${where} names an Agent Session that isn't in people.md`));
    const texts: string[] = [];
    for (let k = 1; ctx.folder.has(`transcripts/${n}.earlier/${k}.md`); k++) texts.push(ctx.text(`transcripts/${n}.earlier/${k}.md`)!);
    texts.push(file.body);
    // As if each text were uploaded again in turn, onto what this Workspace may already hold of the chat, kept as an upload
    // keeps it (`textToKeep`) with the redactions of both, as an export made before scrubbing, or edited by hand, may still hold secrets.
    const existing = await findForUpdate(ctx.db, agent.id, chatId);
    const kept = existing ? await redactionsOf(ctx.db, existing.id) : [];
    const added = redactionsIn(file).filter((r) => !kept.some((k) => sameRedaction(k, r)));
    const redactions = [...kept, ...added];
    // What the Workspace holds gets the redactions the file adds too.
    let upload: Upload | undefined = existing && {
      ...existing,
      markdown: applyRedactions(existing.markdown, added),
      earlier: existing.earlier.map((t) => applyRedactions(t, added)),
    };
    for (const t of texts) upload = afterUpload(upload, textToKeep(t, redactions), sessionIds);
    const updatedAt = date(file.data.updatedAt, `${where} updatedAt`);
    const id = await storeTranscript(ctx.db, {
      workspaceId: ctx.workspaceId,
      agentId: agent.id,
      chatId,
      existing,
      upload: upload!,
      at: updatedAt,
      createdAt: date(file.data.createdAt, `${where} createdAt`),
    });
    await storeRedactions(ctx.db, id, added, updatedAt);
  }
}

/** The hand redactions a Transcript's file lists, in the order they were made. */
function redactionsIn(file: File): Redaction[] {
  return list(file, "redactions").map((r, i) => {
    const where = `${file.path} redactions ${i + 1}`;
    const length = integer(r.length, `${where} length`);
    if (length === 0) refuse(`${where} length must be more than 0`);
    const digest = text(r.digest, `${where} digest`);
    if (!/^[0-9a-f]{64}$/.test(digest)) refuse(`${where} digest must be a SHA-256 digest in hex`);
    return { length, fingerprint: integer(r.fingerprint, `${where} fingerprint`), digest };
  });
}
