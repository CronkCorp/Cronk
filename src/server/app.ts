import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import swagger from "@fastify/swagger";
import type { Clock } from "./clock.js";
import { HttpError, SIGN_IN_COOKIE, type AppContext } from "./context.js";
import { createDatabase, migrate } from "./db/database.js";
import { addSharedSchemas, answer, errors, publicRoute } from "./schemas.js";
import { coordinationRoutes } from "./coordination/routes.js";
import { conversationRoutes } from "./conversation/routes.js";
import { agentRoutes } from "./identity/agent-routes.js";
import { mcpRoutes } from "./mcp/server.js";
import { identityRoutes } from "./identity/routes.js";
import { guidanceRoutes } from "./knowledge/guidance-routes.js";
import { knowledgeRoutes } from "./knowledge/routes.js";
import { portabilityRoutes } from "./portability/routes.js";
import { searchRoutes } from "./search/routes.js";
import { workRoutes } from "./work/routes.js";
import { workspaceRoutes } from "./workspace/routes.js";
import { LiveUpdates } from "./live/live-updates.js";
import { inboxRoutes } from "./inbox/routes.js";
import { watchClaimLapses } from "./coordination/lapses.js";

const healthSchema = { type: "object", required: ["status"], properties: { status: { type: "string", const: "ok" } } } as const;
/** Where the OpenAPI description is served; it takes any query string. */
const OPENAPI_PATH = "/api/openapi.json";

export interface AppConfig {
  databaseUrl: string;
  /** Mark the sign-in cookie Secure; turn on when served over HTTPS. */
  cookieSecure: boolean;
  /** Directory holding the built web client, served at `/`. The API works without it. */
  webRoot?: string | undefined;
}

/**
 * Builds the Cronk HTTP application: connects to Postgres, migrates the schema
 * and registers the API. The caller decides whether to listen or inject. `live` defaults to a
 * new `LiveUpdates`; tests pass their own to stage when events are published.
 */
export async function buildApp(opts: {
  config: AppConfig;
  clock: Clock;
  logger?: boolean;
  live?: LiveUpdates;
  /** How often to look for Claims that lapsed, to tell their watchers; every 5 seconds by default. */
  lapseCheckMs?: number;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Refuse fields a route doesn't declare (its schema's `additionalProperties: false`) instead of
    // silently dropping them, so a caller never hears that a change worked when nothing changed.
    // `allErrors` so an unknown field is named even when a required one is missing too: a misspelt field is both.
    ajv: { customOptions: { removeAdditional: false, allErrors: true } },
  });
  const db = createDatabase(opts.config.databaseUrl, (err) => app.log.warn({ err }, "Lost an idle database connection"));
  try {
    await migrate(db);
  } catch (err) {
    await db.end();
    throw err;
  }
  const ctx: AppContext = { db, clock: opts.clock, cookieSecure: opts.config.cookieSecure, live: opts.live ?? new LiveUpdates() };

  // Open live-update streams would otherwise keep the server from closing.
  app.addHook("preClose", async () => ctx.live.close());
  const stopWatchingLapses = watchClaimLapses(ctx, opts.lapseCheckMs ?? 5_000);
  app.addHook("onClose", async () => {
    stopWatchingLapses();
    await db.end();
  });
  // Every API route refuses query parameters it doesn't declare, including routes that declare none,
  // so a new route can't forget to. The web shell and the OpenAPI document take any query string.
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/") || route.url === OPENAPI_PATH) return;
    // Fastify also takes `query` for `querystring`; declaring both fails at startup, so fold it in.
    const { query, querystring: declared, ...schema } = (route.schema ?? {}) as Record<string, unknown>;
    // `properties: {}` so the OpenAPI description lists no query parameters rather than reading the schema as one.
    const querystring = (declared ?? query ?? { type: "object", properties: {} }) as Record<string, unknown>;
    // Only an inline object schema takes the default: beside a `$ref` it would refuse the declared parameters too.
    const inline = querystring.type === "object" && !("$ref" in querystring);
    route.schema = {
      ...schema,
      querystring: inline ? { additionalProperties: false, ...querystring } : querystring,
      // So every operation's description says it can be refused; a route's own 400 description wins.
      response: { ...errors(400), ...(schema.response as object | undefined) },
    };
  });
  // Every API error has the same shape: `{ error: "<message>" }`.
  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ ...err.details, error: err.message });
    const fastifyError = err as Partial<FastifyError>;
    if (fastifyError.validation) return reply.code(400).send({ error: validationMessage(fastifyError as FastifyError) });
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      return reply.code(fastifyError.statusCode).send({ error: fastifyError.message });
    }
    request.log.error(err);
    return reply.code(500).send({ error: "Something went wrong" });
  });
  await app.register(cookie);
  addSharedSchemas(app);
  // Describes every route from its schema; served at /api/openapi.json.
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Cronk",
        version: "0.0.0",
        description:
          "The Cronk HTTP API. Users call it signed in (the web client's cookie); Agents and scripts send one of an Agent's tokens " +
          "as `Authorization: Bearer <token>`. An Agent's access in a Project is the lowest of its Owner's access, the Project's " +
          "Agent Access, and its token (read-only tokens are refused every write). An Agent calls within one of its Agent Sessions " +
          "by also sending `Cronk-Agent-Session: <id>` (see /api/agent-sessions); the call refreshes the Session, and history records it. " +
          "Agents normally connect over MCP at /mcp instead, which does this for them.",
      },
      components: {
        securitySchemes: {
          signIn: { type: "apiKey", in: "cookie", name: SIGN_IN_COOKIE },
          agentToken: { type: "http", scheme: "bearer", description: "An Agent token issued at POST /api/agents/{id}/tokens" },
        },
      },
      security: [{ signIn: [] }, { agentToken: [] }],
    },
    // Shared schemas appear under `components.schemas` by their `$id`.
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, i) => (typeof json.$id === "string" ? json.$id : `def-${i}`) },
  });
  app.get(OPENAPI_PATH, { schema: { hide: true } }, async () => app.swagger());
  app.get(
    "/api/health",
    { schema: { ...publicRoute, response: { 200: answer("Cronk is up and its database answers", healthSchema) } } },
    async () => {
      await db.query("SELECT 1");
      return { status: "ok" };
    },
  );
  await app.register(identityRoutes(ctx));
  await app.register(agentRoutes(ctx));
  await app.register(workspaceRoutes(ctx));
  await app.register(workRoutes(ctx));
  await app.register(knowledgeRoutes(ctx));
  await app.register(guidanceRoutes(ctx));
  await app.register(coordinationRoutes(ctx));
  await app.register(conversationRoutes(ctx));
  await app.register(searchRoutes(ctx));
  await app.register(inboxRoutes(ctx));
  await app.register(portabilityRoutes(ctx));
  await app.register(mcpRoutes(ctx));

  const webRoot = opts.config.webRoot;
  if (webRoot) await app.register(staticFiles, { root: webRoot });
  app.setNotFoundHandler((request, reply) => {
    // The client routes in the browser, so unknown non-API pages get the app shell.
    if (webRoot && request.method === "GET" && !request.url.startsWith("/api/")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Not found" });
  });
  return app;
}

/** Names the field a caller sent that the route doesn't know; other schema errors keep Fastify's message. */
function validationMessage(err: FastifyError): string {
  const extra = err.validation?.find((issue) => issue.keyword === "additionalProperties");
  if (!extra) return err.message;
  const path = `${err.validationContext}${extra.instancePath.replaceAll("/", ".")}`;
  return `${path} has unknown field "${String(extra.params.additionalProperty)}"`;
}
