import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actingUser, type Actor } from "../actor.js";
import { HttpError, requireActor, type AppContext } from "../context.js";
import { findCommentsByIds, type Comment } from "../conversation/comments.js";
import { requireAgentMayChange, requireClaimHolder } from "../coordination/claims.js";
import { transaction, type Queryable } from "../db/database.js";
import { documentFor } from "../knowledge/document-reads.js";
import type { Document } from "../knowledge/documents.js";
import { requireUnprotected } from "../knowledge/protection.js";
import { artifactTopic, documentTopic } from "../live/topics.js";
import { artifactFor } from "./artifact-routes.js";
import { answer, artifactIdParam, attachmentIdParam, commentIdParam, documentIdParam, errors, holding, listing, noContent, pathParams, ref, ticketKeyParam } from "../schemas.js";
import { ticketsChanged } from "../work/ticket-changes.js";
import { ticketFor } from "../work/ticket-reads.js";
import { findTicketByKey, type Ticket } from "../work/tickets.js";
import { getWorkspace } from "../workspace/workspaces.js";
import { SHOWN_MEDIA_TYPES } from "../../shared/values.js";
import { FileTooLarge, type ByteRange } from "./store.js";
import { formatBytes } from "./sizes.js";
import {
  attachmentKey,
  deleteAttachment,
  findAttachment,
  insertAttachment,
  listArtifactAttachments,
  listDocumentAttachments,
  listTicketAttachments,
  publicAttachment,
  type Attachment,
  type AttachmentTarget,
} from "./attachments.js";

/** The longest file name an Attachment keeps. */
const MAX_NAME_LENGTH = 255;

