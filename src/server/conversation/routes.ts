import type { FastifyInstance } from "fastify";
import type { Actor } from "../actor.js";
import { HttpError, requireActor, type AppContext } from "../context.js";
import { transaction, type Queryable } from "../db/database.js";
import { answer, errors, holding, listing, pathParams, ref, ticketKeyParam } from "../schemas.js";
import { ticketFor } from "../work/ticket-reads.js";
import { findActivity, markAnswered } from "../coordination/activities.js";
import { findComment, insertComment, listComments, publicComment, type Comment, type CommentTarget } from "./comments.js";

const ticketParams = pathParams({ key: ticketKeyParam });

interface NewComment {
  body: string;
  replyToCommentId?: string;
  replyToActivityId?: string;
}

const id = { type: "string", format: "uuid" } as const;

const newCommentBody = {
  type: "object",
  required: ["body"],
  additionalProperties: false,
  properties: {
    body: { type: "string", minLength: 1, maxLength: 100_000, pattern: "\\S", description: "Markdown." },
    replyToCommentId: { ...id, description: "The Comment this one replies to, on the same Ticket or Document." },
    replyToActivityId: {
      ...id,
      description: "The Activity this one replies to, on the same Ticket. The first reply to a question from anyone but the Agent that asked answers it.",
    },
  },
} as const;

/** Comments: conversation on Tickets and Documents, from any Actor. */
export function conversationRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    /** Posts `input` on `target` as `actor`, checking what it replies to is on the same target. */
    const post = async (tx: Queryable, actor: Actor, target: CommentTarget, input: NewComment): Promise<Comment> => {
      const replyToCommentId = input.replyToCommentId ?? null;
      const replyToActivityId = input.replyToActivityId ?? null;
      if (replyToCommentId && replyToActivityId) throw new HttpError(400, "Reply to a Comment or an Activity, not both");
      if (replyToCommentId && !(await findComment(tx, target, replyToCommentId))) {
        throw new HttpError(400, "replyToCommentId names no Comment here");
      }
      const activity = replyToActivityId && "ticketId" in target ? await findActivity(tx, target.ticketId, replyToActivityId) : undefined;
      if (replyToActivityId && !activity) throw new HttpError(400, "replyToActivityId names no Activity on this Ticket");
      const comment = await insertComment(tx, target, actor, { body: input.body, replyToCommentId, replyToActivityId }, ctx.clock.now());
      const askedIt = actor.kind === "agent" && actor.agent.id === activity?.agent.id;
      if (activity && !askedIt) await markAnswered(tx, activity, comment.id);
      return comment;
    };

    app.post<{ Params: { key: string }; Body: NewComment }>(
      "/api/tickets/:key/comments",
      {
        schema: {
          params: ticketParams,
          body: newCommentBody,
          response: { 201: answer("The Comment, posted on the Ticket", holding("comment", "Comment")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const comment = await transaction(ctx.db, async (tx) => {
          const ticket = await ticketFor(tx, actor, request.params.key, "write");
          return post(tx, actor, { ticketId: ticket.id }, request.body);
        });
        return reply.code(201).send({ comment: publicComment(comment) });
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/tickets/:key/comments",
      {
        schema: {
          params: ticketParams,
          response: { 200: answer("The Ticket's Comments, oldest first", listing("comments", ref("Comment"))), ...errors(401, 404, 410) },
        },
      },
      async (request) => {
        const ticket = await ticketFor(ctx.db, await requireActor(ctx, request), request.params.key, "read");
        return { comments: (await listComments(ctx.db, { ticketId: ticket.id })).map(publicComment) };
      },
    );
  };
}
