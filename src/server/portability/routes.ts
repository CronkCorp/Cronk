import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actingUser } from "../actor.js";
import { HttpError, requireActor, requireUser, type AppContext } from "../context.js";
import { transaction, type Queryable } from "../db/database.js";
import { projectFor, requireAdmin, requireWorkspaceAccess } from "../identity/access.js";
import { termsChanged } from "../knowledge/term-routes.js";
import { answer, errors, listing, pathParams, projectKeyParam, ref } from "../schemas.js";
import { getWorkspace } from "../workspace/workspaces.js";
import { isExportMarkdown, streamedFileLimit } from "./streamed-files.js";
import { ARCHIVE_TYPES, MAX_PACKED_BYTES, archiveBody, checkStoredFiles, packFolderStream, unpackFolder, unpackFolderStream, type StoredFolder } from "./archive.js";
import { exportDecisionsFolder, exportFolder } from "./export.js";
import { importExport } from "./import.js";
import { importMarkdownFolder } from "./markdown-folder.js";
import { listRenamedIds } from "./renamed-ids.js";


/** The request body of an import: an archive, which the content-type parser hands over as bytes (so it has no type to check). */
const archiveBodySchema = { description: "The folder as a zip archive, or a tar archive gzipped or not." };

const archiveUpload =
  "The request body is the folder as a zip archive, or a tar archive gzipped (`tar czf`) or not, sent as `application/zip`, `application/gzip`, " +
  "`application/x-tar` or `application/octet-stream`.";

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
    exportRoutes(app, ctx);
    decisionExportRoutes(app, ctx);
    // An export's archive is read as it streams in, its large files going straight into the file store; these parsers apply only to the routes registered with them.
    await app.register(async (streamed) => {
      streamed.addContentTypeParser(ARCHIVE_TYPES, (_request, payload, done) => done(null, payload));
      importRoute(streamed, ctx);
    });
    // A folder of Markdown files arrives as raw bytes, held whole.
    await app.register(async (buffered) => {
      buffered.addContentTypeParser(ARCHIVE_TYPES, { parseAs: "buffer", bodyLimit: MAX_PACKED_BYTES }, (_request, body, done) => done(null, body));
      markdownImportRoutes(buffered, ctx);
    });
  };
}

/** Exporting the Workspace or one Project. */
function exportRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Answers with the export of the Workspace, or of one Project, as a gzipped tar archive to save. */
  const sendExport = (reply: FastifyReply, workspaceId: string, project: { id: string; key: string } | null, versions: boolean) =>
    sendArchive(ctx, reply, project?.key ?? "workspace", (tx, now) => exportFolder(tx, { workspaceId, projectId: project?.id ?? null, versions, now }));

  app.get<{ Querystring: { versions?: boolean } }>(
    "/api/export",
    {
      schema: {
        description: `Exports the whole Workspace: its settings, Users and Agents, Guidance, Documents and every Project with its Tickets. ${EXPORT_FORMAT}`,
        querystring: versionsQuery,
        response: { 200: exportAnswer, ...errors(401, 403, 410) },
      },
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request);
      requireAdmin(user, "export the Workspace");
      return sendExport(reply, user.workspaceId, null, request.query.versions ?? true);
    },
  );

  app.get<{ Params: { key: string }; Querystring: { versions?: boolean } }>(
    "/api/projects/:key/export",
    {
      schema: {
        description: `Exports one Project: its settings, Statuses, members, Guidance, Documents and Tickets, and the Users and Agents they name. ${EXPORT_FORMAT}`,
        params: pathParams({ key: projectKeyParam }),
        querystring: versionsQuery,
        response: { 200: exportAnswer, ...errors(401, 403, 404, 410) },
      },
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request);
      requireAdmin(user, "export a Project");
      const { project } = await projectFor(ctx.db, { kind: "user", user }, request.params.key, "read");
      return sendExport(reply, user.workspaceId, project, request.query.versions ?? true);
    },
  );
}

/** Downloading one scope's Decisions as a `docs/adr/` folder, for anyone who can read them. */
function decisionExportRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Answers with the Decisions of the Workspace (project null) or a Project, as a gzipped tar archive to save. */
  const sendDecisions = (reply: FastifyReply, workspaceId: string, project: { id: string; key: string } | null) =>
    sendArchive(ctx, reply, `${project?.key ?? "workspace"}-adr`, (tx, now) => exportDecisionsFolder(tx, workspaceId, project, now));

  app.get(
    "/api/workspace/decisions/export",
    {
      schema: {
        description: `Exports the Workspace's own Decisions, those in no Project, as a \`docs/adr/\` folder. ${DECISIONS_EXPORT_FORMAT}`,
        response: { 200: decisionsExportAnswer, ...errors(401, 403, 410) },
      },
    },
    async (request, reply) => {
      const actor = await requireActor(ctx, request);
      await requireWorkspaceAccess(ctx.db, actor, "read");
      return sendDecisions(reply, actingUser(actor).workspaceId, null);
    },
  );

  app.get<{ Params: { key: string } }>(
    "/api/projects/:key/decisions/export",
    {
      schema: {
        description: `Exports one Project's Decisions as a \`docs/adr/\` folder. ${DECISIONS_EXPORT_FORMAT}`,
        params: pathParams({ key: projectKeyParam }),
        response: { 200: decisionsExportAnswer, ...errors(401, 403, 404, 410) },
      },
    },
    async (request, reply) => {
      const actor = await requireActor(ctx, request);
      const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
      return sendDecisions(reply, actingUser(actor).workspaceId, project);
    },
  );
}

