import { bareOrigins } from "../files/origins.js";
import { agentAccessSchema } from "../schemas.js";
import { getWorkspace, pickSettings, updateWorkspace, WORKSPACE_SETTINGS, type WorkspaceSettings } from "../workspace/workspaces.js";
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
    ...pickSettings(w),
    artifactAllowedOrigins: w.artifactAllowedOrigins,
    artifactExtraOriginsAllowed: w.artifactExtraOriginsAllowed,
  });
}

/** Sets the Workspace's settings from `workspace.md`. */
export async function importWorkspaceSettings(ctx: ImportContext): Promise<void> {
  const w = ctx.need("workspace.md");
  await updateWorkspace(ctx.db, ctx.workspaceId, {
    name: text(w.data.name, "workspace.md name"),
    agentAccess: oneOf(w.data.agentAccess, agentAccessSchema.enum, "workspace.md agentAccess"),
    ...importedSettings(w.data),
    // Exports from before the Admin's allow-list leave it out, keeping the Workspace's own.
    ...(w.data.artifactAllowedOrigins !== undefined && { artifactAllowedOrigins: bareOrigins(
        Array.isArray(w.data.artifactAllowedOrigins) && w.data.artifactAllowedOrigins.every((v) => typeof v === "string")
          ? (w.data.artifactAllowedOrigins as string[])
          : refuse("workspace.md artifactAllowedOrigins must be a list of origins"),
        "workspace.md artifactAllowedOrigins",
      ) }),
    ...(w.data.artifactExtraOriginsAllowed !== undefined && {
      artifactExtraOriginsAllowed:
        typeof w.data.artifactExtraOriginsAllowed === "boolean" ? w.data.artifactExtraOriginsAllowed : refuse("workspace.md artifactExtraOriginsAllowed must be true or false"),
    }),
  });
}

/**
 * The numeric settings `workspace.md` sets, each within the bounds the API allows. One it leaves out, as an export
 * from before that setting does, keeps the Workspace's own value.
 */
function importedSettings(data: Record<string, unknown>): Partial<WorkspaceSettings> {
  const set: Partial<WorkspaceSettings> = {};
  for (const { name, schema } of WORKSPACE_SETTINGS) {
    if (data[name] === undefined) continue;
    const where = `workspace.md ${name}`;
    const value = integer(data[name], where);
    if (value < schema.minimum || value > schema.maximum) refuse(`${where} must be from ${schema.minimum} to ${schema.maximum}`);
    set[name] = value;
  }
  return set;
}
