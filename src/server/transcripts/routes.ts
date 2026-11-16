import type { FastifyInstance } from "fastify";
import { actingUser } from "../actor.js";
import { HttpError, requireActor, requireUserActor, type AppContext } from "../context.js";
import { lockUntilCommit, transaction } from "../db/database.js";
import { answer, errors, holding, listing, noContent, pathParams, ref } from "../schemas.js";
import { getWorkspace } from "../workspace/workspaces.js";
import {
  afterUpload,
  changedAnything,
  findForUpdate,
  findTranscript,
  listTranscripts,
  transcriptSummary,
  MAX_TRANSCRIPT_BYTES,
  readTranscript,
  deleteTranscript,
  sessionsNamedIn,
  sizeOf,
  storeTranscript,
} from "./transcripts.js";
import { scrubSecrets } from "./scrub.js";

/** The media types a Transcript may be uploaded as: its Markdown, as text. */
const MARKDOWN_TYPES = ["text/markdown", "text/plain"];

/** The refusal of an upload that would make the Transcript hold `size` bytes, over the Workspace's `limit`. */
const tooBig = (size: number, limit: number) => new HttpError(413, `This Transcript would hold ${size} bytes; the Workspace allows at most ${limit}`);

const transcriptParams = pathParams({ id: { type: "string", format: "uuid", description: "The Transcript's id." } });

/** Transcripts (ADR 0013): uploading a chat from the client side, reading it, and its Owner deleting it. */
export function transcriptRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    // A Transcript arrives as its Markdown; this parser applies only to the routes registered here.
    app.addContentTypeParser(MARKDOWN_TYPES, { parseAs: "buffer", bodyLimit: MAX_TRANSCRIPT_BYTES }, (_request, body, done) => done(null, body));

    app.put<{ Params: { chatId: string }; Body: Buffer }>(
      "/api/transcripts/by-chat/:chatId",
      {
        bodyLimit: MAX_TRANSCRIPT_BYTES,
        schema: {
          description:
            "Uploads the chat `chatId` of the calling Agent's client as a Transcript, with one of the Agent's tokens that isn't read-only; no Agent Session is " +
            "needed. The body is the chat as Markdown in the turn convention (`## User` and `## Assistant` turns, tool calls and results as fenced blocks), " +
            "sent as `text/markdown`. Cronk links it to the Agent's own Agent Sessions whose ids it names, and so to everything they changed; " +
            "an upload naming none that changed anything is refused with 422, so a hook may upload every chat. Uploading the same chat again " +
            "replaces the text when the new one continues it (starts with it), keeps the old text as well when it doesn't, and only ever adds " +
            "Sessions. The Transcript, all its texts together, may hold at most the Workspace's `transcriptMaxBytes`.\n\n" +
            "```sh\ncurl -X PUT -H \"Authorization: Bearer $TOKEN\" -H \"Content-Type: text/markdown\" --data-binary @chat.md \\\n" +
            "  $CRONK/api/transcripts/by-chat/$CHAT_ID\n```",
          consumes: MARKDOWN_TYPES,
          body: { description: "The chat as Markdown in the turn convention." },
          params: pathParams({ chatId: { type: "string", minLength: 1, maxLength: 200, description: "The client's id for the chat, such as Claude Code's `session_id`." } }),
          response: {
            200: answer("The Transcript, created or changed", holding("transcript", "Transcript")),
            ...errors(400, 401, 403, 410, 413, 422),
          },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request, { outsideSession: true });
        if (actor.kind !== "agent") throw new HttpError(403, "Only an Agent uploads a Transcript, with one of its tokens");
        if (actor.readOnly) throw new HttpError(403, "This Agent's token is read-only, so it can't upload a Transcript");
        if (!Buffer.isBuffer(request.body)) throw new HttpError(400, "Send the chat as text/markdown");
        const markdown = request.body.toString("utf8");
        const { chatId } = request.params;
        const workspaceId = actor.owner.workspaceId;
        const limit = (await getWorkspace(ctx.db, workspaceId)).transcriptMaxBytes;
        // Refused before anything is scanned when the text alone is too big.
        if (request.body.length > limit) throw tooBig(request.body.length, limit);
        const id = await transaction(ctx.db, async (tx) => {
          // One upload of a chat at a time, so neither loses the other's text or Sessions.
          await lockUntilCommit(tx, `transcript:${actor.agent.id}:${chatId}`);
          const existing = await findForUpdate(tx, actor.agent.id, chatId);
          // Sessions are found in the text as sent; only the scrubbed text is kept.
          const named = await sessionsNamedIn(tx, { id: actor.agent.id, workspaceId }, markdown);
          const upload = afterUpload(existing, scrubSecrets(markdown), named);
          const size = sizeOf(upload);
          if (size > limit) throw tooBig(size, limit);
          if (!(await changedAnything(tx, upload.sessionIds))) {
            throw new HttpError(
              422,
              "This chat names none of this Agent's Agent Sessions that changed anything, so it isn't kept. Only chats that led to changes are",
            );
          }
          return storeTranscript(tx, { workspaceId, agentId: actor.agent.id, chatId, existing, upload, at: ctx.clock.now() });
        });
        const transcript = (await readTranscript(ctx.db, actor, (await findTranscript(ctx.db, workspaceId, id))!, { uploader: true }))!;
        return { transcript };
      },
    );

    app.get(
      "/api/transcripts",
      {
        schema: {
          description: "The Transcripts the caller may read (see GET /api/transcripts/{id}), most recently uploaded first, without their text.",
          response: { 200: answer("The Transcripts", listing("transcripts", ref("TranscriptSummary"))), ...errors(400, 401, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const transcripts = [];
        for (const stored of await listTranscripts(ctx.db, actingUser(actor).workspaceId, "newest")) {
          const transcript = await readTranscript(ctx.db, actor, stored);
          if (transcript) transcripts.push(transcriptSummary(transcript));
        }
        return { transcripts };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/transcripts/:id",
      {
        schema: {
          description:
            "A Transcript, for its Owner, and for anyone with Read in every Project its Agent Sessions changed things in (and in the Workspace, " +
            "for what they changed outside any Project); Agents are capped as usual.",
          params: transcriptParams,
          response: { 200: answer("The Transcript", holding("transcript", "Transcript")), ...errors(400, 401, 404, 410) },
        },
      },
      async (request) => {
        const actor = await requireActor(ctx, request);
        const stored = await findTranscript(ctx.db, actingUser(actor).workspaceId, request.params.id);
        const transcript = stored && (await readTranscript(ctx.db, actor, stored));
        if (!transcript) throw new HttpError(404, "No such Transcript");
        return { transcript };
      },
    );

    app.delete<{ Params: { id: string } }>(
      "/api/transcripts/:id",
      {
        schema: {
          description: "Deletes a Transcript, for good. Only its Owner may, not their Agents; it is otherwise kept, even after its Agent is removed.",
          params: transcriptParams,
          response: { 204: noContent("The Transcript is deleted"), ...errors(400, 401, 403, 404, 410) },
        },
      },
      async (request, reply) => {
        const actor = await requireActor(ctx, request);
        requireUserActor(actor, "delete a Transcript");
        const stored = await findTranscript(ctx.db, actor.user.workspaceId, request.params.id);
        if (!stored || !(await readTranscript(ctx.db, actor, stored))) throw new HttpError(404, "No such Transcript");
        if (stored.ownerId !== actor.user.id) throw new HttpError(403, "Only a Transcript's Owner can delete it");
        await deleteTranscript(ctx.db, stored.id);
        return reply.code(204).send();
      },
    );
  };
}
