import type { FastifyReply, FastifyRequest } from "fastify";
import { userActor, type Actor } from "./actor.js";
import type { Clock } from "./clock.js";
import { findLiveAgentSession, touchAgentSession } from "./coordination/agent-sessions.js";
import type { Database } from "./db/database.js";
import { agentForToken } from "./identity/agents.js";
import { userForSignIn } from "./identity/sign-ins.js";
import type { User } from "./identity/users.js";
import type { LiveUpdates } from "./live/live-updates.js";

export const SIGN_IN_COOKIE = "cronk_sign_in";

/** The header an Agent sends to make a call within one of its live Agent Sessions. */
export const AGENT_SESSION_HEADER = "cronk-agent-session";

/** What every route module needs from the running application. */
export interface AppContext {
  db: Database;
  clock: Clock;
  cookieSecure: boolean;
  live: LiveUpdates;
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
 * call refreshes; a Session that this token didn't start, or that has ended, answers 410. With
 * `refreshSession: false` the Session is only checked, not refreshed, as when a live-update
 * stream of a Ticket re-checks who is watching: being told of others' changes isn't the Agent's own call.
 */
export async function requireActor(ctx: AppContext, request: FastifyRequest, opts: { refreshSession?: boolean } = {}): Promise<Actor> {
  const bearer = bearerToken(request);
  if (bearer) {
    const found = await agentForToken(ctx.db, bearer);
    if (!found) throw new HttpError(401, "This token is unknown or was revoked");
    const sessionId = request.headers[AGENT_SESSION_HEADER];
    if (typeof sessionId !== "string") return { kind: "agent", session: null, ...found };
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
  const actor = await requireActor(ctx, request);
  if (actor.kind === "agent") throw new HttpError(403, "Only a User can do this, not an Agent");
  return actor.user;
}

/** Sets the sign-in cookie. Its lifetime is relative (Max-Age) so it doesn't depend on the browser's clock agreeing with ours. */
export function setSignInCookie(ctx: AppContext, reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SIGN_IN_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: ctx.cookieSecure,
    maxAge: Math.floor((expiresAt.getTime() - ctx.clock.now().getTime()) / 1000),
  });
}
