import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import swagger from "@fastify/swagger";
import type { Clock } from "./clock.js";
import { HttpError, isReading, requestActor, SIGN_IN_COOKIE, type AppContext } from "./context.js";
import { forReader } from "./identity/readable-only-in.js";
import { createDatabase, migrate } from "./db/database.js";
import { addSharedSchemas, answer, errors, publicRoute } from "./schemas.js";
import { coordinationRoutes } from "./coordination/routes.js";
import { conversationRoutes } from "./conversation/routes.js";
import { agentRoutes } from "./identity/agent-routes.js";
import { mcpRoutes } from "./mcp/server.js";
import { identityRoutes } from "./identity/routes.js";
import { guidanceRoutes } from "./knowledge/guidance-routes.js";
import { knowledgeRoutes } from "./knowledge/routes.js";
import { decisionRoutes } from "./knowledge/decision-routes.js";
import { termRoutes } from "./knowledge/term-routes.js";
import { suggestionRoutes } from "./knowledge/suggestion-routes.js";
import { portabilityRoutes } from "./portability/routes.js";
import { searchRoutes } from "./search/routes.js";
import { workRoutes } from "./work/routes.js";
import { documentLinkRoutes } from "./work/document-link-routes.js";
import { workspaceRoutes } from "./workspace/routes.js";
import { LiveUpdates } from "./live/live-updates.js";
import { inboxRoutes } from "./inbox/routes.js";
import { triageRoutes } from "./inbox/triage-routes.js";
import { transcriptRoutes } from "./transcripts/routes.js";
import { watchSilence } from "./coordination/lapses.js";
import { refuseWritesFromOtherSites } from "./identity/same-site.js";
import { attachmentRoutes } from "./files/attachment-routes.js";
import { artifactRoutes } from "./files/artifact-routes.js";
import { artifactHostRoutes, keepArtifactHostApart } from "./files/artifact-host.js";
import { createFileStore, type StorageConfig } from "./files/storage.js";
import { DEFAULT_IMPORT_MAX_BYTES } from "./portability/archive.js";
import { cachedSerializers } from "./serializers.js";

const healthSchema = { type: "object", required: ["status"], properties: { status: { type: "string", const: "ok" } } } as const;
/** Where the OpenAPI description is served; it takes any query string. */
const OPENAPI_PATH = "/api/openapi.json";
/** How long closing waits on the database unless told otherwise; see `closeWithinMs`. */
const DEFAULT_CLOSE_WITHIN_MS = 5_000;
/** How long closing gives a request cut off from the database to send its answer before ending every connection still open. */
const ANSWER_CUT_OFF_WITHIN_MS = 250;

export interface AppConfig {
  databaseUrl: string;
  /** Mark the sign-in cookie Secure; turn on when served over HTTPS. */
  cookieSecure: boolean;
  /**
   * The address Cronk is reached at, such as `https://cronk.example`. Writes made with the sign-in cookie are accepted
   * only from this site; without it, only from the host the request was sent to.
   */
  publicUrl?: string | undefined;
  /** Directory holding the built web client, served at `/`. The API works without it. */
  webRoot?: string | undefined;
  /** Where the files of Attachments and Artifacts are stored: a directory on local disk, or a bucket of an S3-compatible store. */
  storage: StorageConfig;
  /** The most bytes one import of an export may write, to local disk and the file store together; 50 GiB if not given. */
  importMaxBytes?: number | undefined;
  /**
   * The address Artifacts are served from, a hostname of their own such as `https://artifacts.cronk.example` (ADR 0007).
   * Without it, they are served from Cronk's own hostname in a stricter sandbox.
   */
  artifactsUrl?: string | undefined;
  /**
   * Check that each transaction takes the Workspace's blocking lock before locking any Ticket, failing the request if not,
   * so a path with the lock order wrong fails in tests. Costs a query or two per block, so it's off in production.
   */
  checkLockOrder: boolean;
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
  /**
   * How long closing may wait on the database, for requests and looks for lapsed Claims still running; 5 seconds by default.
   * What still waits then is cut off, taking at most a second more: its uncommitted work rolls back and a request answers 500.
   * A quarter of a second later, connections still open, such as one whose upload never finishes arriving, are ended without an answer.
   * So closing finishes within about 6 seconds, inside the 10 seconds `docker stop` gives by default before killing.
   */
  closeWithinMs?: number;
  /** Called once with a function that looks for lapsed Claims at once and resolves when that look is done; tests use it to know a look happened. */
  onLapseWatch?: (lookNow: () => Promise<void>) => void;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    schemaController: { compilersFactory: { buildSerializer: cachedSerializers } },
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
  const ctx: AppContext = {
    db,
    clock: opts.clock,
    cookieSecure: opts.config.cookieSecure,
    live: opts.live ?? new LiveUpdates(),
    log: app.log,
    files: createFileStore(opts.config.storage),
    importMaxBytes: opts.config.importMaxBytes ?? DEFAULT_IMPORT_MAX_BYTES,
    publicUrl: opts.config.publicUrl,
    artifactsUrl: opts.config.artifactsUrl,
    checkLockOrder: opts.config.checkLockOrder,
  };

