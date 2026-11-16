import type { FastifyInstance } from "fastify";
import { actingUser } from "../actor.js";
import { requireActor, requireUser, type AppContext } from "../context.js";
import { requireAdmin, requireWorkspaceAccess, type AgentAccess } from "../identity/access.js";
import { agentAccessSchema, answer, errors, nameSchema, ref } from "../schemas.js";
import { getWorkspace, pickSettings, publicWorkspace, updateWorkspace, WORKSPACE_SETTINGS, type WorkspaceSettings } from "./workspaces.js";
import { attachmentStorage } from "../files/attachments.js";
import { artifactStorage } from "../files/artifacts.js";
import { bareOrigins } from "../files/origins.js";

/** The most origins the Workspace's allow-list may hold. */
const MAX_ALLOWED_ORIGINS = 50;

/** What an Admin may change about the Workspace. */
interface WorkspaceChanges extends Partial<WorkspaceSettings> {
  name?: string;
  agentAccess?: AgentAccess;
  artifactAllowedOrigins?: string[];
  artifactExtraOriginsAllowed?: boolean;
}

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

    app.patch<{ Body: WorkspaceChanges }>(
      "/api/workspace",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: nameSchema,
              agentAccess: agentAccessSchema,
              ...Object.fromEntries(WORKSPACE_SETTINGS.map((s) => [s.name, s.schema])),
              artifactAllowedOrigins: {
                type: "array",
                maxItems: MAX_ALLOWED_ORIGINS,
                items: { type: "string", maxLength: 300 },
                description:
                  "The origins every Artifact may load scripts, styles and fonts from, besides its own files, as bare http or https origins such as " +
                  "`https://cdn.jsdelivr.net`; at most 50. Cronk starts with cdnjs, jsDelivr, unpkg and Google Fonts. Network requests stay blocked whatever it holds.",
              },
              artifactExtraOriginsAllowed: {
                type: "boolean",
                description:
                  "Whether a publish may declare extra origins for its Version, with a reason. Turned off, such publishes are refused and Versions that declared some " +
                  "are served without them.",
              },
            },
          },
          response: { 200: answer("The changed Workspace", ref("Workspace")), ...errors(400, 401, 403, 410) },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "change the Workspace");
        const { name, agentAccess, artifactAllowedOrigins, artifactExtraOriginsAllowed } = request.body;
        const workspace = await updateWorkspace(ctx.db, user.workspaceId, {
          ...(name !== undefined && { name: name.trim() }),
          ...(agentAccess !== undefined && { agentAccess }),
          ...pickSettings(request.body),
          ...(artifactAllowedOrigins !== undefined && { artifactAllowedOrigins: bareOrigins(artifactAllowedOrigins, "artifactAllowedOrigins") }),
          ...(artifactExtraOriginsAllowed !== undefined && { artifactExtraOriginsAllowed }),
        });
        return publicWorkspace(workspace);
      },
    );

    app.get(
      "/api/workspace/storage",
      {
        schema: {
          description: "How much storage the Workspace's files take. There is no quota; this is for planning disk space.",
          response: {
            200: answer("The storage used, by kind of file", {
              type: "object",
              required: ["attachments", "artifacts"],
              properties: {
                attachments: {
                  type: "object",
                  required: ["files", "bytes"],
                  properties: {
                    files: { type: "integer", description: "How many Attachments there are." },
                    bytes: { type: "integer", description: "How many bytes their files take." },
                  },
                },
                artifacts: {
                  type: "object",
                  required: ["files", "bytes"],
                  properties: {
                    files: { type: "integer", description: "How many files the Versions of Artifacts hold, every Version counted." },
                    bytes: { type: "integer", description: "How many bytes those files take." },
                  },
                },
              },
            }),
            ...errors(401, 403, 410),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "see the storage used");
        return { attachments: await attachmentStorage(ctx.db, user.workspaceId), artifacts: await artifactStorage(ctx.db, user.workspaceId) };
      },
    );
  };
}
