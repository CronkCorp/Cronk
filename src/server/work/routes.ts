import type { FastifyInstance } from "fastify";
import { HttpError, requireUser, type AppContext } from "../context.js";
import { transaction } from "../db/database.js";
import { nameSchema } from "../schemas.js";
import { userActor } from "../actor.js";
import { findUserById } from "../identity/users.js";
import type { Queryable } from "../db/database.js";
import {
  findProjectByKey,
  insertProject,
  listProjects,
  listStatuses,
  PROJECT_KEY_PATTERN,
  updateProject,
  type Project,
} from "./projects.js";
import {
  findTicketByKey,
  insertTicket,
  listHistory,
  listLabels,
  normalizeLabels,
  listTickets,
  PRIORITIES,
  updateTicket,
  type Priority,
  type Ticket,
  type TicketEdit,
  type UserRef,
} from "./tickets.js";

const projectKey = { type: "string", pattern: `^${PROJECT_KEY_PATTERN}$` } as const;

/** A Ticket title: non-blank, at most 500 characters. */
const title = { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } as const;
/** A Ticket's Markdown description. */
const description = { type: "string", maxLength: 100_000 } as const;

/** A Label: non-blank, at most 50 characters. */
const label = { type: "string", minLength: 1, maxLength: 50, pattern: "\\S" } as const;

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

    app.get<{ Params: { key: string } }>("/api/projects/:key/tickets", async (request) => {
      const user = await requireUser(ctx, request);
      const project = await projectOr404(ctx.db, user.workspaceId, request.params.key);
      return { tickets: await listTickets(ctx.db, project.id) };
    });

    app.get<{ Params: { key: string } }>("/api/projects/:key/labels", async (request) => {
      const user = await requireUser(ctx, request);
      const project = await projectOr404(ctx.db, user.workspaceId, request.params.key);
      return { labels: await listLabels(ctx.db, project.id) };
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

    app.patch<{ Params: { key: string }; Body: { title?: string; description?: string; statusId?: string; priority?: Priority; labels?: string[]; assigneeId?: string | null } }>(
      "/api/tickets/:key",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: {
              title,
              description,
              statusId: { type: "string", format: "uuid" },
              priority: { type: "string", enum: PRIORITIES },
              labels: { type: "array", maxItems: 20, items: label },
              assigneeId: { type: ["string", "null"], format: "uuid" },
            },
          },
        },
      },
      async (request) => {
        const user = await requireUser(ctx, request);
        const { title, description, statusId, priority, labels, assigneeId } = request.body;
        const ticket = await transaction(ctx.db, async (tx) => {
          const ticket = await findTicketByKey(tx, user.workspaceId, request.params.key, { forUpdate: true });
          if (!ticket) throw new HttpError(404, "No such Ticket");
          const changes: TicketEdit = {
            ...(title !== undefined && { title: title.trim() }),
            ...(description !== undefined && { description }),
            ...(priority !== undefined && { priority }),
            ...(labels !== undefined && { labels: normalizeLabels(labels) }),
          };
          if (statusId !== undefined) {
            const status = (await listStatuses(tx, ticket.projectId)).find((s) => s.id === statusId);
            if (!status) throw new HttpError(400, "That Status isn't one of this Ticket's Project");
            changes.status = status;
          }
          if (assigneeId !== undefined) changes.assignee = assigneeId === null ? null : await workspaceUser(tx, user.workspaceId, assigneeId);
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

/** A User of the Workspace, as a Ticket shows them, or a 400. */
async function workspaceUser(db: Queryable, workspaceId: string, id: string): Promise<UserRef> {
  const found = await findUserById(db, id);
  if (!found || found.workspaceId !== workspaceId) throw new HttpError(400, "No such User");
  return { id: found.id, name: found.name };
}

async function projectOr404(db: Queryable, workspaceId: string, key: string): Promise<Project> {
  const project = await findProjectByKey(db, workspaceId, key);
  if (!project) throw new HttpError(404, "No such Project");
  return project;
}

async function ticketOr404(ctx: AppContext, workspaceId: string, key: string): Promise<Ticket> {
  const ticket = await findTicketByKey(ctx.db, workspaceId, key);
  if (!ticket) throw new HttpError(404, "No such Ticket");
  return ticket;
}