  let closing = false;
  let closed = false;
  app.addHook("preClose", async () => {
    closing = true;
    // Open live-update streams would otherwise keep the server from closing.
    ctx.live.close();
    // Closing waits for requests still running and then for the database; a request or look waiting on the database
    // (on a lock, say) is cut off once the bound is up, rather than waited on forever. Counted from here, as the server
    // waits for its requests before `onClose` runs.
    // A request waiting on something else (a body that never finishes arriving, a download its client stops reading, a file
    // store that never answers) would keep the server open as long. Once a request cut off from the database has had its
    // time to answer, every connection still open is ended: its client sees the connection close without an answer, and
    // an upload cut short stores nothing.
    void db.cutOffAfter(opts.closeWithinMs ?? DEFAULT_CLOSE_WITHIN_MS).then(() => {
      if (!closed) setTimeout(() => app.server.closeAllConnections(), ANSWER_CUT_OFF_WITHIN_MS).unref();
    });
  });
  // A connection kept alive after its last answer would hold the server open until its client lets go, so once closing,
  // each answer ends its connection.
  app.addHook("onSend", async (_request, reply) => {
    if (closing) reply.header("connection", "close");
  });
  const lapses = watchSilence(ctx, opts.lapseCheckMs ?? 5_000);
  opts.onLapseWatch?.(lapses.lookNow);
  app.addHook("onClose", async () => {
    closed = true;
    // A look still running would otherwise query the pool after it has ended.
    await lapses.stop();
    await Promise.all([db.end(), ctx.files.close()]);
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
      // So every operation's description says it can be refused; a route's own 400 and 403 descriptions win. Every write
      // can be refused for coming from another site, and, if it takes a sign-in or token, to an Agent outside an Agent Session
      // (see `requireActor`).
      response: { ...errors(400), ...(isWrite(route.method) && errors(403)), ...(schema.response as object | undefined) },
    };
  });
  // No answer carries what its reader can't read, such as a Discovered Ticket's source in a Project they can't (see `readableOnlyIn`).
  app.addHook("preSerialization", async (request, _reply, payload) => forReader(db, requestActor(request), payload));
  ctx.live.shapeDataWith((request, data) => forReader(db, requestActor(request), data));
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
  // The Artifact hostname serves Artifacts' files and nothing else, so nothing of Cronk's runs or answers there (ADR 0007).
  keepArtifactHostApart(app, opts.config.artifactsUrl);
  refuseWritesFromOtherSites(app, opts.config.publicUrl);
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
          "as `Authorization: Bearer <token>`. A token starts with `cronk_at_` (Cronk's other secrets have their own prefix: `cronk_si_` " +
          "for the sign-in cookie, `cronk_inv_` for an invitation, `cronk_pr_` for a password reset). " +
          "An Agent's access in a Project is the lowest of its Owner's access, the Project's " +
          "Agent Access, and its token (read-only tokens are refused every write). An Agent calls within one of its Agent Sessions " +
          "by also sending `Cronk-Agent-Session: <id>`; the call refreshes the Session, and the Changes, Activities and Comments it makes " +
          "name it. An Agent changes " +
          "things only within an Agent Session: a write sent without one is refused with a 403, while reads work with the bare " +
          "token, without one. Agents normally connect over MCP at /mcp instead, which does this for them. A script " +
          "starts a Session with `POST /api/agent-sessions` (the answer's `session.id`), sends that id on each write, and ends it " +
          "with `DELETE /api/agent-sessions/current` when done; a Session also ends once it stays silent past the Workspace's " +
          "silence threshold. A signed-in write sent from another site (its `Origin`, or else `Referer`, isn't Cronk's own) " +
          "is refused with 403, as is one with the cookie that names no site.\n\n" +
          "```sh\n" +
          'SESSION=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" $CRONK/api/agent-sessions | jq -r .session.id)\n' +
          'curl -X POST -H "Authorization: Bearer $TOKEN" -H "Cronk-Agent-Session: $SESSION" -H "Content-Type: application/json" \\\n' +
          "  -d '{\"title\": \"Nightly report\"}' $CRONK/api/projects/CRONK/tickets\n" +
          'curl -X DELETE -H "Authorization: Bearer $TOKEN" -H "Cronk-Agent-Session: $SESSION" $CRONK/api/agent-sessions/current\n' +
          "```",
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
  await app.register(documentLinkRoutes(ctx));
  await app.register(attachmentRoutes(ctx));
  await app.register(artifactRoutes(ctx));
  await app.register(artifactHostRoutes(ctx));
  await app.register(knowledgeRoutes(ctx));
  await app.register(guidanceRoutes(ctx));
  await app.register(decisionRoutes(ctx));
  await app.register(termRoutes(ctx));
  await app.register(suggestionRoutes(ctx));
  await app.register(coordinationRoutes(ctx));
  await app.register(conversationRoutes(ctx));
  await app.register(searchRoutes(ctx));
  await app.register(inboxRoutes(ctx));
  await app.register(triageRoutes(ctx));
  await app.register(portabilityRoutes(ctx));
  await app.register(transcriptRoutes(ctx));
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

/** Whether a route's method changes something, rather than only reading. */
const isWrite = (method: string | string[]) => [method].flat().some((m) => !isReading(m));

/** Names the field a caller sent that the route doesn't know; other schema errors keep Fastify's message. */
function validationMessage(err: FastifyError): string {
  const extra = err.validation?.find((issue) => issue.keyword === "additionalProperties");
  if (!extra) return err.message;
  const path = `${err.validationContext}${extra.instancePath.replaceAll("/", ".")}`;
  return `${path} has unknown field "${String(extra.params.additionalProperty)}"`;
}
