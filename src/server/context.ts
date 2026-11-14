import type { FastifyReply, FastifyRequest } from "fastify";
import { userActor, type Actor } from "./actor.js";
import type { Clock } from "./clock.js";
import type { Database } from "./db/database.js";
import { agentForToken } from "./identity/agents.js";
import { userForSignIn } from "./identity/sign-ins.js";
import type { User } from "./identity/users.js";

export const SIGN_IN_COOKIE = "cronk_sign_in";

/** What every route module needs from the running application. */
export interface AppContext {
  db: Database;
  clock: Clock;
  cookieSecure: boolean;
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Who is making the request, or a 401: the Agent whose token is sent as
 * `Authorization: Bearer <token>`, or else the signed-in User.
 */
export async function requireActor(ctx: AppContext, request: FastifyRequest): Promise<Actor> {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? "")?.[1];
  if (bearer) {
    const found = await agentForToken(ctx.db, bearer);
    if (!found) throw new HttpError(401, "This token is unknown or was revoked");
    return { kind: "agent", ...found };
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
