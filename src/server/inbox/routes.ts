import type { FastifyInstance } from "fastify";
import { requireUser, type AppContext } from "../context.js";
import { answer, errors, ref } from "../schemas.js";
import { INBOX_KINDS, listInbox, type InboxItem } from "./inbox.js";
import { publicActivity } from "../coordination/activities.js";
import { inboxTopic } from "../live/topics.js";

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
                description: "Only items of these Agents: questions they asked, and Tickets delegated to them.",
              },
            },
          },
          response: {
            200: answer("The signed-in User's Inbox: blocking questions first, then the other items, each oldest first", { type: "object", required: ["items"], properties: { items: { type: "array", items: { anyOf: [questionItem, reviewItem] } } } }),
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

    app.get(
      "/api/inbox/events",
      {
        schema: {
          response: {
            200: {
              description:
                "A server-sent event stream for the signed-in User's Inbox, for as long as they stay signed in. It opens with a `ready` " +
                "event, then sends a `changed` event, with empty data, whenever the Inbox may have changed; fetch it again then.",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            ...errors(401, 403, 410),
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const canSee = async () => (await requireUser(ctx, request)).id === user.id;
        ctx.live.stream(reply, inboxTopic(user.id), canSee);
      },
    );
  };
}
