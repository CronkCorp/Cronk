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
import { actingUser, userActor, type Actor, type AgentActor } from "../actor.js";
import { addRelation, listRelations, removeRelation } from "./relations.js";
import { FINISHED_CATEGORIES, PRIORITIES, RELATION_KINDS, STATUS_CATEGORIES, type Priority, type RelationKind, type StatusCategory } from "../../shared/values.js";
import type { Queryable } from "../db/database.js";
import { projectFor, requireAdmin, requireProjectAccess, requireUserActor, requireWorkspaceAccess, visibleProjects, type Access, type AgentAccess } from "../identity/access.js";
import { listMemberships, removeMembership, setMembership } from "../identity/memberships.js";
import { findUserById, publicUser } from "../identity/users.js";
import {
  countTicketsInStatus,
  deleteStatus,
  findProjectById,
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
  findTicketsByIds,
  insertTicket,
  listHistory,
  listLabels,
  moveTicketsBetweenStatuses,
  wouldNestUnderItself,
  normalizeLabels,
  listTickets,
  updateTicket,
  type Ticket,
  type TicketChanges,
  type TicketEdit,
  type UserRef,
  type AgentRef,
} from "./tickets.js";
import { findAgent } from "../identity/agents.js";
import { clearClaim, requireClaimHolder } from "../coordination/claims.js";
import { hasReportFromClaim } from "../knowledge/reports.js";
import { ticketDetail, ticketDetailSchema, ticketFor, visibleHistory, visibleRelations } from "./ticket-reads.js";
import { inboxesChanged, usersWithItemsOn } from "../inbox/inbox.js";
import { projectTopic } from "../live/topics.js";
import { statusesChanged, ticketsChanged } from "./ticket-changes.js";
import { readyNow, tellReadyAfter, tellNewlyReady, ticketsBlockedBy } from "../coordination/ready.js";

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
  /** Agent ids, or `none` for Tickets with no Delegate. */
  delegate?: string[];
  priority?: Priority[];
  label?: string[];
}

