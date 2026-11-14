import type { FastifyInstance } from "fastify";
import { HttpError, requireActor, type AppContext } from "../context.js";
import { transaction } from "../db/database.js";
import {
  accessSchema,
  agentAccessSchema,
  answer,
  errors,
  holding,
  listing,
  nameSchema,
  noContent,
  pathParams,
  projectKeyParam,
  ref,
  ticketKeyParam,
  userIdParam,
} from "../schemas.js";
import { actingUser, userActor, type Actor } from "../actor.js";
import { addRelation, listRelations, removeRelation, type Relations } from "./relations.js";
import { PRIORITIES, RELATION_KINDS, STATUS_CATEGORIES, type Priority, type RelationKind, type StatusCategory } from "../../shared/values.js";
import type { Queryable } from "../db/database.js";
import { requireAdmin, requireProjectAccess, requireWorkspaceAccess, visibleProjects, type Access, type AgentAccess } from "../identity/access.js";
import { listMemberships, removeMembership, setMembership } from "../identity/memberships.js";
import { findUserById, publicUser } from "../identity/users.js";
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
  updateProject,
  type Project,
  type Status,
  type Visibility,
} from "./projects.js";
import {
  findTicketByKey,
  insertTicket,
  listHistory,
  listLabels,
  moveTicketsBetweenStatuses,
  listSubTickets,
  wouldNestUnderItself,
  normalizeLabels,
  listTickets,
  updateTicket,
  type RecordedChange,
  type Ticket,
  type TicketChanges,
  type TicketEdit,
  type TicketRef,
  type UserRef,
} from "./tickets.js";

const projectKey = { type: "string", pattern: `^${PROJECT_KEY_PATTERN}$` } as const;

/** A Ticket title: non-blank, at most 500 characters. */
const title = { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } as const;
/** A Ticket's Markdown description. */
const description = { type: "string", maxLength: 100_000 } as const;

/** A Label: non-blank, at most 50 characters. */
const label = { type: "string", minLength: 1, maxLength: 50, pattern: "\\S" } as const;

const projectParams = pathParams({ key: projectKeyParam });
const statusParams = pathParams({ key: projectKeyParam, statusId: { type: "string", description: "The Status's id." } });
const ticketParams = pathParams({ key: ticketKeyParam });

/** A User listed in a Project, with their access there. */
const member = { type: "object", required: ["user", "access"], properties: { user: ref("User"), access: accessSchema } } as const;

/** Filters for a Project's Ticket list; each may be repeated to match any of several values. */
interface TicketQuery {
  status?: string[];
  category?: StatusCategory[];
  /** User ids, or `none` for unassigned. */
  assignee?: string[];
  priority?: Priority[];
  label?: string[];
}

