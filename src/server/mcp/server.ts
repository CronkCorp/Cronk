import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { bearerToken, type AppContext } from "../context.js";
import { hashToken } from "../identity/tokens.js";
import { callApi } from "./api.js";
import { registerTools } from "./tools.js";
import type { AgentSession, WaitingWork, Welcome } from "../api-types.js";

/** A Ticket Ready for the Agent, as its welcome lists it. */
type ReadyTicket = Welcome["readyTickets"][number];
import { followEvents, ownBaseUrl } from "./events.js";
import type { LiveEvent } from "../live/live-updates.js";
import { readyLine, waitingLines, welcomeText } from "./welcome.js";

/**
 * One MCP connection: its transport and server, the hash of the token that opened it (the
 * only token it answers), and when its Agent Session ends if it stays silent.
 */
interface Connection {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  tokenHash: string;
  endsIfSilentAt: Date;
  /** Stops pushing waiting work and newly Ready Tickets to it. */
  stopNotifying: () => void;
}

/** How often connections whose Agent Session went silent are forgotten. */
const SWEEP_INTERVAL_MS = 60_000;

const SESSION_ENDED = "This Agent Session has ended; reconnect to start a new one";

/**
 * Cronk's streamable-HTTP MCP endpoint, at `/mcp`. Each MCP session is one Agent Session.
 *
 * This is a thin client of the HTTP API (ADR 0010): it calls the API with the Agent's own
 * token, within the Agent Session, so every rule (tokens, access, Session liveness) is the
 * API's. An MCP session id is its Agent Session's id, and only the token that opened it may
 * use it, so the tools it offers always match that token.
 */
export function mcpRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    const connections = new Map<string, Connection>();

    const drop = async (id: string) => {
      const connection = connections.get(id);
      connections.delete(id);
      connection?.stopNotifying();
      await connection?.server.close();
    };
    // A Session that stayed silent has ended on the API's side; forget its connection too.
    const sweep = async () => {
      const now = ctx.clock.now();
      for (const [id, c] of connections) if (c.endsIfSilentAt <= now) await drop(id);
    };
    const sweeping = setInterval(() => void sweep(), SWEEP_INTERVAL_MS).unref();
    // Set once the server starts closing, so a connection still starting isn't held after the rest are dropped.
    let closing = false;
    app.addHook("preClose", async () => {
      closing = true;
      clearInterval(sweeping);
      // Every stream stops first, so none is opened again while the others' servers close.
      for (const c of connections.values()) c.stopNotifying();
      for (const id of [...connections.keys()]) await drop(id);
    });

    const handle = async (request: FastifyRequest, reply: FastifyReply) => {
      await sweep();
      const token = bearerToken(request);
      if (!token) return refuse(reply, 401, "Send one of your Agent's tokens as Authorization: Bearer <token>");
      const sessionId = request.headers["mcp-session-id"];

      if (typeof sessionId !== "string") {
        if (request.method !== "POST" || !isInitializeRequest(request.body)) {
          return refuse(reply, 400, "Start with an initialize request, without an Mcp-Session-Id header");
        }
        const started = await callApi(app, { token }, "POST", "/api/agent-sessions");
        if (started.status !== 201) return refuse(reply, started.status, started.body.error);
        const { session, welcome } = started.body as { session: AgentSession; welcome: Welcome };
        const server = new McpServer(
          { name: "cronk", version: "0.0.0" },
          { instructions: welcomeText(welcome, session.id), capabilities: { logging: {} } },
        );
        registerTools(server, { readOnly: welcome.readOnly, api: (caller) => (...args) => callApi(app, caller, ...args) });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => session.id, enableJsonResponse: true });
        // Work starting to wait for the Agent, and Tickets becoming Ready for it, reach it as log messages, from the API's own stream
        // of it, which ends as soon as the Agent Session does or its token is revoked. That stream needs
        // real HTTP, so when Cronk doesn't listen (its requests are only injected) nothing is pushed.
        const baseUrl = ownBaseUrl(app);
        const notify = ({ event, data }: LiveEvent) => {
          const notice = (message: string, about: object) =>
            void server.server.sendLoggingMessage({ level: "notice", logger: "cronk", data: { message, ...about } }).catch(() => {});
          if (event === "waiting") {
            const { waiting } = data as { waiting: WaitingWork };
            notice(`Work is waiting for you:\n${waitingLines(waiting).join("\n")}`, { waiting });
          } else if (event === "ticketReady") {
            const { ticket } = data as { ticket: ReadyTicket };
            notice(`A Ticket is now Ready for you:\n${readyLine(ticket)}\nClaim it with the \`tickets\` tool's \`claim\` action.`, { ticketReady: ticket });
          }
        };
        const stopNotifying = baseUrl
          ? await followEvents(baseUrl, { token, sessionId: session.id }, "/api/agent-sessions/current/events", notify)
          : () => {};
        if (closing) {
          stopNotifying();
          return refuse(reply, 503, "Cronk is shutting down; reconnect once it is back");
        }
        connections.set(session.id, {
          transport,
          server,
          tokenHash: hashToken(token),
          endsIfSilentAt: new Date(session.endsIfSilentAt),
          stopNotifying,
        });
        await server.connect(transport);
        return serve(transport, request, reply, token);
      }

      const connection = connections.get(sessionId);
      if (!connection) {
        // Not one this server holds (it restarted, say), so it can't go on: end it if it is the caller's.
        const ended = await callApi(app, { token, sessionId }, "DELETE", "/api/agent-sessions/current");
        return ended.status === 401 ? refuse(reply, 401, ended.body.error) : refuse(reply, 404, SESSION_ENDED);
      }
      // Anyone else naming the session is told it doesn't exist, and changes nothing.
      if (hashToken(token) !== connection.tokenHash) return refuse(reply, 404, SESSION_ENDED);
      // Asking the API for the Session checks the token and refreshes the Session (or ends it, for DELETE).
      const current = await callApi(app, { token, sessionId }, request.method === "DELETE" ? "DELETE" : "GET", "/api/agent-sessions/current");
      if (current.status >= 400) {
        await drop(sessionId);
        return current.status === 401 ? refuse(reply, 401, current.body.error) : refuse(reply, 404, SESSION_ENDED);
      }
      if (request.method === "DELETE") {
        await serve(connection.transport, request, reply, token);
        return drop(sessionId);
      }
      connection.endsIfSilentAt = new Date((current.body.session as AgentSession).endsIfSilentAt);
      return serve(connection.transport, request, reply, token);
    };

    for (const method of ["GET", "POST", "DELETE"] as const) {
      app.route({ method, url: "/mcp", schema: { hide: true }, handler: handle });
    }
  };
}

/** Hands the request to the MCP transport, which answers it, with the token for tools to call the API with. */
async function serve(transport: StreamableHTTPServerTransport, request: FastifyRequest, reply: FastifyReply, token: string) {
  reply.hijack();
  const raw = Object.assign(request.raw, { auth: { token, clientId: "cronk-agent", scopes: [] } });
  await transport.handleRequest(raw, reply.raw, request.body);
}

/** Answers with an HTTP error carrying a JSON-RPC error, as MCP clients expect. */
function refuse(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}