export function workRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { archived?: boolean } }>(
      "/api/projects",
      {
        schema: {
          querystring: { type: "object", properties: { archived: { type: "boolean" } } },
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
        if (agentAccess !== undefined) requireUserActor(actor, "change Agent Access");
        if (name !== undefined || archived !== undefined) requireUserActor(actor, "rename or archive a Project");
        const changes = {
          ...(name !== undefined && { name: name.trim() }),
          ...(archived !== undefined && { archived }),
          ...(visibility !== undefined && { visibility }),
          ...(agentAccess !== undefined && { agentAccess }),
        };
        // Unarchiving, opening, or raising Agent Access can make the Project's delegated Tickets Ready.
        const opensUp = archived === false || visibility === "open" || agentAccess === "write";
        const updated = await tellReadyAfter(ctx, opensUp ? { projectId: project.id } : undefined, (tx) =>
          updateProject(tx, project.id, changes, ctx.clock.now()),
        );
        if (visibility !== undefined && visibility !== project.visibility) inboxesChanged(ctx.live, await usersWithItemsOn(ctx.db, { projectId: project.id }));
        return { project: { ...updated, access } };
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
        // Write for the Owner can make Tickets delegated to their Agents here Ready.
        const affected = request.body.access === "write" ? { projectId: project.id, ownerId: member.id } : undefined;
        await tellReadyAfter(ctx, affected, (tx) => setMembership(tx, project.id, member.id, request.body.access));
        inboxesChanged(ctx.live, [member.id]);
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
        // In an open Project, no longer being listed with Read gives Write, which can make Tickets Ready.
        const affected = project.visibility === "open" ? { projectId: project.id, ownerId: request.params.userId } : undefined;
        await tellReadyAfter(ctx, affected, (tx) => removeMembership(tx, project.id, request.params.userId));
        inboxesChanged(ctx.live, [request.params.userId]);
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
        const { projectId, status } = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, actor, request.params.key, "write");
          requireUserActor(actor, "manage Statuses");
          await lockProject(tx, project.id);
          return { projectId: project.id, status: await insertStatus(tx, project.id, { name, category: request.body.category }) };
        });
        if (!status) throw statusNameTaken(name);
        statusesChanged(ctx.live, projectId);
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
        const { projectId, status } = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, actor, request.params.key, "write");
          requireUserActor(actor, "manage Statuses");
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
          return { projectId: project.id, status };
        });
        statusesChanged(ctx.live, projectId);
        if (name !== undefined) inboxesChanged(ctx.live, await usersWithItemsOn(ctx.db, { statusId: status.id }));
        return { status };
      },
    );

    app.delete<{ Params: { key: string; statusId: string }; Querystring: { moveTo?: string } }>(
      "/api/projects/:key/statuses/:statusId",
      // `moveTo`: the Status the removed Status's Tickets move to. Required while any Ticket is in it.
      {
        schema: {
          params: statusParams,
          querystring: { type: "object", properties: { moveTo: { type: "string" } } },
          response: { 204: noContent("The Status is removed, and any Tickets in it moved"), ...errors(400, 401, 403, 404, 409, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { moveTo } = request.query;
        const { projectId, moved, mayBecomeReady, readyBefore } = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, actor, request.params.key, "write");
          requireUserActor(actor, "manage Statuses");
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
          let moved: Ticket[] = [];
          let mayBecomeReady: string[] = [];
          let readyBefore = new Map<string, string>();
          if (target) {
            // Moving Tickets into or out of finished work may make them, or the Tickets they block, Ready.
            if (FINISHED_CATEGORIES.includes(status.category) !== FINISHED_CATEGORIES.includes(target.category)) {
              const ids = (await listTickets(tx, project.id, { statusIds: [status.id] })).map((t) => t.id);
              mayBecomeReady = [...ids, ...(await ticketsBlockedBy(tx, ids))];
              readyBefore = await readyNow(tx, mayBecomeReady, ctx.clock.now());
            }
            moved = await moveTicketsBetweenStatuses(tx, status, target, actor, ctx.clock.now());
            if (endsClaim(target)) for (const ticket of moved) await clearClaim(tx, ticket.id);
          } else {
            const inUse = await countTicketsInStatus(tx, status.id);
            if (inUse > 0) {
              throw new HttpError(409, `${inUse} Ticket${inUse === 1 ? " is" : "s are"} in ${status.name}; choose a Status to move them to`);
            }
          }
          await deleteStatus(tx, status.id);
          return { projectId: project.id, moved, mayBecomeReady, readyBefore };
        });
        statusesChanged(ctx.live, projectId);
        // Moved Tickets, and those they block, which show their Status and may now be unblocked.
        ticketsChanged(ctx.live, [...moved, ...(await findTicketsByIds(ctx.db, mayBecomeReady))]);
        await tellNewlyReady(ctx, mayBecomeReady, readyBefore);
        // Moved Tickets may have entered or left an In Review Status.
        inboxesChanged(ctx.live, moved.map((t) => t.assignee?.id));
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
            properties: {
              status: { type: "array", items: { type: "string", format: "uuid" } },
              category: { type: "array", items: { type: "string", enum: STATUS_CATEGORIES } },
              assignee: { type: "array", items: { type: "string", anyOf: [{ format: "uuid" }, { const: "none" }] } },
              delegate: { type: "array", items: { type: "string", anyOf: [{ format: "uuid" }, { const: "none" }] } },
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
            delegateIds: q.delegate?.map((id) => (id === "none" ? null : id)),
            priorities: q.priority,
            labels: q.label,
          }),
        };
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/projects/:key/events",
      {
        schema: {
          params: projectParams,
          response: {
            200: {
              description:
                "A server-sent event stream of changes to the Project's Tickets as they happen, for as long as the caller can see the " +
                "Project. It opens with a `ready` event; whenever one of its Tickets is created or changes (its fields, its Sub-Tickets, " +
                "its relations, its linked Documents, its Claim being taken, released or lapsing) a `changed` event arrives whose data is `{ ticket }`, the " +
                "Ticket's key, and a `changed` event with `{ ticket: null }` when its Statuses change.",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            ...errors(401, 404, 410),
          },
        },
      },
      async (request, reply) => {
        const { project } = await projectFor(ctx.db, await requireActor(ctx, request), request.params.key, "read");
        const canSee = async () => {
          const actor = await requireActor(ctx, request, { refreshSession: false });
          return !!(await projectFor(ctx.db, actor, project.key, "read"));
        };
        ctx.live.stream(reply, projectTopic(project.id), canSee);
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
        ticketsChanged(ctx.live, [ticket]);
        return reply.code(201).send({ ticket });
      },
    );

    app.post<{ Params: { key: string }; Body: { title: string; description?: string } }>(
      "/api/tickets/:key/sub-tickets",
      {
        schema: {
          params: ticketParams,
          body: {
            type: "object",
            required: ["title"],
            additionalProperties: false,
            properties: { title, description },
          },
          response: {
            201: answer(
              "The new Sub-Ticket, in the Project's first Status, with the parent's Assignee and Delegate. An Agent must hold the parent's Claim.",
              holding("ticket", "Ticket"),
            ),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const now = ctx.clock.now();
        const { parent, ticket } = await transaction(ctx.db, async (tx) => {
          // The Project first, as creating Tickets and removing Statuses lock it, then the parent.
          await lockProject(tx, (await ticketFor(tx, actor, request.params.key, "write")).projectId);
          const parent = await ticketFor(tx, actor, request.params.key, "write", { forUpdate: true });
          if (actor.kind === "agent") await requireClaimHolder(tx, actor, parent, now, "splitting it into Sub-Tickets");
          const project = (await findProjectById(tx, parent.projectId))!;
          const [firstStatus] = await listStatuses(tx, project.id);
          const created = await insertTicket(tx, {
            project,
            title: request.body.title.trim(),
            description: request.body.description ?? "",
            status: firstStatus!,
            actor,
            now,
          });
          return { parent, ticket: await updateTicket(tx, created, { parent, assignee: parent.assignee, delegate: parent.delegate }, actor, now) };
        });
        // The parent lists its Sub-Tickets.
        ticketsChanged(ctx.live, [ticket, parent]);
        await tellNewlyReady(ctx, [ticket.id], new Map());
        return reply.code(201).send({ ticket });
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/tickets/:key",
      {
        schema: {
          params: ticketParams,
          response: {
            200: answer(
              "The Ticket, its Sub-Tickets in key order, its relations to Tickets the caller can see, and its live Claim",
              ticketDetailSchema,
            ),
            ...errors(401, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const ticket = await ticketFor(ctx.db, actor, request.params.key, "read");
        return ticketDetail(ctx.db, actor, ticket, ctx.clock.now());
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
        const { ends, relations } = await transaction(ctx.db, async (tx) => {
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
          return { ends: [ticket, other], relations: await visibleRelations(tx, actor, await listRelations(tx, ticket.id)) };
        });
        ticketsChanged(ctx.live, ends);
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
        const { ends, readyBefore, relations } = await transaction(ctx.db, async (tx) => {
          const { ticket, other } = await relationEnds(tx, actor, request.params.key, request.params.otherKey);
          // Removing a blocking relation may unblock either end.
          const readyBefore = await readyNow(tx, [ticket.id, other.id], ctx.clock.now());
          const removed = await removeRelation(tx, { ticket, kind: request.params.kind, other, actor: actor, now: ctx.clock.now() });
          if (!removed) throw new HttpError(404, "No such relation");
          return { ends: [ticket, other], readyBefore, relations: await visibleRelations(tx, actor, await listRelations(tx, ticket.id)) };
        });
        ticketsChanged(ctx.live, ends);
        await tellNewlyReady(ctx, ends.map((t) => t.id), readyBefore);
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
              delegateId: { type: ["string", "null"], format: "uuid", description: "One of the Assignee's own Agents. Only Users assign and delegate." },
              parentKey: { type: ["string", "null"], maxLength: 30 },
            },
          },
          response: { 200: answer("The changed Ticket", holding("ticket", "Ticket")), ...errors(400, 401, 403, 404, 409, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { title, description, statusId, priority, labels, assigneeId, delegateId, parentKey } = request.body;
        if (actor.kind === "agent" && (assigneeId !== undefined || delegateId !== undefined)) {
          throw new HttpError(403, "Only a User can assign or delegate a Ticket, not an Agent");
        }
        const { before, ticket, parents, blockedIds, mayBecomeReady, readyBefore } = await transaction(ctx.db, async (tx) => {
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
            if (actor.kind === "agent" && status.id !== ticket.status.id) await requireAgentMayMove(tx, actor, ticket, status, ctx.clock.now());
            changes.status = status;
          }
          if (assigneeId !== undefined) changes.assignee = assigneeId === null ? null : await assignableUser(tx, actor, ticket, assigneeId);
          const assignee = changes.assignee === undefined ? ticket.assignee : changes.assignee;
          if (delegateId !== undefined) {
            changes.delegate = delegateId === null ? null : await delegableAgent(tx, actingUser(actor).workspaceId, assignee, delegateId);
          } else if (assignee?.id !== ticket.assignee?.id && ticket.delegate && !(await ownsAgent(tx, actingUser(actor).workspaceId, assignee, ticket.delegate.id))) {
            // A new Assignee doesn't take over someone else's Agent.
            changes.delegate = null;
          }
          if (parentKey !== undefined) changes.parent = parentKey === null ? null : await parentFor(tx, actingUser(actor).workspaceId, ticket, parentKey);
          // Both parents list their Sub-Tickets.
          const parents = changes.parent === undefined ? [] : [changes.parent, ticket.parent && (await findTicketByKey(tx, actingUser(actor).workspaceId, ticket.parent.key))];
          // A new Delegate starts afresh: whoever held the Claim was working for the old one.
          const finishes = changes.status !== undefined && endsClaim(changes.status);
          if (finishes || (changes.delegate !== undefined && changes.delegate?.id !== ticket.delegate?.id)) await clearClaim(tx, ticket.id);
          // A new Delegate or Status may make the Ticket Ready, and finishing it may unblock others.
          const blockedIds = changes.status ? await ticketsBlockedBy(tx, [ticket.id]) : [];
          const mayBecomeReady = [ticket.id, ...blockedIds];
          const readyBefore = await readyNow(tx, mayBecomeReady, ctx.clock.now());
          const updated = await updateTicket(tx, ticket, changes, actor, ctx.clock.now());
          return { before: ticket, ticket: updated, parents, blockedIds, mayBecomeReady, readyBefore };
        });
        // Any change may show in the Inbox of whoever was or is now its Assignee.
        if (ticket !== before) {
          inboxesChanged(ctx.live, [before.assignee?.id, ticket.assignee?.id]);
          // The Tickets it blocks show its Status, and may now be unblocked.
          ticketsChanged(ctx.live, [ticket, ...parents, ...(await findTicketsByIds(ctx.db, blockedIds))]);
          await tellNewlyReady(ctx, mayBecomeReady, readyBefore);
        }
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
              "The Ticket's history, oldest first, leaving out relations to Tickets and links to Documents the caller can't see",
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

/** The Status Categories an Agent may move a Ticket into; only Users complete, cancel or shelve work. */
const AGENT_CATEGORIES: StatusCategory[] = ["unstarted", "started", "in_review"];

/**
 * Whether moving a Ticket into `status` ends its Claim: a finished Ticket has no work left to Claim,
 * and only Users finish work.
 */
const endsClaim = (status: Status) => FINISHED_CATEGORIES.includes(status.category);

/**
 * Refuses an Agent's move of `ticket` into `status` unless the Status is Unstarted, Started or
 * In Review (a 403) and the Agent calls within the Agent Session holding the Ticket's live Claim (a 409).
 * Moving into In Review hands the work over, so it also needs a Report written during that Claim (a 409).
 * (Agents can't complete Tickets yet; once Autonomous Delegation lets them, completing needs one too.)
 */
async function requireAgentMayMove(db: Queryable, agent: AgentActor, ticket: Ticket, status: Status, now: Date): Promise<void> {
  if (!AGENT_CATEGORIES.includes(status.category)) {
    throw new HttpError(403, "Agents may only move Tickets into Unstarted, Started or In Review Statuses; a User decides the rest");
  }
  const claimId = await requireClaimHolder(db, agent, ticket, now, "moving it");
  if (status.category === "in_review" && !(await hasReportFromClaim(db, ticket.id, claimId))) {
    throw new HttpError(
      409,
      `Write a Report on ${ticket.key} before moving it to ${status.name}: handing work over needs a Report written during your current Claim`,
    );
  }
}

/** The Agent `id`, as a Ticket shows it, if it is one of `assignee`'s own; otherwise a 400. */
async function delegableAgent(db: Queryable, workspaceId: string, assignee: UserRef | null, id: string): Promise<AgentRef> {
  if (!assignee) throw new HttpError(400, "Assign the Ticket to a User before delegating it");
  const agent = await findAgent(db, workspaceId, id);
  if (!agent) throw new HttpError(400, "No such Agent");
  if (agent.ownerId !== assignee.id) throw new HttpError(400, `The Delegate must be one of the Assignee's own Agents, and ${agent.name} isn't ${assignee.name}'s`);
  return { id: agent.id, name: agent.name };
}

/** Whether the Agent `agentId` exists and is one of `user`'s own. */
async function ownsAgent(db: Queryable, workspaceId: string, user: UserRef | null, agentId: string): Promise<boolean> {
  const agent = await findAgent(db, workspaceId, agentId);
  return !!user && agent?.ownerId === user.id;
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

/** The Status with this id among a Project's Statuses. */
function statusOr404(statuses: Status[], statusId: string): Status {
  const status = statuses.find((s) => s.id === statusId);
  if (!status) throw new HttpError(404, "No such Status in this Project");
  return status;
}

const statusNameTaken = (name: string) => new HttpError(409, `Another Status is already named ${name}`);