/** Attachments on Tickets, Documents (Reports too) and Comments: uploading, listing, downloading and deleting them. */
export function attachmentRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // An upload's body is the file, of any type, read as it streams in rather than parsed; this applies only to the routes here.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));

    /**
     * Stores the uploaded file and records it on the item `toAttachTo` finds, which also checks `actor` may attach
     * files to it. It runs once before the file is stored, so a refused upload stores nothing, and again, against the
     * locked rows, when it is recorded.
     */
    const upload = async (request: FastifyRequest<{ Querystring: { name: string } }>, reply: FastifyReply, toAttachTo: (tx: Queryable, actor: Actor) => Promise<AttachmentTarget>) => {
      const actor = await requireActor(ctx, request);
      const name = fileName(request.query.name);
      await transaction(ctx.db, (tx) => toAttachTo(tx, actor));
      const maxBytes = (await getWorkspace(ctx.db, actingUser(actor).workspaceId)).attachmentMaxBytes;
      const tooLarge = () => new HttpError(413, `This file is larger than ${formatBytes(maxBytes)}, the most an Attachment may be in this Workspace`);
      if (Number(request.headers["content-length"]) > maxBytes) throw tooLarge();
      const id = randomUUID();
      const key = attachmentKey(id);
      const size = await ctx.files.put(key, uploadedBytes(request), { maxBytes }).catch((err: unknown) => {
        throw err instanceof FileTooLarge ? tooLarge() : err;
      });
      try {
        const attachment = await transaction(ctx.db, async (tx) =>
          insertAttachment(tx, {
            id,
            workspaceId: actingUser(actor).workspaceId,
            target: await toAttachTo(tx, actor),
            name,
            contentType: mediaType(request.headers["content-type"]),
            size,
            actor,
            now: ctx.clock.now(),
          }),
        );
        attachmentsChanged(ctx, attachment);
        return reply.code(201).send({ attachment: publicAttachment(attachment) });
      } catch (err) {
        await ctx.files.delete(key);
        throw err;
      }
    };

    /** Where to attach a file, by the item's path parameter. */
    const toTicket = (key: string) => async (tx: Queryable, actor: Actor) => ({ ticketId: (await ticketToAttachTo(tx, actor, key, ctx.clock.now())).id });
    const toDocument = (id: string) => async (tx: Queryable, actor: Actor) => ({ documentId: (await documentToAttachTo(tx, actor, id, ctx.clock.now())).id });
    const toComment = (id: string) => async (tx: Queryable, actor: Actor) => ({ commentId: (await commentToAttachTo(tx, actor, id)).id });

    /** The OpenAPI schema of an upload route, described by `description`, with the item's path `params`. */
    const uploadSchema = (description: string, params: object) => ({
      description: `${description} ${UPLOAD_BODY}`,
      consumes: ["application/octet-stream", "*/*"],
      body: { description: "The file's bytes." },
      params,
      querystring: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", minLength: 1, maxLength: MAX_NAME_LENGTH, pattern: "\\S", description: "The file's name, such as `proxy-ip.png`." } },
      },
      response: { 201: answer("The Attachment", holding("attachment", "Attachment")), ...errors(400, 401, 403, 404, 409, 410, 413) },
    });

    app.post<{ Params: { key: string }; Querystring: { name: string } }>(
      "/api/tickets/:key/attachments",
      {
        schema: uploadSchema(
          "Attaches a file to the Ticket. Needs Write in the Ticket's Project; an Agent must also hold the Ticket's Claim, unless it is the Agent's own Discovered Ticket no User has delegated yet.",
          pathParams({ key: ticketKeyParam }),
        ),
      },
      (request, reply) => upload(request, reply, toTicket(request.params.key)),
    );

    app.post<{ Params: { id: string }; Querystring: { name: string } }>(
      "/api/documents/:id/attachments",
      {
        schema: uploadSchema(
          "Attaches a file to the Document or Report. It belongs to the Document, not to one Version, so every Version can show it. " +
            "Needs Write where the Document belongs; an Agent can't attach to a Protected Document, and must hold a Report's Ticket's Claim.",
          pathParams({ id: documentIdParam }),
        ),
      },
      (request, reply) => upload(request, reply, toDocument(request.params.id)),
    );

    app.post<{ Params: { id: string }; Querystring: { name: string } }>(
      "/api/comments/:id/attachments",
      {
        schema: uploadSchema(
          "Attaches a file to a Comment, to show with it. Only whoever posted the Comment may, with Write on its Ticket, Document or Artifact.",
          pathParams({ id: commentIdParam }),
        ),
      },
      (request, reply) => upload(request, reply, toComment(request.params.id)),
    );

    app.get<{ Params: { key: string } }>(
      "/api/tickets/:key/attachments",
      {
        schema: {
          params: pathParams({ key: ticketKeyParam }),
          response: {
            200: answer(
              "Every Attachment on the Ticket, in the order they were attached: its own, and those in its Comments and Reports and in Comments on its Reports",
              listing("attachments", ref("Attachment")),
            ),
            ...errors(401, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const ticket = await ticketFor(ctx.db, actor, request.params.key, "read");
        return { attachments: (await listTicketAttachments(ctx.db, ticket.id)).map(publicAttachment) };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/documents/:id/attachments",
      {
        schema: {
          params: pathParams({ id: documentIdParam }),
          response: {
            200: answer("Every Attachment on the Document, in the order they were attached: its own and those in its Comments", listing("attachments", ref("Attachment"))),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const document = await documentFor(ctx.db, actor, request.params.id, "read");
        return { attachments: (await listDocumentAttachments(ctx.db, document.id)).map(publicAttachment) };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/artifacts/:id/attachments",
      {
        schema: {
          params: pathParams({ id: artifactIdParam }),
          response: {
            200: answer("Every Attachment in the Artifact's Comments, in the order they were attached", listing("attachments", ref("Attachment"))),
            ...errors(401, 404, 410),
          },
        },
      },
      async (request) => {
        const artifact = await artifactFor(ctx.db, await requireActor(ctx, request), request.params.id, "read");
        return { attachments: (await listArtifactAttachments(ctx.db, artifact.id)).map(publicAttachment) };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/attachments/:id/file",
      {
        schema: {
          params: pathParams({ id: attachmentIdParam }),
          response: {
            200: {
              description: "The file, with its media type",
              content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
            },
            ...errors(401, 404, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const attachment = await readableAttachment(ctx.db, actor, request.params.id);
        reply
          .header("accept-ranges", "bytes")
          .header("content-type", attachment.contentType)
          .header("content-disposition", contentDisposition(attachment))
          // The file is someone's upload, served on Cronk's own site: it never runs as a page there.
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
        const range = byteRange(request.headers.range, attachment.size);
        if (range === "unsatisfiable") {
          reply.header("content-range", `bytes */${attachment.size}`);
          throw new HttpError(416, `The file is ${attachment.size} bytes long`);
        }
        if (!range) return reply.header("content-length", attachment.size).send(ctx.files.get(attachmentKey(attachment.id)));
        return reply
          .code(206)
          .header("content-range", `bytes ${range.start}-${range.end}/${attachment.size}`)
          .header("content-length", range.end - range.start + 1)
          .send(ctx.files.get(attachmentKey(attachment.id), range));
      },
    );

    app.delete<{ Params: { id: string } }>(
      "/api/attachments/:id",
      {
        schema: {
          description:
            "Deletes an Attachment and its file. Needs what attaching a file to its Ticket, Document or Comment needs: " +
            "Write where it belongs and, for an Agent, the Ticket's Claim (or its own undelegated Discovered Ticket), an unprotected Document, or a Comment it posted. " +
            "Any User with Write may delete a Comment's Attachment, whoever posted the Comment.",
          params: pathParams({ id: attachmentIdParam }),
          response: { 204: noContent("The Attachment is deleted"), ...errors(401, 403, 404, 409, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const attachment = await transaction(ctx.db, async (tx) => {
          const attachment = await readableAttachment(tx, actor, request.params.id);
          const now = ctx.clock.now();
          if (attachment.on === "ticket") await ticketToAttachTo(tx, actor, attachment.ticketKey!, now);
          else if (attachment.on === "document") await documentToAttachTo(tx, actor, attachment.documentId!, now);
          else await commentToAttachTo(tx, actor, attachment.commentId!, { orUserWithWrite: true });
          if (!(await deleteAttachment(tx, attachment.id))) throw new HttpError(404, "No such Attachment");
          return attachment;
        });
        // Only once the record is gone, so a failed delete never leaves a record without its file.
        await ctx.files.delete(attachmentKey(attachment.id));
        attachmentsChanged(ctx, attachment);
        return reply.code(204).send();
      },
    );
  };
}

/** What every upload's description ends with: how to send the file. */
const UPLOAD_BODY =
  "The request body is the file itself, sent with its media type as `Content-Type` (`application/octet-stream` when unknown), and `name` is its file name.";

/**
 * Tells the watchers of the Ticket, Document or Artifact the Attachment is on or in that their Attachments changed: the
 * Ticket's a `changed` event, the Document's and Artifact's an `attachments` one. Call once the change is committed.
 */
function attachmentsChanged(ctx: AppContext, attachment: Attachment): void {
  if (attachment.ticketId) ticketsChanged(ctx.live, [{ id: attachment.ticketId, key: attachment.ticketKey!, projectId: attachment.projectId! }]);
  if (attachment.documentId) ctx.live.publish(documentTopic(attachment.documentId), { event: "attachments", data: {} });
  if (attachment.artifactId) ctx.live.publish(artifactTopic(attachment.artifactId), { event: "attachments", data: {} });
}

/**
 * The Ticket with this key, if `actor` may attach files to it: Write in its Project and, for an Agent, its Claim, unless it is
 * the Agent's own undelegated Discovered Ticket. Run inside a transaction.
 */
async function ticketToAttachTo(tx: Queryable, actor: Actor, key: string, now: Date): Promise<Ticket> {
  const ticket = await ticketFor(tx, actor, key, "write", { forUpdate: actor.kind === "agent" });
  if (actor.kind === "agent") await requireAgentMayChange(tx, actor, ticket, now, "changing its Attachments");
  return ticket;
}

/**
 * The Document with this id, if `actor` may attach files to it: Write where it belongs and, for an Agent, a
 * Document that isn't Protected, and the Claim on a Report's Ticket. Run inside a transaction.
 */
async function documentToAttachTo(tx: Queryable, actor: Actor, id: string, now: Date): Promise<Document> {
  const document = await documentFor(tx, actor, id, "write");
  requireUnprotected(actor, document, document.title, "attach files to it");
  if (document.ticketKey !== null && actor.kind === "agent") {
    const ticket = (await findTicketByKey(tx, actingUser(actor).workspaceId, document.ticketKey, { forUpdate: true }))!;
    await requireClaimHolder(tx, actor, ticket, now, "changing its Report's Attachments");
  }
  return document;
}

/**
 * The Comment with this id, if `actor` may attach files to it: they posted it (the same User, or the same Agent),
 * and have Write on its Ticket, Document or Artifact. With `orUserWithWrite`, as for removing a file, any User with that
 * Write may too, so a file posted by mistake can be taken down. Run inside a transaction.
 */
async function commentToAttachTo(tx: Queryable, actor: Actor, id: string, opts: { orUserWithWrite?: boolean } = {}): Promise<Comment> {
  const found = (await findCommentsByIds(tx, [id]))[0];
  if (!found) throw new HttpError(404, "No such Comment");
  const { comment } = found;
  if (comment.ticketKey !== null) await ticketFor(tx, actor, comment.ticketKey, "write");
  else if (comment.artifactId !== null) await artifactFor(tx, actor, comment.artifactId, "write");
  else await documentFor(tx, actor, comment.documentId!, "write");
  const moderating = opts.orUserWithWrite && actor.kind === "user";
  if (!moderating && (comment.actor.kind !== actor.kind || comment.actor.id !== actorId(actor))) {
    throw new HttpError(403, "Only whoever posted a Comment may attach files to it");
  }
  return comment;
}

/** The id a Comment records for `actor`: the Agent's, or the User's. */
const actorId = (actor: Actor) => (actor.kind === "agent" ? actor.agent.id : actor.user.id);

/** The Attachment with this id, if `actor` can read the item it is on; otherwise a 404, as if it didn't exist. */
async function readableAttachment(db: Queryable, actor: Actor, id: string): Promise<Attachment> {
  const attachment = await findAttachment(db, actingUser(actor).workspaceId, id);
  if (!attachment) throw new HttpError(404, "No such Attachment");
  const readable = attachment.documentId
    ? documentFor(db, actor, attachment.documentId, "read")
    : attachment.artifactId
      ? artifactFor(db, actor, attachment.artifactId, "read")
      : ticketFor(db, actor, attachment.ticketKey!, "read");
  await readable.catch((err: unknown) => {
    throw err instanceof HttpError && (err.statusCode === 404 || err.statusCode === 403) ? new HttpError(404, "No such Attachment") : err;
  });
  return attachment;
}

/**
 * The one range of bytes a `Range` header asks for in a file of `size` bytes (RFC 9110 § 14): `bytes=a-b`, `bytes=a-`
 * or the last n bytes, `bytes=-n`, with an end past the file cut to it. Undefined, for the whole file, when there is
 * no header or one this doesn't read, such as several ranges; "unsatisfiable" when the range lies outside the file.
 */
function byteRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | undefined {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  const [, from, to] = match;
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (to !== "" && Number(to) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

/** The media types served to show in the page rather than to save. */
const SHOWN_IN_PAGE = new Set<string>(Object.values(SHOWN_MEDIA_TYPES).flat());

/** The `Content-Disposition` an Attachment is served with: shown in the page or saved, under its own name (RFC 6266). */
function contentDisposition(attachment: Attachment): string {
  const ascii = attachment.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(attachment.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${SHOWN_IN_PAGE.has(attachment.contentType) ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}


/** The uploaded file as it streams in. */
function uploadedBytes(request: FastifyRequest): Readable {
  return request.body as Readable;
}

/** A file name as an Attachment keeps it: trimmed, without folders or control characters. */
function fileName(raw: string): string {
  const name = raw.split(/[/\\]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) throw new HttpError(400, "name must be a file name, such as proxy-ip.png");
  return name;
}

/** The media type a `Content-Type` header names, lower case without parameters; `application/octet-stream` for none or a malformed one. */
function mediaType(header: string | undefined): string {
  const type = header?.split(";")[0]!.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : "application/octet-stream";
}
