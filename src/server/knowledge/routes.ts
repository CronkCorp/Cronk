import type { FastifyInstance } from "fastify";
import { actingUser, type Actor } from "../actor.js";
import { HttpError, requireActor, type AppContext } from "../context.js";
import { transaction, type Queryable } from "../db/database.js";
import { projectFor, requireProjectAccess, requireWorkspaceAccess, type Access } from "../identity/access.js";
import { answer, documentIdParam, errors, holding, listing, noContent, pathParams, projectKeyParam, ref } from "../schemas.js";
import { findProjectById } from "../work/projects.js";
import { deleteDocument, findDocument, findVersion, insertDocument, listTree, listVersions, moveDocument, saveVersion, type Document, type Tree, type Version } from "./documents.js";
import { headingsIn, mergeEdits, replaceSection, type SectionRefusal } from "./sections.js";

/** A Document title: non-blank, at most 500 characters. */
const title = { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } as const;
/** A Document's Markdown. */
const body = { type: "string", maxLength: 1_000_000 } as const;

/** The Version a save or delete is based on; it must be the Document's current one (ADR 0009). */
const baseVersion = {
  type: "integer",
  minimum: 1,
  description: "The number of the Version this write is based on. The write is refused if it is no longer the current Version.",
} as const;

const staleVersionAnswer = {
  description: "The save is based on a Version that is no longer current; the answer carries the current Version",
  ...ref("StaleVersion"),
};

