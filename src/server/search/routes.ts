import type { FastifyInstance } from "fastify";
import { requireActor, type AppContext } from "../context.js";
import { projectFor } from "../identity/access.js";
import { answer, errors, listing, ref } from "../schemas.js";
import { SEARCH_KINDS, type SearchKind } from "../../shared/values.js";
import { search } from "./search.js";

/** How many results a search returns unless asked for fewer. */
const DEFAULT_LIMIT = 20;

export function searchRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { q: string; kind?: SearchKind[]; project?: string[]; limit?: number } }>(
      "/api/search",
      {
        schema: {
          querystring: {
            type: "object",
            required: ["q"],
            properties: {
              q: {
                type: "string",
                minLength: 1,
                maxLength: 500,
                description: 'What to look for, as typed into a search box: words, "quoted phrases", and -words to leave out; or a Ticket key, such as CRONK-12, to find that Ticket first.',
              },
              kind: {
                type: "array",
                items: { type: "string", enum: SEARCH_KINDS },
                description: "Only results of these kinds: `ticket`, `document` (in a page tree), `report`, `comment` (on a Ticket, Document or Artifact), `term`, `decision`, `transcript`.",
              },
              project: {
                type: "array",
                items: { type: "string", maxLength: 50 },
                description:
                  "Only results in these Projects, by key in any case; leaves out the Workspace outside any Project. Transcripts whose Agent Sessions changed something in one of them are kept.",
              },
              limit: { type: "integer", minimum: 1, maximum: 100, description: `At most this many results; ${DEFAULT_LIMIT} if left out.` },
            },
          },
          response: {
            200: answer("What the search found among what the caller may read, best match first", listing("results", ref("SearchResult"))),
            ...errors(400, 401, 404, 410),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const { q, kind, project, limit = DEFAULT_LIMIT } = request.query;
        const projectIds = project && (await Promise.all(project.map(async (key) => (await projectFor(ctx.db, actor, key, "read")).project.id)));
        return { results: await search(ctx.db, actor, { query: q, limit, kinds: kind, projectIds }) };
      },
    );
  };
}
