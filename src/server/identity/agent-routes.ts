import type { FastifyInstance } from "fastify";
import { HttpError, requireUser, type AppContext } from "../context.js";
import { transaction, UNIQUE_VIOLATION } from "../db/database.js";
import { answer, errors, holding, listing, nameSchema, noContent, pathParams, ref } from "../schemas.js";
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

const agentId = { type: "string", format: "uuid", description: "The Agent's id." } as const;
const agentParams = pathParams({ id: agentId });
const agentAnswer = holding("agent", "Agent");
const agentBody = { type: "object", required: ["name"], additionalProperties: false, properties: { name: nameSchema } } as const;

export function agentRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // Each User's own Agents; with `all`, an Admin sees every User's.
    app.get<{ Querystring: { all?: boolean } }>(
      "/api/agents",
      {
        schema: {
          querystring: { type: "object", properties: { all: { type: "boolean" } } },
          response: {
            200: answer("The Agents, by Owner then name", listing("agents", ref("Agent"))),
            ...errors(400, 401, 403),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        if (request.query.all) requireAdmin(user, "see every User's Agents");
        const agents = await listAgents(ctx.db, user.workspaceId, request.query.all ? undefined : user.id);
        return { agents: agents.map((a) => publicAgent(a.agent, a.owner)) };
      },
    );

    app.post<{ Body: { name: string } }>(
      "/api/agents",
      {
        schema: {
          body: agentBody,
          response: { 201: answer("The new Agent, owned by the caller", agentAnswer), ...errors(400, 401, 403, 409) },
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
          response: { 200: answer("The renamed Agent", agentAnswer), ...errors(400, 401, 403, 404, 409) },
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
          response: { 204: noContent("The Agent is removed and its tokens revoked"), ...errors(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        await transaction(ctx.db, async (tx) => removeAgent(tx, await ownAgent(ctx, user, request.params.id), ctx.clock.now()));
        return reply.code(204).send();
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/agents/:id/tokens",
      {
        schema: {
          params: agentParams,
          response: {
            200: answer("The Agent's tokens, oldest first, without their secrets", listing("tokens", ref("AgentToken"))),
            ...errors(400, 401, 403, 404),
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
            ...errors(400, 401, 403, 404),
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
          response: { 204: noContent("The token is revoked"), ...errors(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const agent = await ownAgent(ctx, user, request.params.id);
        if (!(await revokeAgentToken(ctx.db, agent, request.params.tokenId))) throw new HttpError(404, "No such token");
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