/** A page tree: its Documents depth first, each followed by those under it. */
const treeAnswer = listing("documents", ref("DocumentTreeEntry"));

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
      const created = await insertDocument(tx, { tree, parentId, title: input.title.trim(), body: input.body ?? "", actor, now: ctx.clock.now() });
      if (created === "no such parent") throw notInTree();
      return created;
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
        return { documents: await listTree(ctx.db, treeFor(actor, project.id)) };
      },
    );

    app.get(
      "/api/workspace/documents",
      { schema: { response: { 200: answer("The Workspace's page tree", treeAnswer), ...errors(401, 403, 410) } } },
      async (request) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "read");
        return { documents: await listTree(ctx.db, treeFor(actor, null)) };
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
        const document = await transaction(ctx.db, (tx) => create(tx, actor, treeFor(actor, null), request.body));
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
          return create(tx, actor, treeFor(actor, project.id), request.body);
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
          await requireCurrent(tx, current, request.body.baseVersion, "save");
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

    app.post<{ Params: { id: string }; Body: { baseVersion: number; heading: string; body: string } }>(
      "/api/documents/:id/replace-section",
      {
        schema: {
          params: documentParams,
          body: {
            type: "object",
            required: ["baseVersion", "heading", "body"],
            additionalProperties: false,
            properties: {
              baseVersion,
              heading: {
                type: "string",
                minLength: 1,
                maxLength: 500,
                pattern: "\\S",
                description: "The section's heading text, such as `Setup`; put its `#` marks first, such as `## Setup`, to pick one of several headings with that text.",
              },
              body: {
                ...body,
                description:
                  "The Markdown to put under the heading, replacing everything down to the next heading of the same or a higher level; the heading itself stays. " +
                  "It may hold lower-level headings, but none of the section's level or higher, and must close any code block it opens.",
              },
            },
          },
          response: {
            200: answer("The Document at its new Version; unchanged if the replacement changed nothing", holding("document", "Document")),
            ...errors(401, 403, 410),
            400: {
              description:
                "The request is invalid: several sections have that heading (the Document's headings are listed), or the new body would end the section or leave a code block open",
              ...ref("SectionRefused"),
            },
            404: { description: "There is no such Document, or it has no section with that heading, in which case its headings are listed", ...ref("SectionRefused") },
            409: staleVersionAnswer,
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const document = await transaction(ctx.db, async (tx) => {
          const current = await documentFor(tx, actor, request.params.id, "write", { forUpdate: true });
          await requireCurrent(tx, current, request.body.baseVersion, "save");
          const replaced = replaceSection(current.body, request.body.heading, request.body.body);
          if (typeof replaced !== "string") throw sectionRefused(current, request.body.heading, replaced);
          return saveVersion(tx, current, { title: current.title, body: replaced, actor, now: ctx.clock.now() });
        });
        return { document };
      },
    );

    app.post<{ Params: { id: string }; Body: { baseVersion: number; title?: string; body?: string } }>(
      "/api/documents/:id/merge",
      {
        schema: {
          params: documentParams,
          body: {
            type: "object",
            required: ["baseVersion"],
            additionalProperties: false,
            properties: {
              baseVersion: { ...baseVersion, description: "The number of the Version the edit started from." },
              title: { ...title, description: "The edited title; the base Version's if left out." },
              body: { ...body, description: "The edited Markdown; the base Version's if left out." },
            },
          },
          response: {
            200: answer("The edit merged section by section with the current Version; nothing is saved", holding("merge", "Merge")),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const document = await documentFor(ctx.db, actor, request.params.id, "read");
        const base = await requireVersion(ctx.db, document, String(request.body.baseVersion));
        const onto = (await findVersion(ctx.db, document.id, document.version))!;
        const mine = { title: request.body.title?.trim() ?? base.title, body: request.body.body ?? base.body };
        return { merge: { onto, ...mergeEdits(base, mine, onto) } };
      },
    );

    app.post<{ Params: { id: string }; Body: { parentId: string | null; position?: number } }>(
      "/api/documents/:id/move",
      {
        schema: {
          params: documentParams,
          body: {
            type: "object",
            required: ["parentId"],
            additionalProperties: false,
            properties: {
              parentId: { type: ["string", "null"], format: "uuid", description: "The Document to put it under, in the same page tree; null for the top." },
              position: { type: "integer", minimum: 0, description: "Its place among its new siblings, counted from 0; last if left out." },
            },
          },
          response: {
            200: answer("The Document in its new place, at the same Version", holding("document", "Document")),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { parentId, position } = request.body;
        const document = await transaction(ctx.db, async (tx) => {
          const document = await documentFor(tx, actor, request.params.id, "write");
          const moved = await moveDocument(tx, treeFor(actor, document.projectId), document, { parentId, position });
          if (moved === "a report") throw new HttpError(400, "A Report lives with its Ticket, outside the page tree, so it can't be moved");
          if (moved === "no such parent") throw notInTree();
          if (moved === "under itself") throw new HttpError(409, "A Document can't move under itself or a Document under it");
          if (moved === "no such position") throw new HttpError(400, `There is no position ${position} among those Documents`);
          return moved;
        });
        return { document };
      },
    );

    app.delete<{ Params: { id: string }; Querystring: { baseVersion: number } }>(
      "/api/documents/:id",
      {
        schema: {
          params: documentParams,
          querystring: {
            type: "object",
            required: ["baseVersion"],
            properties: { baseVersion },
          },
          response: {
            204: noContent("The Document and its Versions are deleted"),
            ...errors(400, 401, 403, 404, 410),
            409: {
              description:
                "The delete is based on a Version that is no longer current, and the answer carries the current Version; or the Document has Documents under it",
              anyOf: [ref("StaleVersion"), ref("Error")],
            },
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        await transaction(ctx.db, async (tx) => {
          const document = await documentFor(tx, actor, request.params.id, "write", { forUpdate: true });
          await requireCurrent(tx, document, request.query.baseVersion, "delete");
          if (!(await deleteDocument(tx, treeFor(actor, document.projectId), document))) {
            throw new HttpError(409, `${document.title} has Documents under it; move or delete them first`);
          }
        });
        return reply.code(204).send();
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
        return { version: await requireVersion(ctx.db, document, request.params.number) };
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
          const earlier = await requireVersion(tx, current, request.params.number);
          await requireCurrent(tx, current, request.body.baseVersion, "save");
          return saveVersion(tx, current, { title: earlier.title, body: earlier.body, actor, now: ctx.clock.now(), restoredFrom: earlier.number });
        });
        return { document };
      },
    );
  };
}

/** The page tree of a Project in the Actor's Workspace, or the Workspace's own with a null `projectId`. */
const treeFor = (actor: Actor, projectId: string | null): Tree => ({ workspaceId: actingUser(actor).workspaceId, projectId });

/** Refuses a section replacement, listing the Document's headings so the caller can pick one. */
function sectionRefused(document: Document, heading: string, refusal: SectionRefusal): HttpError {
  const headings = headingsIn(document.body);
  if (refusal.refused === "open code block") {
    return new HttpError(400, "The new body leaves a code block open, which would swallow the rest of the Document; close it");
  }
  if (refusal.refused === "ends the section") {
    return new HttpError(
      400,
      `The new body has the heading “${refusal.heading}”, which would end the section “${heading.trim()}” and start another; use update to change more than one section`,
    );
  }
  if (refusal.refused === "ambiguous") {
    return new HttpError(400, `${refusal.matches} sections of ${document.title} are headed “${heading.trim()}”; put the heading's # marks first to pick one`, { headings });
  }
  return new HttpError(404, `${document.title} has no section headed “${heading.trim()}”`, { headings });
}

const notInTree = () => new HttpError(400, "The parent must be a Document of the same page tree");

/** One of a Document's Versions by its number in the path; a 404 if it has no such Version. */
async function requireVersion(db: Queryable, document: Document, number: string): Promise<Version> {
  const version = await findVersion(db, document.id, Number(number));
  if (!version) throw new HttpError(404, "No such Version");
  return version;
}

/** What to do after a write is refused as stale, by the kind of write. */
const AFTER_STALE = { save: "merge with it and save again", delete: "read it and delete again if you still mean to" } as const;

/** Refuses a save or delete based on a Version that is no longer current, answering with the current Version. */
async function requireCurrent(db: Queryable, document: Document, baseVersion: number, write: keyof typeof AFTER_STALE): Promise<void> {
  if (baseVersion === document.version) return;
  const current = (await findVersion(db, document.id, document.version))!;
  throw new HttpError(
    409,
    `This ${write} is based on Version ${baseVersion}, but the Document is at Version ${document.version}; ${AFTER_STALE[write]}`,
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
