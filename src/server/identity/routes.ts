import type { FastifyInstance } from "fastify";
import { actingUser } from "../actor.js";
import { HttpError, requireActor, requireUser, SIGN_IN_COOKIE, setSignInCookie, type AppContext } from "../context.js";
import { transaction, UNIQUE_VIOLATION } from "../db/database.js";
import {
  answer,
  errors,
  holding,
  listing,
  nameSchema,
  noContent,
  pathParams,
  publicRoute,
  ref,
  roleSchema,
  userIdParam,
} from "../schemas.js";
import { getWorkspace, insertWorkspace } from "../workspace/workspaces.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { requireAdmin, requireWorkspaceAccess } from "./access.js";
import { publicAgent } from "./agents.js";
import {
  createInvitation,
  deleteInvitation,
  findInvitationByToken,
  listInvitations,
  publicInvitation,
} from "./invitations.js";
import { createSignIn, deleteSignIn } from "./sign-ins.js";
import { countUsers, findUserByEmail, insertUser, listUsers, publicUser, updateUser, type Role } from "./users.js";

// Fixed lock id so two concurrent setup requests can't both create an Admin.
const SETUP_LOCK = 0x7365747570;

const email = { type: "string", minLength: 3, maxLength: 320, pattern: "^[^@\\s]+@[^@\\s]+$" } as const;
const password = { type: "string", minLength: 8, maxLength: 1024 } as const;
const role = roleSchema;

const userAnswer = holding("user", "User");

/** The path parameters of the routes anyone holding an invitation's token may call. */
const invitationTokenParams = pathParams({ token: { type: "string", description: "The secret token the invitation was sent with." } });

const INVITATION_GONE = "This invitation has expired or was withdrawn";

const dummyHash = hashPassword("dummy password for unknown emails");

