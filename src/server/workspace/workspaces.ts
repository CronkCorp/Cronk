import type { Queryable } from "../db/database.js";
import type { AgentAccess } from "../identity/access.js";

const MB = 1024 * 1024;

/** The largest Transcript limit a Workspace may set, and so the largest upload read at all: 100 MB. */
export const MAX_TRANSCRIPT_BYTES = 100 * MB;

/** The smallest Transcript limit a Workspace may set: 1 KB. */
export const MIN_TRANSCRIPT_BYTES = 1024;

/** One numeric Workspace setting: all the API, the `Workspace` schema and `workspace.md` need to know of it. */
interface WorkspaceSetting {
  /** Its name in the API and in `workspace.md`. */
  name: string;
  /** Its column in `workspaces`, where its default and `CHECK` live. */
  column: string;
  /** Whether the column is a `bigint`, which comes back from the database as a string. */
  bigint: boolean;
  /** What the API accepts, which an import checks too. */
  schema: { type: "integer"; minimum: number; maximum: number; description: string };
  /** What the setting is, as the `Workspace` the API returns describes it. */
  returned: string;
}

/**
 * The Workspace's numeric settings. Adding one takes an entry here and its migration: the API, the `Workspace`
 * schema and `workspace.md` export and import all follow from this table.
 */
export const WORKSPACE_SETTINGS = [
  {
    name: "silenceThresholdSeconds",
    column: "silence_threshold_seconds",
    bigint: false,
    schema: {
      type: "integer",
      minimum: 60,
      maximum: 86_400,
      description: "How long an Agent Session may stay silent before it ends and its Claims lapse: one minute to one day.",
    },
    returned: "How long an Agent Session may stay silent before it ends and its Claims lapse.",
  },
  {
    name: "attachmentMaxBytes",
    column: "attachment_max_bytes",
    bigint: true,
    schema: { type: "integer", minimum: MB, maximum: 10 * 1024 * MB, description: "The largest file an Attachment may be, in bytes: 1 MB to 10 GB." },
    returned: "The largest file an Attachment may be, in bytes.",
  },
  {
    name: "transcriptMaxBytes",
    column: "transcript_max_bytes",
    bigint: false,
    schema: {
      type: "integer",
      minimum: MIN_TRANSCRIPT_BYTES,
      maximum: MAX_TRANSCRIPT_BYTES,
      description: "The most a Transcript may hold, all its texts together, in bytes: 1 KB to 100 MB; 10 MB unless changed.",
    },
    returned: "The most a Transcript may hold, all its texts together, in bytes of UTF-8.",
  },
  {
    name: "artifactMaxBytes",
    column: "artifact_max_bytes",
    bigint: true,
    schema: {
      type: "integer",
      minimum: MB,
      maximum: 500 * MB,
      description: "The most bytes one Version of an Artifact may hold, all its files together: 1 MB to 500 MB; 25 MB unless changed.",
    },
    returned: "The most bytes one Version of an Artifact may hold, all its files together.",
  },
  {
    name: "artifactMaxFiles",
    column: "artifact_max_files",
    bigint: false,
    schema: { type: "integer", minimum: 1, maximum: 10_000, description: "The most files one Version of an Artifact may hold: 1 to 10,000; 500 unless changed." },
    returned: "The most files one Version of an Artifact may hold.",
  },
] as const satisfies readonly WorkspaceSetting[];

export type WorkspaceSettingName = (typeof WORKSPACE_SETTINGS)[number]["name"];
type WorkspaceSettingColumn = (typeof WORKSPACE_SETTINGS)[number]["column"];

/** The Workspace's numeric settings, by name. */
export type WorkspaceSettings = { [K in WorkspaceSettingName]: number };

/** The settings `values` holds, in the table's order, leaving out those it doesn't. */
export function pickSettings<T>(values: Partial<Record<WorkspaceSettingName, T>>): Partial<Record<WorkspaceSettingName, T>> {
  return Object.fromEntries(WORKSPACE_SETTINGS.filter((s) => values[s.name] !== undefined).map((s) => [s.name, values[s.name]]));
}

export interface Workspace extends WorkspaceSettings {
  id: string;
  name: string;
  /** The most Agents may do in the Workspace outside any Project. */
  agentAccess: AgentAccess;
  /** The origins every Artifact may load scripts, styles and fonts from, besides its own files. */
  artifactAllowedOrigins: string[];
  /** Whether a publish may declare extra origins for its Version, and Versions are served with those they declared. */
  artifactExtraOriginsAllowed: boolean;
}

/** The shape of the Workspace the API returns. */
export const publicWorkspace = (w: Workspace) => ({
  name: w.name,
  agentAccess: w.agentAccess,
  ...(pickSettings(w) as WorkspaceSettings),
  artifactAllowedOrigins: w.artifactAllowedOrigins,
  artifactExtraOriginsAllowed: w.artifactExtraOriginsAllowed,
});

type WorkspaceRow = {
  id: string;
  name: string;
  agent_access: AgentAccess;
  artifact_allowed_origins: string[];
  artifact_extra_origins_allowed: boolean;
} & { [C in WorkspaceSettingColumn]: number | string };

const toWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  agentAccess: row.agent_access,
  ...(Object.fromEntries(WORKSPACE_SETTINGS.map((s) => [s.name, s.bigint ? Number(row[s.column]) : row[s.column]])) as WorkspaceSettings),
  artifactAllowedOrigins: row.artifact_allowed_origins,
  artifactExtraOriginsAllowed: row.artifact_extra_origins_allowed,
});

export async function insertWorkspace(db: Queryable, input: { name: string; now: Date }): Promise<Workspace> {
  const { rows } = await db.query<WorkspaceRow>("INSERT INTO workspaces (name, created_at) VALUES ($1, $2) RETURNING *", [
    input.name,
    input.now,
  ]);
  return toWorkspace(rows[0]!);
}

export async function getWorkspace(db: Queryable, id: string): Promise<Workspace> {
  const { rows } = await db.query<WorkspaceRow>("SELECT * FROM workspaces WHERE id = $1", [id]);
  return toWorkspace(rows[0]!);
}

/**
 * Renames the Workspace and/or changes its Agent Access, any of its numeric settings, or the origins Artifacts may
 * load from. Whatever `changes` leaves out keeps the Workspace's value.
 */
export async function updateWorkspace(
  db: Queryable,
  id: string,
  changes: Partial<WorkspaceSettings> & {
    name?: string;
    agentAccess?: AgentAccess;
    artifactAllowedOrigins?: string[];
    artifactExtraOriginsAllowed?: boolean;
  },
): Promise<Workspace> {
  const columns: [string, unknown][] = [
    ["name", changes.name],
    ["agent_access", changes.agentAccess],
    ...WORKSPACE_SETTINGS.map((s): [string, unknown] => [s.column, changes[s.name]]),
    ["artifact_allowed_origins", changes.artifactAllowedOrigins],
    ["artifact_extra_origins_allowed", changes.artifactExtraOriginsAllowed],
  ];
  // Column names come from this module, never from the caller; every value is a parameter.
  const sets = columns.map(([column], i) => `${column} = coalesce($${i + 2}, ${column})`).join(", ");
  const { rows } = await db.query<WorkspaceRow>(`UPDATE workspaces SET ${sets} WHERE id = $1 RETURNING *`, [
    id,
    ...columns.map(([, value]) => value ?? null),
  ]);
  return toWorkspace(rows[0]!);
}
