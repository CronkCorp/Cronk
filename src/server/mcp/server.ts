import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppContext } from "../context.js";
import { callApi } from "./api.js";
import { registerTools } from "./tools.js";
import { welcomeText, type Welcome } from "./welcome.js";

/** One MCP connection: its transport and server, and when its Agent Session ends if it stays silent. */
interface Connection {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  endsIfSilentAt: Date;
}

interface PublicSession {
  id: string;
  endsIfSilentAt: string;
}

/**
 * Cronk's streamable-HTTP MCP endpoint, at `/mcp`. Each MCP session is one Agent Session.
 *
 * This is a thin client of the HTTP API (ADR 0010): it calls the API with the Agent's own
 * token, within the Agent Session, so every rule (tokens, access, Session liveness) is the
 * API's. An MCP session id is its Agent Session's id.
 */
export function mcpRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    const connections = new Map<string, Connection>();

    const drop = async (id: string) => {
      const connection = connections.get(id);
      connections.delete(id);
      await connection?.server.close();
    };
    // Sessions that went silent are over on the API's side; forget them here too.
    const sweep = async () => {
      const now = ctx.clock.now();
      for (const [id, c] of connections) if (c.endsIfSilentAt <= now) await drop(id);
    };
    app.addHook("preClose", async () => {
      for (const id of [...connections.keys()]) await drop(id);
    });

    const handle = async (request: FastifyRequest, reply: FastifyReply) => {
      await sweep();
      const token = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? "")?.[1];
      if (!token) return refuse(reply, 401, "Send one of your Agent's tokens as Authorization: Bearer <token>");
      const sessionId = request.headers["mcp-session-id"];

      if (typeof sessionId !== "string") {
        if (request.method !== "POST" || !isInitializeRequest(request.body)) {
          return refuse(reply, 400, "Start with an initialize request, without an Mcp-Session-Id header");
        }
        const started = await callApi(app, { token }, "POST", "/api/agent-sessions");
        if (started.status !== 201) return refuse(reply, started.status, started.body.error);
        const { session, welcome } = started.body as { session: PublicSession; welcome: Welcome };
        const server = new McpServer({ name: "cronk", version: "0.0.0" }, { instructions: welcomeText(welcome, session.id) });
        registerTools(server, { readOnly: welcome.readOnly, api: (caller) => (...args) => callApi(app, caller, ...args) });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => session.id, enableJsonResponse: true });
        connections.set(session.id, { transport, server, endsIfSilentAt: new Date(session.endsIfSilentAt) });
        await server.connect(transport);
        return serve(transport, request, reply, token);
      }

      const connection = connections.get(sessionId);
      // Asking the API for the Session checks the token and refreshes the Session.
      const current = await callApi(app, { token, sessionId }, request.method === "DELETE" ? "DELETE" : "GET", "/api/agent-sessions/current");
      if (current.status === 401) return refuse(reply, 401, current.body.error);
      if (!connection || current.status >= 400) {
        // Over (or never ours): the client has to start a new Agent Session.
        await drop(sessionId);
        return refuse(reply, 404, "This Agent Session has ended; reconnect to start a new one");
      }
      if (request.method === "DELETE") {
        await serve(connection.transport, request, reply, token);
        return drop(sessionId);
      }
      connection.endsIfSilentAt = new Date((current.body.session as PublicSession).endsIfSilentAt);
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
