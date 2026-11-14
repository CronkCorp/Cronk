import type { FastifyInstance } from "fastify";
import type { Actor, AgentActor } from "../actor.js";
import { AGENT_SESSION_HEADER, HttpError, requireActor, type AppContext } from "../context.js";
import { requireWorkspaceAccess, visibleProjects } from "../identity/access.js";
import { publicAgent } from "../identity/agents.js";
import { listProjects } from "../work/projects.js";
import { getWorkspace } from "../workspace/workspaces.js";
import { accessSchema, answer, errors, holding, noContent, pathParams, ref, ticketKeyParam } from "../schemas.js";
import { transaction } from "../db/database.js";
import { ticketDetail, ticketDetailSchema, ticketFor } from "../work/routes.js";
import { claimNextReady, clearClaim, findLiveClaim, setClaim, type ReadyScope } from "./claims.js";
import { findTicketById } from "../work/tickets.js";
import { endAgentSession, publicAgentSession, startAgentSession, type AgentSession } from "./agent-sessions.js";

const ticketParams = pathParams({ key: ticketKeyParam });

const sessionHeader = {
  type: "object",
  required: [AGENT_SESSION_HEADER],
  properties: { [AGENT_SESSION_HEADER]: { type: "string", description: "The id of one of the Agent's live Agent Sessions" } },
} as const;

/** What an Agent is told when its Agent Session starts (see `welcome`). */
const welcomeSchema = {
  type: "object",
  required: ["workspace", "agent", "readOnly", "projects"],
  properties: {
    workspace: {
      anyOf: [{ type: "object", required: ["name"], properties: { name: { type: "string" } } }, { type: "null" }],
      description: "Null when the Workspace's Agent Access is None.",
    },
    agent: ref("Agent"),
    readOnly: { type: "boolean" },
    projects: {
      type: "array",
      description: "The unarchived Projects the Agent can see, with its access in each.",
      items: {
        type: "object",
        required: ["key", "name", "access"],
        properties: { key: { type: "string" }, name: { type: "string" }, access: accessSchema },
      },
    },
  },
} as const;

/**
 * Agent Sessions: an Agent starts one when it connects (the MCP server does this for
 * each MCP connection), makes calls within it by sending the Cronk-Agent-Session
 * header, and ends it when it disconnects.
 */
