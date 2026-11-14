import type { FastifyReply, FastifyRequest } from "fastify";
import type { Clock } from "./clock.js";
import type { Database } from "./db/database.js";
import { userForSession } from "./identity/sessions.js";
import type { User } from "./identity/users.js";

export const SESSION_COOKIE = "cronk_session";

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

/** The signed-in User making the request, or a 401. */
export async function requireUser(ctx: AppContext, request: FastifyRequest): Promise<User> {
  const token = request.cookies[SESSION_COOKIE];
  const user = token ? await userForSession(ctx.db, ctx.clock, token) : undefined;
  if (!user) throw new HttpError(401, "Sign in first");
  return user;
}

/** Sets the session cookie. Its lifetime is relative (Max-Age) so it doesn't depend on the browser's clock agreeing with ours. */
export function setSessionCookie(ctx: AppContext, reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: ctx.cookieSecure,
    maxAge: Math.floor((expiresAt.getTime() - ctx.clock.now().getTime()) / 1000),
  });
}
