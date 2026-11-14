import type { FastifyInstance } from "fastify";
import { HttpError, requireUser, type AppContext } from "../context.js";
import { transaction } from "../db/database.js";
import { nameSchema } from "../schemas.js";
import { findProjectByKey, insertProject, listProjects, listStatuses, updateProject, type Project } from "./projects.js";
import { userActor } from "../actor.js";
import { findTicketByKey, insertTicket, listHistory, listTickets, updateTicket, type Ticket, type TicketEdit } from "./tickets.js";

/** A Project key: a letter then letters or digits, 2 to 10 characters. Stored upper case. */
const projectKey = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]{1,9}$" } as const;

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
      const project = await projectOr404(ctx, user.workspaceId, request.params.key);
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
        const project = await projectOr404(ctx, user.workspaceId, request.params.key);
        const { name, archived } = request.body;
        const changes = { ...(name !== undefined && { name: name.trim() }), ...(archived !== undefined && { archived }) };
        return { project: await updateProject(ctx.db, project.id, changes, ctx.clock.now()) };
      },
    );

    app.get<{ Params: { key: string } }>("/api/projects/:key/tickets", async (request) => {
      const user = await requireUser(ctx, request);
      const project = await projectOr404(ctx, user.workspaceId, request.params.key);
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
        const project = await projectOr404(ctx, user.workspaceId, request.params.key);
        const [firstStatus] = await listStatuses(ctx.db, project.id);
        const ticket = await transaction(ctx.db, (tx) =>
          insertTicket(tx, {
            project,
            title: request.body.title.trim(),
            description: request.body.description ?? "",
            status: firstStatus!,
            actor: userActor(user),
            now: ctx.clock.now(),
          }),
        );
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
            const status = (await listStatuses(tx, ticket.projectId)).find((s) => s.id === statusId);
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

async function projectOr404(ctx: AppContext, workspaceId: string, key: string): Promise<Project> {
  const project = await findProjectByKey(ctx.db, workspaceId, key);
  if (!project) throw new HttpError(404, "No such Project");
  return project;
}

async function ticketOr404(ctx: AppContext, workspaceId: string, key: string): Promise<Ticket> {
  const ticket = await findTicketByKey(ctx.db, workspaceId, key);
  if (!ticket) throw new HttpError(404, "No such Ticket");
  return ticket;
}
