import type { FastifyInstance } from "fastify";
import { HttpError, requireUser, type AppContext } from "../context.js";
import { transaction, UNIQUE_VIOLATION } from "../db/database.js";
import { endAgentSessionsOf, liveAgentSessions, publicAgentSession } from "../coordination/agent-sessions.js";
import { nameSchema } from "../schemas.js";
import { requireAdmin } from "./access.js";
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
import type { User } from "./users.js";

const agentParams = { type: "object", properties: { id: { type: "string", format: "uuid" } } } as const;
const agentBody = { type: "object", required: ["name"], additionalProperties: false, properties: { name: nameSchema } } as const;

export function agentRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // Each User's own Agents with their live Agent Sessions; with `all`, an Admin sees every User's.
    app.get<{ Querystring: { all?: boolean } }>(
      "/api/agents",
      { schema: { querystring: { type: "object", additionalProperties: false, properties: { all: { type: "boolean" } } } } },
      async (request) => {
        const user = await requireUser(ctx, request);
        if (request.query.all) requireAdmin(user, "see every User's Agents");
        const agents = await listAgents(ctx.db, user.workspaceId, request.query.all ? undefined : user.id);
        const sessions = await liveAgentSessions(ctx.db, agents.map((a) => a.agent.id), ctx.clock.now());
        return {
          agents: agents.map((a) => ({ ...publicAgent(a.agent, a.owner), sessions: sessions.get(a.agent.id)!.map(publicAgentSession) })),
        };
      },
    );

    app.post<{ Body: { name: string } }>("/api/agents", { schema: { body: agentBody } }, async (request, reply) => {
      const user = await requireUser(ctx, request);
      const name = request.body.name.trim();
      const agent = await refusingTakenName(name, insertAgent(ctx.db, { owner: user, name, now: ctx.clock.now() }));
      return reply.code(201).send({ agent: publicAgent(agent, user) });
    });

    app.patch<{ Params: { id: string }; Body: { name: string } }>(
      "/api/agents/:id",
      { schema: { params: agentParams, body: agentBody } },
      async (request) => {
        const user = await requireUser(ctx, request);
        const agent = await ownAgent(ctx, user, request.params.id);
        const name = request.body.name.trim();
        return { agent: publicAgent(await refusingTakenName(name, renameAgent(ctx.db, agent, name)), user) };
      },
    );

    app.delete<{ Params: { id: string } }>("/api/agents/:id", { schema: { params: agentParams } }, async (request, reply) => {
      const user = await requireUser(ctx, request);
      await transaction(ctx.db, async (tx) => {
        const agent = await ownAgent(ctx, user, request.params.id);
        const now = ctx.clock.now();
        await removeAgent(tx, agent, now);
        await endAgentSessionsOf(tx, agent.id, now);
      });
      return reply.code(204).send();
    });

    app.get<{ Params: { id: string } }>("/api/agents/:id/tokens", { schema: { params: agentParams } }, async (request) => {
      const user = await requireUser(ctx, request);
      return { tokens: await listAgentTokens(ctx.db, await ownAgent(ctx, user, request.params.id)) };
    });

    // The secret is only ever returned here, once; Cronk keeps just its hash.
    app.post<{ Params: { id: string }; Body: { readOnly?: boolean } }>(
      "/api/agents/:id/tokens",
      {
        schema: {
          params: agentParams,
          body: { type: "object", additionalProperties: false, properties: { readOnly: { type: "boolean" } } },
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
          params: { type: "object", properties: { id: { type: "string", format: "uuid" }, tokenId: { type: "string", format: "uuid" } } },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const agent = await ownAgent(ctx, user, request.params.id);
        if (!(await revokeAgentToken(ctx.db, agent, request.params.tokenId, ctx.clock.now()))) throw new HttpError(404, "No such token");
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
