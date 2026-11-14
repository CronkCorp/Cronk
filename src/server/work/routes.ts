import type { FastifyInstance } from "fastify";
import { HttpError, requireUser, type AppContext } from "../context.js";
import { transaction } from "../db/database.js";
import { nameSchema } from "../schemas.js";
import { userActor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { requireAdmin, requireProjectAccess, visibleProjects, type Access } from "../identity/access.js";
import { listMemberships, removeMembership, setMembership } from "../identity/memberships.js";
import { findUserById, publicUser, type User } from "../identity/users.js";
import {
  countTicketsInStatus,
  deleteStatus,
  findProjectById,
  findProjectByKey,
  findStatusToMoveInto,
  insertProject,
  insertStatus,
  lockProject,
  lockStatus,
  moveStatus,
  renameStatus,
  listProjects,
  listStatuses,
  PROJECT_KEY_PATTERN,
  STATUS_CATEGORIES,
  updateProject,
  type Project,
  type Status,
  type StatusCategory,
  type Visibility,
} from "./projects.js";
import {
  findTicketByKey,
  insertTicket,
  listHistory,
  listTickets,
  moveTicketsBetweenStatuses,
  updateTicket,
  type Ticket,
  type TicketEdit,
} from "./tickets.js";

const projectKey = { type: "string", pattern: `^${PROJECT_KEY_PATTERN}$` } as const;

/** A Ticket title: non-blank, at most 500 characters. */
const title = { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } as const;
/** A Ticket's Markdown description. */
const description = { type: "string", maxLength: 100_000 } as const;

export function workRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { archived?: boolean } }>(
      "/api/projects",
      { schema: { querystring: { type: "object", properties: { archived: { type: "boolean" } } } } },
      async (request) => {
        const user = await requireUser(ctx, request);
        const projects = await listProjects(ctx.db, user.workspaceId, request.query.archived ?? false);
        return { projects: await visibleProjects(ctx.db, user, projects) };
      },
    );

    app.post<{ Body: { name: string; key: string } }>(
      "/api/projects",
      {
        schema: {
          body: {
            type: "object",
            required: ["name", "key"],
            additionalProperties: false,
            properties: { name: nameSchema, key: projectKey },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const key = request.body.key.toUpperCase();
        const project = await transaction(ctx.db, (tx) =>
          insertProject(tx, { workspaceId: user.workspaceId, name: request.body.name.trim(), key, now: ctx.clock.now() }),
        );
        if (!project) throw new HttpError(409, `Another Project already has the key ${key}`);
        return reply.code(201).send({ project: { ...project, access: "write" } });
      },
    );

    app.get<{ Params: { key: string } }>("/api/projects/:key", async (request) => {
      const user = await requireUser(ctx, request);
      const { project, access } = await projectFor(ctx.db, user, request.params.key, "read");
      return { project: { ...project, access }, statuses: await listStatuses(ctx.db, project.id) };
    });

    app.patch<{ Params: { key: string }; Body: { name?: string; archived?: boolean; visibility?: Visibility } }>(
      "/api/projects/:key",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: { name: nameSchema, archived: { type: "boolean" }, visibility: { type: "string", enum: ["open", "private"] } },
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const { project, access } = await projectFor(ctx.db, user, request.params.key, "write");
        const { name, archived, visibility } = request.body;
        if (visibility !== undefined) requireAdmin(user, "make a Project open or private");
        const changes = {
          ...(name !== undefined && { name: name.trim() }),
          ...(archived !== undefined && { archived }),
          ...(visibility !== undefined && { visibility }),
        };
        return { project: { ...(await updateProject(ctx.db, project.id, changes, ctx.clock.now())), access } };
      },
    );

    app.get<{ Params: { key: string } }>("/api/projects/:key/members", async (request) => {
      const user = await requireUser(ctx, request);
      const { project } = await projectFor(ctx.db, user, request.params.key, "read");
      const members = await listMemberships(ctx.db, project.id);
      return { members: members.map((m) => ({ user: publicUser(m.user), access: m.access })) };
    });

    const memberParams = {
      type: "object",
      properties: { key: { type: "string" }, userId: { type: "string", format: "uuid" } },
    } as const;

    app.put<{ Params: { key: string; userId: string }; Body: { access: Access } }>(
      "/api/projects/:key/members/:userId",
      {
        schema: {
          params: memberParams,
          body: {
            type: "object",
            required: ["access"],
            additionalProperties: false,
            properties: { access: { type: "string", enum: ["read", "write"] } },
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const { project } = await projectFor(ctx.db, user, request.params.key, "read");
        requireAdmin(user, "change who is in a Project");
        const member = await findUserById(ctx.db, request.params.userId);
        if (!member || member.workspaceId !== user.workspaceId) throw new HttpError(404, "No such User");
        if (member.role === "admin") throw new HttpError(400, "Admins have Write access in every Project");
        await setMembership(ctx.db, project.id, member.id, request.body.access);
        return { member: { user: publicUser(member), access: request.body.access } };
      },
    );

    app.delete<{ Params: { key: string; userId: string } }>(
      "/api/projects/:key/members/:userId",
      { schema: { params: memberParams } },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const { project } = await projectFor(ctx.db, user, request.params.key, "read");
        requireAdmin(user, "change who is in a Project");
        await removeMembership(ctx.db, project.id, request.params.userId);
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { key: string }; Body: { name: string; category: StatusCategory } }>(
      "/api/projects/:key/statuses",
      {
        schema: {
          body: {
            type: "object",
            required: ["name", "category"],
            additionalProperties: false,
            properties: { name: nameSchema, category: { type: "string", enum: STATUS_CATEGORIES } },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const name = request.body.name.trim();
        const status = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, user, request.params.key, "write");
          await lockProject(tx, project.id);
          return insertStatus(tx, project.id, { name, category: request.body.category });
        });
        if (!status) throw statusNameTaken(name);
        return reply.code(201).send({ status });
      },
    );

    app.patch<{ Params: { key: string; statusId: string }; Body: { name?: string; position?: number } }>(
      "/api/projects/:key/statuses/:statusId",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            // `position` counts from 0 among the Statuses of the same Status Category.
            properties: { name: nameSchema, position: { type: "integer", minimum: 0 } },
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const name = request.body.name?.trim();
        const status = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, user, request.params.key, "write");
          await lockProject(tx, project.id);
          let status = statusOr404(await listStatuses(tx, project.id), request.params.statusId);
          if (name !== undefined) {
            const renamed = await renameStatus(tx, project.id, status.id, name);
            if (!renamed) throw statusNameTaken(name);
            status = renamed;
          }
          const { position } = request.body;
          if (position !== undefined && !(await moveStatus(tx, project.id, status, position))) {
            throw new HttpError(400, `${status.name} can't move to position ${position}: its Status Category isn't that long`);
          }
          return status;
        });
        return { status };
      },
    );

    app.delete<{ Params: { key: string; statusId: string }; Querystring: { moveTo?: string } }>(
      "/api/projects/:key/statuses/:statusId",
      // `moveTo`: the Status the removed Status's Tickets move to. Required while any Ticket is in it.
      { schema: { querystring: { type: "object", properties: { moveTo: { type: "string" } } } } },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const { moveTo } = request.query;
        await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, user, request.params.key, "write");
          await lockProject(tx, project.id);
          const statuses = await listStatuses(tx, project.id);
          const status = statusOr404(statuses, request.params.statusId);
          if (!statuses.some((s) => s.category === status.category && s.id !== status.id)) {
            throw new HttpError(409, `${status.name} is the last Status of its Status Category, which needs at least one`);
          }
          await lockStatus(tx, status.id);
          const target = moveTo === undefined ? undefined : statuses.find((s) => s.id === moveTo && s.id !== status.id);
          if (moveTo !== undefined && !target) {
            throw new HttpError(400, "Tickets can only move to another Status of this Project");
          }
          if (target) {
            await moveTicketsBetweenStatuses(tx, status, target, userActor(user), ctx.clock.now());
          } else {
            const inUse = await countTicketsInStatus(tx, status.id);
            if (inUse > 0) {
              throw new HttpError(409, `${inUse} Ticket${inUse === 1 ? " is" : "s are"} in ${status.name}; choose a Status to move them to`);
            }
          }
          await deleteStatus(tx, status.id);
        });
        return reply.code(204).send();
      },
    );

    app.get<{ Params: { key: string } }>("/api/projects/:key/tickets", async (request) => {
      const user = await requireUser(ctx, request);
      const { project } = await projectFor(ctx.db, user, request.params.key, "read");
      return { tickets: await listTickets(ctx.db, project.id) };
    });

    app.post<{ Params: { key: string }; Body: { title: string; description?: string } }>(
      "/api/projects/:key/tickets",
      {
        schema: {
          body: {
            type: "object",
            required: ["title"],
            additionalProperties: false,
            properties: { title, description },
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(ctx, request);
        const ticket = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, user, request.params.key, "write");
          // New Tickets start in the Project's first Status; the lock keeps it from being removed meanwhile.
          await lockProject(tx, project.id);
          const [firstStatus] = await listStatuses(tx, project.id);
          return insertTicket(tx, {
            project,
            title: request.body.title.trim(),
            description: request.body.description ?? "",
            status: firstStatus!,
            actor: userActor(user),
            now: ctx.clock.now(),
          });
        });
        return reply.code(201).send({ ticket });
      },
    );

    app.get<{ Params: { key: string } }>("/api/tickets/:key", async (request) => {
      const user = await requireUser(ctx, request);
      return { ticket: await ticketFor(ctx.db, user, request.params.key, "read") };
    });

    app.patch<{ Params: { key: string }; Body: { title?: string; description?: string; statusId?: string } }>(
      "/api/tickets/:key",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: { title, description, statusId: { type: "string", format: "uuid" } },
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const { title, description, statusId } = request.body;
        const ticket = await transaction(ctx.db, async (tx) => {
          const ticket = await ticketFor(tx, user, request.params.key, "write", { forUpdate: true });
          const changes: TicketEdit = {
            ...(title !== undefined && { title: title.trim() }),
            ...(description !== undefined && { description }),
          };
          if (statusId !== undefined) {
            const status = await findStatusToMoveInto(tx, ticket.projectId, statusId);
            if (!status) throw new HttpError(400, "That Status isn't one of this Ticket's Project");
            changes.status = status;
          }
          return updateTicket(tx, ticket, changes, userActor(user), ctx.clock.now());
        });
        return { ticket };
      },
    );

    app.get<{ Params: { key: string } }>("/api/tickets/:key/history", async (request) => {
      const user = await requireUser(ctx, request);
      const ticket = await ticketFor(ctx.db, user, request.params.key, "read");
      return { changes: await listHistory(ctx.db, ticket.id) };
    });
  };
}

