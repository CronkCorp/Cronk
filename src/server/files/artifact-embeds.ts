import { fromMarkdown } from "mdast-util-from-markdown";
import type { Queryable } from "../db/database.js";
import { readableClause, type Readable } from "../identity/access.js";
import { ticketKeySql } from "../work/tickets.js";
import { artifactEmbedsIn, type ArtifactAt } from "../../shared/artifact-embeds.js";
import type { MarkdownNode } from "../../shared/ticket-references.js";

/**
 * Embedded Artifacts: an Artifact's address alone on a line of a Document's, Report's or Comment's Markdown shows
 * the Artifact in place (shared/artifact-embeds.ts says which lines do). The API answers what each body embeds, and
 * what the current text of each Document and Comment embeds is recorded, so an Artifact finds where it is embedded
 * through an index instead of reading everything.
 */

/** Something whose Markdown may embed Artifacts: a Document (a Report too) or a Comment. */
export interface EmbedSource {
  kind: "document" | "comment";
  id: string;
}

/**
 * The Artifacts Markdown `body` embeds, in order, of those the Workspace holds: an address naming no Artifact of
 * it, or a Version it doesn't have, stays a link.
 */
export async function embedsIn(db: Queryable, workspaceId: string, body: string): Promise<ArtifactAt[]> {
  const found = artifactEmbedsIn(fromMarkdown(body) as MarkdownNode);
  if (found.length === 0) return [];
  const { rows } = await db.query<{ id: string; version: number }>("SELECT id, version FROM artifacts WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [
    workspaceId,
    [...new Set(found.map((e) => e.artifactId))],
  ]);
  const latest = new Map(rows.map((r) => [r.id, r.version]));
  return found.filter((e) => latest.has(e.artifactId) && (e.version === null || e.version <= latest.get(e.artifactId)!));
}

/** The column of `artifact_embeds` naming a source of each kind. */
const SOURCE_COLUMN = { document: "document_id", comment: "comment_id" } as const;

/** Every source's Workspace and Markdown body, as `s`, by its kind and id. */
const sources = (artifacts = true) => `(
  SELECT 'document' AS kind, d.id, d.workspace_id, d.body FROM documents d
  UNION ALL
  ${
    artifacts
      ? `SELECT 'comment', c.id, coalesce(tp.workspace_id, d.workspace_id, x.workspace_id), c.body
  FROM comments c LEFT JOIN tickets t ON t.id = c.ticket_id LEFT JOIN projects tp ON tp.id = t.project_id
    LEFT JOIN documents d ON d.id = c.document_id LEFT JOIN artifacts x ON x.id = c.artifact_id`
      : `SELECT 'comment', c.id, coalesce(tp.workspace_id, d.workspace_id), c.body
  FROM comments c LEFT JOIN tickets t ON t.id = c.ticket_id LEFT JOIN projects tp ON tp.id = t.project_id
    LEFT JOIN documents d ON d.id = c.document_id`
  }
) s`;

interface SourceRow {
  kind: EmbedSource["kind"];
  id: string;
  workspace_id: string;
  body: string;
}

/** Records what one source embeds now, replacing what it embedded before, and answers it. */
async function record(db: Queryable, source: SourceRow): Promise<ArtifactAt[]> {
  const column = SOURCE_COLUMN[source.kind];
  await db.query(`DELETE FROM artifact_embeds WHERE ${column} = $1`, [source.id]);
  const embeds = await embedsIn(db, source.workspace_id, source.body);
  await db.query(
    `INSERT INTO artifact_embeds (${column}, artifact_id, version, position)
     SELECT $1, e.artifact_id, e.version, e.position FROM unnest($2::uuid[], $3::int[]) WITH ORDINALITY AS e(artifact_id, version, position)`,
    [source.id, embeds.map((e) => e.artifactId), embeds.map((e) => e.version)],
  );
  return embeds;
}

/** Records what `source` embeds now, from its current text, and answers it. Run in the transaction that creates or changes it. */
export async function recordEmbeds(db: Queryable, source: EmbedSource): Promise<ArtifactAt[]> {
  const { rows } = await db.query<SourceRow>(`SELECT * FROM ${sources()} WHERE s.kind = $1 AND s.id = $2`, [source.kind, source.id]);
  return rows[0] ? record(db, rows[0]) : [];
}

/**
 * Records again what each source of the Workspace embeds whose text names Artifact `artifactId`, as after it gains a
 * Version an address may have named before it existed. Run in the transaction that publishes it.
 */
export async function recordEmbedsNaming(db: Queryable, workspaceId: string, artifactId: string): Promise<void> {
  const { rows } = await db.query<SourceRow>(`SELECT * FROM ${sources()} WHERE s.workspace_id = $1 AND strpos(lower(s.body), $2) > 0 ORDER BY s.kind, s.id`, [
    workspaceId,
    artifactId.toLowerCase(),
  ]);
  for (const row of rows) await record(db, row);
}

