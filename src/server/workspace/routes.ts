import type { FastifyInstance } from "fastify";
import { HttpError, requireUser, type AppContext } from "../context.js";
import { getWorkspace, renameWorkspace } from "./workspaces.js";

export function workspaceRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get("/api/workspace", async (request) => {
      const user = await requireUser(ctx, request);
      const workspace = await getWorkspace(ctx.db, user.workspaceId);
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
            properties: { name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } },
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        if (user.role !== "admin") throw new HttpError(403, "Only an Admin can rename the Workspace");
        const workspace = await renameWorkspace(ctx.db, user.workspaceId, request.body.name.trim());
        return { name: workspace.name };
      },
    );
  };
}
