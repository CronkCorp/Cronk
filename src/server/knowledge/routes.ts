import type { FastifyInstance } from "fastify";
import { actingUser } from "../actor.js";
import { HttpError, requireActor, requireUser, type AppContext } from "../context.js";
import { requireAdmin, requireWorkspaceAccess } from "../identity/access.js";
import { answer, errors, holding, listing, ref } from "../schemas.js";
import { getGuidance, listGuidanceVersions, writeGuidance, type Guidance, type GuidanceOwner } from "./guidance.js";

/** A save of Guidance: its new Markdown and the Version it is based on. */
interface GuidanceWrite {
  markdown: string;
  baseVersion: number;
}

const writeBody = {
  type: "object",
  required: ["markdown", "baseVersion"],
  additionalProperties: false,
  properties: {
    markdown: { type: "string", maxLength: 100_000 },
    baseVersion: { type: "integer", minimum: 0, description: "The Version this save is based on: the current one, or 0 for the first save." },
  },
} as const;

/** The refusal of a save based on an outdated Version, with the current Guidance to merge into. */
const staleSave = {
  description: "The Guidance changed since the Version the save is based on",
  type: "object",
  required: ["error", "guidance"],
  properties: { error: { type: "string" }, guidance: ref("Guidance") },
} as const;

/**
 * Guidance for Agents: the Workspace's and each Project's. Anyone who can read the Workspace
 * (or Project) reads its Guidance; only Users write it, Admins for the Workspace's.
 */
export function guidanceRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get(
      "/api/workspace/guidance",
      { schema: { response: { 200: answer("The Workspace's Guidance", holding("guidance", "Guidance")), ...errors(401, 403, 410) } } },
      async (request) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "read");
        return { guidance: await getGuidance(ctx.db, workspaceGuidance(actingUser(actor).workspaceId)) };
      },
    );

    app.get(
      "/api/workspace/guidance/versions",
      {
        schema: {
          response: { 200: answer("Every Version of the Workspace's Guidance, oldest first", listing("versions", ref("GuidanceVersion"))), ...errors(401, 403, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "read");
        return { versions: await listGuidanceVersions(ctx.db, workspaceGuidance(actingUser(actor).workspaceId)) };
      },
    );

    app.put<{ Body: GuidanceWrite }>(
      "/api/workspace/guidance",
      {
        schema: {
          body: writeBody,
          response: { 200: answer("The Workspace's Guidance as saved", holding("guidance", "Guidance")), ...errors(400, 401, 403, 410), 409: staleSave },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "write the Workspace's Guidance");
        const guidance = await save(ctx, workspaceGuidance(user.workspaceId), request.body, user.id);
        return { guidance };
      },
    );
  };
}

const workspaceGuidance = (workspaceId: string): GuidanceOwner => ({ workspaceId, projectId: null });

/** Saves Guidance on the Version the caller based it on; a 409 if someone saved since. */
async function save(ctx: AppContext, owner: GuidanceOwner, body: GuidanceWrite, userId: string): Promise<Guidance> {
  const saved = await writeGuidance(ctx.db, owner, { ...body, userId, now: ctx.clock.now() });
  if (saved) return saved;
  throw new HttpError(409, "This Guidance changed since the Version you based your save on; merge into the current Version and save again", {
    guidance: await getGuidance(ctx.db, owner),
  });
}
