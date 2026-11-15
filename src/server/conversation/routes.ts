import type { FastifyInstance } from "fastify";
import type { Actor } from "../actor.js";
import { HttpError, requireActor, requireUser, type AppContext } from "../context.js";
import { userActor } from "../actor.js";
import { findStatusToMoveInto, listStatuses } from "../work/projects.js";
import { updateTicket } from "../work/tickets.js";
import { transaction, type Queryable } from "../db/database.js";
import { answer, documentIdParam, errors, holding, listing, pathParams, ref, ticketKeyParam } from "../schemas.js";
import { documentFor } from "../knowledge/document-reads.js";
import { ticketFor } from "../work/ticket-reads.js";
import { findActivity, markAnswered, publicActivity, type Activity } from "../coordination/activities.js";
import { agentTopic, documentTopic, ticketTopic } from "../live/topics.js";
import { ticketsChanged } from "../work/ticket-changes.js";
import { inboxesChanged } from "../inbox/inbox.js";
import { MENTION_SYNTAX } from "../../shared/values.js";
import { markWaiting, waitingEvent, type CommentPlace, type Positioned, type WaitingFor, type WaitingWork } from "../coordination/waiting-work.js";
import type { Document } from "../knowledge/documents.js";
import { findComment, insertComment, listComments, publicComment, type Comment, type CommentTarget } from "./comments.js";

const ticketParams = pathParams({ key: ticketKeyParam });
const documentParams = pathParams({ id: documentIdParam });

interface NewComment {
  body: string;
  replyToCommentId?: string;
  replyToActivityId?: string;
  anchor?: { passage: string };
}

const id = { type: "string", format: "uuid" } as const;

