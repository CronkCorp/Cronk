import type { FastifyInstance } from "fastify";
import { HttpError, requireUser, type AppContext } from "../context.js";
import { transaction } from "../db/database.js";
import { nameSchema } from "../schemas.js";
import { userActor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import {
  countTicketsInStatus,
  deleteStatus,
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
        return { projects: await listProjects(ctx.db, user.workspaceId, request.query.archived ?? false) };
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
        return reply.code(201).send({ project });
      },
    );

    app.get<{ Params: { key: string } }>("/api/projects/:key", async (request) => {
      const user = await requireUser(ctx, request);
      const project = await projectOr404(ctx.db, user.workspaceId, request.params.key);
      return { project, statuses: await listStatuses(ctx.db, project.id) };
    });

    app.patch<{ Params: { key: string }; Body: { name?: string; archived?: boolean } }>(
      "/api/projects/:key",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: { name: nameSchema, archived: { type: "boolean" } },
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const project = await projectOr404(ctx.db, user.workspaceId, request.params.key);
        const { name, archived } = request.body;
        const changes = { ...(name !== undefined && { name: name.trim() }), ...(archived !== undefined && { archived }) };
        return { project: await updateProject(ctx.db, project.id, changes, ctx.clock.now()) };
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
          const project = await projectOr404(tx, user.workspaceId, request.params.key);
          await lockProject(tx, project.id);
          return insertStatus(tx, project.id, { name, category: request.body.category });
        });
        if (!status) throw new HttpError(409, `Another Status is already named ${name}`);
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
          const project = await projectOr404(tx, user.workspaceId, request.params.key);
          await lockProject(tx, project.id);
          let status = await statusOr404(tx, project, request.params.statusId);
          if (name !== undefined) {
            const renamed = await renameStatus(tx, project.id, status.id, name);
            if (!renamed) throw new HttpError(409, `Another Status is already named ${name}`);
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
          const project = await projectOr404(tx, user.workspaceId, request.params.key);
          await lockProject(tx, project.id);
          const all = await listStatuses(tx, project.id);
          const status = all.find((s) => s.id === request.params.statusId);
          if (!status) throw new HttpError(404, "No such Status in this Project");
          if (!all.some((s) => s.category === status.category && s.id !== status.id)) {
            throw new HttpError(409, `${status.name} is the last Status of its Status Category, which needs at least one`);
          }
          await lockStatus(tx, status.id);
          const target = moveTo === undefined ? undefined : all.find((s) => s.id === moveTo && s.id !== status.id);
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
      const project = await projectOr404(ctx.db, user.workspaceId, request.params.key);
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
          const project = await projectOr404(tx, user.workspaceId, request.params.key);
          // New Tickets start in the Project's first Status.
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
      return { ticket: await ticketOr404(ctx, user.workspaceId, request.params.key) };
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
          const ticket = await findTicketByKey(tx, user.workspaceId, request.params.key, { forUpdate: true });
          if (!ticket) throw new HttpError(404, "No such Ticket");
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
      const ticket = await ticketOr404(ctx, user.workspaceId, request.params.key);
      return { changes: await listHistory(ctx.db, ticket.id) };
    });
  };
}

async function projectOr404(db: Queryable, workspaceId: string, key: string): Promise<Project> {
  const project = await findProjectByKey(db, workspaceId, key);
  if (!project) throw new HttpError(404, "No such Project");
  return project;
}

/** One of the Project's Statuses, by id. */
async function statusOr404(db: Queryable, project: Project, statusId: string): Promise<Status> {
  const status = (await listStatuses(db, project.id)).find((s) => s.id === statusId);
  if (!status) throw new HttpError(404, "No such Status in this Project");
  return status;
}

async function ticketOr404(ctx: AppContext, workspaceId: string, key: string): Promise<Ticket> {
  const ticket = await findTicketByKey(ctx.db, workspaceId, key);
  if (!ticket) throw new HttpError(404, "No such Ticket");
  return ticket;
}
