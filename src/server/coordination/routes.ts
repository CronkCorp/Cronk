import type { FastifyInstance } from "fastify";
import type { Actor, AgentActor } from "../actor.js";
import { AGENT_SESSION_HEADER, HttpError, requireActor, type AppContext } from "../context.js";
import { requireWorkspaceAccess, visibleProjects } from "../identity/access.js";
import { publicAgent } from "../identity/agents.js";
import { listProjects } from "../work/projects.js";
import { getWorkspace } from "../workspace/workspaces.js";
import { endAgentSession, publicAgentSession, startAgentSession, type AgentSession } from "./agent-sessions.js";

const sessionHeader = {
  type: "object",
  required: [AGENT_SESSION_HEADER],
  properties: { [AGENT_SESSION_HEADER]: { type: "string", description: "The id of one of the Agent's live Agent Sessions" } },
} as const;

/**
 * Agent Sessions: an Agent starts one when it connects (the MCP server does this for
 * each MCP connection), makes calls within it by sending the Cronk-Agent-Session
 * header, and ends it when it disconnects.
 */
export function coordinationRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // Starts an Agent Session and returns it with the welcome the Agent gets on connecting.
    app.post("/api/agent-sessions", async (request, reply) => {
      const agent = requireAgent(await requireActor(ctx, request));
      const session = await startAgentSession(ctx.db, { agentId: agent.agent.id, tokenId: agent.tokenId, now: ctx.clock.now() });
      return reply.code(201).send({ session: publicAgentSession(session), welcome: await welcome(ctx, agent) });
    });

    // The Agent Session named by the Cronk-Agent-Session header; asking refreshes it, as every call in it does.
    app.get("/api/agent-sessions/current", { schema: { headers: sessionHeader } }, async (request) => {
      return { session: publicAgentSession(requireSession(await requireActor(ctx, request))) };
    });

    app.delete("/api/agent-sessions/current", { schema: { headers: sessionHeader } }, async (request, reply) => {
      const session = requireSession(await requireActor(ctx, request));
      await endAgentSession(ctx.db, session.id, ctx.clock.now());
      return reply.code(204).send();
    });
  };
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
async function welcome(ctx: AppContext, agent: AgentActor) {
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
