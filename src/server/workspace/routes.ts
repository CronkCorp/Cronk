import type { FastifyInstance } from "fastify";
import { actingUser } from "../actor.js";
import { requireActor, requireUser, type AppContext } from "../context.js";
import { requireAdmin, requireWorkspaceAccess, type AgentAccess } from "../identity/access.js";
import { agentAccessSchema, nameSchema } from "../schemas.js";
import { getWorkspace, updateWorkspace, type Workspace } from "./workspaces.js";

const publicWorkspace = (w: Workspace) => ({ name: w.name, agentAccess: w.agentAccess });

export function workspaceRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get("/api/workspace", async (request) => {
      const actor = await requireActor(ctx, request);
      await requireWorkspaceAccess(ctx.db, actor, "read");
      return publicWorkspace(await getWorkspace(ctx.db, actingUser(actor).workspaceId));
    });

    app.patch<{ Body: { name?: string; agentAccess?: AgentAccess } }>(
      "/api/workspace",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: { name: nameSchema, agentAccess: agentAccessSchema },
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "change the Workspace");
        const { name, agentAccess } = request.body;
        const workspace = await updateWorkspace(ctx.db, user.workspaceId, {
          ...(name !== undefined && { name: name.trim() }),
          ...(agentAccess !== undefined && { agentAccess }),
        });
        return publicWorkspace(workspace);
      },
    );
  };
}
