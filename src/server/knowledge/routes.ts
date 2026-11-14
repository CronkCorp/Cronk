import type { FastifyInstance } from "fastify";
import { actingUser, type Actor } from "../actor.js";
import { HttpError, requireActor, type AppContext } from "../context.js";
import { transaction, type Queryable } from "../db/database.js";
import { requireProjectAccess, requireWorkspaceAccess, type Access } from "../identity/access.js";
import { answer, documentIdParam, errors, holding, pathParams, projectKeyParam, ref } from "../schemas.js";
import { findProjectById } from "../work/projects.js";
import { projectFor } from "../work/routes.js";
import { findDocument, findVersion, insertDocument, saveVersion, type Document, type Tree } from "./documents.js";

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

const projectParams = pathParams({ key: projectKeyParam });
const documentParams = pathParams({ id: documentIdParam });

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
  };
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