/**
 * Answers with the folder `build` makes as a gzipped tar archive to save, named `cronk-<name>-<stamp>.tar.gz`.
 * It is built in a read-only, repeatable-read transaction so its files agree with each other, and streamed: the files
 * of Attachments and Artifacts are read from the file store only as the archive reaches them. Each of those is checked
 * first, so a file missing or the wrong size is answered with an error rather than a 200 and an archive cut short; one
 * that fails after the check, removed meanwhile, aborts the download.
 */
async function sendArchive(ctx: AppContext, reply: FastifyReply, name: string, build: (tx: Queryable, now: Date) => Promise<StoredFolder>) {
  const now = ctx.clock.now();
  const folder = await transaction(ctx.db, async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return build(tx, now);
  });
  await checkStoredFiles(folder, ctx.files).catch((err: unknown) => {
    // A file the records name but the store lacks, or holds at another size, is for an operator to look into; other errors are logged as any are.
    if (err instanceof HttpError) reply.log.error(err);
    throw err;
  });
  const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  return reply
    .header("content-type", "application/gzip")
    .header("content-disposition", `attachment; filename="cronk-${name}-${stamp}.tar.gz"`)
    .send(packFolderStream(folder, ctx.files));
}

/** Importing an export. */
function importRoute(app: FastifyInstance, ctx: AppContext) {
  app.post(
    "/api/import",
    {
      schema: {
        consumes: ARCHIVE_TYPES,
        body: archiveBodySchema,
        description:
          "Imports an export made by GET /api/export or GET /api/projects/{key}/export, all of it or nothing. A Workspace export goes into a Workspace " +
          "with no Projects, Documents or Guidance yet, as in a fresh installation; a Project export becomes a new Project, refused if its key is taken. " +
          "Users are matched by email and Agents by Owner and name; Users not found are created deactivated, since they have no password here, until an Admin invites them and they accept, " +
          "and Agents not found are created without tokens. Agents and Agent Sessions keep their ids, unless an id is already taken here: then they get a new one, " +
          "and the import answers and keeps which id became which (GET /api/import/renamed-ids). Relations to Tickets outside the export are left out. " +
          "The archive is read as it streams in. Its Markdown files may take up to 200 MB packed and 512 MB unpacked; every other file, such as an Attachment's, " +
          "is streamed into storage and may be as large as the Workspace allows an Attachment (or an Artifact Version) to be, under the export's own workspace.md limits " +
          "for a Workspace export. A file over its limit refuses the import with a 413 naming it. " +
          "On top of those, one import may write at most what the server's IMPORT_MAX_BYTES allows (50 GiB by default), counting a zip archive, which is " +
          "written to a temporary file before it is read, and every file streamed into storage; an archive larger than that is refused with a 413 as soon as it crosses it. " +
          archiveUpload,
        response: {
          201: answer("What the import brought in", {
            type: "object",
            required: ["scope", "projects", "renamedIds"],
            properties: {
              scope: { type: "string", enum: ["workspace", "project"], description: "Whether it was a Workspace or a Project export." },
              projects: { type: "array", items: { type: "string" }, description: "The keys of the Projects it created." },
              renamedIds: { type: "array", items: ref("RenamedId"), description: "The Agents and Agent Sessions it gave new ids, because their ids were taken." },
            },
          }),
          ...errors(400, 401, 403, 409, 410, 413),
        },
      },
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request);
      requireAdmin(user, "import an export");
      const body = archiveStream(request.body);
      const workspace = await getWorkspace(ctx.db, user.workspaceId);
      // The keys of the files the import streams in, held there until moved to their places, and of those places, so
      // none stays if it fails at any point: unpacking, a refused value, the commit or a dropped connection.
      const importId = randomUUID();
      const temporary: string[] = [];
      const stored: string[] = [];
      try {
        const folder = await unpackFolderStream(body, {
          store: ctx.files,
          temporaryKey: () => {
            const key = `imports/${importId}/${temporary.length + 1}`;
            temporary.push(key);
            return key;
          },
          isMarkdown: isExportMarkdown,
          limit: (path, markdown) => streamedFileLimit(path, markdown, workspace),
          importMaxBytes: ctx.importMaxBytes,
        });
        const { imported, termPlaces } = await transaction(ctx.db, (tx) => importExport(tx, user.workspaceId, folder, ctx.clock.now(), { store: ctx.files, stored }));
        // Committed now: Terms pages already open learn of the imported Terms, which may override Workspace Terms.
        for (const place of termPlaces) termsChanged(ctx.live, place);
        return reply.code(201).send(imported);
      } catch (err) {
        // A refusal can come before the whole archive has arrived, which is then left unread: the connection closes once answered.
        if (!request.raw.complete) reply.header("connection", "close");
        await removeFiles(request, ctx, stored);
        // The database refusing a value (a constraint or a malformed value) means the export holds data Cronk can't take.
        const code = (err as { code?: unknown }).code;
        if (typeof code === "string" && /^2[23]/.test(code)) throw new HttpError(400, `The export holds data Cronk can't take: ${(err as Error).message}`);
        throw err;
      } finally {
        // Those moved to their places are gone already; any left, such as a file no index names, go now.
        await removeFiles(request, ctx, temporary);
      }
    },
  );

  app.get(
    "/api/import/renamed-ids",
    {
      schema: {
        description:
          "Every Agent and Agent Session an import gave a new id because the id it had in the export was taken here, oldest first, " +
          "so something naming the old id, such as a Transcript uploaded before the import, can be matched to it.",
        response: { 200: answer("The ids imports renamed, in the order they did", listing("renamedIds", ref("RenamedId"))), ...errors(401, 403, 410) },
      },
    },
    async (request) => {
      const user = await requireUser(ctx, request);
      requireAdmin(user, "see the ids imports renamed");
      return { renamedIds: await listRenamedIds(ctx.db, user.workspaceId) };
    },
  );
}

