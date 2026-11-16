import type { FastifyInstance } from "fastify";
import { actingUser } from "../actor.js";
import { claimsEnded, tellReadyAfter } from "../coordination/ready.js";
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
import { inboxesChanged } from "../inbox/inbox.js";
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
import { issuePasswordReset, usePasswordReset, userForPasswordReset, type ResetRefusal } from "./password-resets.js";
import { createSignIn, deleteSignIn, endSignIns } from "./sign-ins.js";
import { claimUserWithoutPassword, countUsers, findUserByEmail, findUserById, insertUser, listUsers, passwordHashOf, publicUser, setPasswordHash, updateUser, type Role } from "./users.js";

// Fixed lock id so two concurrent setup requests can't both create an Admin.
const SETUP_LOCK = 0x7365747570;

const email = { type: "string", minLength: 3, maxLength: 320, pattern: "^[^@\\s]+@[^@\\s]+$" } as const;
const password = { type: "string", minLength: 8, maxLength: 1024 } as const;
const role = roleSchema;

const userAnswer = holding("user", "User");

/** The path parameters of the routes anyone holding an invitation's token may call. */
const invitationTokenParams = pathParams({ token: { type: "string", description: "The secret token the invitation was sent with." } });

const INVITATION_GONE = "This invitation has expired or was withdrawn";

/** The path parameters of the routes anyone holding a password reset link's token may call. */
const resetTokenParams = pathParams({ token: { type: "string", description: "The secret token from the password reset link." } });

const RESET_GONE = "This password reset link has expired or no longer works";

/** Why a User can't be given a reset link, as the API answers it. */
const RESET_REFUSED: Record<ResetRefusal, HttpError> = {
  "no such user": new HttpError(404, "No such User"),
  deactivated: new HttpError(409, "This User is deactivated; reactivate them first"),
  "not joined": new HttpError(409, "This User hasn't joined yet; invite them instead"),
};

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
        // A User an import brought in to this Workspace hasn't joined yet; an invitation is how they do.
        const existing = (await findUserByEmail(ctx.db, inviteeEmail))?.user;
        if (existing && (existing.joined || existing.workspaceId !== user.workspaceId)) {
          throw new HttpError(409, `${inviteeEmail} is already a User`);
        }
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
      "/api/invitations/by-token/:token",
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
      "/api/invitations/by-token/:token/accept",
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
          const details = { workspaceId: invitation.workspaceId, email: invitation.email, name: request.body.name.trim(), passwordHash, role: invitation.role };
          const claimed = await claimUserWithoutPassword(tx, details);
          if (claimed) return claimed;
          try {
            return await insertUser(tx, { ...details, now });
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
        // Becoming an Admin can make Tickets delegated to the User's Agents Ready. Becoming active again can too,
        // but deactivating ended their Agents' Sessions, so the next Session's welcome lists them instead.
        const opensUp = request.body.role === "admin";
        const updated = await tellReadyAfter(ctx, opensUp ? { ownerId: request.params.id } : undefined, (tx) =>
          updateUser(tx, user.workspaceId, request.params.id, request.body, ctx.clock.now()),
        );
        if (updated === "last admin") throw new HttpError(409, "The Workspace needs at least one active Admin");
        if (!updated) throw new HttpError(404, "No such User");
        // Deactivating ended their Agents' Sessions, so the Claims those held lapsed.
        await claimsEnded(ctx, updated.endedClaims.ticketIds);
        // A new role can show or hide private Projects, and so the items in them.
        if (request.body.role !== undefined) inboxesChanged(ctx.live, [updated.user.id]);
        return { user: publicUser(updated.user) };
      },
    );

    app.post<{ Params: { id: string } }>(
      "/api/users/:id/password-reset",
      {
        schema: {
          params: pathParams({ id: userIdParam }),
          response: {
            201: answer(
              "The reset link's secret token, only ever returned here, and when it expires. Until the link is used the User's old password no longer works and their sign-ins have ended; their Agents' Sessions keep running",
              { type: "object", required: ["token", "expiresAt"], properties: { token: { type: "string" }, expiresAt: { type: "string", format: "date-time" } } },
            ),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        requireAdmin(user, "issue password reset links");
        const target = await findUserById(ctx.db, request.params.id);
        if (target?.workspaceId !== user.workspaceId) throw new HttpError(404, "No such User");
        const issued = await transaction(ctx.db, (tx) => issuePasswordReset(tx, { userId: target.id, issuedBy: user.id, now: ctx.clock.now() }));
        if (typeof issued === "string") throw RESET_REFUSED[issued];
        return reply.code(201).send(issued);
      },
    );

    // Anyone holding a reset link's token may view and use it; the token is the proof.
    app.get<{ Params: { token: string } }>(
      "/api/password-resets/by-token/:token",
      {
        schema: {
          params: resetTokenParams,
          ...publicRoute,
          response: {
            200: answer("Whose password the link resets, and in which Workspace", {
              type: "object",
              required: ["email", "name", "workspaceName"],
              properties: { email: { type: "string" }, name: { type: "string" }, workspaceName: { type: "string" } },
            }),
            ...errors(404),
          },
        },
      },
      async (request) => {
        const user = await userForPasswordReset(ctx.db, request.params.token, ctx.clock.now());
        if (!user) throw new HttpError(404, RESET_GONE);
        const workspace = await getWorkspace(ctx.db, user.workspaceId);
        return { email: user.email, name: user.name, workspaceName: workspace.name };
      },
    );

    app.post<{ Params: { token: string }; Body: { password: string } }>(
      "/api/password-resets/by-token/:token",
      {
        schema: {
          params: resetTokenParams,
          ...publicRoute,
          body: { type: "object", required: ["password"], additionalProperties: false, properties: { password } },
          response: { 200: answer("The User, with the new password, now signed in; the link no longer works", userAnswer), ...errors(400, 404) },
        },
      },
      async (request, reply) => {
        const passwordHash = await hashPassword(request.body.password);
        const user = await transaction(ctx.db, (tx) => usePasswordReset(tx, request.params.token, passwordHash, ctx.clock.now()));
        if (!user) throw new HttpError(404, RESET_GONE);
        const signIn = await createSignIn(ctx.db, ctx.clock, user.id);
        setSignInCookie(ctx, reply, signIn.token, signIn.expiresAt);
        return { user: publicUser(user) };
      },
    );

    app.put<{ Body: { currentPassword: string; password: string } }>(
      "/api/me/password",
      {
        schema: {
          body: {
            type: "object",
            required: ["currentPassword", "password"],
            additionalProperties: false,
            properties: { currentPassword: { type: "string", maxLength: 1024 }, password },
          },
          response: {
            204: noContent("The password is changed; this sign-in stays, the User's other sign-ins have ended"),
            ...errors(400, 401, 403, 410),
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const current = await passwordHashOf(ctx.db, user.id);
        if (!current || !(await verifyPassword(request.body.currentPassword, current))) {
          throw new HttpError(403, "The current password is incorrect");
        }
        const passwordHash = await hashPassword(request.body.password);
        await transaction(ctx.db, async (tx) => {
          await setPasswordHash(tx, user.id, passwordHash);
          await endSignIns(tx, user.id, { except: request.cookies[SIGN_IN_COOKIE] });
        });
        return reply.code(204).send();
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
