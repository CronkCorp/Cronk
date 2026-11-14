import type { FastifyInstance } from "fastify";
import { actingUser, userActor, type Actor } from "../actor.js";
import { HttpError, requireActor, requireUser, type AppContext } from "../context.js";
import { requireAdmin, requireWorkspaceAccess } from "../identity/access.js";
import type { User } from "../identity/users.js";
import { answer, errors, holding, listing, pathParams, projectKeyParam, ref } from "../schemas.js";
import type { Project } from "../work/projects.js";
import { projectFor } from "../work/routes.js";
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
  description: "The Guidance changed since the Version the save is based on; `guidance` is the current Version",
  allOf: [ref("Error"), { type: "object", required: ["guidance"], properties: { guidance: ref("Guidance") } }],
} as const;

/** Where one Guidance lives in the API, and how a caller reaches it. */
interface GuidanceResource<Params> {
  /** The path the Guidance is at, such as `/api/workspace/guidance`. */
  url: string;
  params?: object;
  /** Whose Guidance it is, as in "The Workspace's Guidance". */
  whose: string;
  /** The Guidance's owner, if `actor` may read it; otherwise throws. */
  toRead: (actor: Actor, params: Params) => Promise<GuidanceOwner>;
  /** The Guidance's owner, if `user` may write it; otherwise throws. */
  toWrite: (user: User, params: Params) => Promise<GuidanceOwner>;
}

/**
 * Guidance for Agents: the Workspace's and each Project's. Anyone who can read the Workspace
 * (or Project) reads its Guidance; only Users write it: Admins the Workspace's, and Users with
 * Write in a Project that Project's.
 */
export function guidanceRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    guidanceResource<object>(app, ctx, {
      url: "/api/workspace/guidance",
      whose: "The Workspace's",
      toRead: async (actor) => {
        await requireWorkspaceAccess(ctx.db, actor, "read");
        return { workspaceId: actingUser(actor).workspaceId, projectId: null };
      },
      toWrite: async (user) => {
        requireAdmin(user, "write the Workspace's Guidance");
        return { workspaceId: user.workspaceId, projectId: null };
      },
    });

    guidanceResource<{ key: string }>(app, ctx, {
      url: "/api/projects/:key/guidance",
      params: pathParams({ key: projectKeyParam }),
      whose: "The Project's",
      toRead: async (actor, { key }) => projectGuidance(actingUser(actor), await projectFor(ctx.db, actor, key, "read")),
      toWrite: async (user, { key }) => projectGuidance(user, await projectFor(ctx.db, userActor(user), key, "write")),
    });
  };
}

/** A Project's Guidance; `projectFor` found the Project in `user`'s Workspace. */
const projectGuidance = (user: User, { project }: { project: Project }): GuidanceOwner => ({ workspaceId: user.workspaceId, projectId: project.id });

/** Registers reading a Guidance, listing its Versions, and saving it. */
function guidanceResource<Params>(app: FastifyInstance, ctx: AppContext, resource: GuidanceResource<Params>) {
  const { url, whose } = resource;
  const params = resource.params ? { params: resource.params } : {};
  const readErrors = resource.params ? errors(401, 403, 404, 410) : errors(401, 403, 410);

  app.get<{ Params: Params }>(
    url,
    { schema: { ...params, response: { 200: answer(`${whose} Guidance`, holding("guidance", "Guidance")), ...readErrors } } },
    async (request) => {
      const owner = await resource.toRead(await requireActor(ctx, request), request.params as Params);
      return { guidance: await getGuidance(ctx.db, owner) };
    },
  );

  app.get<{ Params: Params }>(
    `${url}/versions`,
    {
      schema: {
        ...params,
        response: { 200: answer(`Every Version of ${whose} Guidance, oldest first`, listing("versions", ref("GuidanceVersion"))), ...readErrors },
      },
    },
    async (request) => {
      const owner = await resource.toRead(await requireActor(ctx, request), request.params as Params);
      return { versions: await listGuidanceVersions(ctx.db, owner) };
    },
  );

  app.put<{ Params: Params; Body: GuidanceWrite }>(
    url,
    {
      schema: {
        ...params,
        body: writeBody,
        response: { 200: answer(`${whose} Guidance as saved`, holding("guidance", "Guidance")), ...readErrors, ...errors(400), 409: staleSave },
      },
    },
    async (request) => {
      const user = await requireUser(ctx, request);
      const owner = await resource.toWrite(user, request.params as Params);
      return { guidance: await save(ctx, owner, request.body, user.id) };
    },
  );
}

/** Saves Guidance on the Version the caller based it on; a 409 if someone saved since. */
async function save(ctx: AppContext, owner: GuidanceOwner, body: GuidanceWrite, userId: string): Promise<Guidance> {
  const saved = await writeGuidance(ctx.db, owner, { ...body, userId, now: ctx.clock.now() });
  if (saved) return saved;
  throw new HttpError(409, "This Guidance changed since the Version you based your save on; merge into the current Version and save again", {
    guidance: await getGuidance(ctx.db, owner),
  });
}
