import type { FastifyInstance } from "fastify";
import { actingUser, type Actor } from "../actor.js";
import { HttpError, requireActor, type AppContext } from "../context.js";
import { transaction, type Queryable } from "../db/database.js";
import { requireProjectAccess, requireWorkspaceAccess, type Access } from "../identity/access.js";
import { answer, documentIdParam, errors, holding, listing, pathParams, projectKeyParam, ref } from "../schemas.js";
import { findProjectById } from "../work/projects.js";
import { projectFor } from "../work/routes.js";
import { findDocument, findVersion, insertDocument, listTree, listVersions, saveVersion, type Document, type Tree, type Version } from "./documents.js";

/** A Document title: non-blank, at most 500 characters. */
const title = { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } as const;
/** A Document's Markdown. */
const body = { type: "string", maxLength: 1_000_000 } as const;

/** The Version a save is based on; it must be the Document's current one (ADR 0009). */
const baseVersion = {
  type: "integer",
  minimum: 1,
  description: "The number of the Version this save is based on. The save is refused if it is no longer the current Version.",
} as const;

const staleVersionAnswer = {
  description: "The save is based on a Version that is no longer current; the answer carries the current Version",
  ...ref("StaleVersion"),
};

/** A page tree: its Documents depth first, each followed by those under it. */
const treeAnswer = listing("documents", {
  type: "object",
  required: ["id", "parentId", "title", "depth"],
  properties: {
    id: { type: "string", format: "uuid" },
    parentId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
    title: { type: "string" },
    depth: { type: "integer", description: "How deep it sits: 0 at the top." },
  },
});

const projectParams = pathParams({ key: projectKeyParam });
const documentParams = pathParams({ id: documentIdParam });
const versionParams = pathParams({
  id: documentIdParam,
  number: { type: "string", pattern: "^[1-9][0-9]{0,8}$", description: "The Version's number, counting from 1." },
});

interface NewDocument {
  title: string;
  body?: string;
  parentId?: string | null;
}

const newDocumentBody = {
  type: "object",
  required: ["title"],
  additionalProperties: false,
  properties: {
    title,
    body,
    parentId: { type: ["string", "null"], format: "uuid", description: "The Document to put it under; at the top if left out." },
  },
} as const;

