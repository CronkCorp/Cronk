import { agentAccessSchema } from "../schemas.js";
import { getWorkspace, updateWorkspace } from "../workspace/workspaces.js";
import type { ExportContext } from "./export-context.js";
import { integer, oneOf, text } from "./fields.js";
import type { ImportContext } from "./import-context.js";

/** `workspace.md`: the Workspace's settings, in a Workspace export only. */

/** Writes `workspace.md`. */
export async function exportWorkspaceSettings(ctx: ExportContext): Promise<void> {
  const w = await getWorkspace(ctx.db, ctx.scope.workspaceId);
  ctx.add("workspace.md", { name: w.name, agentAccess: w.agentAccess, silenceThresholdSeconds: w.silenceThresholdSeconds });
}

/** Sets the Workspace's settings from `workspace.md`. */
export async function importWorkspaceSettings(ctx: ImportContext): Promise<void> {
  const w = ctx.need("workspace.md");
  await updateWorkspace(ctx.db, ctx.workspaceId, {
    name: text(w.data.name, "workspace.md name"),
    agentAccess: oneOf(w.data.agentAccess, agentAccessSchema.enum, "workspace.md agentAccess"),
    silenceThresholdSeconds: integer(w.data.silenceThresholdSeconds, "workspace.md silenceThresholdSeconds"),
  });
}
