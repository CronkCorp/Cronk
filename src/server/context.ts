import type { FastifyReply, FastifyRequest } from "fastify";
import type { Clock } from "./clock.js";
import type { Database } from "./db/database.js";
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

/** The signed-in User making the request, or a 401. */
export async function requireUser(ctx: AppContext, request: FastifyRequest): Promise<User> {
  const token = request.cookies[SIGN_IN_COOKIE];
  const user = token ? await userForSignIn(ctx.db, ctx.clock, token) : undefined;
  if (!user) throw new HttpError(401, "Sign in first");
  return user;
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
