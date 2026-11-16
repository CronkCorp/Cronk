import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { actingUser, type Actor } from "../actor.js";
import { HttpError, requireActor, type AppContext } from "../context.js";
import { requireClaimHolder } from "../coordination/claims.js";
import { transaction, type Queryable } from "../db/database.js";
import { answer, attachmentIdParam, errors, holding, listing, pathParams, ref, ticketKeyParam } from "../schemas.js";
import { ticketsChanged } from "../work/ticket-changes.js";
import { ticketFor } from "../work/ticket-reads.js";
import type { Ticket } from "../work/tickets.js";
import { attachmentKey, findAttachment, insertAttachment, listAttachments, publicAttachment, type Attachment } from "./attachments.js";

/** The longest file name an Attachment keeps. */
const MAX_NAME_LENGTH = 255;

const uploadDescription =
  "Attaches a file to the Ticket. The request body is the file itself, sent with its media type as `Content-Type` " +
  "(`application/octet-stream` when unknown), and `name` is its file name. Needs Write in the Ticket's Project; an Agent must also hold the Ticket's Claim.";

/** Attachments on Tickets: uploading, listing and downloading them. */
export function attachmentRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // An upload's body is the file, of any type, read as it streams in rather than parsed; this applies only to the routes here.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));

    app.post<{ Params: { key: string }; Querystring: { name: string } }>(
      "/api/tickets/:key/attachments",
      {
        schema: {
          description: uploadDescription,
          consumes: ["application/octet-stream", "*/*"],
          body: { description: "The file's bytes." },
          params: pathParams({ key: ticketKeyParam }),
          querystring: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string", minLength: 1, maxLength: MAX_NAME_LENGTH, pattern: "\\S", description: "The file's name, such as `proxy-ip.png`." } },
          },
          response: { 201: answer("The Attachment", holding("attachment", "Attachment")), ...errors(400, 401, 403, 404, 409, 410, 413) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const name = fileName(request.query.name);
        // Checked before the file is stored, so a refused upload stores nothing; checked again below against the locked row.
        await transaction(ctx.db, (tx) => ticketToAttachTo(tx, actor, request.params.key, ctx.clock.now()));
        const id = randomUUID();
        const key = attachmentKey(id);
        const size = await ctx.files.put(key, uploadedBytes(request));
        try {
          const { ticket, attachment } = await transaction(ctx.db, async (tx) => {
            const ticket = await ticketToAttachTo(tx, actor, request.params.key, ctx.clock.now());
            const attachment = await insertAttachment(tx, {
              id,
              workspaceId: actingUser(actor).workspaceId,
              ticketId: ticket.id,
              name,
              contentType: mediaType(request.headers["content-type"]),
              size,
              actor,
              now: ctx.clock.now(),
            });
            return { ticket, attachment };
          });
          ticketsChanged(ctx.live, [ticket]);
          return reply.code(201).send({ attachment: publicAttachment(attachment) });
        } catch (err) {
          await ctx.files.delete(key);
          throw err;
        }
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/tickets/:key/attachments",
      {
        schema: {
          params: pathParams({ key: ticketKeyParam }),
          response: { 200: answer("The Ticket's Attachments, in the order they were attached", listing("attachments", ref("Attachment"))), ...errors(401, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const ticket = await ticketFor(ctx.db, actor, request.params.key, "read");
        return { attachments: (await listAttachments(ctx.db, ticket.id)).map(publicAttachment) };
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
        return reply
          .header("content-type", attachment.contentType)
          .header("content-length", attachment.size)
          .send(ctx.files.get(attachmentKey(attachment.id)));
      },
    );
  };
}

/** The Ticket with this key, if `actor` may attach files to it: Write in its Project and, for an Agent, its Claim. Run inside a transaction. */
async function ticketToAttachTo(tx: Queryable, actor: Actor, key: string, now: Date): Promise<Ticket> {
  const ticket = await ticketFor(tx, actor, key, "write", { forUpdate: actor.kind === "agent" });
  if (actor.kind === "agent") await requireClaimHolder(tx, actor, ticket, now, "changing its Attachments");
  return ticket;
}

/** The Attachment with this id, if `actor` can read its Ticket; otherwise a 404, as if it didn't exist. */
async function readableAttachment(db: Queryable, actor: Actor, id: string): Promise<Attachment> {
  const attachment = await findAttachment(db, actingUser(actor).workspaceId, id);
  if (!attachment) throw new HttpError(404, "No such Attachment");
  await ticketFor(db, actor, attachment.ticketKey, "read").catch((err: unknown) => {
    throw err instanceof HttpError && err.statusCode === 404 ? new HttpError(404, "No such Attachment") : err;
  });
  return attachment;
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