/** Importing a plain folder of Markdown files as Documents of the Workspace or a Project. */
function markdownImportRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    "/api/workspace/documents/import",
    {
      bodyLimit: MAX_PACKED_BYTES,
      schema: {
        consumes: ARCHIVE_TYPES,
        body: archiveBodySchema,
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
      bodyLimit: MAX_PACKED_BYTES,
      schema: {
        consumes: ARCHIVE_TYPES,
        body: archiveBodySchema,
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
}

/** Removes the files under `keys`, each tried even if another fails, so one failure hides neither the rest nor why the import failed. */
async function removeFiles(request: FastifyRequest, ctx: AppContext, keys: string[]): Promise<void> {
  const removed = await Promise.allSettled(keys.map((key) => ctx.files.delete(key)));
  for (const [i, result] of removed.entries()) {
    if (result.status === "rejected") request.log.error({ err: result.reason, key: keys[i] }, "An import couldn't remove a file it stored");
  }
}

/** The uploaded archive as a stream; a body sent as another type, such as JSON, is refused. */
function archiveStream(body: unknown): Readable {
  return body instanceof Readable ? body : Readable.from([archiveBody(body)]);
}

const EXPORT_FORMAT =
  "The answer is a gzipped tar archive of Markdown files with YAML frontmatter, laid out as its README.md describes; POST /api/import reads it back.";

const DECISIONS_EXPORT_FORMAT =
  "Any User or Agent who can read the Decisions can download it. The answer is a gzipped tar archive holding only `docs/adr/NNNN-<title>.md`, " +
  "one per Decision, each the same file GET /api/export or GET /api/projects/{key}/export writes for it, without its Versions; empty when there are none.";

const decisionsExportAnswer = {
  description: "The Decisions, as a gzipped tar archive of `docs/adr/` to save",
  content: { "application/gzip": { schema: { type: "string", format: "binary" } } },
};

const versionsQuery = {
  type: "object",
  properties: {
    versions: { type: "boolean", default: true, description: "Include every Version of Documents, Reports, Guidance and Terms; false exports only the current one, which imports as Version 1." },
  },
} as const;

const exportAnswer = {
  description: "The export, as a gzipped tar archive to save",
  content: { "application/gzip": { schema: { type: "string", format: "binary" } } },
};

const IMPORT_RULES =
  "A file is titled by its frontmatter's `title`, else by a `#` heading on its first line, else by its name; frontmatter is left out of the body. " +
  "A folder's `README.md` or `index.md`, or a file named like it beside it, is the folder's own Document; a folder without one becomes an empty Document named after it. " +
  "Files and folders are ordered by name, numbers counting as numbers. Files other than Markdown (`.md`, `.markdown`) and hidden ones are skipped, " +
  "and a single folder holding everything (as archiving a folder adds) is unwrapped.";
