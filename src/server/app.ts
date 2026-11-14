import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { Clock } from "./clock.js";
import { HttpError, type AppContext } from "./context.js";
import { createDatabase, migrate } from "./db/database.js";
import { identityRoutes } from "./identity/routes.js";
import { workspaceRoutes } from "./workspace/routes.js";

export interface AppConfig {
  databaseUrl: string;
  /** Mark the session cookie Secure; turn on when served over HTTPS. */
  cookieSecure: boolean;
}

/**
 * Builds the Cronk HTTP application: connects to Postgres, migrates the schema
 * and registers the API. The caller decides whether to listen or inject.
 */
export async function buildApp(opts: { config: AppConfig; clock: Clock; logger?: boolean }): Promise<FastifyInstance> {
  const db = createDatabase(opts.config.databaseUrl);
  await migrate(db);
  const ctx: AppContext = { db, clock: opts.clock, cookieSecure: opts.config.cookieSecure };

  const app = Fastify({ logger: opts.logger ?? false });
  app.addHook("onClose", async () => db.end());
  app.setErrorHandler((err: unknown, _request, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    throw err;
  });
  await app.register(cookie);
  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { status: "ok" };
  });
  await app.register(identityRoutes(ctx));
  await app.register(workspaceRoutes(ctx));
  return app;
}
