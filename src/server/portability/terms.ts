import { glossaryHeading, glossaryMarkdown } from "../knowledge/glossary.js";
import { insertTermRow, insertTermVersion, tidyFields, type TermFields } from "../knowledge/terms.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { date, integer, list, refuse, text, type File } from "./fields.js";
import { isRecord } from "./format.js";
import type { ImportContext } from "./import-context.js";

/**
 * Terms: a place's `GLOSSARY.md`, to read and to keep in a repository, and beside it `terms.md`, whose
 * frontmatter holds every Term whole, with its Versions when the export includes them, for importing.
 */

interface TermRow {
  id: string;
  name: string;
  definition: string;
  avoid: string[];
  group_name: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

type VersionRow = ActorColumns & { number: number; name: string; definition: string; avoid: string[]; group_name: string | null; at: Date };

const fieldsOf = (row: { name: string; definition: string; avoid: string[]; group_name: string | null }): TermFields => ({
  name: row.name,
  definition: row.definition,
  avoid: row.avoid,
  group: row.group_name,
});

/** Writes the Terms of the Workspace (projectId null) or a Project as `${dir}GLOSSARY.md` and `${dir}terms.md`, if it has any. */
export async function exportTerms(ctx: ExportContext, dir: string, place: { projectId: null; workspaceName: string } | { projectId: string; projectKey: string }) {
  const { rows } = await ctx.db.query<TermRow>(
    "SELECT * FROM terms WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY lower(name), name",
    [ctx.scope.workspaceId, place.projectId],
  );
  if (rows.length === 0) return;
  const { title, intro } = glossaryHeading(place);
  ctx.folder.set(`${dir}GLOSSARY.md`, glossaryMarkdown(title, intro, rows.map(fieldsOf)));
  const terms = [];
  for (const t of rows) {
    const { rows: versions } = await ctx.db.query<VersionRow>("SELECT * FROM term_versions WHERE term_id = $1 ORDER BY number", [t.id]);
    const current = versions.find((v) => v.number === t.version)!;
    terms.push({
      ...fieldsOf(t),
      version: t.version,
      createdAt: iso(t.created_at),
      createdBy: ctx.actor(versions[0]!),
      updatedAt: iso(t.updated_at),
      updatedBy: ctx.actor(current),
      versions: ctx.scope.versions ? versions.map((v) => ({ number: v.number, ...fieldsOf(v), at: iso(v.at), by: ctx.actor(v) })) : undefined,
    });
  }
  ctx.add(`${dir}terms.md`, { terms }, "Every Term here, whole; GLOSSARY.md beside this file reads them as a glossary.\n");
}

/** A Term's fields as `terms.md` holds them, at `where`. */
function readFields(entry: Record<string, unknown>, where: string): TermFields {
  const avoid = entry.avoid ?? [];
  if (!Array.isArray(avoid) || !avoid.every((w) => typeof w === "string")) refuse(`${where} avoid must be a list of words`);
  const group = entry.group;
  if (group !== null && group !== undefined && typeof group !== "string") refuse(`${where} group must be text`);
  return tidyFields({ name: text(entry.name, `${where} name`), definition: text(entry.definition, `${where} definition`), avoid, group: group ?? null });
}

/**
 * Imports the Terms in `${dir}terms.md`, if the export has it: each with one Version per entry of its
 * `versions`, or without them a single Version holding what it says now, by whoever first wrote it.
 */
export async function importTerms(ctx: ImportContext, dir: string, projectId: string | null): Promise<void> {
  const file: File | undefined = ctx.read(`${dir}terms.md`);
  if (!file) return;
  const seen = new Set<string>();
  for (const [i, entry] of list(file, "terms").entries()) {
    const where = `${file.path} terms[${i}]`;
    const fields = readFields(entry, where);
    if (seen.has(fields.name.toLowerCase())) refuse(`${where} has the name ${fields.name}, which another Term there has; names are unique ignoring case`);
    seen.add(fields.name.toLowerCase());
    const versions = entry.versions === undefined ? [] : Array.isArray(entry.versions) && entry.versions.every(isRecord) ? entry.versions : refuse(`${where} versions must be a list`);
    const version = versions.length > 0 ? integer(entry.version, `${where} version`) : 1;
    const id = await insertTermRow(ctx.db, {
      workspaceId: ctx.workspaceId,
      projectId,
      ...fields,
      version,
      createdAt: date(entry.createdAt, `${where} createdAt`),
      updatedAt: date(entry.updatedAt, `${where} updatedAt`),
    });
    if (versions.length === 0) {
      const actor = await ctx.actor(entry.createdBy, `${where} createdBy`);
      await insertTermVersion(ctx.db, id, { number: 1, ...fields, at: date(entry.updatedAt, `${where} updatedAt`), actor });
      continue;
    }
    const numbers = versions.map((v, n) => integer(v.number, `${where} versions[${n}] number`));
    if (!numbers.every((n, k) => n === k + 1) || numbers.at(-1) !== version) {
      refuse(`${where} versions must be numbered 1, 2, 3 and so on, with none missing, up to its version ${version}`);
    }
    for (const [n, v] of versions.entries()) {
      const at = `${where} versions[${n}]`;
      await insertTermVersion(ctx.db, id, { number: n + 1, ...readFields(v, at), at: date(v.at, `${at} at`), actor: await ctx.actor(v.by, `${at} by`) });
    }
  }
}
