import type { FastifyInstance, FastifyReply } from "fastify";
import { actingUser, type Actor } from "../actor.js";
import { HttpError, requireActor, requireUserActor, type AppContext } from "../context.js";
import { transaction, type Queryable } from "../db/database.js";
import { projectTermsTopic, termsTopic } from "../live/topics.js";
import type { LiveEvent, LiveUpdates } from "../live/live-updates.js";
import { canRead, projectFor, readablePlaces, requireProjectAccess, requireWorkspaceAccess, type Access } from "../identity/access.js";
import { answer, errors, holding, listing, noContent, pathParams, projectKeyParam, protectionBody, protectionHistoryAnswer, ref, termIdParam } from "../schemas.js";
import { findProjectById } from "../work/projects.js";
import { getWorkspace } from "../workspace/workspaces.js";
import { glossaryHeading, glossaryMarkdown } from "./glossary.js";
import { listMentions } from "./mentions.js";
import { listProtectionMarkings, requireUnprotected, setProtected } from "./protection.js";
import {
  answeredTerms,
  deleteTerm,
  findProtectedWorkspaceTerm,
  findTerm,
  insertTerm,
  listApplicableTerms,
  listTerms,
  listTermVersions,
  saveTermVersion,
  type StoredTerm,
  type Term,
  type TermFields,
  type TermPlace,
} from "./terms.js";

/** A Term's name: non-blank, at most 200 characters. */
const name = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S", description: "Its canonical name; unique where it belongs, ignoring case." } as const;
const definition = { type: "string", minLength: 1, maxLength: 100_000, pattern: "\\S", description: "What it means, as Markdown." } as const;
const avoid = {
  type: "array",
  maxItems: 100,
  items: { type: "string", maxLength: 200 },
  description: "The words to avoid for it; blanks and repeats (ignoring case) are dropped.",
} as const;
const group = {
  type: ["string", "null"],
  maxLength: 200,
  description: "The group the glossary lists it under; null or blank for none.",
} as const;

interface NewTerm {
  name: string;
  definition: string;
  avoid?: string[];
  group?: string | null;
}

const newTermBody = {
  type: "object",
  required: ["name", "definition"],
  additionalProperties: false,
  properties: { name, definition, avoid, group },
} as const;

const nameFilter = {
  type: "object",
  properties: { name: { type: "string", description: "Only the Term with this name, ignoring case." } },
} as const;

/** The Version a save or delete is based on; it must be the Term's current one (ADR 0009). */
const baseVersion = {
  type: "integer",
  minimum: 1,
  description: "The number of the Version this write is based on. The write is refused if it is no longer the current Version.",
} as const;

interface TermEdit {
  baseVersion: number;
  name?: string;
  definition?: string;
  avoid?: string[];
  group?: string | null;
}

/** A write refused as stale, with the current Version, or one taking another Term's name. */
const writeConflict = {
  description:
    "The write is based on a Version that is no longer current, and the answer carries the current Version; or the new name is another Term's where it belongs",
  anyOf: [ref("StaleTermVersion"), ref("Error")],
};

const projectParams = pathParams({ key: projectKeyParam });
const termParams = pathParams({ id: termIdParam });

/** The refusal of a Term whose name another Term where it belongs already has. */
const nameTaken = (termName: string) => new HttpError(409, `There is already a Term named ${termName.trim()} here; names are unique ignoring case`);

/**
 * Terms: the Workspace's and each Project's glossary. Anyone who can read where a Term belongs reads it;
 * anyone with Write there creates and edits it.
 */