const newCommentBody = {
  type: "object",
  required: ["body"],
  additionalProperties: false,
  properties: {
    body: {
      type: "string",
      minLength: 1,
      maxLength: 100_000,
      pattern: "\\S",
      description: `Markdown. ${MENTION_SYNTAX}`,
    },
    replyToCommentId: { ...id, description: "The Comment this one replies to, on the same Ticket or Document." },
    replyToActivityId: {
      ...id,
      description: "The Activity this one replies to, on the same Ticket. The first reply to a question from a User answers it.",
    },
    anchor: {
      type: "object",
      required: ["passage"],
      additionalProperties: false,
      description: "Only on a Document: the passage of its current Version the Comment is about. It stays anchored while later Versions still hold it.",
      properties: { passage: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S", description: "Text the Document holds, exactly." } },
    },
  },
} as const;

/** A Comment just posted: the question it answered, if any, and the Agents it now waits for. */
interface Posted {
  comment: Comment;
  answered: Activity | undefined;
  waiting: WaitingFor[];
}

/** Comments: conversation on Tickets and Documents, from any Actor. */
export function conversationRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    /**
     * Posts `input` on `target` as `actor`, checking what it replies to is on the same target,
     * and that an anchor's passage is in `document`, the Document it is on.
     */
    const post = async (
      tx: Queryable,
      positioned: Positioned,
      actor: Actor,
      target: CommentTarget,
      place: CommentPlace,
      input: NewComment,
      document?: Document,
    ): Promise<Posted> => {
      const replyToCommentId = input.replyToCommentId ?? null;
      const replyToActivityId = input.replyToActivityId ?? null;
      if (replyToCommentId && replyToActivityId) throw new HttpError(400, "Reply to a Comment or an Activity, not both");
      if (replyToCommentId && !(await findComment(tx, target, replyToCommentId))) {
        throw new HttpError(400, "replyToCommentId names no Comment here");
      }
      const activity = replyToActivityId && "ticketId" in target ? await findActivity(tx, target.ticketId, replyToActivityId) : undefined;
      if (replyToActivityId && !activity) throw new HttpError(400, "replyToActivityId names no Activity on this Ticket");
      if (input.anchor && !document) throw new HttpError(400, "Only a Comment on a Document can anchor to a passage");
      if (input.anchor && !document!.body.includes(input.anchor.passage)) {
        throw new HttpError(400, `Version ${document!.version} of the Document doesn't hold that passage; quote it exactly`);
      }
      const anchor = input.anchor ? { passage: input.anchor.passage, version: document!.version } : null;
      const comment = await insertComment(tx, target, actor, { body: input.body, replyToCommentId, replyToActivityId, anchor }, ctx.clock.now());
      // A User answers a question by replying to it; the first such reply is its answer.
      const answered = activity && actor.kind === "user" && (await markAnswered(tx, activity, comment.id)) ? await findActivity(tx, activity.ticketId, activity.id) : undefined;
      const asker = answered ? { agentId: answered.agent.id } : null;
      return { comment, answered, waiting: await markWaiting(tx, actor, comment, place, asker, comment.at, positioned) };
    };

    /**
     * Runs `fn` in a transaction, passing it what to tell `post` about the positions it takes,
     * then `committed` with its result. Each position is expected on its Agent's stream
     * (`LiveUpdates.expect`) before it commits, until `committed` pushes it (`pushWaiting`). If the
     * transaction rolls back or `committed` throws, they are forgotten, so they never hold a
     * stream's `ready` back for good.
     */
    const posting = async <T>(fn: (tx: Queryable, positioned: Positioned) => Promise<T>, committed: (result: T) => void): Promise<T> => {
      const forget: (() => void)[] = [];
      try {
        const result = await transaction(ctx.db, (tx) => fn(tx, (agentId, seq) => forget.push(ctx.live.expect(agentTopic(agentId), seq))));
        committed(result);
        return result;
      } catch (err) {
        for (const f of forget) f();
        throw err;
      }
    };

    /**
     * Tells each Agent the Comment now waits for, through its live Agent Sessions. Call from `posting`'s `committed`.
     *
     * Posts for the same Agent commit in position order (`markWaiting`), but their pushes aren't
     * serialized: in theory a later post's event could be pushed before an earlier one's, and a
     * stream dropped between the two, reopened from the later id, would skip the earlier work
     * (its welcome still lists it). Accepted: the earlier post pushes as soon as its COMMIT
     * answers, without touching the database again, while the later one, which waited on that
     * COMMIT, still has round trips to make before it can push.
     */
    const pushWaiting = (posted: Posted, on: Omit<WaitingWork, "reason" | "comment">) => {
      for (const { agentId, reason, seq } of posted.waiting) {
        ctx.live.publish(agentTopic(agentId), waitingEvent(seq, { reason, comment: publicComment(posted.comment), ...on }));
      }
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
        const { ticket, posted } = await posting(
          async (tx, positioned) => {
            const ticket = await ticketFor(tx, actor, request.params.key, "write");
            const place = { projectId: ticket.projectId, delegateId: ticket.delegate?.id ?? null };
            return { ticket, posted: await post(tx, positioned, actor, { ticketId: ticket.id }, place, request.body) };
          },
          ({ ticket, posted }) => {
            ctx.live.publish(ticketTopic(ticket.id), { event: "comment", data: { comment: publicComment(posted.comment) } });
            if (posted.answered) {
              ctx.live.publish(ticketTopic(ticket.id), { event: "activity", data: { activity: publicActivity(posted.answered) } });
              inboxesChanged(ctx.live, [posted.answered.agent.owner.id]);
            }
            pushWaiting(posted, { ticket: { key: ticket.key, title: ticket.title }, document: null });
          },
        );
        return reply.code(201).send({ comment: publicComment(posted.comment) });
      },
    );

    // An Inbox action: hands work under review back, with a Comment saying what is left to do.
    app.post<{ Params: { key: string }; Body: { comment: string; statusId?: string } }>(
      "/api/tickets/:key/send-back",
      {
        schema: {
          params: ticketParams,
          body: {
            type: "object",
            required: ["comment"],
            additionalProperties: false,
            properties: {
              comment: { ...newCommentBody.properties.body, description: `What is left to do, as Markdown. ${MENTION_SYNTAX}` },
              statusId: { ...id, description: "A Started Status of the Ticket's Project. The Project's first Started Status if left out." },
            },
          },
          response: {
            200: answer(
              "The Ticket, moved from its In Review Status back to a Started one, and the Comment posted on it, which waits for its Delegate",
              { type: "object", required: ["ticket", "comment"], properties: { ticket: ref("Ticket"), comment: ref("Comment") } },
            ),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const actor = userActor(user);
        const { ticket, posted } = await posting(
          async (tx, positioned) => {
            const ticket = await ticketFor(tx, actor, request.params.key, "write", { forUpdate: true });
            if (ticket.status.category !== "in_review") throw new HttpError(409, `${ticket.key} is ${ticket.status.name}, not In Review`);
            const started = (await listStatuses(tx, ticket.projectId)).filter((s) => s.category === "started");
            const chosen = request.body.statusId === undefined ? started[0] : started.find((s) => s.id === request.body.statusId);
            // Locked so it can't be removed before the move commits.
            const status = chosen && (await findStatusToMoveInto(tx, ticket.projectId, chosen.id));
            if (!status) throw new HttpError(400, "That isn't a Started Status of this Ticket's Project");
            const moved = await updateTicket(tx, ticket, { status }, actor, ctx.clock.now());
            const place = { projectId: ticket.projectId, delegateId: ticket.delegate?.id ?? null };
            return { ticket: moved, posted: await post(tx, positioned, actor, { ticketId: ticket.id }, place, { body: request.body.comment }) };
          },
          ({ ticket, posted }) => {
            ctx.live.publish(ticketTopic(ticket.id), { event: "comment", data: { comment: publicComment(posted.comment) } });
            pushWaiting(posted, { ticket: { key: ticket.key, title: ticket.title }, document: null });
            inboxesChanged(ctx.live, [ticket.assignee?.id]);
            ticketsChanged(ctx.live, [ticket]);
          },
        );
        return { ticket, comment: publicComment(posted.comment) };
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

    app.post<{ Params: { id: string }; Body: NewComment }>(
      "/api/documents/:id/comments",
      {
        schema: {
          params: documentParams,
          body: newCommentBody,
          response: { 201: answer("The Comment, posted on the Document", holding("comment", "Comment")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { document, posted } = await posting(
          async (tx, positioned) => {
            const document = await documentFor(tx, actor, request.params.id, "write");
            const place = { projectId: document.projectId, delegateId: null };
            return { document, posted: await post(tx, positioned, actor, { documentId: document.id }, place, request.body, document) };
          },
          ({ document, posted }) => {
            ctx.live.publish(documentTopic(document.id), { event: "comment", data: { comment: publicComment(posted.comment) } });
            pushWaiting(posted, { ticket: null, document: { id: document.id, title: document.title } });
          },
        );
        return reply.code(201).send({ comment: publicComment(posted.comment) });
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/documents/:id/comments",
      {
        schema: {
          params: documentParams,
          response: { 200: answer("The Document's Comments, oldest first", listing("comments", ref("Comment"))), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request) => {
        const document = await documentFor(ctx.db, await requireActor(ctx, request), request.params.id, "read");
        return { comments: (await listComments(ctx.db, { documentId: document.id })).map(publicComment) };
      },
    );
  };
}