/** How many sources a full recording reads at a time, so a large Workspace isn't held in memory at once. */
const BATCH = 200;

/**
 * Records what every source embeds, in the Workspace `workspaceId` (all Workspaces when null), as for a database or
 * an import that didn't record them yet. If what counts as an embed changes, add a migration that runs it again.
 */
export async function recordAllEmbeds(db: Queryable, workspaceId: string | null = null, opts: { artifacts?: boolean } = {}): Promise<void> {
  for (let after = { kind: "", id: "00000000-0000-0000-0000-000000000000" }; ; ) {
    const { rows } = await db.query<SourceRow>(
      `SELECT * FROM ${sources(opts.artifacts)} WHERE ($1::uuid IS NULL OR s.workspace_id = $1) AND (s.kind, s.id) > ($2, $3::uuid)
       ORDER BY s.kind, s.id LIMIT $4`,
      [workspaceId, after.kind, after.id, BATCH],
    );
    for (const row of rows) await record(db, row);
    if (rows.length < BATCH) return;
    after = rows[rows.length - 1]!;
  }
}

/** SQL for what the source `alias.id` of `kind` embeds as recorded, as a JSON array in order, for selecting beside it. */
export const embedsSql = (kind: EmbedSource["kind"], alias: string) =>
  `(SELECT coalesce(json_agg(json_build_object('artifactId', e.artifact_id, 'version', e.version) ORDER BY e.position), '[]'::json)
    FROM artifact_embeds e WHERE e.${SOURCE_COLUMN[kind]} = ${alias}.id)`;

/** A place an Artifact is embedded, as its Version menu lists it. */
export interface EmbeddedIn {
  kind: "document" | "report" | "comment";
  /** The Document's, Report's or Comment's id. */
  id: string;
  /** Its title; for a Comment, the title of the Ticket, Document or Artifact it is on. */
  title: string;
  /** Null when it lies in the Workspace outside any Project. */
  projectKey: string | null;
  /** For a Report, or a Comment on a Ticket: the Ticket's key. */
  ticketKey: string | null;
  /** For a Comment on a Document: the Document's id. */
  documentId: string | null;
  /** For a Comment on an Artifact: that Artifact's id. */
  artifactId: string | null;
  /** The Version it embeds; null for the latest. */
  version: number | null;
  /** When it last changed; for a Comment, when it was posted. */
  at: Date;
}

/** How many places an Artifact lists. */
const EMBEDDED_IN_LIMIT = 50;

/** Where an Artifact is embedded, most recently changed first (at most 50), leaving out what lies where `readable` doesn't let its reader read. */
export async function listEmbeddedIn(db: Queryable, artifactId: string, readable: Readable): Promise<EmbeddedIn[]> {
  const isReadable = readableClause("f", readable, 2);
  const { rows } = await db.query<EmbeddedIn>(
    `WITH e AS (SELECT * FROM artifact_embeds e WHERE e.artifact_id = $1),
     found AS (
       SELECT CASE WHEN d.ticket_id IS NULL THEN 'document' ELSE 'report' END AS kind, d.id, d.title, p.key AS project_key,
              ${ticketKeySql("tp", "tt")} AS ticket_key, NULL::uuid AS document_id, NULL::uuid AS artifact_id, e.version, d.updated_at AS at, d.project_id, d.workspace_id
       FROM e JOIN documents d ON d.id = e.document_id LEFT JOIN projects p ON p.id = d.project_id
         LEFT JOIN tickets tt ON tt.id = d.ticket_id LEFT JOIN projects tp ON tp.id = tt.project_id
       UNION ALL
       SELECT 'comment', c.id, coalesce(t.title, d.title, x.title), coalesce(tp.key, dp.key, xp.key), ${ticketKeySql("tp", "t")}, c.document_id,
              c.artifact_id, e.version, c.at, coalesce(t.project_id, d.project_id, x.project_id), coalesce(tp.workspace_id, d.workspace_id, x.workspace_id)
       FROM e JOIN comments c ON c.id = e.comment_id LEFT JOIN tickets t ON t.id = c.ticket_id LEFT JOIN projects tp ON tp.id = t.project_id
         LEFT JOIN documents d ON d.id = c.document_id LEFT JOIN projects dp ON dp.id = d.project_id
         LEFT JOIN artifacts x ON x.id = c.artifact_id LEFT JOIN projects xp ON xp.id = x.project_id
     )
     SELECT kind, id, title, project_key AS "projectKey", ticket_key AS "ticketKey", document_id AS "documentId", artifact_id AS "artifactId", version, at
     FROM found f WHERE ${isReadable.sql}
     ORDER BY at DESC, id, version NULLS FIRST LIMIT ${EMBEDDED_IN_LIMIT}`,
    [artifactId, ...isReadable.params],
  );
  return rows;
}
