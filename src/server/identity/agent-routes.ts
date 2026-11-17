import type { FastifyInstance } from "fastify";
import { HttpError, requireUser, type AppContext } from "../context.js";
import { transaction, UNIQUE_VIOLATION } from "../db/database.js";
import { endAgentSessionsOf, lastAgentSessionEnds, liveAgentSessions, publicAgentSession } from "../coordination/agent-sessions.js";
import { listAgentRecord } from "../coordination/agent-record.js";
import { answer, errors, holding, listing, nameSchema, noContent, pathParams, ref } from "../schemas.js";
import { readablePlaces, requireAdmin } from "./access.js";
import { userActor } from "../actor.js";
import { countDelegatedTickets, listClaimsOfSessions } from "../coordination/claims.js";
import {
  findAgent,
  insertAgent,
  issueAgentToken,
  listAgentTokens,
  listAgents,
  publicAgent,
  removeAgent,
  renameAgent,
  revokeAgentToken,
  type Agent,
} from "./agents.js";
import { findUserById, type User } from "./users.js";
import { waitingItemsChanged } from "../inbox/inbox.js";
import { agentsTopic } from "../live/topics.js";
import { claimsEnded } from "../coordination/ready.js";
import { clearDelegationsTo } from "../work/tickets.js";
import { ticketsChanged } from "../work/ticket-changes.js";

const agentId = { type: "string", format: "uuid", description: "The Agent's id." } as const;
const agentParams = pathParams({ id: agentId });
const agentAnswer = holding("agent", "Agent");
const agentBody = { type: "object", required: ["name"], additionalProperties: false, properties: { name: nameSchema } } as const;

