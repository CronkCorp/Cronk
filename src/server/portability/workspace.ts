import { agentAccessSchema } from "../schemas.js";
import { MAX_TRANSCRIPT_BYTES, MIN_TRANSCRIPT_BYTES } from "../transcripts/transcripts.js";
import { getWorkspace, updateWorkspace } from "../workspace/workspaces.js";
import type { ExportContext } from "./export-context.js";
import { integer, oneOf, refuse, text } from "./fields.js";
import type { ImportContext } from "./import-context.js";

/** `workspace.md`: the Workspace's settings, in a Workspace export only. */

/** Writes `workspace.md`. */
export async function exportWorkspaceSettings(ctx: ExportContext): Promise<void> {
  const w = await getWorkspace(ctx.db, ctx.scope.workspaceId);
  ctx.add("workspace.md", {
    name: w.name,
    agentAccess: w.agentAccess,
    silenceThresholdSeconds: w.silenceThresholdSeconds,
    attachmentMaxBytes: w.attachmentMaxBytes,
    transcriptMaxBytes: w.transcriptMaxBytes,
    artifactMaxBytes: w.artifactMaxBytes,
    artifactMaxFiles: w.artifactMaxFiles,
  });
}

/** Sets the Workspace's settings from `workspace.md`. */
export async function importWorkspaceSettings(ctx: ImportContext): Promise<void> {
  const w = ctx.need("workspace.md");
  await updateWorkspace(ctx.db, ctx.workspaceId, {
    name: text(w.data.name, "workspace.md name"),
    agentAccess: oneOf(w.data.agentAccess, agentAccessSchema.enum, "workspace.md agentAccess"),
    silenceThresholdSeconds: integer(w.data.silenceThresholdSeconds, "workspace.md silenceThresholdSeconds"),
    // An export from before Attachments has none; the Workspace keeps its own.
    ...(w.data.attachmentMaxBytes !== undefined && { attachmentMaxBytes: integer(w.data.attachmentMaxBytes, "workspace.md attachmentMaxBytes") }),
    // Exports from before Transcripts leave it out, keeping the default.
    ...(w.data.transcriptMaxBytes !== undefined && { transcriptMaxBytes: transcriptMaxBytes(w.data.transcriptMaxBytes) }),
    // Exports from before Artifacts leave their limits out, keeping the defaults.
    ...(w.data.artifactMaxBytes !== undefined && { artifactMaxBytes: positive(w.data.artifactMaxBytes, "workspace.md artifactMaxBytes") }),
    ...(w.data.artifactMaxFiles !== undefined && { artifactMaxFiles: positive(w.data.artifactMaxFiles, "workspace.md artifactMaxFiles") }),
  });
}

/** The Transcript limit `workspace.md` sets, within the bounds the API allows. */
function transcriptMaxBytes(value: unknown): number {
  const bytes = integer(value, "workspace.md transcriptMaxBytes");
  if (bytes < MIN_TRANSCRIPT_BYTES || bytes > MAX_TRANSCRIPT_BYTES) {
    refuse(`workspace.md transcriptMaxBytes must be from ${MIN_TRANSCRIPT_BYTES} to ${MAX_TRANSCRIPT_BYTES}`);
  }
  return bytes;
}

/** A limit `workspace.md` sets, which must be a whole number above 0. */
function positive(value: unknown, where: string): number {
  const n = integer(value, where);
  if (n < 1) refuse(`${where} must be above 0`);
  return n;
}
