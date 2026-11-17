import type { FastifyInstance } from "fastify";
import { requireUser, type AppContext } from "../context.js";
import { answer, errors, ref } from "../schemas.js";
import { INBOX_KINDS, listInbox, type InboxItem } from "./inbox.js";
import { publicActivity } from "../coordination/activities.js";
import { inboxTopic, TRIAGE_TOPIC } from "../live/topics.js";

const timestamp = { type: "string", format: "date-time" } as const;

const reviewItem = {
  type: "object",
  required: ["kind", "at", "ticket", "reports"],
  description: "A Ticket in an In Review Status the User is Assignee of, with its Reports.",
  properties: {
    kind: { type: "string", const: "review" },
    at: { ...timestamp, description: "When the Ticket entered its Status." },
    ticket: ref("Ticket"),
    reports: { type: "array", items: ref("Report") },
  },
} as const;

const unverifiedItem = {
  type: "object",
  required: ["kind", "at", "ticket", "reports"],
  description:
    "An Agent's completion under Autonomous Delegation of a Ticket the User is Assignee of, Unverified until a User Accepts it, with its Reports.",
  properties: {
    kind: { type: "string", const: "unverified" },
    at: { ...timestamp, description: "When the Agent completed it." },
    ticket: ref("Ticket"),
    reports: { type: "array", items: ref("Report") },
  },
} as const;

const questionItem = {
  type: "object",
  required: ["kind", "at", "question", "ticket"],
  description: "An open question of one of the User's Agents, with the Ticket it is on. A User answers it by replying to it with a Comment.",
  properties: {
    kind: { type: "string", const: "question" },
    at: { ...timestamp, description: "When the Agent asked it." },
    question: ref("Activity"),
    ticket: ref("TicketRef"),
  },
} as const;

const decisionItem = {
  type: "object",
  required: ["kind", "at", "decision", "ticket"],
  description:
    "A Decision an Agent proposed, which the User reviews: they are Assignee of the Ticket it came from, or, with none or while that Assignee " +
    "is deactivated, the proposing Agent's Owner. " +
    "It stays until a User accepts or rejects it; rejecting needs a reason, which reaches the Agent.",
  properties: {
    kind: { type: "string", const: "decision" },
    at: { ...timestamp, description: "When the Agent proposed it." },
    decision: ref("Decision"),
    ticket: { anyOf: [ref("TicketRef"), { type: "null" }], description: "The Ticket it came from; null for none." },
  },
} as const;

const suggestionItem = {
  type: "object",
  required: ["kind", "at", "suggestion"],
  description:
    "A Suggestion an Agent made on a Project item, which the User reviews: they are Assignee of the Ticket it came from, or, with none, the Agent's Owner. " +
    "It stays until a User accepts it, edits and accepts it, or rejects it with a reason, which reaches the Agent. Suggestions on Workspace items go to Triage.",
  properties: {
    kind: { type: "string", const: "suggestion" },
    at: { ...timestamp, description: "When the Agent made it." },
    suggestion: ref("Suggestion"),
  },
} as const;

/** What a Discovered Ticket in the Inbox or Triage pauses. */
export const pausedTickets = {
  type: "array",
  items: {
    allOf: [
      ref("BlockingRef"),
      {
        type: "object",
        required: ["canRemove"],
        properties: {
          canRemove: {
            type: "boolean",
            description:
              "Whether the User may remove the block (DELETE /api/tickets/{key}/relations/blocked_by/{otherKey} from the paused Ticket): Write on the paused Ticket, " +
              "and on this one too for a block a User added.",
          },
        },
      },
    ],
  },
  description: "The Tickets it blocks that the User can see, in key order, each with the Agent that added the block and why: what it pauses until finished or the block is removed.",
} as const;

/** How many Tickets a Discovered Ticket in the Inbox or Triage pauses that the User can't see. */
export const hiddenBlocks = {
  type: "integer",
  minimum: 0,
  description: "How many Tickets it blocks that the User can't see, which `blocks` leaves out.",
} as const;

const discoveredItem = {
  type: "object",
  required: ["kind", "at", "ticket", "reports", "blocks", "hiddenBlocks"],
  description:
    "A Discovered Ticket the User is Assignee of, in Backlog and undelegated, waiting for them to delegate it, keep it in Backlog (POST /api/tickets/{key}/keep) " +
    "or cancel it. Its `discovered` marker says which Agent filed it and from which Ticket. `reports` is empty.",
  properties: {
    kind: { type: "string", const: "discovered" },
    at: { ...timestamp, description: "When the Agent filed it." },
    ticket: ref("Ticket"),
    reports: { type: "array", items: ref("Report") },
    blocks: pausedTickets,
    hiddenBlocks,
  },
} as const;

/** The Inbox: a User's list of everything waiting on them. */
export function inboxRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { kind?: InboxItem["kind"][]; project?: string[]; agent?: string[] } }>(
      "/api/inbox",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              kind: { type: "array", items: { type: "string", enum: INBOX_KINDS }, description: "Only items of these kinds." },
              project: { type: "array", items: { type: "string", maxLength: 10 }, description: "Only items in the Projects with these keys, in any case." },
              agent: {
                type: "array",
                items: { type: "string", format: "uuid" },
                description:
                  "Only items of these Agents: questions they asked, Tickets delegated to them, Decisions they proposed, Suggestions they made and Discovered Tickets they filed.",
              },
            },
          },
          response: {
            200: answer("The signed-in User's Inbox: blocking questions first, then the other items, each oldest first", { type: "object", required: ["items"], properties: { items: { type: "array", items: { anyOf: [questionItem, reviewItem, unverifiedItem, decisionItem, suggestionItem, discoveredItem] } } } }),
            ...errors(400, 401, 403, 410),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const { kind, project, agent } = request.query;
        return { items: (await listInbox(ctx.db, user, { kinds: kind, projectKeys: project, agentIds: agent })).map((item) => (item.kind === "question" ? { ...item, question: publicActivity(item.question) } : item)) };
      },
    );

    app.get<{ Querystring: { triage?: boolean } }>(
      "/api/inbox/events",
      {
        schema: {
          querystring: {
            type: "object",
            properties: { triage: { type: "boolean", description: "Also send a `triage` event whenever Triage may have changed." } },
          },
          response: {
            200: {
              description:
                "A server-sent event stream for the signed-in User's Inbox, for as long as they stay signed in. It opens with a `ready` " +
                "event, then sends a `changed` event, with empty data, whenever the Inbox may have changed; fetch it again then. " +
                "With `triage`, it also sends a `triage` event, with empty data, whenever Triage may have changed for anyone; fetch `/api/triage` again then.",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            ...errors(401, 403, 410),
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const canSee = async () => (await requireUser(ctx, request)).id === user.id;
        // Triage rides on the same stream, so the app needs no second one, as browsers allow only a few per site.
        ctx.live.stream(reply, request.query.triage ? [inboxTopic(user.id), TRIAGE_TOPIC] : inboxTopic(user.id), canSee);
      },
    );
  };
}
