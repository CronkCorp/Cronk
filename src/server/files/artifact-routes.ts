import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { actingUser, type Actor } from "../actor.js";
import { HttpError, requireActor, requireUserActor, type AppContext } from "../context.js";
import { sourceClaimOf } from "../coordination/sources.js";
import { transaction, type Queryable } from "../db/database.js";
import { projectFor, requireProjectAccess, requireWorkspaceAccess, type Access } from "../identity/access.js";
import { listProtectionMarkings, requireUnprotected, setProtected } from "../knowledge/protection.js";
import { ARCHIVE_TYPES, archiveBody, unpackFolder, unwrapFolder, bytesOf, type Folder } from "../portability/archive.js";
import { answer, errors, holding, listing, pathParams, projectKeyParam, protectionBody, protectionHistoryAnswer, ref } from "../schemas.js";
import { findProjectById } from "../work/projects.js";
import { getWorkspace } from "../workspace/workspaces.js";
import { cronkOrigin, frameUrl } from "./artifact-host.js";
import { formatBytes } from "./sizes.js";
import {
  artifactFileKey,
  findArtifact,
  findArtifactVersion,
  insertArtifact,
  insertArtifactVersion,
  listArtifactFiles,
  listArtifacts,
  listArtifactVersions,
  type Artifact,
  type ArtifactFile,
  type ArtifactVersion,
} from "./artifacts.js";

/** An Artifact's title: non-blank, at most 200 characters. */
const titleParam = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S", description: "The Artifact's title, such as `Sign-in limits dashboard`." } as const;
const ticketParam = {
  type: "string",
  maxLength: 30,
  description:
    "For an Agent: the key of the Ticket it is working on, whose Claim its Agent Session holds; the Version records it as where it came from. " +
    "Left out, the Ticket of the one such Claim the Agent Session holds; needed when it holds several.",
} as const;
const artifactIdParam = { type: "string", format: "uuid", description: "The Artifact's id." } as const;
const artifactParams = pathParams({ id: artifactIdParam });
const versionParams = pathParams({ id: artifactIdParam, number: { type: "string", pattern: "^[1-9][0-9]{0,8}$", description: "The Version's number, counting from 1." } });
const projectParams = pathParams({ key: projectKeyParam });