export function knowledgeRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    /** Creates a Document in `tree`, which the caller has Write in. */
    const create = async (tx: Queryable, actor: Actor, tree: Tree, input: NewDocument) => {
      const parentId = input.parentId ?? null;
      if (parentId !== null) {
        const parent = await findDocument(tx, tree.workspaceId, parentId);
        if (!parent || parent.projectId !== tree.projectId) throw new HttpError(400, "The parent must be a Document of the same page tree");
      }
      return insertDocument(tx, { tree, parentId, title: input.title.trim(), body: input.body ?? "", actor, now: ctx.clock.now() });
    };

    app.get<{ Params: { key: string } }>(
      "/api/projects/:key/documents",
      {
        schema: {
          params: projectParams,
          response: { 200: answer("The Project's page tree", treeAnswer), ...errors(401, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
        return { documents: await listTree(ctx.db, { workspaceId: actingUser(actor).workspaceId, projectId: project.id }) };
      },
    );

    app.get(
      "/api/workspace/documents",
      { schema: { response: { 200: answer("The Workspace's page tree", treeAnswer), ...errors(401, 403, 410) } } },
      async (request) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "read");
        return { documents: await listTree(ctx.db, { workspaceId: actingUser(actor).workspaceId, projectId: null }) };
      },
    );

    app.post<{ Body: NewDocument }>(
      "/api/workspace/documents",
      {
        schema: {
          body: newDocumentBody,
          response: {
            201: answer("The new Workspace Document at Version 1, last among its siblings", holding("document", "Document")),
            ...errors(400, 401, 403, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "write");
        const tree = { workspaceId: actingUser(actor).workspaceId, projectId: null };
        const document = await transaction(ctx.db, (tx) => create(tx, actor, tree, request.body));
        return reply.code(201).send({ document });
      },
    );

    app.post<{ Params: { key: string }; Body: NewDocument }>(
      "/api/projects/:key/documents",
      {
        schema: {
          params: projectParams,
          body: newDocumentBody,
          response: {
            201: answer("The new Document at Version 1, last among its siblings", holding("document", "Document")),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const document = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, actor, request.params.key, "write");
          return create(tx, actor, { workspaceId: actingUser(actor).workspaceId, projectId: project.id }, request.body);
        });
        return reply.code(201).send({ document });
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/documents/:id",
      {
        schema: {
          params: documentParams,
          response: { 200: answer("The Document at its current Version", holding("document", "Document")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        return { document: await documentFor(ctx.db, actor, request.params.id, "read") };
      },
    );

    app.patch<{ Params: { id: string }; Body: { baseVersion: number; title?: string; body?: string } }>(
      "/api/documents/:id",
      {
        schema: {
          params: documentParams,
          body: {
            type: "object",
            required: ["baseVersion"],
            additionalProperties: false,
            properties: { baseVersion, title, body },
          },
          response: {
            200: answer("The Document at its new Version; unchanged if the save changed nothing", holding("document", "Document")),
            ...errors(400, 401, 403, 404, 410),
            409: staleVersionAnswer,
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const document = await transaction(ctx.db, async (tx) => {
          const current = await documentFor(tx, actor, request.params.id, "write", { forUpdate: true });
          await requireCurrent(tx, current, request.body.baseVersion);
          return saveVersion(tx, current, {
            title: request.body.title?.trim() ?? current.title,
            body: request.body.body ?? current.body,
            actor,
            now: ctx.clock.now(),
          });
        });
        return { document };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/documents/:id/versions",
      {
        schema: {
          params: documentParams,
          response: {
            200: answer("The Document's Versions, newest first, without their bodies", listing("versions", ref("VersionSummary"))),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const document = await documentFor(ctx.db, actor, request.params.id, "read");
        return { versions: await listVersions(ctx.db, document.id) };
      },
    );

    app.get<{ Params: { id: string; number: string } }>(
      "/api/documents/:id/versions/:number",
      {
        schema: {
          params: versionParams,
          response: { 200: answer("The Version, with its body", holding("version", "Version")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const document = await documentFor(ctx.db, actor, request.params.id, "read");
        return { version: await versionOr404(ctx.db, document, request.params.number) };
      },
    );

    app.post<{ Params: { id: string; number: string }; Body: { baseVersion: number } }>(
      "/api/documents/:id/versions/:number/restore",
      {
        schema: {
          params: versionParams,
          body: { type: "object", required: ["baseVersion"], additionalProperties: false, properties: { baseVersion } },
          response: {
            200: answer("The Document at a new Version holding the restored Version's title and body", holding("document", "Document")),
            ...errors(400, 401, 403, 404, 410),
            409: staleVersionAnswer,
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const document = await transaction(ctx.db, async (tx) => {
          const current = await documentFor(tx, actor, request.params.id, "write", { forUpdate: true });
          const earlier = await versionOr404(tx, current, request.params.number);
          await requireCurrent(tx, current, request.body.baseVersion);
          return saveVersion(tx, current, { title: earlier.title, body: earlier.body, actor, now: ctx.clock.now(), restoredFrom: earlier.number });
        });
        return { document };
      },
    );
  };
}

async function versionOr404(db: Queryable, document: Document, number: string): Promise<Version> {
  const version = await findVersion(db, document.id, Number(number));
  if (!version) throw new HttpError(404, "No such Version");
  return version;
}

/** Refuses a save based on a Version that is no longer current, answering with the current Version. */
async function requireCurrent(db: Queryable, document: Document, baseVersion: number): Promise<void> {
  if (baseVersion === document.version) return;
  const current = (await findVersion(db, document.id, document.version))!;
  throw new HttpError(
    409,
    `This save is based on Version ${baseVersion}, but the Document is at Version ${document.version}; merge with it and save again`,
    { current },
  );
}

/**
 * The Document with this id, if `actor` has at least `need` where it belongs: in its
 * Project (one they can't see answers 404, as if the Document didn't exist), or in the
 * Workspace for a Workspace Document.
 */
async function documentFor(db: Queryable, actor: Actor, id: string, need: Access, opts: { forUpdate?: boolean } = {}): Promise<Document> {
  const document = await findDocument(db, actingUser(actor).workspaceId, id, opts);
  if (!document) throw new HttpError(404, "No such Document");
  if (document.projectId === null) {
    await requireWorkspaceAccess(db, actor, need);
  } else {
    await requireProjectAccess(db, actor, (await findProjectById(db, document.projectId))!, need, "No such Document");
  }
  return document;
}