export function termRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    /** Answers Terms with their overrides as the caller may see them. */
    const answerTerms = async (actor: Actor, terms: StoredTerm[]) =>
      answeredTerms(ctx.db, actingUser(actor).workspaceId, terms, await readablePlaces(ctx.db, actor));
    const answerTerm = async (actor: Actor, term: StoredTerm): Promise<Term> => (await answerTerms(actor, [term]))[0]!;

    /**
     * Refuses an Agent's naming a Project Term after a Protected Workspace Term, which would replace
     * that Term within the Project and so change what it says there.
     */
    const requireNotReplacingProtected = async (db: Queryable, actor: Actor, projectId: string | null, termName: string) => {
      if (actor.kind !== "agent" || projectId === null) return;
      const replaced = await findProtectedWorkspaceTerm(db, actingUser(actor).workspaceId, termName);
      if (replaced) requireUnprotected(actor, replaced, replaced.name, "replace it with a Project Term of the same name");
    };

    const create = async (actor: Actor, place: TermPlace, input: NewTerm) => {
      await requireNotReplacingProtected(ctx.db, actor, place.projectId, input.name);
      const fields: TermFields = { name: input.name, definition: input.definition, avoid: input.avoid ?? [], group: input.group ?? null };
      const created = await transaction(ctx.db, (tx) => insertTerm(tx, { place, fields, actor, now: ctx.clock.now() }));
      if (created === "name taken") throw nameTaken(input.name);
      termsChanged(ctx.live, place);
      return answerTerm(actor, created);
    };

    const byName = (terms: StoredTerm[], wanted: string | undefined) =>
      wanted === undefined ? terms : terms.filter((t) => t.name.toLowerCase() === wanted.trim().toLowerCase());

    app.get<{ Querystring: { name?: string } }>(
      "/api/workspace/terms",
      {
        schema: {
          querystring: nameFilter,
          response: { 200: answer("The Workspace's Terms, by name", listing("terms", ref("Term"))), ...errors(401, 403, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "read");
        const terms = await listTerms(ctx.db, placeOf(actor, null));
        return { terms: await answerTerms(actor, byName(terms, request.query.name)) };
      },
    );

    app.get<{ Params: { key: string }; Querystring: { name?: string } }>(
      "/api/projects/:key/terms",
      {
        schema: {
          params: projectParams,
          querystring: nameFilter,
          response: {
            200: answer(
              "The Terms that apply in the Project, by name: its own, and the Workspace's it has no Term of the same name for " +
                "(ignoring case), if the caller can read the Workspace",
              listing("terms", ref("Term")),
            ),
            ...errors(401, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
        const place = placeOf(actor, project.id);
        const terms = await listApplicableTerms(ctx.db, place, await canRead(ctx.db, actor, null));
        return { terms: await answerTerms(actor, byName(terms, request.query.name)) };
      },
    );

    const changesStream = (what: string) => ({
      200: {
        description:
          `A server-sent event stream of changes to ${what} as they happen, for as long as the caller can read there. It opens with a ` +
          "`ready` event; whenever a Term there is created, saved, deleted, or marked Protected or unmarked, a `changed` event arrives " +
          "whose data is `{}`, so the caller reads the Terms again.",
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
    });

    app.get(
      "/api/workspace/terms/events",
      {
        schema: {
          response: {
            ...changesStream("the Workspace's Terms, and to the Terms of each Project the caller can see, which may override them"),
            ...errors(401, 403, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "read");
        const workspaceId = actingUser(actor).workspaceId;
        const now = () => requireActor(ctx, request, { refreshSession: false });
        const canSee = async () => canRead(ctx.db, await now(), null);
        // A Project's Term changes reach only those who can see that Project.
        const admits = async (event: LiveEvent) => event.projectId === undefined || canRead(ctx.db, await now(), event.projectId);
        ctx.live.stream(reply, [termsTopic(workspaceId, null), projectTermsTopic(workspaceId)], canSee, undefined, admits);
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/projects/:key/terms/events",
      {
        schema: {
          params: projectParams,
          response: {
            ...changesStream("the Project's Terms, and to the Workspace's if the caller can read the Workspace, as the Project lists those it doesn't override"),
            ...errors(401, 404, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
        const workspaceId = actingUser(actor).workspaceId;
        // Whether the stream also carries the Workspace's Terms; it ends once the caller can no longer read the Workspace, so a reopened one leaves them out.
        const readsWorkspace = await canRead(ctx.db, actor, null);
        const canSee = async () => {
          const now = await requireActor(ctx, request, { refreshSession: false });
          return !!(await projectFor(ctx.db, now, project.key, "read")) && (!readsWorkspace || (await canRead(ctx.db, now, null)));
        };
        const topics = [termsTopic(workspaceId, project.id), ...(readsWorkspace ? [termsTopic(workspaceId, null)] : [])];
        ctx.live.stream(reply, topics, canSee);
      },
    );

    app.post<{ Body: NewTerm }>(
      "/api/workspace/terms",
      {
        schema: {
          body: newTermBody,
          response: { 201: answer("The new Workspace Term at Version 1", holding("term", "Term")), ...errors(400, 401, 403, 409, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "write");
        const term = await create(actor, placeOf(actor, null), request.body);
        return reply.code(201).send({ term });
      },
    );

    app.post<{ Params: { key: string }; Body: NewTerm }>(
      "/api/projects/:key/terms",
      {
        schema: {
          params: projectParams,
          body: newTermBody,
          response: {
            201: answer("The new Project Term at Version 1; it replaces any Workspace Term of the same name within the Project", holding("term", "Term")),
            ...errors(400, 401, 403, 404, 409, 410),
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "write");
        const term = await create(actor, placeOf(actor, project.id), request.body);
        return reply.code(201).send({ term });
      },
    );

    const glossaryAnswer = {
      200: {
        description: "The place's own Terms as a GLOSSARY.md, grouped and by name, as an export writes it",
        content: { "text/markdown": { schema: { type: "string" } } },
      },
    };
    const sendGlossary = (reply: FastifyReply, title: string, intro: string | null, terms: StoredTerm[]) =>
      reply
        .header("content-type", "text/markdown; charset=utf-8")
        .header("content-disposition", 'attachment; filename="GLOSSARY.md"')
        .send(glossaryMarkdown(title, intro, terms));

    app.get(
      "/api/workspace/terms/glossary",
      { schema: { response: { ...glossaryAnswer, ...errors(401, 403, 410) } } },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        await requireWorkspaceAccess(ctx.db, actor, "read");
        const workspaceId = actingUser(actor).workspaceId;
        const { title, intro } = glossaryHeading({ workspaceName: (await getWorkspace(ctx.db, workspaceId)).name });
        return sendGlossary(reply, title, intro, await listTerms(ctx.db, { workspaceId, projectId: null }));
      },
    );

    app.get<{ Params: { key: string } }>(
      "/api/projects/:key/terms/glossary",
      { schema: { params: projectParams, response: { ...glossaryAnswer, ...errors(401, 404, 410) } } },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const { project } = await projectFor(ctx.db, actor, request.params.key, "read");
        const { title, intro } = glossaryHeading({ projectKey: project.key });
        return sendGlossary(reply, title, intro, await listTerms(ctx.db, placeOf(actor, project.id)));
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/terms/:id",
      {
        schema: {
          params: termParams,
          response: { 200: answer("The Term at its current Version", holding("term", "Term")), ...errors(401, 403, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const term = await termFor(ctx.db, actor, request.params.id, "read");
        return { term: await answerTerm(actor, term) };
      },
    );

    app.patch<{ Params: { id: string }; Body: TermEdit }>(
      "/api/terms/:id",
      {
        schema: {
          params: termParams,
          body: {
            type: "object",
            required: ["baseVersion"],
            additionalProperties: false,
            properties: { baseVersion, name, definition, avoid, group },
          },
          response: {
            200: answer("The Term at its new Version; unchanged if the save changed nothing", holding("term", "Term")),
            ...errors(400, 401, 403, 404, 410),
            409: writeConflict,
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { baseVersion: base, ...edit } = request.body;
        const saved = await transaction(ctx.db, async (tx) => {
          const current = await termFor(tx, actor, request.params.id, "write", { forUpdate: true });
          requireUnprotected(actor, current, current.name);
          if (edit.name !== undefined) await requireNotReplacingProtected(tx, actor, current.projectId, edit.name);
          await requireCurrent(tx, current, base, "save");
          const fields: TermFields = {
            name: edit.name ?? current.name,
            definition: edit.definition ?? current.definition,
            avoid: edit.avoid ?? current.avoid,
            group: edit.group === undefined ? current.group : edit.group,
          };
          const saved = await saveTermVersion(tx, actingUser(actor).workspaceId, current, { fields, actor, now: ctx.clock.now() });
          if (saved === "name taken") throw nameTaken(fields.name);
          return saved;
        });
        termsChanged(ctx.live, placeOf(actor, saved.projectId));
        return { term: await answerTerm(actor, saved) };
      },
    );

    app.delete<{ Params: { id: string }; Querystring: { baseVersion: number } }>(
      "/api/terms/:id",
      {
        schema: {
          params: termParams,
          querystring: { type: "object", required: ["baseVersion"], properties: { baseVersion } },
          response: {
            204: noContent("The Term and its Versions are deleted"),
            ...errors(400, 401, 403, 404, 410),
            409: { description: "The delete is based on a Version that is no longer current, and the answer carries the current Version", ...ref("StaleTermVersion") },
          },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        const deleted = await transaction(ctx.db, async (tx) => {
          const term = await termFor(tx, actor, request.params.id, "write", { forUpdate: true });
          requireUnprotected(actor, term, term.name, "delete it");
          requireUserActor(actor, "delete a Term");
          await requireCurrent(tx, term, request.query.baseVersion, "delete");
          await deleteTerm(tx, actingUser(actor).workspaceId, term);
          return term;
        });
        termsChanged(ctx.live, placeOf(actor, deleted.projectId));
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { id: string }; Body: { protected: boolean } }>(
      "/api/terms/:id/protection",
      {
        schema: {
          params: termParams,
          body: protectionBody,
          response: { 200: answer("The Term marked Protected or unmarked, at the same Version", holding("term", "Term")), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const term = await transaction(ctx.db, async (tx) => {
          const term = await termFor(tx, actor, request.params.id, "write", { forUpdate: true });
          requireUserActor(actor, "mark a Term Protected or unmark it");
          await setProtected(tx, { kind: "term", id: term.id }, request.body.protected, actor.user.id, ctx.clock.now());
          return { ...term, protected: request.body.protected };
        });
        termsChanged(ctx.live, placeOf(actor, term.projectId));
        return { term: await answerTerm(actor, term) };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/terms/:id/protection",
      { schema: { params: termParams, response: { 200: protectionHistoryAnswer, ...errors(401, 403, 404, 410) } } },
      async (request) => {
        const term = await termFor(ctx.db, await requireActor(ctx, request), request.params.id, "read");
        return { markings: await listProtectionMarkings(ctx.db, { kind: "term", id: term.id }) };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/terms/:id/mentions",
      {
        schema: {
          params: termParams,
          response: {
            200: answer(
              "What names the Term with its capitalisation, as a whole word, where it applies, most recently changed first (at most 50): " +
                "Tickets, Documents, Comments, other Terms and Decisions the caller can read",
              listing("mentions", ref("Mention")),
            ),
            ...errors(401, 403, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const term = await termFor(ctx.db, actor, request.params.id, "read");
        return { mentions: await listMentions(ctx.db, { termId: term.id }, await readablePlaces(ctx.db, actor)) };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/terms/:id/versions",
      {
        schema: {
          params: termParams,
          response: { 200: answer("The Term's Versions, newest first", listing("versions", ref("TermVersion"))), ...errors(401, 403, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const term = await termFor(ctx.db, actor, request.params.id, "read");
        return { versions: await listTermVersions(ctx.db, term.id) };
      },
    );
  };
}

/** What to do after a write is refused as stale, by the kind of write. */
const AFTER_STALE = { save: "read it and save again", delete: "read it and delete again if you still mean to" } as const;

/** Refuses a save or delete based on a Version that is no longer current, answering with the current Version. */
async function requireCurrent(db: Queryable, term: StoredTerm, base: number, write: keyof typeof AFTER_STALE): Promise<void> {
  if (base === term.version) return;
  const current = (await listTermVersions(db, term.id))[0]!;
  throw new HttpError(409, `This ${write} is based on Version ${base}, but the Term is at Version ${term.version}; ${AFTER_STALE[write]}`, { current });
}

/**
 * Tells whoever watches Terms that one in `place` was created or changed: that place's watchers and, for a Project
 * Term, the Workspace's, whose Terms are answered with their overrides. Call it only once the change is committed.
 */
export function termsChanged(live: LiveUpdates, place: TermPlace): void {
  const event = { event: "changed", data: {} };
  live.publish(termsTopic(place.workspaceId, place.projectId), event);
  if (place.projectId !== null) live.publish(projectTermsTopic(place.workspaceId), { ...event, projectId: place.projectId });
}

/** Where Terms belong for `actor`: a Project of their Workspace, or the Workspace itself when `projectId` is null. */
const placeOf = <P extends string | null>(actor: Actor, projectId: P): TermPlace & { projectId: P } => ({ workspaceId: actingUser(actor).workspaceId, projectId });

/**
 * The Term with this id, if `actor` has at least `need` where it belongs: in its Project (one they
 * can't see answers 404, as if the Term didn't exist), or in the Workspace for a Workspace Term.
 */
export async function termFor(db: Queryable, actor: Actor, id: string, need: Access, opts: { forUpdate?: boolean } = {}): Promise<StoredTerm> {
  const term = await findTerm(db, actingUser(actor).workspaceId, id, opts);
  if (!term) throw new HttpError(404, "No such Term");
  if (term.projectId === null) await requireWorkspaceAccess(db, actor, need);
  else await requireProjectAccess(db, actor, (await findProjectById(db, term.projectId))!, need, "No such Term");
  return term;
}
