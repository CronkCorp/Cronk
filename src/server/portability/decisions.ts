import { continueNumbering, decisionKey, insertDecisionRow, insertDecisionVersion, parseDecisionKey, type DecisionScope } from "../knowledge/decisions.js";
import { DECISION_STATUSES, type DecisionStatus } from "../../shared/values.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { date, integer, oneOf, refuse, text, type File } from "./fields.js";
import { slug } from "./format.js";
import type { ImportContext } from "./import-context.js";

/**
 * Decisions: `docs/adr/NNNN-<title>.md` for the Workspace's, and beside a Project's `project.md`
 * for its own, named by number as an ADR folder is; its Versions in `NNNN-<title>.versions/` when
 * the export includes them. Other Decisions are named by key.
 */

interface DecisionRow {
  id: string;
  number: number;
  title: string;
  body: string;
  status: DecisionStatus;
  status_reason: string | null;
  group_name: string | null;
  supersedes: number[];
  superseded_by: number | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

type VersionRow = ActorColumns & Omit<DecisionRow, "id" | "version" | "created_at" | "updated_at" | "superseded_by"> & { at: Date };

const keys = (projectKey: string | null, numbers: number[]) => (numbers.length === 0 ? undefined : [...numbers].sort((a, b) => a - b).map((n) => decisionKey(projectKey, n)));

/** Writes the Decisions of the Workspace (projectId null) or a Project into `${dir}/docs/adr`. */
export async function exportDecisions(ctx: ExportContext, dir: string, projectId: string | null, projectKey: string | null): Promise<void> {
  const { rows } = await ctx.db.query<DecisionRow>(
    "SELECT * FROM decisions WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY number",
    [ctx.scope.workspaceId, projectId],
  );
  for (const d of rows) {
    const { rows: versions } = await ctx.db.query<VersionRow>("SELECT * FROM decision_versions WHERE decision_id = $1 ORDER BY number", [d.id]);
    const base = `${dir === "" ? "" : `${dir}/`}docs/adr/${String(d.number).padStart(4, "0")}-${slug(d.title)}`;
    const current = versions.find((v) => v.number === d.version)!;
    ctx.add(
      `${base}.md`,
      {
        key: decisionKey(projectKey, d.number),
        title: d.title,
        status: d.status,
        statusReason: d.status_reason ?? undefined,
        group: d.group_name ?? undefined,
        supersedes: keys(projectKey, d.supersedes),
        supersededBy: d.superseded_by === null ? undefined : decisionKey(projectKey, d.superseded_by),
        version: d.version,
        createdAt: iso(d.created_at),
        createdBy: ctx.actor(versions[0]!),
        updatedAt: iso(d.updated_at),
        updatedBy: ctx.actor(current),
      },
      d.body,
    );
    if (ctx.scope.versions) {
      for (const v of versions) {
        ctx.add(
          `${base}.versions/${v.number}.md`,
          { title: v.title, status: v.status, statusReason: v.status_reason ?? undefined, group: v.group_name ?? undefined, supersedes: keys(projectKey, v.supersedes), at: iso(v.at), by: ctx.actor(v) },
          v.body,
        );
      }
    }
  }
}

/** The numbers of the Decisions a file names by key in `field`, which must be of its own scope. */
function numbersIn(file: File, field: string, projectKey: string | null): number[] {
  const value = file.data[field] ?? [];
  if (!Array.isArray(value)) refuse(`${file.path} ${field} must be a list of Decision keys`);
  return value.map((key) => {
    const parsed = typeof key === "string" ? parseDecisionKey(key) : undefined;
    if (!parsed || parsed.projectKey !== projectKey) refuse(`${file.path} ${field} must name Decisions of ${projectKey ?? "the Workspace"} by key, such as ${decisionKey(projectKey, 1)}`);
    return parsed.number;
  });
}

/** What a Decision file or one of its Versions holds besides its body and who wrote it. */
function contentIn(file: File, projectKey: string | null) {
  const group = file.data.group;
  if (group !== undefined && group !== null && typeof group !== "string") refuse(`${file.path} group must be text`);
  const statusReason = file.data.statusReason;
  if (statusReason !== undefined && statusReason !== null && typeof statusReason !== "string") refuse(`${file.path} statusReason must be text`);
  return {
    title: text(file.data.title, `${file.path} title`),
    body: file.body,
    status: oneOf(file.data.status, DECISION_STATUSES, `${file.path} status`),
    statusReason: typeof statusReason === "string" && statusReason.trim() !== "" ? statusReason : null,
    group: typeof group === "string" && group.trim() !== "" ? group.trim() : null,
    supersedes: numbersIn(file, "supersedes", projectKey),
  };
}

/** Imports the Decisions in `${dir}/docs/adr` into the Workspace (projectId null) or a Project. */
export async function importDecisions(ctx: ImportContext, dir: string, projectId: string | null, projectKey: string | null): Promise<void> {
  const scope: DecisionScope = { workspaceId: ctx.workspaceId, projectId };
  const adr = `${dir === "" ? "" : `${dir}/`}docs/adr`;
  const seen = new Set<number>();
  for (const path of ctx.filesIn(adr)) {
    const number = Number(/\/(\d+)-[^/]*\.md$/.exec(path)?.[1]);
    if (!Number.isInteger(number) || number < 1) refuse(`${path} must be named by its number, such as ${adr}/0001-title.md`);
    if (seen.has(number)) refuse(`${path} has the same number as another Decision in ${adr}`);
    seen.add(number);
    const d = ctx.need(path);
    const base = path.slice(0, -".md".length);
    const versions = ctx.numbered(`${base}.versions`);
    const version = versions.length > 0 ? integer(d.data.version, `${path} version`) : 1;
    if (versions.length > 0 && !versions.some(([n]) => n === version)) refuse(`${path} is at Version ${version}, which ${base}.versions/ doesn't hold`);
    const supersededBy = d.data.supersededBy === undefined || d.data.supersededBy === null ? [] : numbersIn({ ...d, data: { by: [d.data.supersededBy] } }, "by", projectKey);
    const content = contentIn(d, projectKey);
    const id = await insertDecisionRow(ctx.db, scope, {
      ...content,
      number,
      supersededBy: supersededBy[0] ?? null,
      version,
      createdAt: date(d.data.createdAt, `${path} createdAt`),
      updatedAt: date(d.data.updatedAt, `${path} updatedAt`),
    });
    if (versions.length === 0) {
      // Without its Versions, it starts at Version 1 by whoever first wrote it.
      const by = await ctx.actor(d.data.createdBy, `${path} createdBy`);
      await insertDecisionVersion(ctx.db, id, { ...content, number: 1, actor: by, now: date(d.data.updatedAt, `${path} updatedAt`) });
    }
    for (const [n, v] of versions) {
      await insertDecisionVersion(ctx.db, id, { ...contentIn(v, projectKey), number: n, actor: await ctx.actor(v.data.by, `${v.path} by`), now: date(v.data.at, `${v.path} at`) });
    }
  }
  await continueNumbering(ctx.db, scope);
}
