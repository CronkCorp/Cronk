import type { FastifyInstance } from "fastify";
import type { Actor } from "../actor.js";
import { HttpError, requireActor, requireUser, type AppContext } from "../context.js";
import { userActor } from "../actor.js";
import { findStatusToMoveInto, listStatuses, type Status } from "../work/projects.js";
import { updateTicket, type Ticket } from "../work/tickets.js";
import { checkChoices, dependentNote, dependentsOf, REOPEN_CHOICES, type Dependent, type ReopenChoice } from "../work/reopen.js";
import { clearClaim } from "../coordination/claims.js";
import type { Queryable } from "../db/database.js";
import { answer, artifactIdParam, documentIdParam, errors, listing, pathParams, ref, savedHolding, ticketKeyParam } from "../schemas.js";
import { documentFor } from "../knowledge/document-reads.js";
import { avoidedWordsIn, titleAndBody } from "../knowledge/avoided-words.js";
import { ticketFor } from "../work/ticket-reads.js";
import { findActivity, markAnswered, publicActivity, type Activity } from "../coordination/activities.js";
import { agentTopic, artifactTopic, documentTopic, ticketTopic } from "../live/topics.js";
import { ticketsChanged } from "../work/ticket-changes.js";
import { tellNewlyReady } from "../coordination/ready.js";
import { inboxesChanged } from "../inbox/inbox.js";
import { MENTION_SYNTAX } from "../../shared/values.js";
import { markWaiting, waitingEvent, withWaitingWork, type CommentPlace, type CommentWork, type Positioned, type WaitingFor } from "../coordination/waiting-work.js";
import type { Document } from "../knowledge/documents.js";
import { artifactFor } from "../files/artifact-routes.js";
import { findArtifactVersion } from "../files/artifacts.js";
import { findComment, insertComment, listComments, publicComment, type Comment, type CommentTarget } from "./comments.js";

const ticketParams = pathParams({ key: ticketKeyParam });
const documentParams = pathParams({ id: documentIdParam });
const artifactParams = pathParams({ id: artifactIdParam });

interface NewComment {
  body: string;
  /** Only on an Artifact: the Version being viewed. */
  version?: number;
  replyToCommentId?: string;
  replyToActivityId?: string;
  anchor?: { passage: string };
  /** Set only by the send-back route, never from a request body. */
  sendBack?: boolean;
}

const id = { type: "string", format: "uuid" } as const;

interface ReopenBody {
  comment: string;
  statusId?: string;
  dependents: Record<string, ReopenChoice>;
}

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

