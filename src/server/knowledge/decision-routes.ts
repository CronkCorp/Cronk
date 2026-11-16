import type { FastifyInstance } from "fastify";
import { actingUser, type Actor } from "../actor.js";
import { DECISION_STATUSES, type DecisionStatus } from "../../shared/values.js";
import { HttpError, requireActor, requireUserActor, type AppContext } from "../context.js";
import { transaction, type Queryable } from "../db/database.js";
import { projectFor, requireProjectAccess, requireWorkspaceAccess, type Access } from "../identity/access.js";
import { answer, errors, holding, listing, pathParams, projectKeyParam, ref } from "../schemas.js";
import { findProjectById } from "../work/projects.js";
import {
  contentOf,
  DECISION_TEMPLATE,
  findDecisionByKey,
  findDecisionVersion,
  insertDecision,
  listDecisions,
  listDecisionVersions,
  saveDecision,
  supersededNumbers,
  applySuperseding,
  type Decision,
  type DecisionContent,
  type DecisionScope,
  type DecisionVersion,
} from "./decisions.js";

/** A Decision title: non-blank, at most 500 characters. */
const title = { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } as const;
/** A Decision's Markdown. */
const body = { type: "string", maxLength: 1_000_000 } as const;
/** A Decision's group; blank for none. */
const group = { type: ["string", "null"], maxLength: 200, description: "The group it is filed under, such as Security; null or blank for none." } as const;

/** The Version an edit is based on; it must be the Decision's current one (ADR 0009). */
const baseVersion = {
  type: "integer",
  minimum: 1,
  description: "The number of the Version this edit is based on. The edit is refused if it is no longer the current Version.",
} as const;

const projectParams = pathParams({ key: projectKeyParam });
const decisionKeyParam = { type: "string", description: "The Decision's key, such as `CRONK-D7`, or `D7` in the Workspace; any case." } as const;
const decisionParams = pathParams({ key: decisionKeyParam });
const versionParams = pathParams({
  key: decisionKeyParam,
  number: { type: "string", pattern: "^[1-9][0-9]{0,8}$", description: "The Version's number, counting from 1." },
});

interface DecisionEdit {
  baseVersion: number;
  title?: string;
  body?: string;
  group?: string | null;
  supersedes?: string[];
}

/** The Decisions a Decision supersedes, by key. */
const supersedes = {
  type: "array",
  maxItems: 100,
  items: { type: "string", maxLength: 30 },
  description: "The keys of the Decisions it replaces, of the same Project or Workspace; they become superseded when it is accepted.",
} as const;

interface NewDecision {
  title: string;
  body?: string;
  group?: string | null;
  supersedes?: string[];
}

const newDecisionBody = {
  type: "object",
  required: ["title"],
  additionalProperties: false,
  properties: {
    title,
    body: { ...body, description: "Markdown; the ADR sections (the decision and its reasons, Consequences, Considered Options) to fill in if left out." },
    group,
    supersedes,
  },
} as const;

/** A group as given: trimmed, and null when blank. */
const groupOf = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

/**
 * The Decision with this key, if `actor` has at least `need` where it belongs: in its Project
 * (one they can't see answers 404, as if the Decision didn't exist), or in the Workspace.
 */
export async function decisionFor(db: Queryable, actor: Actor, key: string, need: Access, opts: { forUpdate?: boolean } = {}): Promise<Decision> {
  const decision = await findDecisionByKey(db, actingUser(actor).workspaceId, key, opts);
  if (!decision) throw new HttpError(404, "No such Decision");
  if (decision.projectId === null) await requireWorkspaceAccess(db, actor, need);
  else await requireProjectAccess(db, actor, (await findProjectById(db, decision.projectId))!, need, "No such Decision");
  return decision;
}

