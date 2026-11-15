import type { FastifyInstance } from "fastify";
import type { Actor } from "../actor.js";
import { HttpError, requireActor, type AppContext } from "../context.js";
import { transaction, type Queryable } from "../db/database.js";
import { readablePlaces } from "../identity/access.js";
import { documentFor } from "../knowledge/document-reads.js";
import { listLinkedDocuments, type Document } from "../knowledge/documents.js";
import { answer, documentIdParam, errors, listing, pathParams, ref, ticketKeyParam } from "../schemas.js";
import { linkDocument, unlinkDocument } from "./document-links.js";
import { ticketFor } from "./ticket-reads.js";
import type { Ticket } from "./tickets.js";

const linkParams = pathParams({ key: ticketKeyParam, documentId: documentIdParam });

/** Linking Documents to a Ticket from the Ticket's side. */
export function documentLinkRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.post<{ Params: { key: string; documentId: string } }>(
      "/api/tickets/:key/documents/:documentId",
      {
        schema: {
          params: linkParams,
          response: {
            201: answer("The Ticket's Documents, with the one linked", listing("documents", ref("LinkedDocument"))),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const documents = await transaction(ctx.db, async (tx) => {
          const { ticket, document } = await linkEnds(tx, actor, request.params.key, request.params.documentId);
          await linkDocument(tx, { ticket, document, actor, now: ctx.clock.now() });
          return listLinkedDocuments(tx, ticket, await readablePlaces(tx, actor));
        });
        return reply.code(201).send({ documents });
      },
    );

    app.delete<{ Params: { key: string; documentId: string } }>(
      "/api/tickets/:key/documents/:documentId",
      {
        schema: {
          params: linkParams,
          response: {
            200: answer("The Ticket's remaining Documents", listing("documents", ref("LinkedDocument"))),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const documents = await transaction(ctx.db, async (tx) => {
          const { ticket, document } = await linkEnds(tx, actor, request.params.key, request.params.documentId);
          if (!(await unlinkDocument(tx, { ticket, document, actor, now: ctx.clock.now() }))) throw new HttpError(404, "That Document isn't linked to this Ticket");
          return listLinkedDocuments(tx, ticket, await readablePlaces(tx, actor));
        });
        return { documents };
      },
    );
  };
}

/**
 * The Ticket and Document of a link being changed, if `actor` has Write on the Ticket and can read
 * the Document. A missing or hidden Ticket answers 404; a missing or hidden Document, 400.
 */
async function linkEnds(tx: Queryable, actor: Actor, key: string, documentId: string): Promise<{ ticket: Ticket; document: Document }> {
  const ticket = await ticketFor(tx, actor, key, "write");
  const document = await documentFor(tx, actor, documentId, "read").catch((err: unknown) => {
    throw err instanceof HttpError && err.statusCode === 404 ? new HttpError(400, "No such Document") : err;
  });
  return { ticket, document };
}