/** The Project with this key, if `user` has at least `need` in it (see `requireProjectAccess`). */
async function projectFor(db: Queryable, user: User, key: string, need: Access): Promise<{ project: Project; access: Access }> {
  const project = await findProjectByKey(db, user.workspaceId, key);
  if (!project) throw new HttpError(404, "No such Project");
  return { project, access: await requireProjectAccess(db, user, project, need) };
}

/** The Status with this id among a Project's Statuses. */
function statusOr404(statuses: Status[], statusId: string): Status {
  const status = statuses.find((s) => s.id === statusId);
  if (!status) throw new HttpError(404, "No such Status in this Project");
  return status;
}

const statusNameTaken = (name: string) => new HttpError(409, `Another Status is already named ${name}`);

/**
 * The Ticket with this key, if `user` has at least `need` in its Project. A Ticket in
 * a Project they can't see answers 404, like one that doesn't exist.
 */
async function ticketFor(db: Queryable, user: User, key: string, need: Access, opts: { forUpdate?: boolean } = {}): Promise<Ticket> {
  const ticket = await findTicketByKey(db, user.workspaceId, key, opts);
  const project = ticket && (await findProjectById(db, ticket.projectId));
  if (!ticket || !project) throw new HttpError(404, "No such Ticket");
  await requireProjectAccess(db, user, project, need, "No such Ticket");
  return ticket;
}