export function agentRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // Each User's own Agents with their live Agent Sessions; with `all`, an Admin sees every User's.
    // With `removed`, the removed Agents instead, whose Agent Records stay readable.
    app.get<{ Querystring: { all?: boolean; removed?: boolean } }>(
      "/api/agents",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              all: { type: "boolean", description: "Every User's Agents, not just the caller's; only for an Admin." },
              removed: {
                type: "boolean",
                description: "The removed Agents, each with when it was removed, instead of the live ones. Their Agent Records stay readable.",
              },
            },
          },
          response: {
            200: answer("The Agents, by Owner then name; live ones unless `removed` is set", listing("agents", ref("Agent"))),
            ...errors(400, 401, 403, 410),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        if (request.query.all) requireAdmin(user, "see every User's Agents");
        const agents = await listAgents(ctx.db, user.workspaceId, request.query.all ? undefined : user.id, { removed: request.query.removed });
        const agentIds = agents.map((a) => a.agent.id);
        const now = ctx.clock.now();
        const sessions = await liveAgentSessions(ctx.db, agentIds, now);
        const lastEnded = await lastAgentSessionEnds(ctx.db, agentIds, now);
        const claims = await listClaimsOfSessions(ctx.db, [...sessions.values()].flat().map((s) => s.id));
        const delegated = await countDelegatedTickets(ctx.db, agentIds);
        // Tickets the caller can't read are left out of Claims and counts, as they are everywhere else.
        const readable = new Set((await readablePlaces(ctx.db, userActor(user))).projectIds);
        const readableClaims = (sessionId: string) =>
          claims.get(sessionId)!.flatMap((c) => (readable.has(c.projectId) ? [{ ticketKey: c.ticketKey, title: c.title }] : []));
        const readableCount = (agentId: string) =>
          [...delegated.get(agentId)!].reduce((sum, [projectId, count]) => sum + (readable.has(projectId) ? count : 0), 0);
        return {
          agents: agents.map((a) => ({
            ...publicAgent(a.agent, a.owner),
            sessions: sessions.get(a.agent.id)!.map((s) => ({ ...publicAgentSession(s), claims: readableClaims(s.id) })),
            lastSessionEndedAt: lastEnded.get(a.agent.id) ?? null,
            delegateTicketCount: readableCount(a.agent.id),
          })),
        };
      },
    );

    app.get(
      "/api/agents/events",
      {
        schema: {
          response: {
            200: {
              description:
                "A server-sent event stream for the signed-in User's own Agents, for as long as they stay signed in. It opens with a " +
                "`ready` event, then sends a `changed` event, with empty data, when one of their Agent Sessions may have started, " +
                "ended or fallen silent, Claimed or released a Ticket, or moved when it would fall silent; fetch the Agents again then. " +
                "These are noticed every few seconds, not at once.",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            ...errors(401, 403, 410),
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const canSee = async () => (await requireUser(ctx, request)).id === user.id;
        ctx.live.stream(reply, agentsTopic(user.id), canSee);
      },
    );

    app.post<{ Body: { name: string } }>(
      "/api/agents",
      {
        schema: {
          body: agentBody,
          response: { 201: answer("The new Agent, owned by the caller", agentAnswer), ...errors(400, 401, 403, 409, 410) },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const name = request.body.name.trim();
        const agent = await refusingTakenName(name, insertAgent(ctx.db, { owner: user, name, now: ctx.clock.now() }));
        return reply.code(201).send({ agent: publicAgent(agent, user) });
      },
    );

    app.patch<{ Params: { id: string }; Body: { name: string } }>(
      "/api/agents/:id",
      {
        schema: {
          params: agentParams,
          body: agentBody,
          response: { 200: answer("The renamed Agent", agentAnswer), ...errors(400, 401, 403, 404, 409, 410) },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const agent = await ownAgent(ctx, user, request.params.id);
        const name = request.body.name.trim();
        return { agent: publicAgent(await refusingTakenName(name, renameAgent(ctx.db, agent, name)), user) };
      },
    );

    app.delete<{ Params: { id: string } }>(
      "/api/agents/:id",
      {
        schema: {
          params: agentParams,
          response: {
            204: noContent("The Agent is removed, its tokens revoked, its Agent Sessions ended and it is cleared as Delegate of every Ticket"),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const { claimed, undelegated } = await transaction(ctx.db, async (tx) => {
          const agent = await ownAgent(ctx, user, request.params.id);
          const now = ctx.clock.now();
          await removeAgent(tx, agent, now);
          // Its Tickets are no longer delegated, as if its Owner had cleared each by hand.
          const undelegated = await clearDelegationsTo(tx, agent.id, userActor(user), now);
          const { ticketIds: claimed } = await endAgentSessionsOf(tx, agent.id, now);
          return { claimed, undelegated };
        });
        // The Agent is gone, so nothing is Ready for it, but their Claims ended.
        await claimsEnded(ctx, claimed);
        ticketsChanged(ctx.live, undelegated);
        // Its open questions leave its Owner's Inbox.
        waitingItemsChanged(ctx.live, [user.id]);
        return reply.code(204).send();
      },
    );

    // The Agent Record: what an Agent did across the Workspace, for its Owner or an Admin, even once the Agent is removed.
    app.get<{ Params: { id: string }; Querystring: { since?: string; limit: number } }>(
      "/api/agents/:id/record",
      {
        schema: {
          params: agentParams,
          querystring: {
            type: "object",
            properties: {
              since: { type: "string", format: "date-time", description: "Leave out what it did before this time." },
              limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "At most this many entries." },
            },
          },
          response: {
            200: answer(
              "The Agent Record: what the Agent did, newest first: the Changes it made, the Activities and Comments it wrote and the Versions it saved, " +
                "leaving out what the caller can't read. It stays readable to its Owner and Admins after the Agent is removed",
              listing("record", ref("AgentRecordEntry")),
            ),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const agent = await findAgent(ctx.db, user.workspaceId, request.params.id, { evenRemoved: true });
        if (!agent || (agent.ownerId !== user.id && user.role !== "admin")) throw new HttpError(404, "No such Agent");
        const owner = (await findUserById(ctx.db, agent.ownerId))!;
        const { since, limit } = request.query;
        const by = { id: agent.id, name: agent.name, owner: { id: owner.id, name: owner.name } };
        return { record: await listAgentRecord(ctx.db, userActor(user), by, { since: since === undefined ? undefined : new Date(since), limit }) };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/agents/:id/tokens",
      {
        schema: {
          params: agentParams,
          response: {
            200: answer("The Agent's tokens, oldest first, without their secrets", listing("tokens", ref("AgentToken"))),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        return { tokens: await listAgentTokens(ctx.db, await ownAgent(ctx, user, request.params.id)) };
      },
    );

    // The secret is only ever returned here, once; Cronk keeps just its hash.
    app.post<{ Params: { id: string }; Body: { readOnly?: boolean } }>(
      "/api/agents/:id/tokens",
      {
        schema: {
          params: agentParams,
          body: { type: "object", additionalProperties: false, properties: { readOnly: { type: "boolean" } } },
          response: {
            201: answer("The new token and its secret, sent as `Authorization: Bearer <secret>`; the secret is only ever returned here", {
              type: "object",
              required: ["token", "secret"],
              properties: { token: ref("AgentToken"), secret: { type: "string" } },
            }),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const agent = await ownAgent(ctx, user, request.params.id);
        const issued = await issueAgentToken(ctx.db, { agent, readOnly: request.body?.readOnly ?? false, now: ctx.clock.now() });
        return reply.code(201).send(issued);
      },
    );

    app.delete<{ Params: { id: string; tokenId: string } }>(
      "/api/agents/:id/tokens/:tokenId",
      {
        schema: {
          params: pathParams({ id: agentId, tokenId: { type: "string", format: "uuid", description: "The token's id." } }),
          response: { 204: noContent("The token is revoked"), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const agent = await ownAgent(ctx, user, request.params.id);
        const ended = await revokeAgentToken(ctx.db, agent, request.params.tokenId, ctx.clock.now());
        if (!ended) throw new HttpError(404, "No such token");
        // The Agent's other tokens may pick them up.
        await claimsEnded(ctx, ended.ticketIds);
        return reply.code(204).send();
      },
    );
  };
}

/**
 * One of `user`'s own Agents. Only an Agent's Owner manages it: an Admin, who can see
 * every Agent, is refused; anyone else is answered as if it didn't exist.
 */
async function ownAgent(ctx: AppContext, user: User, id: string): Promise<Agent> {
  const agent = await findAgent(ctx.db, user.workspaceId, id);
  if (!agent || (agent.ownerId !== user.id && user.role !== "admin")) throw new HttpError(404, "No such Agent");
  if (agent.ownerId !== user.id) throw new HttpError(403, "Only an Agent's Owner can change it");
  return agent;
}

/** Answers 409 when the Owner already has another Agent called `name`. */
async function refusingTakenName(name: string, saving: Promise<Agent>): Promise<Agent> {
  try {
    return await saving;
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new HttpError(409, `You already have an Agent called ${name}`);
    throw err;
  }
}
