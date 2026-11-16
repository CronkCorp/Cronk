import type { FastifyInstance } from "fastify";
import { actingUser } from "../actor.js";
import { requireActor, requireUser, type AppContext } from "../context.js";
import { requireAdmin, requireWorkspaceAccess, type AgentAccess } from "../identity/access.js";
import { agentAccessSchema, answer, errors, nameSchema, ref } from "../schemas.js";
import { MAX_TRANSCRIPT_BYTES, MIN_TRANSCRIPT_BYTES } from "../transcripts/transcripts.js";
import { getWorkspace, publicWorkspace, updateWorkspace } from "./workspaces.js";

export function workspaceRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get(
      "/api/workspace",
      { schema: { response: { 200: answer("The caller's Workspace", ref("Workspace")), ...errors(401, 403, 410) } } },
      async (request) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "read");
        return publicWorkspace(await getWorkspace(ctx.db, actingUser(actor).workspaceId));
      },
    );

    app.patch<{ Body: { name?: string; agentAccess?: AgentAccess; silenceThresholdSeconds?: number; transcriptMaxBytes?: number } }>(
      "/api/workspace",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: nameSchema,
              agentAccess: agentAccessSchema,
              silenceThresholdSeconds: {
                type: "integer",
                minimum: 60,
                maximum: 86_400,
                description: "How long an Agent Session may stay silent before it ends and its Claims lapse: one minute to one day.",
              },
              transcriptMaxBytes: {
                type: "integer",
                minimum: MIN_TRANSCRIPT_BYTES,
                maximum: MAX_TRANSCRIPT_BYTES,
                description: "The most a Transcript may hold, all its texts together, in bytes: 1 KB to 100 MB; 10 MB unless changed.",
              },
            },
          },
          response: { 200: answer("The changed Workspace", ref("Workspace")), ...errors(400, 401, 403, 410) },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "change the Workspace");
        const { name, agentAccess, silenceThresholdSeconds, transcriptMaxBytes } = request.body;
        const workspace = await updateWorkspace(ctx.db, user.workspaceId, {
          ...(name !== undefined && { name: name.trim() }),
          ...(agentAccess !== undefined && { agentAccess }),
          ...(silenceThresholdSeconds !== undefined && { silenceThresholdSeconds }),
          ...(transcriptMaxBytes !== undefined && { transcriptMaxBytes }),
        });
        return publicWorkspace(workspace);
      },
    );
  };
}