export function coordinationRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // Starts an Agent Session and returns it with the welcome the Agent gets on connecting.
    app.post(
      "/api/agent-sessions",
      {
        schema: {
          response: {
            201: answer("The new Agent Session, with the welcome the Agent gets on connecting", {
              type: "object",
              required: ["session", "welcome"],
              properties: { session: ref("AgentSession"), welcome: welcomeSchema },
            }),
            ...errors(401, 403, 410),
          },
        },
      },
      async (request, reply) => {
        const agent = requireAgent(await requireActor(ctx, request));
        const session = await startAgentSession(ctx.db, { agentId: agent.agent.id, tokenId: agent.tokenId, now: ctx.clock.now() });
        return reply.code(201).send({ session: publicAgentSession(session), welcome: await welcome(ctx, agent) });
      },
    );

    // The Agent Session named by the Cronk-Agent-Session header; asking refreshes it, as every call in it does.
    app.get(
      "/api/agent-sessions/current",
      {
        schema: {
          headers: sessionHeader,
          response: { 200: answer("The Agent Session, refreshed", holding("session", "AgentSession")), ...errors(400, 401, 403, 410) },
        },
      },
      async (request) => {
        return { session: publicAgentSession(requireSession(await requireActor(ctx, request))) };
      },
    );

    app.post(
      "/api/agent-sessions/current/next",
      {
        schema: {
          headers: sessionHeader,
          response: {
            200: answer("The Agent's next Ready Ticket, now Claimed by the Agent Session, with the Tickets around it", {
              type: "object",
              required: ["next"],
              properties: { next: { anyOf: [ticketDetailSchema, { type: "null" }], description: "Null when none of the Agent's Tickets is Ready." } },
            }),
            ...errors(400, 401, 403, 410),
          },
        },
      },
      async (request) => {
        const actor = requireAgent(await requireActor(ctx, request));
        const session = requireSession(actor);
        const now = ctx.clock.now();
        const scope = await readyScope(ctx, actor);
        const id = await transaction(ctx.db, (tx) => claimNextReady(tx, scope, session.id, now));
        return { next: id ? await ticketDetail(ctx.db, actor, (await findTicketById(ctx.db, id))!, now) : null };
      },
    );

    app.post<{ Params: { key: string } }>(
      "/api/tickets/:key/claim",
      {
        schema: {
          params: ticketParams,
          headers: sessionHeader,
          response: {
            200: answer("The Ticket, now Claimed by the Agent Session, with the Tickets around it", ticketDetailSchema),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request) => {
        const actor = requireAgent(await requireActor(ctx, request));
        const session = requireSession(actor);
        const now = ctx.clock.now();
        return transaction(ctx.db, async (tx) => {
          const ticket = await ticketFor(tx, actor, request.params.key, "write", { forUpdate: true });
          if (ticket.delegate?.id !== actor.agent.id) throw new HttpError(409, `${ticket.key} isn't delegated to ${actor.agent.name}`);
          if (ticket.status.category === "completed" || ticket.status.category === "canceled") {
            throw new HttpError(409, `${ticket.key} is ${ticket.status.name}, so there is nothing left to work on`);
          }
          const held = await findLiveClaim(tx, ticket.id, now);
          if (held && held.session.id !== session.id) throw new HttpError(409, `${ticket.key} is Claimed by another Agent Session`);
          await setClaim(tx, ticket.id, session.id, now);
          return ticketDetail(tx, actor, ticket, now);
        });
      },
    );

    app.delete<{ Params: { key: string } }>(
      "/api/tickets/:key/claim",
      {
        schema: {
          params: ticketParams,
          headers: sessionHeader,
          response: { 204: noContent("The Claim is released; the Ticket keeps its Delegate"), ...errors(400, 401, 403, 404, 409, 410) },
        },
      },
      async (request, reply) => {
        const actor = requireAgent(await requireActor(ctx, request));
        const session = requireSession(actor);
        await transaction(ctx.db, async (tx) => {
          const ticket = await ticketFor(tx, actor, request.params.key, "write", { forUpdate: true });
          const held = await findLiveClaim(tx, ticket.id, ctx.clock.now());
          if (held?.session.id !== session.id) throw new HttpError(409, `This Agent Session doesn't hold ${ticket.key}'s Claim`);
          await clearClaim(tx, ticket.id);
        });
        return reply.code(204).send();
      },
    );

    app.delete(
      "/api/agent-sessions/current",
      { schema: { headers: sessionHeader, response: { 204: noContent("The Agent Session has ended"), ...errors(400, 401, 403, 410) } } },
      async (request, reply) => {
        const session = requireSession(await requireActor(ctx, request));
        await endAgentSession(ctx.db, session.id, ctx.clock.now());
        return reply.code(204).send();
      },
    );
  };
}

/** Where the Agent looks for Ready Tickets: the unarchived Projects it may write in. */
async function readyScope(ctx: AppContext, agent: AgentActor): Promise<ReadyScope> {
  const projects = await visibleProjects(ctx.db, agent, await listProjects(ctx.db, agent.owner.workspaceId, false));
  return { agentId: agent.agent.id, projectIds: projects.filter((p) => p.access === "write").map((p) => p.id) };
}

function requireAgent(actor: Actor): AgentActor {
  if (actor.kind !== "agent") throw new HttpError(403, "Only an Agent has Agent Sessions");
  return actor;
}

function requireSession(actor: Actor): AgentSession {
  const session = requireAgent(actor).session;
  if (!session) throw new HttpError(400, "Name the Agent Session in the Cronk-Agent-Session header");
  return session;
}

/**
 * What an Agent is told when it connects: who it is and for whom, whether it may only
 * read, and the Projects it can see. The Workspace's name is left out if the Workspace's
 * Agent Access is None.
 */
export async function welcome(ctx: AppContext, agent: AgentActor) {
  const workspaceId = agent.owner.workspaceId;
  const readable = await requireWorkspaceAccess(ctx.db, agent, "read").then(
    () => true,
    (err: unknown) => {
      if (err instanceof HttpError) return false;
      throw err;
    },
  );
  const projects = await visibleProjects(ctx.db, agent, await listProjects(ctx.db, workspaceId, false));
  return {
    workspace: readable ? { name: (await getWorkspace(ctx.db, workspaceId)).name } : null,
    agent: publicAgent(agent.agent, agent.owner),
    readOnly: agent.readOnly,
    projects: projects.map((p) => ({ key: p.key, name: p.name, access: p.access })),
  };
}
