import type { FastifyInstance } from "fastify";
import { HttpError, requireActor, requireUser, type AppContext } from "../context.js";
import { transaction } from "../db/database.js";
import { waitingItemsChanged } from "../inbox/inbox.js";
import { agentTopic, documentTopic } from "../live/topics.js";
import { markSuggestionRejected, suggestionRejectionOf, waitingEvent, withWaitingWork } from "../coordination/waiting-work.js";
import { answer, errors, holding, listing, pathParams, ref } from "../schemas.js";
import {
  acceptSuggestion,
  createSuggestion,
  listAgentSuggestions,
  rejectSuggestion,
  SUGGESTION_STATES,
  suggestionFor,
  type NewSuggestion,
  type Suggestion,
  type SuggestionState,
} from "./suggestions.js";

const suggestionParams = pathParams({ id: { type: "string", format: "uuid", description: "The Suggestion's id." } });

/** The fields a Suggestion's content may hold; which ones depends on its item's kind. */
const contentBody = {
  type: "object",
  additionalProperties: false,
  description:
    "The item's new content: for a Document `title` and `body`; for a Term `name`, `definition`, `avoid` and `group`; for a Decision `title`, `body` and `group`; " +
    "for Guidance `markdown`. Fields left out keep what the base Version holds; a new Document needs a `title`, and its `body` is empty if left out.",
  properties: {
    title: { type: "string", maxLength: 500 },
    body: { type: "string", maxLength: 1_000_000 },
    name: { type: "string", maxLength: 200 },
    definition: { type: "string", maxLength: 100_000 },
    avoid: { type: "array", maxItems: 100, items: { type: "string", maxLength: 200 } },
    group: { type: ["string", "null"], maxLength: 200 },
    markdown: { type: "string", maxLength: 100_000 },
  },
} as const;

const itemBody = {
  description:
    "The item to change: a Document or Term by `id`, a Decision by `key`, or Guidance by its Project's key as `project` (left out for the Workspace's). " +
    "To suggest a new Document under a protected branch, name the Document it goes under as `parentId` instead of an `id`.",
  oneOf: [
    { type: "object", required: ["kind", "id"], additionalProperties: false, properties: { kind: { type: "string", enum: ["document", "term"] }, id: { type: "string", format: "uuid" } } },
    {
      type: "object",
      required: ["kind", "parentId"],
      additionalProperties: false,
      properties: { kind: { type: "string", const: "document" }, parentId: { type: "string", format: "uuid", description: "The Document the new one goes under." } },
    },
    { type: "object", required: ["kind", "key"], additionalProperties: false, properties: { kind: { type: "string", const: "decision" }, key: { type: "string", maxLength: 30 } } },
    {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: { kind: { type: "string", const: "guidance" }, project: { type: ["string", "null"], maxLength: 10 } },
    },
  ],
} as const;

const newSuggestionBody = {
  type: "object",
  required: ["item", "baseVersion", "content", "reasoning"],
  additionalProperties: false,
  properties: {
    item: itemBody,
    baseVersion: { type: "integer", minimum: 0, description: "The Version of the item the change starts from, as you read it; 0 only for Guidance nobody has written, and for a new Document." },
    content: contentBody,
    reasoning: { type: "string", minLength: 1, maxLength: 10_000, description: "Why the change, in Markdown, for the User who reviews it." },
    ticket: {
      type: "string",
      maxLength: 30,
      description:
        "The key of the Ticket you hold the Claim on that the Suggestion came from; its Assignee reviews it. It must be of the item's Project, or, for a " +
        "Workspace item, of an open Project. Left out, the Ticket of the one such Claim your Agent Session holds; needed when it holds several.",
    },
  },
} as const;

/**
 * Suggestions (ADR 0014): Agents propose new Versions of Protected items, which Users accept, edit and
 * accept, or reject with a reason. Whoever can read where an item lives can read its Suggestions.
 */
