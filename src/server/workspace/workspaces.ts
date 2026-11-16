import type { Queryable } from "../db/database.js";
import type { AgentAccess } from "../identity/access.js";

export interface Workspace {
  id: string;
  name: string;
  /** The most Agents may do in the Workspace outside any Project. */
  agentAccess: AgentAccess;
  /** How long an Agent Session may stay silent before it ends and its Claims lapse. */
  silenceThresholdSeconds: number;
  /** The largest file an Attachment may be, in bytes. */
  attachmentMaxBytes: number;
  /** The most a Transcript may hold, all its texts together, in bytes. */
  transcriptMaxBytes: number;
  /** The most bytes, and files, one Version of an Artifact may hold. */
  artifactMaxBytes: number;
  artifactMaxFiles: number;
  /** The origins every Artifact may load scripts, styles and fonts from, besides its own files. */
  artifactAllowedOrigins: string[];
  /** Whether a publish may declare extra origins for its Version, and Versions are served with those they declared. */
  artifactExtraOriginsAllowed: boolean;
}

/** The shape of the Workspace the API returns. */
export const publicWorkspace = (w: Workspace) => ({
  name: w.name,
  agentAccess: w.agentAccess,
  silenceThresholdSeconds: w.silenceThresholdSeconds,
  attachmentMaxBytes: w.attachmentMaxBytes,
  transcriptMaxBytes: w.transcriptMaxBytes,
  artifactMaxBytes: w.artifactMaxBytes,
  artifactMaxFiles: w.artifactMaxFiles,
  artifactAllowedOrigins: w.artifactAllowedOrigins,
  artifactExtraOriginsAllowed: w.artifactExtraOriginsAllowed,
});

interface WorkspaceRow {
  id: string;
  name: string;
  agent_access: AgentAccess;
  silence_threshold_seconds: number;
  attachment_max_bytes: string;
  transcript_max_bytes: number;
  artifact_max_bytes: string;
  artifact_max_files: number;
  artifact_allowed_origins: string[];
  artifact_extra_origins_allowed: boolean;
}

const toWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  agentAccess: row.agent_access,
  silenceThresholdSeconds: row.silence_threshold_seconds,
  attachmentMaxBytes: Number(row.attachment_max_bytes),
  transcriptMaxBytes: row.transcript_max_bytes,
  artifactMaxBytes: Number(row.artifact_max_bytes),
  artifactMaxFiles: row.artifact_max_files,
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
 * Renames the Workspace and/or changes its Agent Access, silence threshold, its limits on Attachments, Transcripts and
 * Artifacts, or the origins Artifacts may load from.
 */
export async function updateWorkspace(
  db: Queryable,
  id: string,
  changes: {
    name?: string;
    agentAccess?: AgentAccess;
    silenceThresholdSeconds?: number;
    attachmentMaxBytes?: number;
    transcriptMaxBytes?: number;
    artifactMaxBytes?: number;
    artifactMaxFiles?: number;
    artifactAllowedOrigins?: string[];
    artifactExtraOriginsAllowed?: boolean;
  },
): Promise<Workspace> {
  const { rows } = await db.query<WorkspaceRow>(
    `UPDATE workspaces SET name = coalesce($2, name), agent_access = coalesce($3, agent_access),
       silence_threshold_seconds = coalesce($4, silence_threshold_seconds), attachment_max_bytes = coalesce($5, attachment_max_bytes),
       transcript_max_bytes = coalesce($6, transcript_max_bytes), artifact_max_bytes = coalesce($7, artifact_max_bytes),
       artifact_max_files = coalesce($8, artifact_max_files), artifact_allowed_origins = coalesce($9, artifact_allowed_origins),
       artifact_extra_origins_allowed = coalesce($10, artifact_extra_origins_allowed)
     WHERE id = $1 RETURNING *`,
    [
      id,
      changes.name ?? null,
      changes.agentAccess ?? null,
      changes.silenceThresholdSeconds ?? null,
      changes.attachmentMaxBytes ?? null,
      changes.transcriptMaxBytes ?? null,
      changes.artifactMaxBytes ?? null,
      changes.artifactMaxFiles ?? null,
      changes.artifactAllowedOrigins ?? null,
      changes.artifactExtraOriginsAllowed ?? null,
    ],
  );
  return toWorkspace(rows[0]!);
}
