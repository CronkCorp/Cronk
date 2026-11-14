import type { FastifyInstance } from "fastify";
import { actingUser } from "../actor.js";
import { requireActor, requireUser, type AppContext } from "../context.js";
import { requireAdmin } from "../identity/access.js";
import { nameSchema } from "../schemas.js";
import { getWorkspace, renameWorkspace } from "./workspaces.js";

export function workspaceRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get("/api/workspace", async (request) => {
      const actor = await requireActor(ctx, request);
      const workspace = await getWorkspace(ctx.db, actingUser(actor).workspaceId);
      return { name: workspace.name };
    });

    app.patch<{ Body: { name: string } }>(
      "/api/workspace",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            additionalProperties: false,
            properties: { name: nameSchema },
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "rename the Workspace");
        const workspace = await renameWorkspace(ctx.db, user.workspaceId, request.body.name.trim());
        return { name: workspace.name };
      },
    );
  };
}