export function suggestionRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    /** Tells whoever a change to `suggestion` concerns: its reviewer's Inbox and, once accepted, the watchers of a Document it changed. */
    const changed = (suggestion: Suggestion) => {
      waitingItemsChanged(ctx.live, [suggestion.reviewer?.id]);
      if (suggestion.state === "accepted" && suggestion.item.kind === "document") {
        ctx.live.publish(documentTopic(suggestion.item.id!), { event: "version", data: { version: suggestion.resultVersion } });
      }
    };

    app.post<{ Body: NewSuggestion }>(
      "/api/suggestions",
      {
        schema: {
          body: newSuggestionBody,
          response: {
            201: answer("The new Suggestion, open, waiting for a User", holding("suggestion", "Suggestion")),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const suggestion = await transaction(ctx.db, (tx) => createSuggestion(tx, actor, request.body, ctx.clock.now()));
        changed(suggestion);
        return reply.code(201).send({ suggestion });
      },
    );

    app.get<{ Querystring: { state?: SuggestionState[] } }>(
      "/api/suggestions",
      {
        schema: {
          querystring: {
            type: "object",
            properties: { state: { type: "array", items: { type: "string", enum: SUGGESTION_STATES }, description: "Only Suggestions in one of these states." } },
          },
          response: {
            200: answer("The calling Agent's own Suggestions, newest first, on items it can still read", listing("suggestions", ref("Suggestion"))),
            ...errors(400, 401, 403, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        if (actor.kind !== "agent") throw new HttpError(403, "Only an Agent lists its own Suggestions; a User finds those they review in their Inbox");
        return { suggestions: await listAgentSuggestions(ctx.db, actor, request.query.state) };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/suggestions/:id",
      {
        schema: {
          params: suggestionParams,
          response: { 200: answer("The Suggestion, with its item as it stands now", holding("suggestion", "Suggestion")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request) => ({ suggestion: await suggestionFor(ctx.db, await requireActor(ctx, request), request.params.id, "read") }),
    );

    app.post<{ Params: { id: string }; Body: { content?: Record<string, unknown> } | undefined }>(
      "/api/suggestions/:id/accept",
      {
        schema: {
          params: suggestionParams,
          body: {
            type: ["object", "null"],
            additionalProperties: false,
            properties: {
              content: {
                ...contentBody,
                description:
                  "Edit and accept: the content as the User changed it, fields left out as suggested. If it differs from the Suggestion, the new Version " +
                  "is credited to the User and linked to the Suggestion; left out, or unchanged, the Version is credited to the Agent.",
              },
            },
          },
          response: {
            200: answer("The Suggestion, accepted, naming the Version it made", holding("suggestion", "Suggestion")),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const suggestion = await transaction(ctx.db, (tx) => acceptSuggestion(tx, user, request.params.id, request.body?.content, ctx.clock.now()));
        changed(suggestion);
        return { suggestion };
      },
    );

    app.post<{ Params: { id: string }; Body: { reason: string } }>(
      "/api/suggestions/:id/reject",
      {
        schema: {
          params: suggestionParams,
          body: {
            type: "object",
            required: ["reason"],
            additionalProperties: false,
            properties: { reason: { type: "string", maxLength: 10_000, description: "Why, in Markdown; required. It reaches the Agent as Waiting Work." } },
          },
          response: { 200: answer("The Suggestion, rejected", holding("suggestion", "Suggestion")), ...errors(400, 401, 403, 404, 409, 410) },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        // The rejection waits for the Agent that made it, pushed to it once committed.
        const { suggestion } = await withWaitingWork(
          ctx,
          async (tx, positioned) => {
            const suggestion = await rejectSuggestion(tx, user, request.params.id, request.body.reason, ctx.clock.now());
            const seq = await markSuggestionRejected(tx, user.workspaceId, suggestion, ctx.clock.now(), positioned);
            return { suggestion, seq };
          },
          ({ suggestion, seq }) => {
            if (seq !== undefined) ctx.live.publish(agentTopic(suggestion.proposedBy.id), waitingEvent(seq, suggestionRejectionOf(suggestion)));
          },
        );
        changed(suggestion);
        return { suggestion };
      },
    );
  };
}