export function identityRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get(
      "/api/setup",
      {
        schema: {
          ...publicRoute,
          response: {
            200: answer("Whether the installation still needs its first Admin", {
              type: "object",
              required: ["required"],
              properties: { required: { type: "boolean" } },
            }),
          },
        },
      },
      async () => ({ required: (await countUsers(ctx.db)) === 0 }),
    );

    app.post<{ Body: { email: string; password: string; name: string; workspaceName?: string } }>(
      "/api/setup",
      {
        schema: {
          ...publicRoute,
          body: {
            type: "object",
            required: ["email", "password", "name"],
            additionalProperties: false,
            properties: { email, password, name: nameSchema, workspaceName: nameSchema },
          },
          response: { 201: answer("The first Admin, now signed in", userAnswer), ...errors(400, 409) },
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
        const signIn = await createSignIn(ctx.db, ctx.clock, user.id);
        setSignInCookie(ctx, reply, signIn.token, signIn.expiresAt);
        return reply.code(201).send({ user: publicUser(user) });
      },
    );

    app.post<{ Body: { email: string; password: string } }>(
      "/api/sign-in",
      {
        schema: {
          ...publicRoute,
          body: {
            type: "object",
            required: ["email", "password"],
            additionalProperties: false,
            properties: { email: { type: "string", maxLength: 320 }, password: { type: "string", maxLength: 1024 } },
          },
          response: { 200: answer("The User, now signed in", userAnswer), ...errors(400, 401, 403) },
        },
      },
      async (request, reply) => {
        const found = await findUserByEmail(ctx.db, request.body.email.trim());
        // Check a password even for unknown emails so response time doesn't reveal which emails exist.
        const ok = await verifyPassword(request.body.password, found?.passwordHash ?? (await dummyHash));
        if (!found || !ok) throw new HttpError(401, "Email or password is incorrect");
        if (!found.user.active) throw new HttpError(403, "An Admin has deactivated you, so you can't sign in");
        const signIn = await createSignIn(ctx.db, ctx.clock, found.user.id);
        setSignInCookie(ctx, reply, signIn.token, signIn.expiresAt);
        return { user: publicUser(found.user) };
      },
    );

    app.delete("/api/sign-in", { schema: { ...publicRoute, response: { 204: noContent("Signed out") } } }, async (request, reply) => {
      const token = request.cookies[SIGN_IN_COOKIE];
      if (token) await deleteSignIn(ctx.db, token);
      reply.clearCookie(SIGN_IN_COOKIE, { path: "/" });
      return reply.code(204).send();
    });

    app.post<{ Body: { email: string; role?: Role } }>(
      "/api/invitations",
      {
        schema: {
          body: { type: "object", required: ["email"], additionalProperties: false, properties: { email, role } },
          response: {
            201: answer("The invitation, with the secret token the invitee accepts it with; it is only ever returned here", {
              type: "object",
              required: ["invitation", "token"],
              properties: { invitation: ref("Invitation"), token: { type: "string" } },
            }),
            ...errors(400, 401, 403, 409, 410),
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "invite Users");
        const inviteeEmail = request.body.email.trim();
        if (await findUserByEmail(ctx.db, inviteeEmail)) throw new HttpError(409, `${inviteeEmail} is already a User`);
        const { invitation, token } = await createInvitation(ctx.db, {
          workspaceId: user.workspaceId,
          email: inviteeEmail,
          role: request.body.role ?? "member",
          invitedBy: user.id,
          now: ctx.clock.now(),
        });
        return reply.code(201).send({ invitation: publicInvitation(invitation), token });
      },
    );

    app.get(
      "/api/invitations",
      {
        schema: {
          response: {
            200: answer("The Workspace's unexpired invitations, newest first", listing("invitations", ref("Invitation"))),
            ...errors(401, 403, 410),
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "see invitations");
        const invitations = await listInvitations(ctx.db, user.workspaceId, ctx.clock.now());
        return { invitations: invitations.map(publicInvitation) };
      },
    );

    app.delete<{ Params: { id: string } }>(
      "/api/invitations/:id",
      {
        schema: {
          params: pathParams({ id: { type: "string", format: "uuid", description: "The invitation's id." } }),
          response: { 204: noContent("The invitation is withdrawn"), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "withdraw invitations");
        if (!(await deleteInvitation(ctx.db, user.workspaceId, request.params.id))) throw new HttpError(404, "No such invitation");
        return reply.code(204).send();
      },
    );

    // Anyone holding an invitation's token may view and accept it; the token is the proof.
    app.get<{ Params: { token: string } }>(
      "/api/invitations/:token",
      {
        schema: {
          params: invitationTokenParams,
          ...publicRoute,
          response: {
            200: answer("Who the invitation is for and which Workspace it joins", {
              type: "object",
              required: ["email", "role", "workspaceName"],
              properties: { email: { type: "string" }, role, workspaceName: { type: "string" } },
            }),
            ...errors(404),
          },
        },
      },
      async (request) => {
        const invitation = await findInvitationByToken(ctx.db, request.params.token, ctx.clock.now());
        if (!invitation) throw new HttpError(404, INVITATION_GONE);
        const workspace = await getWorkspace(ctx.db, invitation.workspaceId);
        return { email: invitation.email, role: invitation.role, workspaceName: workspace.name };
      },
    );

    app.post<{ Params: { token: string }; Body: { name: string; password: string } }>(
      "/api/invitations/:token/accept",
      {
        schema: {
          params: invitationTokenParams,
          ...publicRoute,
          body: {
            type: "object",
            required: ["name", "password"],
            additionalProperties: false,
            properties: { name: nameSchema, password },
          },
          response: { 201: answer("The new User, now signed in", userAnswer), ...errors(400, 404, 409) },
        },
      },
      async (request, reply) => {
        const passwordHash = await hashPassword(request.body.password);
        const user = await transaction(ctx.db, async (tx) => {
          const now = ctx.clock.now();
          const invitation = await findInvitationByToken(tx, request.params.token, now, { forUpdate: true });
          if (!invitation) throw new HttpError(404, INVITATION_GONE);
          await deleteInvitation(tx, invitation.workspaceId, invitation.id);
          try {
            return await insertUser(tx, {
              workspaceId: invitation.workspaceId,
              email: invitation.email,
              name: request.body.name.trim(),
              passwordHash,
              role: invitation.role,
              now,
            });
          } catch (err) {
            // Someone with this email became a User after the invitation was sent.
            if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new HttpError(409, `${invitation.email} is already a User`);
            throw err;
          }
        });
        const signIn = await createSignIn(ctx.db, ctx.clock, user.id);
        setSignInCookie(ctx, reply, signIn.token, signIn.expiresAt);
        return reply.code(201).send({ user: publicUser(user) });
      },
    );

    app.get(
      "/api/users",
      {
        schema: {
          response: {
            200: answer("The Workspace's Users", listing("users", ref("User"))),
            ...errors(401, 403, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "read");
        return { users: (await listUsers(ctx.db, actingUser(actor).workspaceId)).map(publicUser) };
      },
    );

    app.patch<{ Params: { id: string }; Body: { role?: Role; active?: boolean } }>(
      "/api/users/:id",
      {
        schema: {
          params: pathParams({ id: userIdParam }),
          body: { type: "object", additionalProperties: false, properties: { role, active: { type: "boolean" } } },
          response: { 200: answer("The changed User", userAnswer), ...errors(400, 401, 403, 404, 409, 410) },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "change Users");
        const updated = await transaction(ctx.db, (tx) =>
          updateUser(tx, user.workspaceId, request.params.id, request.body, ctx.clock.now()),
        );
        if (updated === "last admin") throw new HttpError(409, "The Workspace needs at least one active Admin");
        if (!updated) throw new HttpError(404, "No such User");
        return { user: publicUser(updated) };
      },
    );

    // Who the caller is: a User, or an Agent with its Owner and whether its token is read-only.
    app.get(
      "/api/me",
      {
        schema: {
          response: {
            200: answer("A signed-in User gets `user`; an Agent token gets `agent` and whether the token is `readOnly`", {
              type: "object",
              properties: { user: ref("User"), agent: ref("Agent"), readOnly: { type: "boolean" } },
            }),
            ...errors(401, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        if (actor.kind === "user") return { user: publicUser(actor.user) };
        return { agent: publicAgent(actor.agent, actor.owner), readOnly: actor.readOnly };
      },
    );
  };
}
