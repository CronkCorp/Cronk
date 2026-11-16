import type { FastifyInstance } from "fastify";
import { actingUser, type Actor } from "../actor.js";
import { HttpError, requireActor, type AppContext } from "../context.js";
import { transaction, type Queryable } from "../db/database.js";
import { canRead, projectFor, readablePlaces, requireProjectAccess, requireWorkspaceAccess, type Access } from "../identity/access.js";
import { answer, errors, holding, listing, pathParams, projectKeyParam, ref, termIdParam } from "../schemas.js";
import { findProjectById } from "../work/projects.js";
import { findTerm, insertTerm, listApplicableTerms, listTerms, withOverrides, type StoredTerm, type TermFields, type TermPlace } from "./terms.js";

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
      withOverrides(ctx.db, actingUser(actor).workspaceId, terms, await readablePlaces(ctx.db, actor));

    const create = async (actor: Actor, place: TermPlace, input: NewTerm) => {
      const fields: TermFields = { name: input.name, definition: input.definition, avoid: input.avoid ?? [], group: input.group ?? null };
      const created = await transaction(ctx.db, (tx) => insertTerm(tx, { place, fields, actor, now: ctx.clock.now() }));
      if (created === "name taken") throw nameTaken(input.name);
      return (await answerTerms(actor, [created]))[0]!;
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
        const terms = await listTerms(ctx.db, { workspaceId: actingUser(actor).workspaceId, projectId: null });
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
        const place = { workspaceId: actingUser(actor).workspaceId, projectId: project.id };
        const terms = await listApplicableTerms(ctx.db, place, await canRead(ctx.db, actor, null));
        return { terms: await answerTerms(actor, byName(terms, request.query.name)) };
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
        const term = await create(actor, { workspaceId: actingUser(actor).workspaceId, projectId: null }, request.body);
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
        const term = await create(actor, { workspaceId: actingUser(actor).workspaceId, projectId: project.id }, request.body);
        return reply.code(201).send({ term });
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
        return { term: (await answerTerms(actor, [term]))[0]! };
      },
    );
  };
}

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