export function decisionRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    /** Saves `content` as `current`'s next Version, then keeps the Decisions it supersedes in step. */
    const save = async (tx: Queryable, actor: Actor, current: Decision, content: DecisionContent) => {
      const now = ctx.clock.now();
      const saved = await saveDecision(tx, current, content, actor, now);
      await applySuperseding(tx, scopeOf(actor, saved), contentOf(current), saved, actor, now);
      return saved;
    };

    /** Creates a proposed Decision in `scope`, which the caller has Write in. Only a User records one. */
    const create = async (tx: Queryable, actor: Actor, scope: DecisionScope, input: NewDecision) => {
      requireUserActor(actor, "record a Decision");
      const content: DecisionContent = {
        title: input.title.trim(),
        body: input.body ?? DECISION_TEMPLATE,
        status: "proposed",
        group: groupOf(input.group),
        supersedes: await requireSuperseded(tx, scope, null, input.supersedes ?? []),
      };
      return insertDecision(tx, scope, content, actor, ctx.clock.now());
    };

    interface RegisterQuery {
      status?: DecisionStatus[];
      group?: string[];
    }
    const registerSchema = (whose: string) => ({
      querystring: {
        type: "object",
        properties: {
          status: { type: "array", items: { type: "string", enum: DECISION_STATUSES }, description: "Only Decisions with one of these statuses." },
          group: { type: "array", items: { type: "string", maxLength: 200 }, description: "Only Decisions in one of these groups, ignoring case." },
        },
      },
      response: {
        200: answer(`${whose} Decisions matching the filters, newest first, without their bodies`, listing("decisions", ref("DecisionSummary"))),
        ...errors(400, 401, 403, 404, 410),
      },
    });
    const register = (scope: DecisionScope, q: RegisterQuery) => listDecisions(ctx.db, scope, { statuses: q.status, groups: q.group });

    app.get<{ Params: { key: string }; Querystring: RegisterQuery }>(
      "/api/projects/:key/decisions",
      { schema: { params: projectParams, ...registerSchema("The Project's") } },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
        return { decisions: await register({ workspaceId: actingUser(actor).workspaceId, projectId: project.id }, request.query) };
      },
    );

    app.get<{ Querystring: RegisterQuery }>("/api/workspace/decisions", { schema: registerSchema("The Workspace's") }, async (request) => {
      const actor = await requireActor(ctx, request);
      await requireWorkspaceAccess(ctx.db, actor, "read");
      return { decisions: await register({ workspaceId: actingUser(actor).workspaceId, projectId: null }, request.query) };
    });

    app.post<{ Params: { key: string }; Body: NewDecision }>(
      "/api/projects/:key/decisions",
      {
        schema: {
          params: projectParams,
          body: newDecisionBody,
          response: { 201: answer("The new Decision, proposed, at Version 1", holding("decision", "Decision")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const decision = await transaction(ctx.db, async (tx) => {
          const { project } = await projectFor(tx, actor, request.params.key, "write");
          return create(tx, actor, { workspaceId: actingUser(actor).workspaceId, projectId: project.id }, request.body);
        });
        return reply.code(201).send({ decision });
      },
    );

    app.post<{ Body: NewDecision }>(
      "/api/workspace/decisions",
      {
        schema: {
          body: newDecisionBody,
          response: { 201: answer("The new Workspace Decision, proposed, at Version 1", holding("decision", "Decision")), ...errors(400, 401, 403, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "write");
        const decision = await transaction(ctx.db, (tx) => create(tx, actor, { workspaceId: actingUser(actor).workspaceId, projectId: null }, request.body));
        return reply.code(201).send({ decision });
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/decisions/:key",
      {
        schema: {
          params: decisionParams,
          response: { 200: answer("The Decision at its current Version", holding("decision", "Decision")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        return { decision: await decisionFor(ctx.db, actor, request.params.key, "read") };
      },
    );

    app.patch<{ Params: { key: string }; Body: DecisionEdit }>(
      "/api/decisions/:key",
      {
        schema: {
          params: decisionParams,
          body: {
            type: "object",
            required: ["baseVersion"],
            additionalProperties: false,
            properties: { baseVersion, title, body, group, supersedes },
          },
          response: {
            200: answer("The Decision at its new Version; unchanged if the edit changed nothing", holding("decision", "Decision")),
            ...errors(400, 401, 403, 404, 410),
            409: { description: "The edit is based on a Version that is no longer current; the answer carries the current Version", ...ref("StaleDecision") },
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const decision = await transaction(ctx.db, async (tx) => {
          const current = await decisionFor(tx, actor, request.params.key, "write", { forUpdate: true });
          requireUserActor(actor, "edit a Decision");
          await requireCurrent(tx, current, request.body.baseVersion);
          const { title: newTitle, body: newBody, group: newGroup, supersedes: newSupersedes } = request.body;
          const content = {
            ...contentOf(current),
            ...(newTitle !== undefined && { title: newTitle.trim() }),
            ...(newBody !== undefined && { body: newBody }),
            ...(newGroup !== undefined && { group: groupOf(newGroup) }),
            ...(newSupersedes !== undefined && { supersedes: await requireSuperseded(tx, scopeOf(actor, current), current.number, newSupersedes) }),
          };
          return save(tx, actor, current, content);
        });
        return { decision };
      },
    );

    app.post<{ Params: { key: string }; Body: { status: DecisionStatus } }>(
      "/api/decisions/:key/status",
      {
        schema: {
          params: decisionParams,
          body: {
            type: "object",
            required: ["status"],
            additionalProperties: false,
            properties: {
              status: {
                type: "string",
                enum: DECISION_STATUSES,
                description: "The new status. A Decision becomes superseded only when one superseding it is accepted, so superseded is refused here.",
              },
            },
          },
          response: {
            200: answer("The Decision at a new Version with that status; unchanged if it already had it", holding("decision", "Decision")),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { status } = request.body;
        const decision = await transaction(ctx.db, async (tx) => {
          const current = await decisionFor(tx, actor, request.params.key, "write", { forUpdate: true });
          requireUserActor(actor, "change a Decision's status");
          if (status === "superseded") {
            throw new HttpError(400, "A Decision is superseded when a Decision that supersedes it is accepted; record that Decision, or deprecate this one");
          }
          return save(tx, actor, current, { ...contentOf(current), status });
        });
        return { decision };
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/decisions/:key/versions",
      {
        schema: {
          params: decisionParams,
          response: {
            200: answer("The Decision's Versions, newest first, without their bodies", listing("versions", ref("DecisionVersionSummary"))),
            ...errors(400, 401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const decision = await decisionFor(ctx.db, await requireActor(ctx, request), request.params.key, "read");
        return { versions: await listDecisionVersions(ctx.db, decision) };
      },
    );

    app.get<{ Params: { key: string; number: string } }>(
      "/api/decisions/:key/versions/:number",
      {
        schema: {
          params: versionParams,
          response: { 200: answer("The Version, with its body", holding("version", "DecisionVersion")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request) => {
        const decision = await decisionFor(ctx.db, await requireActor(ctx, request), request.params.key, "read");
        const version = await findDecisionVersion(ctx.db, decision, Number(request.params.number));
        if (!version) throw new HttpError(404, "No such Version");
        return { version };
      },
    );
  };
}

/** Refuses an edit based on a Version that is no longer current, answering with the current Version. */
async function requireCurrent(db: Queryable, decision: Decision, base: number): Promise<void> {
  if (base === decision.version) return;
  const current: DecisionVersion = (await findDecisionVersion(db, decision, decision.version))!;
  throw new HttpError(
    409,
    `This edit is based on Version ${base}, but ${decision.key} is at Version ${decision.version}; merge with it and save again`,
    { current },
  );
}

/** Where a Decision belongs, in the Actor's Workspace. */
const scopeOf = (actor: Actor, decision: Decision): DecisionScope => ({ workspaceId: actingUser(actor).workspaceId, projectId: decision.projectId });

/** The numbers of the Decisions `keys` name in `scope`, or a 400 saying why they can't be superseded. */
async function requireSuperseded(db: Queryable, scope: DecisionScope, own: number | null, keys: string[]): Promise<number[]> {
  const numbers = await supersededNumbers(db, scope, own, keys);
  if (typeof numbers === "string") throw new HttpError(400, numbers);
  return numbers;
}
