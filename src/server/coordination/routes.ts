import type { FastifyInstance } from "fastify";
import type { Actor, AgentActor } from "../actor.js";
import { AGENT_SESSION_HEADER, HttpError, requireActor, type AppContext } from "../context.js";
import { requireWorkspaceAccess, visibleProjects } from "../identity/access.js";
import { publicAgent } from "../identity/agents.js";
import { getGuidance, projectGuidanceMarkdown } from "../knowledge/guidance.js";
import { listTerms, termNamesByProject } from "../knowledge/terms.js";
import { listProjects } from "../work/projects.js";
import { getWorkspace } from "../workspace/workspaces.js";
import { accessSchema, answer, errors, holding, listing, noContent, pathParams, ref, savedHolding, ticketKeyParam } from "../schemas.js";
import { avoidedWordsIn, titleAndBody } from "../knowledge/avoided-words.js";
import { transaction } from "../db/database.js";
import { ticketDetail, ticketDetailSchema, ticketFor } from "../work/ticket-reads.js";
import { claimNextReady, clearClaim, findLiveClaim, isTicketReady, listReadyTicketIds, requireClaimHolder, setClaim } from "./claims.js";
import { findReport, insertReport, listTicketReports } from "../knowledge/reports.js";
import { insertActivity, listActivities, publicActivity } from "./activities.js";
import { findTicketById, findTicketsByIds } from "../work/tickets.js";
import { ACTIVITY_KINDS, PRIORITIES, type ActivityKind } from "../../shared/values.js";
import { latestWaitingSeq, missedWaitingWork, takeWaitingWork, waitingEvent } from "./waiting-work.js";
import { agentTopic, ticketTopic } from "../live/topics.js";
import { waitingItemsChanged } from "../inbox/inbox.js";
import { ticketsChanged } from "../work/ticket-changes.js";
import { claimsEnded, readyScope, readyTicket, whyNotReady } from "./ready.js";
import { endAgentSession, publicAgentSession, startAgentSession, type AgentSession } from "./agent-sessions.js";

const ticketParams = pathParams({ key: ticketKeyParam });

const sessionHeader = {
  type: "object",
  required: [AGENT_SESSION_HEADER],
  properties: { [AGENT_SESSION_HEADER]: { type: "string", description: "The id of one of the Agent's live Agent Sessions" } },
} as const;

/** How many Ready Tickets the welcome lists. */
const WELCOME_READY_LIMIT = 20;

/** What an Agent is told when its Agent Session starts (see `welcome`). */
const welcomeSchema = {
  type: "object",
  required: ["workspace", "agent", "readOnly", "projects", "readyTickets", "waitingWork", "artifacts"],
  properties: {
    workspace: {
      anyOf: [
        {
          type: "object",
          required: ["name", "guidance", "terms"],
          properties: {
            name: { type: "string" },
            guidance: { type: "string", description: "The Workspace's Guidance, as Markdown." },
            terms: { type: "array", items: { type: "string" }, description: "The names of the Workspace's Terms, by name; get one with the terms tool." },
          },
        },
        { type: "null" },
      ],
      description: "Null when the Workspace's Agent Access is None.",
    },
    agent: ref("Agent"),
    readOnly: { type: "boolean" },
    projects: {
      type: "array",
      description: "The unarchived Projects the Agent can see, with its access and the Project's Guidance in each.",
      items: {
        type: "object",
        required: ["key", "name", "access", "guidance", "terms"],
        properties: {
          key: { type: "string" },
          name: { type: "string" },
          access: accessSchema,
          guidance: { type: "string", description: "The Project's Guidance, as Markdown; it layers over the Workspace's." },
          terms: {
            type: "array",
            items: { type: "string" },
            description: "The names of the Project's own Terms, by name; within the Project each replaces the Workspace Term of the same name, ignoring case.",
          },
        },
      },
    },
    readyTickets: {
      type: "array",
      description: `The Agent's Ready Tickets in the order \`next\` offers them, at most ${WELCOME_READY_LIMIT}.`,
      items: {
        type: "object",
        required: ["key", "title", "priority", "status", "autonomous"],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          priority: { type: "string", enum: PRIORITIES },
          status: ref("Status"),
          autonomous: { type: "boolean", description: "Under Autonomous Delegation: the Agent completes it itself, with a Report, rather than stopping at In Review." },
        },
      },
    },
    waitingWork: {
      type: "array",
      description:
        "Comments waiting for the Agent since its last welcome, oldest first: answers to its questions, @mentions of it, and " +
        "Comments on Tickets delegated to it. A full token's welcome takes them, so the next one lists only newer ones; a read-only " +
        "token's leaves them waiting. Work in places the Agent can't see right now is left out, and waits until it can.",
      items: ref("WaitingWork"),
    },
    artifacts: {
      type: "object",
      description: "What an Artifact published in the Workspace may load and hold, as an Admin set it.",
      required: ["allowedOrigins", "extraOriginsAllowed", "maxBytes", "maxFiles"],
      properties: {
        allowedOrigins: { type: "array", items: { type: "string" }, description: "The origins every Artifact may load scripts, styles and fonts from." },
        extraOriginsAllowed: { type: "boolean", description: "Whether a publish may declare extra origins for its Version." },
        maxBytes: { type: "integer", description: "The most bytes one Version may hold, all its files together." },
        maxFiles: { type: "integer", description: "The most files one Version may hold." },
      },
    },
  },
} as const;

