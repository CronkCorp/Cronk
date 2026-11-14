import type { FastifyInstance } from "fastify";
import { actingUser } from "../actor.js";
import { requireActor, type AppContext } from "../context.js";
import { transaction } from "../db/database.js";
import { projectFor, requireWorkspaceAccess } from "../identity/access.js";
import { answer, errors, listing, pathParams, projectKeyParam, ref } from "../schemas.js";
import { unpackFolder } from "./archive.js";
import { importMarkdownFolder } from "./markdown-folder.js";

/** The media types an uploaded archive may come as. */
const ARCHIVE_TYPES = ["application/gzip", "application/x-gzip", "application/x-tar", "application/x-compressed-tar", "application/octet-stream"];
/** The largest archive an import takes. */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

const archiveUpload =
  "The request body is the folder as a tar archive, gzipped (`tar czf`) or not, sent as `application/gzip`, `application/x-tar` or `application/octet-stream`.";

const importedAnswer = answer(
  "The Documents created, depth first, each followed by those under it; they go at the top of the page tree, after the Documents already there",
  listing("documents", ref("DocumentTreeEntry")),
);

/**
 * Portability (ADR 0003): exporting the Workspace or a Project as a folder of Markdown files with
 * YAML frontmatter, importing such an export, and importing a plain folder of Markdown files as Documents.
 */
export function portabilityRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // Archives arrive as raw bytes; this parser applies only to the routes registered here.
    app.addContentTypeParser(ARCHIVE_TYPES, { parseAs: "buffer", bodyLimit: MAX_ARCHIVE_BYTES }, (_request, body, done) => done(null, body));

    app.post(
      "/api/workspace/documents/import",
      {
        bodyLimit: MAX_ARCHIVE_BYTES,
        schema: {
          description: `Imports a folder of Markdown files as Workspace Documents: each file becomes a Document and each folder one too, with what it holds under it. ${IMPORT_RULES} ${archiveUpload}`,
          response: { 201: importedAnswer, ...errors(400, 401, 403, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "write");
        const folder = await unpackFolder(archiveBody(request.body));
        const tree = { workspaceId: actingUser(actor).workspaceId, projectId: null };
        const documents = await transaction(ctx.db, (tx) => importMarkdownFolder(tx, tree, folder, actor, ctx.clock.now()));
        return reply.code(201).send({ documents });
      },
    );

    app.post<{ Params: { key: string } }>(
      "/api/projects/:key/documents/import",
      {
        bodyLimit: MAX_ARCHIVE_BYTES,
        schema: {
          description: `Imports a folder of Markdown files as Documents of the Project: each file becomes a Document and each folder one too, with what it holds under it. ${IMPORT_RULES} ${archiveUpload}`,
          params: pathParams({ key: projectKeyParam }),
          response: { 201: importedAnswer, ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const folder = await unpackFolder(archiveBody(request.body));
        const documents = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, actor, request.params.key, "write");
          const tree = { workspaceId: actingUser(actor).workspaceId, projectId: project.id };
          return importMarkdownFolder(tx, tree, folder, actor, ctx.clock.now());
        });
        return reply.code(201).send({ documents });
      },
    );
  };
}

const IMPORT_RULES =
  "A file is titled by its frontmatter's `title`, else by a `#` heading on its first line, else by its name; frontmatter is left out of the body. " +
  "A folder's `README.md` or `index.md`, or a file named like it beside it, is the folder's own Document; a folder without one becomes an empty Document named after it. " +
  "Files and folders are ordered by name, numbers counting as numbers. Files other than Markdown (`.md`, `.markdown`) and hidden ones are skipped, " +
  "and a single folder holding everything (as archiving a folder adds) is unwrapped.";

/** The uploaded archive; a body sent as JSON or text isn't one. */
function archiveBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  return Buffer.alloc(0);
}