/** What a Comment on an Artifact takes: a Comment's fields, but no anchor nor Activity to reply to, and the Version being viewed. */
const { anchor: _anchor, replyToActivityId: _activity, ...commentFields } = newCommentBody.properties;
const newArtifactCommentBody = {
  ...newCommentBody,
  properties: {
    ...commentFields,
    replyToCommentId: { ...id, description: "The Comment this one replies to, on the same Artifact." },
    version: {
      type: "integer",
      minimum: 1,
      description: "The number of the Version being viewed, which the Comment records; the latest Version if left out.",
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
      const comment = await insertComment(tx, target, actor, { body: input.body, replyToCommentId, replyToActivityId, anchor, sendBack: input.sendBack }, ctx.clock.now());
      // A User answers a question by replying to it; the first such reply is its answer.
      const answered = activity && actor.kind === "user" && (await markAnswered(tx, activity, comment.id)) ? await findActivity(tx, activity.ticketId, activity.id) : undefined;
      const asker = answered ? { agentId: answered.agent.id } : null;
      return { comment, answered, waiting: await markWaiting(tx, actor, comment, place, asker, comment.at, positioned) };
    };

    /** Runs `fn` in a transaction, then `committed`, keeping the positions it takes expected meanwhile (see `withWaitingWork`). */
    const posting = <T,>(fn: (tx: Queryable, positioned: Positioned) => Promise<T>, committed: (result: T) => void): Promise<T> =>
      withWaitingWork(ctx, fn, committed);

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
    const pushWaiting = (posted: Posted, on: Pick<CommentWork, "ticket" | "document" | "artifact">) => {
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
          response: { 201: answer("The Comment, posted on the Ticket", savedHolding("comment", "Comment")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { ticket, posted, avoidedWords } = await posting(
          async (tx, positioned) => {
            const ticket = await ticketFor(tx, actor, request.params.key, "write");
            const place = { projectId: ticket.projectId, delegateId: ticket.delegate?.id ?? null, publisherId: null };
            const posted = await post(tx, positioned, actor, { ticketId: ticket.id }, place, request.body);
            return { ticket, posted, avoidedWords: await avoidedWordsIn(tx, actor, ticket.projectId, titleAndBody({ body: request.body.body })) };
          },
          ({ ticket, posted }) => {
            ctx.live.publish(ticketTopic(ticket.id), { event: "comment", data: { comment: publicComment(posted.comment) } });
            if (posted.answered) {
              ctx.live.publish(ticketTopic(ticket.id), { event: "activity", data: { activity: publicActivity(posted.answered) } });
              inboxesChanged(ctx.live, [posted.answered.agent.owner.id]);
            }
            pushWaiting(posted, { ticket: { key: ticket.key, title: ticket.title }, document: null, artifact: null });
          },
        );
        return reply.code(201).send({ comment: publicComment(posted.comment), avoidedWords });
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
            const status = await statusOf(tx, ticket, "started", request.body.statusId);
            const moved = await updateTicket(tx, ticket, { status, sendBack: true }, actor, ctx.clock.now());
            const place = { projectId: ticket.projectId, delegateId: ticket.delegate?.id ?? null, publisherId: null };
            return { ticket: moved, posted: await post(tx, positioned, actor, { ticketId: ticket.id }, place, { body: request.body.comment, sendBack: true }) };
          },
          ({ ticket, posted }) => {
            ctx.live.publish(ticketTopic(ticket.id), { event: "comment", data: { comment: publicComment(posted.comment) } });
            pushWaiting(posted, { ticket: { key: ticket.key, title: ticket.title }, document: null, artifact: null });
            inboxesChanged(ctx.live, [ticket.assignee?.id]);
            ticketsChanged(ctx.live, [ticket]);
          },
        );
        // Sending it back makes it Ready again; In Review, it wasn't Ready before.
        await tellNewlyReady(ctx, [ticket.id], new Map());
        return { ticket, comment: publicComment(posted.comment) };
      },
    );

    // An Inbox action: hands an Agent's Unverified completion back to its Delegate, with a Comment saying why.
    app.post<{ Params: { key: string }; Body: ReopenBody }>(
      "/api/tickets/:key/reopen",
      {
        schema: {
          params: ticketParams,
          body: {
            type: "object",
            required: ["comment", "dependents"],
            additionalProperties: false,
            properties: {
              comment: { ...newCommentBody.properties.body, description: `Why the completion is Reopened, as Markdown. ${MENTION_SYNTAX}` },
              statusId: { ...id, description: "A Started Status of the Ticket's Project. The Project's first Started Status if left out." },
              dependents: {
                type: "object",
                maxProperties: 200,
                description:
                  "What happens to each Ticket it blocks that already continued on the work, by key: `keep` or `pause` for a Started one " +
                  "(`pause` releases its Claim and moves it to its Project's first Unstarted Status), `keep` or `reopen` for an Unverified one. " +
                  "Every such Ticket the caller can see needs a choice; others take none.",
                additionalProperties: { type: "string", enum: REOPEN_CHOICES },
              },
            },
          },
          response: {
            200: answer(
              "The Ticket, moved from its Completed Status back to a Started one with the same Delegate, and the Comment posted on it, which waits for its Delegate",
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
            if (ticket.verification !== "unverified") throw new HttpError(409, `${ticket.key} isn't an Unverified completion, so there is nothing to Reopen`);
            const now = ctx.clock.now();
            const reason = request.body.comment;
            const dependents = await dependentsOf(tx, actor, ticket);
            const chosen = checkChoices(dependents, request.body.dependents);
            const reopen = async (t: Ticket, statusId?: string) =>
              updateTicket(tx, t, { status: await statusOf(tx, t, "started", statusId), reopen: true, verification: null }, actor, now);
            const reopened = await reopen(ticket, request.body.statusId);
            const posts: { ticket: Ticket; posted: Posted }[] = [];
            const comment = async (t: Ticket, body: string) => {
              const place = { projectId: t.projectId, delegateId: t.delegate?.id ?? null, publisherId: null };
              const posted = await post(tx, positioned, actor, { ticketId: t.id }, place, { body });
              posts.push({ ticket: t, posted });
              return posted;
            };
            const posted = await comment(reopened, reason);
            // Each dependent's Agent is told what the Reopen means for it, where the User may write.
            const told = new Set([ticket.id, ...dependents.map((d) => d.ticket.id)]);
            const tellAgent = async ({ ticket: t, access }: Dependent, body: string) => {
              if (t.delegate && access === "write" && t.status.category !== "canceled") await comment(t, body);
            };
            // The Tickets the Reopen changed, then every one it blocks again, kept or not, whose watchers see that.
            const changed: Ticket[] = [reopened];
            const blockedAgain: Ticket[] = dependents.map((d) => d.ticket);
            for (const dependent of dependents) {
              const d = dependent.ticket;
              const choice = chosen.get(d.id) ?? "keep";
              if (choice === "pause") {
                await clearClaim(tx, d.id);
                const paused = await updateTicket(tx, d, { status: await statusOf(tx, d, "unstarted") }, actor, now);
                changed.push(paused);
                await tellAgent({ ...dependent, ticket: paused }, dependentNote(ticket, reason, { pausedTo: paused.status.name }));
              } else if (choice === "reopen") {
                const alsoReopened = await reopen(d);
                changed.push(alsoReopened);
                await tellAgent({ ...dependent, ticket: alsoReopened }, dependentNote(ticket, reason, { reopenedToo: true }));
                // What builds on a Ticket Reopened too is blocked again as well, so its Agents are told; it keeps going, so it
                // isn't changed, or locked, here.
                for (const next of await dependentsOf(tx, actor, d, { lock: false })) {
                  if (told.has(next.ticket.id)) continue;
                  told.add(next.ticket.id);
                  blockedAgain.push(next.ticket);
                  await tellAgent(next, dependentNote(alsoReopened, reason, { kept: next.ticket }));
                }
              } else {
                await tellAgent(dependent, dependentNote(ticket, reason, { kept: d }));
              }
            }
            return { ticket: reopened, posted, posts, changed, blockedAgain };
          },
          ({ posts, changed, blockedAgain }) => {
            for (const { ticket, posted } of posts) {
              ctx.live.publish(ticketTopic(ticket.id), { event: "comment", data: { comment: publicComment(posted.comment) } });
              pushWaiting(posted, { ticket: { key: ticket.key, title: ticket.title }, document: null, artifact: null });
            }
            inboxesChanged(ctx.live, changed.map((t) => t.assignee?.id));
            ticketsChanged(ctx.live, [...changed, ...blockedAgain]);
          },
        );
        // Reopening it makes it Ready again; Completed, it wasn't Ready before.
        await tellNewlyReady(ctx, [ticket.id], new Map());
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
          response: { 201: answer("The Comment, posted on the Document", savedHolding("comment", "Comment")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { document, posted, avoidedWords } = await posting(
          async (tx, positioned) => {
            const document = await documentFor(tx, actor, request.params.id, "write");
            const place = { projectId: document.projectId, delegateId: null, publisherId: null };
            const posted = await post(tx, positioned, actor, { documentId: document.id }, place, request.body, document);
            return { document, posted, avoidedWords: await avoidedWordsIn(tx, actor, document.projectId, titleAndBody({ body: request.body.body })) };
          },
          ({ document, posted }) => {
            ctx.live.publish(documentTopic(document.id), { event: "comment", data: { comment: publicComment(posted.comment) } });
            pushWaiting(posted, { ticket: null, document: { id: document.id, title: document.title }, artifact: null });
          },
        );
        return reply.code(201).send({ comment: publicComment(posted.comment), avoidedWords });
      },
    );

    app.post<{ Params: { id: string }; Body: NewComment }>(
      "/api/artifacts/:id/comments",
      {
        schema: {
          description:
            "Posts a Comment on an Artifact, recording the Version being viewed. It waits for the Agent that published that Version, " +
            "as well as any Agent it @mentions or whose question it answers. Needs Write where the Artifact belongs; Protected or not, anyone with Write may comment.",
          params: artifactParams,
          body: newArtifactCommentBody,
          response: { 201: answer("The Comment, posted on the Artifact", savedHolding("comment", "Comment")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { posted, avoidedWords } = await posting(
          async (tx, positioned) => {
            const artifact = await artifactFor(tx, actor, request.params.id, "write");
            const { version: number = artifact.version, ...input } = request.body;
            const version = await findArtifactVersion(tx, artifact.id, number);
            if (!version) throw new HttpError(400, `"${artifact.title}" has no Version ${number}; its latest is Version ${artifact.version}`);
            const place = { projectId: artifact.projectId, delegateId: null, publisherId: version.actor.kind === "agent" ? version.actor.id : null };
            const posted = await post(tx, positioned, actor, { artifactId: artifact.id, version: number }, place, input);
            return { artifact, posted, avoidedWords: await avoidedWordsIn(tx, actor, artifact.projectId, titleAndBody({ body: input.body })) };
          },
          ({ artifact, posted }) => {
            ctx.live.publish(artifactTopic(artifact.id), { event: "comment", data: { comment: publicComment(posted.comment) } });
            pushWaiting(posted, { ticket: null, document: null, artifact: { id: artifact.id, title: artifact.title, version: posted.comment.artifactVersion! } });
          },
        );
        return reply.code(201).send({ comment: publicComment(posted.comment), avoidedWords });
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/artifacts/:id/comments",
      {
        schema: {
          params: artifactParams,
          response: { 200: answer("The Artifact's Comments on all its Versions, oldest first", listing("comments", ref("Comment"))), ...errors(401, 404, 410) },
        },
      },
      async (request) => {
        const artifact = await artifactFor(ctx.db, await requireActor(ctx, request), request.params.id, "read");
        return { comments: (await listComments(ctx.db, { artifactId: artifact.id })).map(publicComment) };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/artifacts/:id/events",
      {
        schema: {
          params: artifactParams,
          response: {
            200: {
              description:
                "A server-sent event stream of the Artifact's changes as they happen, for as long as the caller can see it. It opens with a " +
                "`ready` event; each new Comment arrives as a `comment` event whose data is `{ comment }`, a Comment as JSON, and an `attachments` event " +
                "with no data says files attached to its Comments changed.",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            ...errors(401, 404, 410),
          },
        },
      },
      async (request, reply) => {
        const artifact = await artifactFor(ctx.db, await requireActor(ctx, request), request.params.id, "read");
        const canSee = async () => {
          const actor = await requireActor(ctx, request, { refreshSession: false });
          return !!(await artifactFor(ctx.db, actor, artifact.id, "read"));
        };
        ctx.live.stream(reply, artifactTopic(artifact.id), canSee);
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

/**
 * The Status of `ticket`'s Project in `category` with `statusId`, or its first one there; locked so it can't be removed
 * before the move commits.
 */
async function statusOf(tx: Queryable, ticket: Ticket, category: "started" | "unstarted", statusId?: string): Promise<Status> {
  const inCategory = (await listStatuses(tx, ticket.projectId)).filter((s) => s.category === category);
  const chosen = statusId === undefined ? inCategory[0] : inCategory.find((s) => s.id === statusId);
  const status = chosen && (await findStatusToMoveInto(tx, ticket.projectId, chosen.id));
  if (status) return status;
  const name = category === "started" ? "Started" : "Unstarted";
  if (statusId === undefined) throw new HttpError(409, `${ticket.projectKey} has no ${name} Status to move ${ticket.key} into`);
  throw new HttpError(400, `That isn't a ${name} Status of this Ticket's Project`);
}