/**
 * Agent Sessions: an Agent starts one when it connects (the MCP server does this for
 * each MCP connection), makes calls within it by sending the Cronk-Agent-Session
 * header, and ends it when it disconnects.
 */
export function coordinationRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // Starts an Agent Session and returns it with the welcome the Agent gets on connecting.
    app.post(
      "/api/agent-sessions",
      {
        schema: {
          response: {
            201: answer("The new Agent Session, with the welcome the Agent gets on connecting", {
              type: "object",
              required: ["session", "welcome"],
              properties: { session: ref("AgentSession"), welcome: welcomeSchema },
            }),
            ...errors(401, 403, 410),
          },
        },
      },
      async (request, reply) => {
        const agent = requireAgent(await requireActor(ctx, request, { outsideSession: true }));
        const session = await startAgentSession(ctx.db, { agentId: agent.agent.id, tokenId: agent.tokenId, now: ctx.clock.now() });
        return reply.code(201).send({ session: publicAgentSession(session), welcome: await welcome(ctx, { ...agent, session }) });
      },
    );

    // The Agent Session named by the Cronk-Agent-Session header; asking refreshes it, as every call in it does.
    app.get(
      "/api/agent-sessions/current",
      {
        schema: {
          headers: sessionHeader,
          response: { 200: answer("The Agent Session, refreshed", holding("session", "AgentSession")), ...errors(400, 401, 403, 410) },
        },
      },
      async (request) => {
        return { session: publicAgentSession(requireSession(await requireActor(ctx, request))) };
      },
    );

    app.post(
      "/api/agent-sessions/current/next",
      {
        schema: {
          headers: sessionHeader,
          response: {
            200: answer("The Agent's next Ready Ticket, now Claimed by the Agent Session, with the Tickets around it", {
              type: "object",
              required: ["next"],
              properties: { next: { anyOf: [ticketDetailSchema, { type: "null" }], description: "Null when none of the Agent's Tickets is Ready." } },
            }),
            ...errors(400, 401, 403, 410),
          },
        },
      },
      async (request) => {
        const actor = requireAgent(await requireActor(ctx, request));
        const session = requireSession(actor);
        const now = ctx.clock.now();
        const scope = await readyScope(ctx.db, actor);
        const id = await transaction(ctx.db, (tx) => claimNextReady(tx, scope, session.id, now));
        const ticket = id ? (await findTicketById(ctx.db, id))! : null;
        ticketsChanged(ctx.live, [ticket]);
        return { next: ticket ? await ticketDetail(ctx.db, actor, ticket, now) : null };
      },
    );

    app.post<{ Params: { key: string } }>(
      "/api/tickets/:key/claim",
      {
        schema: {
          params: ticketParams,
          headers: sessionHeader,
          response: {
            200: answer("The Ticket, now Claimed by the Agent Session, with the Tickets around it", ticketDetailSchema),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request) => {
        const actor = requireAgent(await requireActor(ctx, request));
        const session = requireSession(actor);
        const now = ctx.clock.now();
        const claimed = await transaction(ctx.db, async (tx) => {
          const ticket = await ticketFor(tx, actor, request.params.key, "write", { forUpdate: true });
          // Claiming again from the Agent Session holding the Claim keeps it; otherwise the Ticket must be Ready.
          const held = await findLiveClaim(tx, ticket.id, now);
          if (held?.session.id !== session.id) {
            const scope = await readyScope(tx, actor);
            if (!(await isTicketReady(tx, scope, ticket.id, now))) throw new HttpError(409, await whyNotReady(tx, actor, scope, ticket, now));
            await setClaim(tx, ticket.id, session.id, now);
          }
          return { ticket, detail: await ticketDetail(tx, actor, ticket, now) };
        });
        ticketsChanged(ctx.live, [claimed.ticket]);
        return claimed.detail;
      },
    );

    app.delete<{ Params: { key: string } }>(
      "/api/tickets/:key/claim",
      {
        schema: {
          params: ticketParams,
          headers: sessionHeader,
          response: { 204: noContent("The Claim is released; the Ticket keeps its Delegate"), ...errors(400, 401, 403, 404, 409, 410) },
        },
      },
      async (request, reply) => {
        const actor = requireAgent(await requireActor(ctx, request));
        const session = requireSession(actor);
        const released = await transaction(ctx.db, async (tx) => {
          const ticket = await ticketFor(tx, actor, request.params.key, "write", { forUpdate: true });
          const held = await findLiveClaim(tx, ticket.id, ctx.clock.now());
          if (held?.session.id !== session.id) throw new HttpError(409, `This Agent Session doesn't hold ${ticket.key}'s Claim`);
          await clearClaim(tx, ticket.id);
          return ticket;
        });
        await claimsEnded(ctx, [released.id]);
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { key: string }; Body: { kind: ActivityKind; body: string; blocking?: boolean } }>(
      "/api/tickets/:key/activities",
      {
        schema: {
          params: ticketParams,
          headers: sessionHeader,
          body: {
            type: "object",
            required: ["kind", "body"],
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ACTIVITY_KINDS },
              body: { type: "string", minLength: 1, maxLength: 100_000, pattern: "\\S", description: "Markdown." },
              blocking: {
                type: "boolean",
                description:
                  "Only for a question: the Agent waits for the answer. False if left out, and always false under Autonomous Delegation, where the Agent records its best guess and carries on.",
              },
            },
          },
          response: {
            201: answer("The Activity, logged on the Ticket; the call refreshes the Agent Session and so its Claim", savedHolding("activity", "Activity")),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = requireAgent(await requireActor(ctx, request));
        const session = requireSession(actor);
        const { kind, body, blocking = false } = request.body;
        if (blocking && kind !== "question") throw new HttpError(400, "Only a question can be blocking");
        const now = ctx.clock.now();
        const { activity, avoidedWords } = await transaction(ctx.db, async (tx) => {
          const ticket = await ticketFor(tx, actor, request.params.key, "write", { forUpdate: true });
          await requireClaimHolder(tx, actor, ticket, now, "logging Activities on it");
          // Under Autonomous Delegation the Agent never waits: it records its best guess and carries on.
          const activity = await insertActivity(tx, ticket.id, { ...actor, session }, { kind, body, blocking: blocking && !ticket.autonomous }, now);
          return { activity, avoidedWords: await avoidedWordsIn(tx, actor, ticket.projectId, titleAndBody({ body })) };
        });
        ctx.live.publish(ticketTopic(activity.ticketId), { event: "activity", data: { activity: publicActivity(activity) } });
        if (kind === "question") waitingItemsChanged(ctx.live, [actor.owner.id]);
        return reply.code(201).send({ activity: publicActivity(activity), avoidedWords });
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/tickets/:key/activities",
      {
        schema: {
          params: ticketParams,
          response: { 200: answer("The Ticket's Activities, oldest first", listing("activities", ref("Activity"))), ...errors(401, 404, 410) },
        },
      },
      async (request) => {
        const ticket = await ticketFor(ctx.db, await requireActor(ctx, request), request.params.key, "read");
        return { activities: (await listActivities(ctx.db, ticket.id)).map(publicActivity) };
      },
    );

    app.post<{ Params: { key: string }; Body: { title: string; body: string } }>(
      "/api/tickets/:key/reports",
      {
        schema: {
          params: ticketParams,
          headers: sessionHeader,
          body: {
            type: "object",
            required: ["title", "body"],
            additionalProperties: false,
            properties: {
              title: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
              body: { type: "string", minLength: 1, maxLength: 1_000_000, pattern: "\\S", description: "The findings, as Markdown." },
            },
          },
          response: {
            201: answer(
              "The Report, a Document of the Ticket's Project at Version 1, kept out of the page tree; it counts as the Report of the current Claim",
              savedHolding("report", "Document"),
            ),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = requireAgent(await requireActor(ctx, request));
        requireSession(actor);
        const now = ctx.clock.now();
        const { ticket, report, avoidedWords } = await transaction(ctx.db, async (tx) => {
          const ticket = await ticketFor(tx, actor, request.params.key, "write", { forUpdate: true });
          const claimId = await requireClaimHolder(tx, actor, ticket, now, "writing a Report on it");
          const report = await insertReport(tx, { ticket, claimId, agent: actor, title: request.body.title.trim(), body: request.body.body, now });
          return { ticket, report, avoidedWords: await avoidedWordsIn(tx, actor, ticket.projectId, titleAndBody(request.body)) };
        });
        ctx.live.publish(ticketTopic(ticket.id), { event: "report", data: { report: (await findReport(ctx.db, report.id))! } });
        waitingItemsChanged(ctx.live, [ticket.assignee?.id]);
        return reply.code(201).send({ report, avoidedWords });
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/tickets/:key/reports",
      {
        schema: {
          params: ticketParams,
          response: { 200: answer("The Ticket's Reports, oldest first, without their bodies", listing("reports", ref("Report"))), ...errors(401, 404, 410) },
        },
      },
      async (request) => {
        const ticket = await ticketFor(ctx.db, await requireActor(ctx, request), request.params.key, "read");
        return { reports: await listTicketReports(ctx.db, ticket.id) };
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/tickets/:key/events",
      {
        schema: {
          params: ticketParams,
          response: {
            200: {
              description:
                "A server-sent event stream of the Ticket's changes as they happen, for as long as the caller can see it. It opens " +
                "with a `ready` event; each new Activity arrives as an `activity` event whose data is `{ activity }`, an Activity as JSON, " +
                "and arrives again once a Comment answers it. Each new Comment arrives as a `comment` event whose data is `{ comment }`, " +
                "and each new Report as a `report` event whose data is `{ report }`, a Report as JSON. Whenever the Ticket itself changes " +
                "(its fields, its Sub-Tickets, its relations, its linked Documents, its Claim being taken, released or lapsing) a " +
                "`changed` event arrives whose data is `{ ticket }`, the Ticket's key.",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            ...errors(401, 404, 410),
          },
        },
      },
      async (request, reply) => {
        const ticket = await ticketFor(ctx.db, await requireActor(ctx, request), request.params.key, "read");
        const canSee = async () => {
          const actor = await requireActor(ctx, request, { refreshSession: false });
          return !!(await ticketFor(ctx.db, actor, ticket.key, "read"));
        };
        ctx.live.stream(reply, ticketTopic(ticket.id), canSee);
      },
    );

    app.get(
      "/api/agent-sessions/current/events",
      {
        schema: {
          headers: {
            ...sessionHeader,
            properties: {
              ...sessionHeader.properties,
              "last-event-id": { type: "string", description: "The id of the last event a stream got, to send what it missed since" },
            },
          },
          response: {
            200: {
              description:
                "A server-sent event stream of work as it starts waiting for the Agent, for as long as the Agent Session is live. It opens " +
                "with a `ready` event; each Comment that starts waiting for the Agent arrives as a `waiting` event whose data is " +
                "`{ waiting }`, a WaitingWork as JSON, with an `id`; `ready` carries one too. Reopened with the last id it got as " +
                "`Last-Event-ID`, the stream first sends, before `ready`, each `waiting` event it missed meanwhile whose work no welcome " +
                "has taken since, then any pushed while it did so. Pushed work is still listed in the welcome of the Agent's next Agent Session. " +
                "Each time one of the Agent's Tickets becomes Ready for it (delegated to it, unblocked, moved back into unfinished work, or its " +
                "Claim released, ended or lapsed) or its Project opens up to it (unarchived, made open, or its Agent Access raised; or the Agent's " +
                "Owner granted Write there, unlisted from an open Project, or made an Admin), " +
                "a `ticketReady` event arrives whose data is `{ ticket }`, the Ticket as the welcome lists it; " +
                "it has no `id` and isn't sent again on reopening, as the next welcome lists Ready Tickets anyway. Changes made at the same " +
                "moment can, rarely, tell of one Ticket twice, and another Session may Claim it first, so a Claim can still be refused. A read-only token's stream " +
                "gets none, as it can't Claim them. " +
                "While it is open the Agent Session isn't silent: the stream refreshes it on its heartbeat (every 25 seconds), so it and its Claims stay alive.",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            ...errors(400, 401, 403, 410),
          },
        },
      },
      async (request, reply) => {
        const agent = requireAgent(await requireActor(ctx, request));
        requireSession(agent);
        // Unlike a Ticket's stream, this one refreshes the Session on every check: an Agent with it open is connected, not silent.
        const canSee = async () => !!requireSession(await requireActor(ctx, request));
        const lastEventId = request.headers["last-event-id"];
        const catchUp = async () => ({
          missed:
            typeof lastEventId === "string" && /^\d{1,18}$/.test(lastEventId)
              ? (await missedWaitingWork(ctx.db, agent, lastEventId)).map(({ seq, work }) => waitingEvent(seq, work))
              : [],
          readyId: await latestWaitingSeq(ctx.db, agent.agent.id),
        });
        // A read-only token can't Claim, so it isn't told what it could Claim.
        ctx.live.stream(reply, agentTopic(agent.agent.id), canSee, catchUp, (event) => !(agent.readOnly && event.event === "ticketReady"));
      },
    );

    app.delete(
      "/api/agent-sessions/current",
      { schema: { headers: sessionHeader, response: { 204: noContent("The Agent Session has ended"), ...errors(400, 401, 403, 410) } } },
      async (request, reply) => {
        const session = requireSession(await requireActor(ctx, request));
        const { ticketIds } = await endAgentSession(ctx.db, session.id, ctx.clock.now());
        await claimsEnded(ctx, ticketIds);
        return reply.code(204).send();
      },
    );
  };
}

function requireAgent(actor: Actor): AgentActor {
  if (actor.kind !== "agent") throw new HttpError(403, "Only an Agent has Agent Sessions");
  return actor;
}

function requireSession(actor: Actor): AgentSession {
  const session = requireAgent(actor).session;
  if (!session) throw new HttpError(400, "Name the Agent Session in the Cronk-Agent-Session header");
  return session;
}

/**
 * What an Agent is told when it connects: who it is and for whom, whether it may only
 * read, the Workspace's Guidance, the Projects it can see with each one's Guidance, and its
 * Ready Tickets, and the work waiting for it, which the welcome takes so the next one doesn't
 * list it again, and what an Artifact may load and hold. The Workspace, with its name and Guidance,
 * is left out if the Workspace's Agent Access is None.
 */
export async function welcome(ctx: AppContext, agent: AgentActor & { session: AgentSession }) {
  const workspaceId = agent.owner.workspaceId;
  const readable = await requireWorkspaceAccess(ctx.db, agent, "read").then(
    () => true,
    (err: unknown) => {
      if (err instanceof HttpError) return false;
      throw err;
    },
  );
  const projects = await visibleProjects(ctx.db, agent, await listProjects(ctx.db, workspaceId, false));
  const guidance = await projectGuidanceMarkdown(ctx.db, projects.map((p) => p.id));
  const workspace = readable && {
    name: (await getWorkspace(ctx.db, workspaceId)).name,
    guidance: (await getGuidance(ctx.db, { workspaceId, projectId: null })).markdown,
    terms: (await listTerms(ctx.db, { workspaceId, projectId: null })).map((t) => t.name),
  };
  const projectTerms = await termNamesByProject(ctx.db, projects.map((p) => p.id));
  const settings = await getWorkspace(ctx.db, workspaceId);
  return {
    workspace: workspace || null,
    agent: publicAgent(agent.agent, agent.owner),
    readOnly: agent.readOnly,
    projects: projects.map((p) => ({ key: p.key, name: p.name, access: p.access, guidance: guidance.get(p.id)!, terms: projectTerms.get(p.id)! })),
    readyTickets: await readyTickets(ctx, agent),
    waitingWork: await takeWaitingWork(ctx.db, agent, agent.session.id, ctx.clock.now()),
    // Artifacts may be published in its Projects even when the Workspace itself is hidden from the Agent.
    artifacts: {
      allowedOrigins: settings.artifactAllowedOrigins,
      extraOriginsAllowed: settings.artifactExtraOriginsAllowed,
      maxBytes: settings.artifactMaxBytes,
      maxFiles: settings.artifactMaxFiles,
    },
  };
}

/** The first of the Agent's Ready Tickets, as the welcome lists them. */
async function readyTickets(ctx: AppContext, agent: AgentActor) {
  const ids = await listReadyTicketIds(ctx.db, await readyScope(ctx.db, agent), ctx.clock.now(), WELCOME_READY_LIMIT);
  const tickets = await findTicketsByIds(ctx.db, ids);
  return tickets.map(readyTicket);
}
