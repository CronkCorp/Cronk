import type { FastifyInstance } from "fastify";
import { requireUser, type AppContext } from "../context.js";
import { answer, errors, ref } from "../schemas.js";
import { listInbox } from "./inbox.js";
import { publicActivity } from "../coordination/activities.js";

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
    app.get(
      "/api/inbox",
      {
        schema: {
          response: {
            200: answer("The signed-in User's Inbox: blocking questions first, then the other items, each oldest first", { type: "object", required: ["items"], properties: { items: { type: "array", items: { anyOf: [questionItem, reviewItem] } } } }),
            ...errors(401, 403, 410),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        return { items: (await listInbox(ctx.db, user)).map((item) => (item.kind === "question" ? { ...item, question: publicActivity(item.question) } : item)) };
      },
    );
  };
}