export function workRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { archived?: boolean } }>(
      "/api/projects",
      {
        schema: {
          querystring: { type: "object", additionalProperties: false, properties: { archived: { type: "boolean" } } },
          response: { 200: answer("The Projects the caller can see", listing("projects", ref("Project"))), ...errors(400, 401, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const projects = await listProjects(ctx.db, actingUser(actor).workspaceId, request.query.archived ?? false);
        return { projects: await visibleProjects(ctx.db, actor, projects) };
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
          response: {
            201: answer("The new Project, with one Status per Status Category", holding("project", "Project")),
            ...errors(400, 401, 403, 409, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "write");
        const key = request.body.key.toUpperCase();
        const project = await transaction(ctx.db, (tx) =>
          insertProject(tx, { workspaceId: actingUser(actor).workspaceId, name: request.body.name.trim(), key, now: ctx.clock.now() }),
        );
        if (!project) throw new HttpError(409, `Another Project already has the key ${key}`);
        return reply.code(201).send({ project: { ...project, access: "write" } });
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/projects/:key",
      {
        schema: {
          params: projectParams,
          response: {
            200: answer("The Project and its Statuses, in workflow order", {
              type: "object",
              required: ["project", "statuses"],
              properties: { project: ref("Project"), statuses: { type: "array", items: ref("Status") } },
            }),
            ...errors(401, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { project, access } = await projectFor(ctx.db, actor, request.params.key, "read");
        return { project: { ...project, access }, statuses: await listStatuses(ctx.db, project.id) };
      },
    );

    app.patch<{
      Params: { key: string };
      Body: { name?: string; archived?: boolean; visibility?: Visibility; agentAccess?: AgentAccess };
    }>(
      "/api/projects/:key",
      {
        schema: {
          params: projectParams,
          body: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: nameSchema,
              archived: { type: "boolean" },
              visibility: { type: "string", enum: ["open", "private"] },
              agentAccess: agentAccessSchema,
            },
          },
          response: { 200: answer("The changed Project", holding("project", "Project")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { project, access } = await projectFor(ctx.db, actor, request.params.key, "write");
        const { name, archived, visibility, agentAccess } = request.body;
        if (visibility !== undefined) requireAdmin(actor, "make a Project open or private");
        if (agentAccess !== undefined && actor.kind === "agent") throw new HttpError(403, "Only a User can change Agent Access");
        const changes = {
          ...(name !== undefined && { name: name.trim() }),
          ...(archived !== undefined && { archived }),
          ...(visibility !== undefined && { visibility }),
          ...(agentAccess !== undefined && { agentAccess }),
        };
        return { project: { ...(await updateProject(ctx.db, project.id, changes, ctx.clock.now())), access } };
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/projects/:key/members",
      {
        schema: {
          params: projectParams,
          response: {
            200: answer("The Users listed in the Project, with their access", listing("members", member)),
            ...errors(401, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
        const members = await listMemberships(ctx.db, project.id);
        return { members: members.map((m) => ({ user: publicUser(m.user), access: m.access })) };
      },
    );

    const memberParams = pathParams({
      key: projectKeyParam,
      userId: userIdParam,
    });

    app.put<{ Params: { key: string; userId: string }; Body: { access: Access } }>(
      "/api/projects/:key/members/:userId",
      {
        schema: {
          params: memberParams,
          body: {
            type: "object",
            required: ["access"],
            additionalProperties: false,
            properties: { access: accessSchema },
          },
          response: {
            200: answer("The User's access in the Project", { type: "object", required: ["member"], properties: { member } }),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
        requireAdmin(actor, "change who is in a Project");
        const member = await findUserById(ctx.db, request.params.userId);
        if (!member || member.workspaceId !== actingUser(actor).workspaceId) throw new HttpError(404, "No such User");
        if (member.role === "admin") throw new HttpError(400, "Admins have Write access in every Project");
        await setMembership(ctx.db, project.id, member.id, request.body.access);
        return { member: { user: publicUser(member), access: request.body.access } };
      },
    );

    app.delete<{ Params: { key: string; userId: string } }>(
      "/api/projects/:key/members/:userId",
      {
        schema: {
          params: memberParams,
          response: { 204: noContent("The User is no longer listed in the Project"), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
        requireAdmin(actor, "change who is in a Project");
        await removeMembership(ctx.db, project.id, request.params.userId);
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { key: string }; Body: { name: string; category: StatusCategory } }>(
      "/api/projects/:key/statuses",
      {
        schema: {
          params: projectParams,
          body: {
            type: "object",
            required: ["name", "category"],
            additionalProperties: false,
            properties: { name: nameSchema, category: { type: "string", enum: STATUS_CATEGORIES } },
          },
          response: {
            201: answer("The new Status, last of its Status Category", holding("status", "Status")),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const name = request.body.name.trim();
        const status = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, actor, request.params.key, "write");
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
          params: statusParams,
          body: {
            type: "object",
            additionalProperties: false,
            // `position` counts from 0 among the Statuses of the same Status Category.
            properties: { name: nameSchema, position: { type: "integer", minimum: 0 } },
          },
          response: { 200: answer("The changed Status", holding("status", "Status")), ...errors(400, 401, 403, 404, 409, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const name = request.body.name?.trim();
        const status = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, actor, request.params.key, "write");
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
      {
        schema: {
          params: statusParams,
          querystring: { type: "object", additionalProperties: false, properties: { moveTo: { type: "string" } } },
          response: { 204: noContent("The Status is removed, and any Tickets in it moved"), ...errors(400, 401, 403, 404, 409, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { moveTo } = request.query;
        await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, actor, request.params.key, "write");
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
            await moveTicketsBetweenStatuses(tx, status, target, actor, ctx.clock.now());
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

    app.get<{ Params: { key: string }; Querystring: TicketQuery }>(
      "/api/projects/:key/tickets",
      {
        schema: {
          params: projectParams,
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: {
              status: { type: "array", items: { type: "string", format: "uuid" } },
              category: { type: "array", items: { type: "string", enum: STATUS_CATEGORIES } },
              assignee: { type: "array", items: { type: "string", anyOf: [{ format: "uuid" }, { const: "none" }] } },
              priority: { type: "array", items: { type: "string", enum: PRIORITIES } },
              label: { type: "array", items: { type: "string", maxLength: 50 } },
            },
          },
          response: {
            200: answer("The Project's Tickets matching the filters, in key order", listing("tickets", ref("Ticket"))),
            ...errors(400, 401, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
        const q = request.query;
        return {
          tickets: await listTickets(ctx.db, project.id, {
            statusIds: q.status,
            categories: q.category,
            assigneeIds: q.assignee?.map((id) => (id === "none" ? null : id)),
            priorities: q.priority,
            labels: q.label,
          }),
        };
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/projects/:key/labels",
      {
        schema: {
          params: projectParams,
          response: {
            200: answer(
              "The Labels on the Project's Tickets, alphabetically, one per spelling ignoring case",
              listing("labels", { type: "string" }),
            ),
            ...errors(401, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
        return { labels: await listLabels(ctx.db, project.id) };
      },
    );

    app.post<{ Params: { key: string }; Body: { title: string; description?: string } }>(
      "/api/projects/:key/tickets",
      {
        schema: {
          params: projectParams,
          body: {
            type: "object",
            required: ["title"],
            additionalProperties: false,
            properties: { title, description },
          },
          response: {
            201: answer("The new Ticket, in the Project's first Status", holding("ticket", "Ticket")),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const ticket = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, actor, request.params.key, "write");
          // New Tickets start in the Project's first Status; the lock keeps it from being removed meanwhile.
          await lockProject(tx, project.id);
          const [firstStatus] = await listStatuses(tx, project.id);
          return insertTicket(tx, {
            project,
            title: request.body.title.trim(),
            description: request.body.description ?? "",
            status: firstStatus!,
            actor: actor,
            now: ctx.clock.now(),
          });
        });
        return reply.code(201).send({ ticket });
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/tickets/:key",
      {
        schema: {
          params: ticketParams,
          response: {
            200: answer("The Ticket, its Sub-Tickets in key order, and its relations to Tickets the caller can see", {
              type: "object",
              required: ["ticket", "subTickets", "relations"],
              properties: { ticket: ref("Ticket"), subTickets: { type: "array", items: ref("TicketRef") }, relations: ref("Relations") },
            }),
            ...errors(401, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const ticket = await ticketFor(ctx.db, actor, request.params.key, "read");
        return {
          ticket,
          subTickets: await listSubTickets(ctx.db, ticket.id),
          relations: await visibleRelations(ctx.db, actor, await listRelations(ctx.db, ticket.id)),
        };
      },
    );

    app.post<{ Params: { key: string }; Body: { kind: RelationKind; ticketKey: string } }>(
      "/api/tickets/:key/relations",
      {
        schema: {
          params: ticketParams,
          body: {
            type: "object",
            required: ["kind", "ticketKey"],
            additionalProperties: false,
            properties: { kind: { type: "string", enum: RELATION_KINDS }, ticketKey: { type: "string", maxLength: 30 } },
          },
          response: {
            201: answer("The Ticket's relations, with the new one", holding("relations", "Relations")),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const relations = await transaction(ctx.db, async (tx) => {
          const { ticket, other } = await relationEnds(tx, actor, request.params.key, request.body.ticketKey);
          const added = await addRelation(tx, actingUser(actor).workspaceId, {
            ticket,
            kind: request.body.kind,
            other,
            actor: actor,
            now: ctx.clock.now(),
          });
          if (!added) {
            throw new HttpError(409, `${other.key} already blocks ${ticket.key}, directly or through other Tickets, so that would make a blocking cycle`);
          }
          return visibleRelations(tx, actor, await listRelations(tx, ticket.id));
        });
        return reply.code(201).send({ relations });
      },
    );

    app.delete<{ Params: { key: string; kind: RelationKind; otherKey: string } }>(
      "/api/tickets/:key/relations/:kind/:otherKey",
      {
        schema: {
          params: pathParams({
            key: ticketKeyParam,
            kind: {
              type: "string",
              enum: RELATION_KINDS,
              description: "How the Ticket relates to the other, read from the Ticket's side.",
            },
            otherKey: { type: "string", description: "The other Ticket's key, such as `CRONK-7`; any case." },
          }),
          response: {
            200: answer("The Ticket's remaining relations", holding("relations", "Relations")),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const relations = await transaction(ctx.db, async (tx) => {
          const { ticket, other } = await relationEnds(tx, actor, request.params.key, request.params.otherKey);
          const removed = await removeRelation(tx, { ticket, kind: request.params.kind, other, actor: actor, now: ctx.clock.now() });
          if (!removed) throw new HttpError(404, "No such relation");
          return visibleRelations(tx, actor, await listRelations(tx, ticket.id));
        });
        return { relations };
      },
    );

    app.patch<{ Params: { key: string }; Body: TicketChanges }>(
      "/api/tickets/:key",
      {
        schema: {
          params: ticketParams,
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
              parentKey: { type: ["string", "null"], maxLength: 30 },
            },
          },
          response: { 200: answer("The changed Ticket", holding("ticket", "Ticket")), ...errors(400, 401, 403, 404, 409, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { title, description, statusId, priority, labels, assigneeId, parentKey } = request.body;
        const ticket = await transaction(ctx.db, async (tx) => {
          const ticket = await ticketFor(tx, actor, request.params.key, "write", { forUpdate: true });
          const changes: TicketEdit = {
            ...(title !== undefined && { title: title.trim() }),
            ...(description !== undefined && { description }),
            ...(priority !== undefined && { priority }),
            ...(labels !== undefined && { labels: normalizeLabels(labels) }),
          };
          if (statusId !== undefined) {
            const status = await findStatusToMoveInto(tx, ticket.projectId, statusId);
            if (!status) throw new HttpError(400, "That Status isn't one of this Ticket's Project");
            changes.status = status;
          }
          if (assigneeId !== undefined) changes.assignee = assigneeId === null ? null : await assignableUser(tx, actor, ticket, assigneeId);
          if (parentKey !== undefined) changes.parent = parentKey === null ? null : await parentFor(tx, actingUser(actor).workspaceId, ticket, parentKey);
          return updateTicket(tx, ticket, changes, actor, ctx.clock.now());
        });
        return { ticket };
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/tickets/:key/history",
      {
        schema: {
          params: ticketParams,
          response: {
            200: answer(
              "The Ticket's history, oldest first, leaving out relations to Tickets the caller can't see",
              listing("changes", ref("RecordedChange")),
            ),
            ...errors(401, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const ticket = await ticketFor(ctx.db, actor, request.params.key, "read");
        return { changes: await visibleHistory(ctx.db, actor, await listHistory(ctx.db, ticket.id)) };
      },
    );
  };
}

/** The User `id`, as a Ticket shows them, if they are active and can see the Ticket's Project; otherwise a 400. */
async function assignableUser(db: Queryable, actor: Actor, ticket: Ticket, id: string): Promise<UserRef> {
  const assignee = await findUserById(db, id);
  if (!assignee || assignee.workspaceId !== actingUser(actor).workspaceId) throw new HttpError(400, "No such User");
  if (!assignee.active) throw new HttpError(400, `${assignee.name} is deactivated`);
  const project = (await findProjectById(db, ticket.projectId))!;
  if ((await visibleProjects(db, userActor(assignee), [project])).length === 0) throw new HttpError(400, `${assignee.name} can't see this Project`);
  return { id: assignee.id, name: assignee.name };
}

/** Keys of the Projects, archived or not, that `actor` can see. */
async function visibleProjectKeys(db: Queryable, actor: Actor): Promise<Set<string>> {
  const projects = [...(await listProjects(db, actingUser(actor).workspaceId, false)), ...(await listProjects(db, actingUser(actor).workspaceId, true))];
  return new Set((await visibleProjects(db, actor, projects)).map((p) => p.key));
}

/** The Project key a Ticket key starts with. */
const projectKeyOf = (ticketKey: string) => ticketKey.slice(0, ticketKey.lastIndexOf("-"));

/** Relations, leaving out Tickets of Projects `actor` can't see. */
async function visibleRelations(db: Queryable, actor: Actor, relations: Relations): Promise<Relations> {
  const keys = await visibleProjectKeys(db, actor);
  const visible = (refs: TicketRef[]) => refs.filter((ref) => keys.has(projectKeyOf(ref.key)));
  return { blocks: visible(relations.blocks), blockedBy: visible(relations.blockedBy), relatesTo: visible(relations.relatesTo) };
}

/** A Ticket's history, leaving out Relation changes with Tickets of Projects `actor` can't see. */
async function visibleHistory(db: Queryable, actor: Actor, changes: RecordedChange[]): Promise<RecordedChange[]> {
  const keys = await visibleProjectKeys(db, actor);
  return changes.filter((c) => !(c.change === "relation added" || c.change === "relation removed") || keys.has(projectKeyOf(c.ticket.key)));
}

/** The Ticket `key` names, if it may become the parent of `ticket`; otherwise a 400 or 409. */
async function parentFor(tx: Queryable, workspaceId: string, ticket: Ticket, key: string): Promise<Ticket> {
  const parent = await findTicketByKey(tx, workspaceId, key);
  if (!parent || parent.projectId !== ticket.projectId) throw new HttpError(400, "The parent must be a Ticket of the same Project");
  if (parent.id === ticket.id) throw new HttpError(400, "A Ticket can't be its own parent");
  if (await wouldNestUnderItself(tx, ticket, parent)) {
    throw new HttpError(409, `${parent.key} is a Sub-Ticket of ${ticket.key}, so it can't be its parent`);
  }
  return parent;
}

/**
 * The two Tickets of a Relation being changed, if `actor` has Write in both Projects,
 * since the change shows on both. A missing or hidden `key` answers 404; a missing or
 * hidden `otherKey`, 400.
 */
async function relationEnds(tx: Queryable, actor: Actor, key: string, otherKey: string): Promise<{ ticket: Ticket; other: Ticket }> {
  const ticket = await ticketFor(tx, actor, key, "write");
  const other = await ticketFor(tx, actor, otherKey, "write").catch((err: unknown) => {
    throw err instanceof HttpError && err.statusCode === 404 ? new HttpError(400, `No such Ticket ${otherKey}`) : err;
  });
  if (other.id === ticket.id) throw new HttpError(400, "A Ticket can't be related to itself");
  return { ticket, other };
}

/** The Project with this key, if `actor` has at least `need` in it (see `requireProjectAccess`). */
async function projectFor(db: Queryable, actor: Actor, key: string, need: Access): Promise<{ project: Project; access: Access }> {
  const project = await findProjectByKey(db, actingUser(actor).workspaceId, key);
  if (!project) throw new HttpError(404, "No such Project");
  return { project, access: await requireProjectAccess(db, actor, project, need) };
}

/** The Status with this id among a Project's Statuses. */
function statusOr404(statuses: Status[], statusId: string): Status {
  const status = statuses.find((s) => s.id === statusId);
  if (!status) throw new HttpError(404, "No such Status in this Project");
  return status;
}

const statusNameTaken = (name: string) => new HttpError(409, `Another Status is already named ${name}`);

/**
 * The Ticket with this key, if `actor` has at least `need` in its Project. A Ticket in
 * a Project they can't see answers 404, like one that doesn't exist.
 */
async function ticketFor(db: Queryable, actor: Actor, key: string, need: Access, opts: { forUpdate?: boolean } = {}): Promise<Ticket> {
  const ticket = await findTicketByKey(db, actingUser(actor).workspaceId, key, opts);
  const project = ticket && (await findProjectById(db, ticket.projectId));
  if (!ticket || !project) throw new HttpError(404, "No such Ticket");
  await requireProjectAccess(db, actor, project, need, "No such Ticket");
  return ticket;
}
