import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import swagger from "@fastify/swagger";
import type { Clock } from "./clock.js";
import { HttpError, SIGN_IN_COOKIE, type AppContext } from "./context.js";
import { createDatabase, migrate } from "./db/database.js";
import { publicRoute } from "./schemas.js";
import { agentRoutes } from "./identity/agent-routes.js";
import { identityRoutes } from "./identity/routes.js";
import { workRoutes } from "./work/routes.js";
import { workspaceRoutes } from "./workspace/routes.js";

export interface AppConfig {
  databaseUrl: string;
  /** Mark the sign-in cookie Secure; turn on when served over HTTPS. */
  cookieSecure: boolean;
  /** Directory holding the built web client, served at `/`. The API works without it. */
  webRoot?: string | undefined;
}

/**
 * Builds the Cronk HTTP application: connects to Postgres, migrates the schema
 * and registers the API. The caller decides whether to listen or inject.
 */
export async function buildApp(opts: { config: AppConfig; clock: Clock; logger?: boolean }): Promise<FastifyInstance> {
  const db = createDatabase(opts.config.databaseUrl);
  try {
    await migrate(db);
  } catch (err) {
    await db.end();
    throw err;
  }
  const ctx: AppContext = { db, clock: opts.clock, cookieSecure: opts.config.cookieSecure };

  const app = Fastify({ logger: opts.logger ?? false });
  app.addHook("onClose", async () => db.end());
  // Every API error has the same shape: `{ error: "<message>" }`.
  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const fastifyError = err as { validation?: unknown; statusCode?: number; message?: string };
    if (fastifyError.validation || (fastifyError.statusCode && fastifyError.statusCode < 500)) {
      return reply.code(fastifyError.statusCode ?? 400).send({ error: fastifyError.message });
    }
    request.log.error(err);
    return reply.code(500).send({ error: "Something went wrong" });
  });
  await app.register(cookie);
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
          "Agent Access, and its token (read-only tokens are refused every write).",
      },
      components: {
        securitySchemes: {
          signIn: { type: "apiKey", in: "cookie", name: SIGN_IN_COOKIE },
          agentToken: { type: "http", scheme: "bearer", description: "An Agent token issued at POST /api/agents/{id}/tokens" },
        },
      },
      security: [{ signIn: [] }, { agentToken: [] }],
    },
  });
  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.get("/api/health", { schema: publicRoute }, async () => {
    await db.query("SELECT 1");
    return { status: "ok" };
  });
  await app.register(identityRoutes(ctx));
  await app.register(agentRoutes(ctx));
  await app.register(workspaceRoutes(ctx));
  await app.register(workRoutes(ctx));

  const webRoot = opts.config.webRoot;
  if (webRoot) await app.register(staticFiles, { root: webRoot });
  app.setNotFoundHandler((request, reply) => {
    // The client routes in the browser, so unknown non-API pages get the app shell.
    if (webRoot && request.method === "GET" && !request.url.startsWith("/api/")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Not found" });
  });
  return app;
}
