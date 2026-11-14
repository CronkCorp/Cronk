import type { FastifyInstance } from "fastify";
import type { Actor, AgentActor } from "../actor.js";
import { AGENT_SESSION_HEADER, HttpError, requireActor, type AppContext } from "../context.js";
import { requireWorkspaceAccess, visibleProjects } from "../identity/access.js";
import { publicAgent } from "../identity/agents.js";
import { listProjects } from "../work/projects.js";
import { getWorkspace } from "../workspace/workspaces.js";
import { accessSchema, answer, errors, holding, noContent, ref } from "../schemas.js";
import { endAgentSession, publicAgentSession, startAgentSession, type AgentSession } from "./agent-sessions.js";

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