/** The largest archive a publish takes; the Workspace's limits on what it unpacks to are usually far lower. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;


const publishRules =
  "The request body is the whole folder as a zip archive, or a tar archive gzipped (`tar czf`) or not, sent as `application/zip`, `application/gzip`, " +
  "`application/x-tar` or `application/octet-stream`. It must hold `index.html` at its top; a single folder holding everything (as archiving a folder adds) " +
  "is unwrapped and hidden files are skipped. A Version may hold as many files and bytes as the Workspace allows (500 files and 25 MB unless an Admin changed them). " +
  "Its page may load scripts, styles and fonts only from itself, cdnjs, jsDelivr, unpkg and Google Fonts, and may make no network requests. " +
  "Needs Write where it belongs; Agents publish within an Agent Session.";

interface PublishQuery {
  title?: string;
  ticket?: string;
  baseVersion?: number;
}

/** Artifacts: publishing folders as Versions, and reading them. Their files are served on the Artifact hostname (artifact-host.ts). */
export function artifactRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // Archives arrive as raw bytes; this parser applies only to the routes registered here.
    app.addContentTypeParser(ARCHIVE_TYPES, { parseAs: "buffer", bodyLimit: MAX_ARCHIVE_BYTES }, (_request, body, done) => done(null, body));

    /** What the API answers for an Artifact, for the caller of `request`. */
    const shown = async (request: FastifyRequest, artifact: Artifact, opts: { versions?: boolean } = {}) => {
      const origin = cronkOrigin(ctx, request);
      return {
        ...publicArtifact(artifact, origin),
        ...(opts.versions && {
          frameUrl: await frameUrl(ctx, request, ctx.db, artifact.workspaceId, artifact.id, artifact.version),
          versions: (await listArtifactVersions(ctx.db, artifact.id)).map((v) => publicVersion(artifact, v, origin)),
        }),
      };
    };

    /** Stores the folder of a publish and records it with `record`, which runs in a transaction; nothing stays stored if it fails. */
    const publish = async (actor: Actor, body: unknown, record: (tx: Queryable, files: ArtifactFile[]) => Promise<Artifact>): Promise<Artifact> => {
      const workspace = await getWorkspace(ctx.db, actingUser(actor).workspaceId);
      const folder = checkedFolder(await unpackFolder(archiveBody(body)), workspace);
      const files: ArtifactFile[] = [];
      try {
        for (const [path, contents] of folder) {
          // Listed before it is stored, so a file the store fails partway through is removed too.
          const file = { id: randomUUID(), path, contentType: mediaTypeOf(path), size: 0 };
          files.push(file);
          file.size = await ctx.files.put(artifactFileKey(file.id), bytesOf(contents));
        }
        return await transaction(ctx.db, (tx) => record(tx, files));
      } catch (err) {
        for (const file of files) await ctx.files.delete(artifactFileKey(file.id));
        throw err;
      }
    };

    /** Publishes a new Artifact in a Project, or the Workspace when `projectId` is null, which `actor` may write in. */
    const create = (actor: Actor, projectId: string | null, body: unknown, query: PublishQuery) =>
      publish(actor, body, async (tx, files) => {
        const now = ctx.clock.now();
        const source = await sourceClaimOf(tx, actor, projectId, query.ticket, now, "an Artifact");
        return insertArtifact(
          tx,
          { workspaceId: actingUser(actor).workspaceId, projectId },
          { title: query.title!.trim(), actor, sourceTicketId: source?.ticketId ?? null, files, now },
        );
      });

    const createSchema = (where: string) => ({
      description: `Publishes a folder as a new Artifact of ${where}, at Version 1. ${publishRules}`,
      consumes: ARCHIVE_TYPES,
      body: { description: "The folder as a zip archive, or a tar archive gzipped or not." },
      querystring: { type: "object", required: ["title"], properties: { title: titleParam, ticket: ticketParam } },
      response: { 201: answer("The new Artifact", holding("artifact", "Artifact")), ...errors(400, 401, 403, 404, 409, 410, 413) },
    });

    app.post<{ Params: { key: string }; Querystring: PublishQuery }>(
      "/api/projects/:key/artifacts",
      { schema: { params: projectParams, ...createSchema("the Project") } },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "write");
        const artifact = await create(actor, project.id, request.body, request.query);
        return reply.code(201).send({ artifact: await shown(request, artifact) });
      },
    );

    app.post<{ Querystring: PublishQuery }>("/api/workspace/artifacts", { schema: createSchema("the Workspace, outside any Project") }, async (request, reply) => {
      const actor = await requireActor(ctx, request);
      await requireWorkspaceAccess(ctx.db, actor, "write");
      const artifact = await create(actor, null, request.body, request.query);
      return reply.code(201).send({ artifact: await shown(request, artifact) });
    });

    app.post<{ Params: { id: string }; Querystring: PublishQuery }>(
      "/api/artifacts/:id/versions",
      {
        schema: {
          description:
            "Publishes a folder as the Artifact's next Version, which its address then shows. `baseVersion` names the Version the publish is based on: " +
            `the publish is refused if a later one was published meanwhile, so merge with it and publish again. ${publishRules} An Agent can't publish a Protected Artifact.`,
          consumes: ARCHIVE_TYPES,
          params: artifactParams,
          body: { description: "The folder as a zip archive, or a tar archive gzipped or not." },
          querystring: {
            type: "object",
            required: ["baseVersion"],
            properties: {
              baseVersion: { type: "integer", minimum: 1, description: "The number of the Version this publish is based on; it must be the latest." },
              title: { ...titleParam, description: "The Artifact's new title; it keeps its title if left out." },
              ticket: ticketParam,
            },
          },
          response: {
            201: answer("The Artifact at its new Version", holding("artifact", "Artifact")),
            ...errors(400, 401, 403, 404, 410, 413),
            409: {
              description: "The publish is based on a Version that is no longer the latest (the answer names the latest), or names a Ticket whose Claim the Agent Session doesn't hold",
              anyOf: [ref("StaleArtifact"), ref("Error")],
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        await artifactFor(ctx.db, actor, request.params.id, "write");
        const artifact = await publish(actor, request.body, async (tx, files) => {
          const current = await artifactFor(tx, actor, request.params.id, "write", { forUpdate: true });
          requireUnprotected(actor, current, current.title, "publish new Versions of it");
          if (request.query.baseVersion !== current.version) {
            throw new HttpError(
              409,
              `This publish is based on Version ${request.query.baseVersion}, but "${current.title}" is at Version ${current.version}; merge with it and publish again`,
              { version: current.version },
            );
          }
          const now = ctx.clock.now();
          const source = await sourceClaimOf(tx, actor, current.projectId, request.query.ticket, now, "an Artifact");
          const title = request.query.title?.trim() ?? current.title;
          return insertArtifactVersion(tx, current, { title, actor, sourceTicketId: source?.ticketId ?? null, files, now });
        });
        return reply.code(201).send({ artifact: await shown(request, artifact) });
      },
    );

    const listSchema = (whose: string) => ({
      response: { 200: answer(`${whose} Artifacts, most recently published first`, listing("artifacts", ref("Artifact"))), ...errors(401, 403, 404, 410) },
    });

    app.get<{ Params: { key: string } }>("/api/projects/:key/artifacts", { schema: { params: projectParams, ...listSchema("The Project's") } }, async (request) => {
      const actor = await requireActor(ctx, request);
      const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
      const artifacts = await listArtifacts(ctx.db, { workspaceId: actingUser(actor).workspaceId, projectId: project.id });
      return { artifacts: await Promise.all(artifacts.map((a) => shown(request, a))) };
    });

    app.get("/api/workspace/artifacts", { schema: listSchema("The Workspace's, outside any Project,") }, async (request) => {
      const actor = await requireActor(ctx, request);
      await requireWorkspaceAccess(ctx.db, actor, "read");
      const artifacts = await listArtifacts(ctx.db, { workspaceId: actingUser(actor).workspaceId, projectId: null });
      return { artifacts: await Promise.all(artifacts.map((a) => shown(request, a))) };
    });

    app.get<{ Params: { id: string } }>(
      "/api/artifacts/:id",
      {
        schema: {
          params: artifactParams,
          response: { 200: answer("The Artifact at its latest Version, with its Versions and where to frame it", holding("artifact", "Artifact")), ...errors(401, 404, 410) },
        },
      },
      async (request) => {
        const artifact = await artifactFor(ctx.db, await requireActor(ctx, request), request.params.id, "read");
        return { artifact: await shown(request, artifact, { versions: true }) };
      },
    );

    app.get<{ Params: { id: string; number: string } }>(
      "/api/artifacts/:id/versions/:number",
      {
        schema: {
          params: versionParams,
          response: { 200: answer("The Version, with its files and where to frame it", holding("version", "ArtifactVersion")), ...errors(401, 404, 410) },
        },
      },
      async (request) => {
        const artifact = await artifactFor(ctx.db, await requireActor(ctx, request), request.params.id, "read");
        const version = await findArtifactVersion(ctx.db, artifact.id, Number(request.params.number));
        if (!version) throw new HttpError(404, "No such Version");
        const files = await listArtifactFiles(ctx.db, artifact.id, version.number);
        return {
          version: {
            ...publicVersion(artifact, version, cronkOrigin(ctx, request)),
            frameUrl: await frameUrl(ctx, request, ctx.db, artifact.workspaceId, artifact.id, version.number),
            files: files.map((f) => ({ path: f.path, contentType: f.contentType, size: f.size })),
          },
        };
      },
    );

    app.post<{ Params: { id: string }; Body: { protected: boolean } }>(
      "/api/artifacts/:id/protection",
      {
        schema: {
          params: artifactParams,
          body: protectionBody,
          response: { 200: answer("The Artifact marked Protected or unmarked", holding("artifact", "Artifact")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const artifact = await transaction(ctx.db, async (tx) => {
          const artifact = await artifactFor(tx, actor, request.params.id, "write", { forUpdate: true });
          requireUserActor(actor, "mark an Artifact Protected or unmark it");
          await setProtected(tx, { kind: "artifact", id: artifact.id }, request.body.protected, actor.user.id, ctx.clock.now());
          return { ...artifact, protected: request.body.protected };
        });
        return { artifact: await shown(request, artifact) };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/artifacts/:id/protection",
      { schema: { params: artifactParams, response: { 200: protectionHistoryAnswer, ...errors(401, 404, 410) } } },
      async (request) => {
        const artifact = await artifactFor(ctx.db, await requireActor(ctx, request), request.params.id, "read");
        return { markings: await listProtectionMarkings(ctx.db, { kind: "artifact", id: artifact.id }) };
      },
    );
  };
}

/**
 * The Artifact with this id, if `actor` has at least `need` where it belongs: in its Project (one they can't see
 * answers 404, as if the Artifact didn't exist), or in the Workspace.
 */
export async function artifactFor(db: Queryable, actor: Actor, id: string, need: Access, opts: { forUpdate?: boolean } = {}): Promise<Artifact> {
  const artifact = await findArtifact(db, actingUser(actor).workspaceId, id, opts);
  if (!artifact) throw new HttpError(404, "No such Artifact");
  if (artifact.projectId === null) await requireWorkspaceAccess(db, actor, need);
  else await requireProjectAccess(db, actor, (await findProjectById(db, artifact.projectId))!, need, "No such Artifact");
  return artifact;
}

/** An Artifact's address in Cronk, which shows its latest Version, or with `version`, that Version. */
export const artifactAddress = (origin: string, id: string, version?: number) => `${origin}/artifacts/${id}${version === undefined ? "" : `?version=${version}`}`;

/** What the API answers for an Artifact, without its Versions. */
export function publicArtifact(a: Artifact, origin: string) {
  return {
    id: a.id,
    title: a.title,
    projectKey: a.projectKey,
    version: a.version,
    protected: a.protected,
    url: artifactAddress(origin, a.id),
    versionUrl: artifactAddress(origin, a.id, a.version),
    publishedBy: a.latest.actor,
    sourceTicket: a.latest.sourceTicket,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** What the API answers for one Version of an Artifact, without its files. */
export function publicVersion(a: Artifact, v: ArtifactVersion, origin: string) {
  return {
    number: v.number,
    title: v.title,
    at: v.at,
    actor: v.actor,
    sourceTicket: v.sourceTicket,
    fileCount: v.files,
    size: v.size,
    url: artifactAddress(origin, a.id, v.number),
  };
}

/** A folder fit to publish: unwrapped, holding `index.html` at its top, and within the Workspace's limits; otherwise a 400 or 413 saying why. */
function checkedFolder(raw: Folder, limits: { artifactMaxBytes: number; artifactMaxFiles: number }): Folder {
  const folder = unwrapFolder(raw);
  if (!folder.has("index.html")) throw new HttpError(400, "An Artifact's folder must hold index.html at its top, the page it opens on");
  if (folder.size > limits.artifactMaxFiles) {
    throw new HttpError(413, `This folder holds ${folder.size} files, more than the ${limits.artifactMaxFiles} an Artifact Version may hold in this Workspace`);
  }
  const bytes = [...folder.values()].reduce((sum, contents) => sum + bytesOf(contents).length, 0);
  if (bytes > limits.artifactMaxBytes) {
    throw new HttpError(413, `This folder's files take ${formatBytes(bytes)}, more than the ${formatBytes(limits.artifactMaxBytes)} an Artifact Version may take in this Workspace`);
  }
  return folder;
}


/** Media types by file extension, for the files a page loads; anything else is served as bytes, which a browser won't run. */
const MEDIA_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  wasm: "application/wasm",
  pdf: "application/pdf",
};

/** The media type a file in an Artifact is served with, by its extension. */
export const mediaTypeOf = (path: string): string => MEDIA_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
