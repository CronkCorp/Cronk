import type { FastifyInstance } from "fastify";
import { HttpError, requireUser, SESSION_COOKIE, setSessionCookie, type AppContext } from "../context.js";
import { transaction } from "../db/database.js";
import { insertWorkspace } from "../workspace/workspaces.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { createSession, deleteSession } from "./sessions.js";
import { countUsers, findUserByEmail, insertUser, publicUser } from "./users.js";

// Fixed lock id so two concurrent setup requests can't both create an Admin.
const SETUP_LOCK = 0x7365747570;

const email = { type: "string", minLength: 3, maxLength: 320, pattern: "^[^@\\s]+@[^@\\s]+$" } as const;
const password = { type: "string", minLength: 8, maxLength: 1024 } as const;
const name = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } as const;

const dummyHash = hashPassword("dummy password for unknown emails");

export function identityRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get("/api/setup", async () => ({ required: (await countUsers(ctx.db)) === 0 }));

    app.post<{ Body: { email: string; password: string; name: string; workspaceName?: string } }>(
      "/api/setup",
      {
        schema: {
          body: {
            type: "object",
            required: ["email", "password", "name"],
            additionalProperties: false,
            properties: { email, password, name, workspaceName: name },
          },
        },
      },
      async (request, reply) => {
        const body = request.body;
        const passwordHash = await hashPassword(body.password);
        const user = await transaction(ctx.db, async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock($1)", [SETUP_LOCK]);
          if ((await countUsers(tx)) > 0) throw new HttpError(409, "This installation is already set up");
          const now = ctx.clock.now();
          const workspace = await insertWorkspace(tx, { name: body.workspaceName?.trim() || "Cronk", now });
          return insertUser(tx, {
            workspaceId: workspace.id,
            email: body.email.trim(),
            name: body.name.trim(),
            passwordHash,
            role: "admin",
            now,
          });
        });
        const session = await createSession(ctx.db, ctx.clock, user.id);
        setSessionCookie(ctx, reply, session.token, session.expiresAt);
        return reply.code(201).send({ user: publicUser(user) });
      },
    );

    app.post<{ Body: { email: string; password: string } }>(
      "/api/sessions",
      {
        schema: {
          body: {
            type: "object",
            required: ["email", "password"],
            additionalProperties: false,
            properties: { email: { type: "string", maxLength: 320 }, password: { type: "string", maxLength: 1024 } },
          },
        },
      },
      async (request, reply) => {
        const found = await findUserByEmail(ctx.db, request.body.email.trim());
        // Check a password even for unknown emails so response time doesn't reveal which emails exist.
        const ok = await verifyPassword(request.body.password, found?.passwordHash ?? (await dummyHash));
        if (!found || !ok) throw new HttpError(401, "Email or password is incorrect");
        const session = await createSession(ctx.db, ctx.clock, found.user.id);
        setSessionCookie(ctx, reply, session.token, session.expiresAt);
        return { user: publicUser(found.user) };
      },
    );

    app.delete("/api/sessions/current", async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) await deleteSession(ctx.db, token);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    });

    app.get("/api/me", async (request) => ({ user: publicUser(await requireUser(ctx, request)) }));
  };
}
