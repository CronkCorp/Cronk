import type { FastifyInstance } from "fastify";
import { actingUser } from "../actor.js";
import { requireActor, requireUser, type AppContext } from "../context.js";
import { requireAdmin, requireWorkspaceAccess, type AgentAccess } from "../identity/access.js";
import { agentAccessSchema, answer, errors, nameSchema, ref } from "../schemas.js";
import { MAX_TRANSCRIPT_BYTES, MIN_TRANSCRIPT_BYTES } from "../transcripts/transcripts.js";
import { getWorkspace, publicWorkspace, updateWorkspace } from "./workspaces.js";
import { attachmentStorage } from "../files/attachments.js";

const MB = 1024 * 1024;

/** What an Admin may change about the Workspace. */
interface WorkspaceChanges {
  name?: string;
  agentAccess?: AgentAccess;
  silenceThresholdSeconds?: number;
  attachmentMaxBytes?: number;
  transcriptMaxBytes?: number;
  artifactMaxBytes?: number;
  artifactMaxFiles?: number;
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
              silenceThresholdSeconds: {
                type: "integer",
                minimum: 60,
                maximum: 86_400,
                description: "How long an Agent Session may stay silent before it ends and its Claims lapse: one minute to one day.",
              },
              attachmentMaxBytes: {
                type: "integer",
                minimum: MB,
                maximum: 10 * 1024 * MB,
                description: "The largest file an Attachment may be, in bytes: 1 MB to 10 GB.",
              },
              transcriptMaxBytes: {
                type: "integer",
                minimum: MIN_TRANSCRIPT_BYTES,
                maximum: MAX_TRANSCRIPT_BYTES,
                description: "The most a Transcript may hold, all its texts together, in bytes: 1 KB to 100 MB; 10 MB unless changed.",
              },
              artifactMaxBytes: {
                type: "integer",
                minimum: MB,
                maximum: 500 * MB,
                description: "The most bytes one Version of an Artifact may hold, all its files together: 1 MB to 500 MB; 25 MB unless changed.",
              },
              artifactMaxFiles: {
                type: "integer",
                minimum: 1,
                maximum: 10_000,
                description: "The most files one Version of an Artifact may hold: 1 to 10,000; 500 unless changed.",
              },
            },
          },
          response: { 200: answer("The changed Workspace", ref("Workspace")), ...errors(400, 401, 403, 410) },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "change the Workspace");
        const { name, agentAccess, silenceThresholdSeconds, attachmentMaxBytes, transcriptMaxBytes, artifactMaxBytes, artifactMaxFiles } = request.body;
        const workspace = await updateWorkspace(ctx.db, user.workspaceId, {
          ...(name !== undefined && { name: name.trim() }),
          ...(agentAccess !== undefined && { agentAccess }),
          ...(silenceThresholdSeconds !== undefined && { silenceThresholdSeconds }),
          ...(attachmentMaxBytes !== undefined && { attachmentMaxBytes }),
          ...(transcriptMaxBytes !== undefined && { transcriptMaxBytes }),
          ...(artifactMaxBytes !== undefined && { artifactMaxBytes }),
          ...(artifactMaxFiles !== undefined && { artifactMaxFiles }),
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
              required: ["attachments"],
              properties: {
                attachments: {
                  type: "object",
                  required: ["files", "bytes"],
                  properties: {
                    files: { type: "integer", description: "How many Attachments there are." },
                    bytes: { type: "integer", description: "How many bytes their files take." },
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
        return { attachments: await attachmentStorage(ctx.db, user.workspaceId) };
      },
    );
  };
}
