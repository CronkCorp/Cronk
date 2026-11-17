import type { FastifyInstance } from "fastify";
import { requireUser, type AppContext } from "../context.js";
import { answer, errors, ref } from "../schemas.js";
import { listTriage, TRIAGE_KINDS, type TriageItem } from "./triage.js";
import { decisionItem as inboxDecisionItem, hiddenBlocks, pausedTickets } from "./routes.js";

const timestamp = { type: "string", format: "date-time" } as const;

const suggestionItem = {
  type: "object",
  required: ["kind", "at", "suggestion"],
  description:
    "An open Suggestion nobody reviews: on a Workspace item, or on a Project item whose source Ticket's Assignee and Agent's Owner are both inactive. " +
    "It leaves Triage once a User accepts it, edits and accepts it, or rejects it with a reason, which reaches the Agent.",
  properties: {
    kind: { type: "string", const: "suggestion" },
    at: { ...timestamp, description: "When the Agent made it." },
    suggestion: ref("Suggestion"),
  },
} as const;

const decisionItem = {
  ...inboxDecisionItem,
  description:
    "A Decision an Agent proposed that nobody reviews: the Assignee of the Ticket it came from, if any, and the proposing Agent's Owner are both " +
    "deactivated. It leaves Triage once a User accepts or rejects it, with a reason, which reaches the Agent, or once either reviewer is reactivated.",
} as const;

const unverifiedItem = {
  type: "object",
  required: ["kind", "at", "ticket", "reports"],
  description:
    "An Agent's completion under Autonomous Delegation of a Ticket with no Assignee, Unverified until a User with Write in its Project Accepts it, with its Reports.",
  properties: {
    kind: { type: "string", const: "unverified" },
    at: { ...timestamp, description: "When the Agent completed it." },
    ticket: ref("Ticket"),
    reports: { type: "array", items: ref("Report") },
  },
} as const;

const unattendedItem = {
  type: "object",
  required: ["kind", "at", "reason", "ticket", "reports"],
  description:
    "An open Ticket, delegated or In Review, or an Agent's Unverified completion, whose Assignee is deactivated or has no access to its Project, " +
    "so nobody would act on it, with its Reports. It leaves Triage once a User reassigns it to an active User with access there, the Assignee " +
    "is reactivated or gets access back, or it is neither Unverified nor open and delegated or In Review, as when a User Accepts the completion. " +
    "Its Assignee, Delegate and Changes stay as they were until then.",
  properties: {
    kind: { type: "string", const: "unattended" },
    at: { ...timestamp, description: "When it entered its Status; for an Unverified completion, when it was completed." },
    reason: {
      type: "string",
      enum: ["deactivated", "no_access"],
      description: "Why its Assignee can't act on it: they are deactivated, or they have no access to its Project.",
    },
    ticket: ref("Ticket"),
    reports: { type: "array", items: ref("Report") },
  },
} as const;

const discoveredItem = {
  type: "object",
  required: ["kind", "at", "ticket", "reports", "blocks", "hiddenBlocks"],
  description:
    "A Discovered Ticket in Backlog and undelegated, with no Assignee or one who is deactivated or has no access to its Project. " +
    "A User with Write in its Project takes it by assigning it to themselves, " +
    "which moves it to their Inbox. `reports` is empty.",
  properties: {
    kind: { type: "string", const: "discovered" },
    at: { ...timestamp, description: "When the Agent filed it." },
    ticket: ref("Ticket"),
    reports: { type: "array", items: ref("Report") },
    blocks: pausedTickets,
    hiddenBlocks,
  },
} as const;

/** Triage: the shared list of waiting items with no clear User, each User seeing those they could act on. */
export function triageRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { kind?: TriageItem["kind"][]; project?: string[] } }>(
      "/api/triage",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              kind: { type: "array", items: { type: "string", enum: TRIAGE_KINDS }, description: "Only items of these kinds." },
              project: {
                type: "array",
                items: { type: "string", maxLength: 10 },
                description: "Only items in the Projects with these keys, in any case; this leaves out items on Workspace items.",
              },
            },
          },
          response: {
            200: answer(
              "The waiting items with no clear User that the signed-in User could act on, which takes Write where the item lives (Admins see all), oldest first",
              { type: "object", required: ["items"], properties: { items: { type: "array", items: { anyOf: [unverifiedItem, unattendedItem, decisionItem, suggestionItem, discoveredItem] } } } },
            ),
            ...errors(400, 401, 403, 410),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const { kind, project } = request.query;
        return { items: await listTriage(ctx.db, user, { kinds: kind, projectKeys: project }) };
      },
    );
  };
}
