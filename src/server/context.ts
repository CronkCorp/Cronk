import type { FastifyReply, FastifyRequest } from "fastify";
import { userActor, type Actor, type AgentActor } from "./actor.js";
import type { Clock } from "./clock.js";
import { findLiveAgentSession, touchAgentSession } from "./coordination/agent-sessions.js";
import type { Database } from "./db/database.js";
import { agentForToken } from "./identity/agents.js";
import { userForSignIn } from "./identity/sign-ins.js";
import type { User } from "./identity/users.js";
import type { LiveUpdates } from "./live/live-updates.js";
import type { FileStore } from "./files/store.js";

export const SIGN_IN_COOKIE = "cronk_sign_in";

/** The header an Agent sends to make a call within one of its live Agent Sessions. */
export const AGENT_SESSION_HEADER = "cronk-agent-session";

/** Whether an HTTP method only reads; every other method changes something. */
export const isReading = (method: string): boolean => ["GET", "HEAD", "OPTIONS"].includes(method);

/** Why an Agent's write without an Agent Session is refused, and how to start one. */
export const SESSION_NEEDED =
  "An Agent changes things only within an Agent Session: start one with POST /api/agent-sessions, send its id as the " +
  "Cronk-Agent-Session header on every write, and end it with DELETE /api/agent-sessions/current when done. " +
  "Reads work without one.";

/** What every route module needs from the running application. */
export interface AppContext {
  db: Database;
  clock: Clock;
  cookieSecure: boolean;
  live: LiveUpdates;
  /** Where the files of Attachments and Artifacts are stored. */
  files: FileStore;
  /** The most bytes one import of an export may write, to local disk and the file store together (see `AppConfig`). */
  importMaxBytes: number;
  /** The address Cronk is reached at, if configured (see `AppConfig`). */
  publicUrl?: string | undefined;
  /** The address of the Artifact hostname, if configured (see `AppConfig`). */
  artifactsUrl?: string | undefined;
}

export class HttpError extends Error {
  /** `details` are sent alongside `error` in the answer, such as the current Version a stale save is refused with. */
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The token sent as `Authorization: Bearer <token>`, if any. */
export const bearerToken = (request: FastifyRequest): string | undefined =>
  /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? "")?.[1];

/**
 * Who is making the request, or a 401: the Agent whose token is sent as
 * `Authorization: Bearer <token>`, or else the signed-in User. An Agent that also
 * sends the Cronk-Agent-Session header calls within that Agent Session, which the
 * call refreshes; a Session that this token didn't start, or that has ended, answers 410. An Agent that
 * doesn't send it may only read: any other method answers 403 (saying the token is read-only, if it is), except where `outsideSession` is set, as
 * when starting an Agent Session, or for a route only a User may call, which refuses Agents anyway. With
 * `refreshSession: false` the Session is only checked, not refreshed, as when a live-update
 * stream of a Ticket re-checks who is watching: being told of others' changes isn't the Agent's own call.
 */
export async function requireActor(ctx: AppContext, request: FastifyRequest, opts: { refreshSession?: boolean; outsideSession?: boolean } = {}): Promise<Actor> {
  const actor = await resolveActor(ctx, request, opts);
  actors.set(request, actor);
  return actor;
}

/** The Actor `requireActor` found making each request, for shaping its answer to what they may read. */
const actors = new WeakMap<FastifyRequest, Actor>();

/** Who `requireActor` found making the request, if it was called for it. */
export const requestActor = (request: FastifyRequest): Actor | undefined => actors.get(request);

async function resolveActor(ctx: AppContext, request: FastifyRequest, opts: { refreshSession?: boolean; outsideSession?: boolean }): Promise<Actor> {
  const bearer = bearerToken(request);
  if (bearer) {
    const found = await agentForToken(ctx.db, bearer);
    if (!found) throw new HttpError(401, "This token is unknown or was revoked");
    const sessionId = request.headers[AGENT_SESSION_HEADER];
    if (typeof sessionId !== "string") {
      if (!opts.outsideSession && !isReading(request.method)) {
        // A Session wouldn't help a read-only token, so it hears the reason that would still stand.
        throw new HttpError(403, found.readOnly ? "This Agent's token is read-only, so it can't change anything" : SESSION_NEEDED);
      }
      return { kind: "agent", session: null, ...found };
    }
    const lookUp = opts.refreshSession === false ? findLiveAgentSession : touchAgentSession;
    const session = await lookUp(ctx.db, { agentId: found.agent.id, tokenId: found.tokenId }, sessionId, ctx.clock.now());
    if (!session) throw new HttpError(410, "This Agent Session has ended; start a new one");
    return { kind: "agent", session, ...found };
  }
  const token = request.cookies[SIGN_IN_COOKIE];
  const user = token ? await userForSignIn(ctx.db, ctx.clock, token) : undefined;
  if (!user) throw new HttpError(401, "Sign in first");
  return userActor(user);
}

/** The signed-in User making the request; a 401 if nobody is, a 403 for an Agent. */
export async function requireUser(ctx: AppContext, request: FastifyRequest): Promise<User> {
  // An Agent is refused below whether or not it calls within an Agent Session, so it hears why.
  const actor = await requireActor(ctx, request, { outsideSession: true });
  requireUserActor(actor, "do this");
  return actor.user;
}

/** A 403 for an Agent: `what` completes "Only a User can …", as "manage Statuses". */
export function requireUserActor(actor: Actor, what: string): asserts actor is Exclude<Actor, AgentActor> {
  if (actor.kind === "agent") throw new HttpError(403, `Only a User can ${what}, not an Agent`);
}

/**
 * Sets the sign-in cookie. Its lifetime is relative (Max-Age) so it doesn't depend on the browser's clock agreeing with ours.
 * `Strict`, so a browser sends it only with requests from Cronk's own site, not from other sites or links on them;
 * a screen that needs no session, as accepting an invitation, works when opened from a link elsewhere too.
 */
export function setSignInCookie(ctx: AppContext, reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SIGN_IN_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: ctx.cookieSecure,
    maxAge: Math.floor((expiresAt.getTime() - ctx.clock.now().getTime()) / 1000),
  });
}
