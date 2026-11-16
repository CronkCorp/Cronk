import { afterUpload, changedItems, findForUpdate, storeTranscript, type Upload } from "../transcripts/transcripts.js";
import { iso, type ExportContext } from "./export-context.js";
import { date, refuse, text } from "./fields.js";
import type { ImportContext } from "./import-context.js";

/**
 * `transcripts/<n>.md`: the Workspace's Transcripts, numbered from 1 in the order they were first uploaded, in a Workspace
 * export only. The frontmatter names the Agent and its Agent Sessions by their ids in `people.md`, with the client's chat id;
 * the body is the latest text. `<n>.earlier/<k>.md` hold, as they are, the texts a later upload didn't continue, oldest first.
 * The Tickets (by key) and Documents (by path) the Sessions changed are listed for whoever reads the files; an import links
 * them again through the Sessions.
 */

interface TranscriptRow {
  id: string;
  agent_id: string;
  chat_id: string;
  markdown: string;
  earlier: string[];
  created_at: Date;
  updated_at: Date;
  session_ids: string[];
}

/** Writes every Transcript of the Workspace. Run after the Documents, so it can name them by path, and before `people.md`. */
export async function exportTranscripts(ctx: ExportContext): Promise<void> {
  const { rows } = await ctx.db.query<TranscriptRow>(
    `SELECT tr.*, coalesce((SELECT array_agg(s.id ORDER BY s.started_at, s.id) FROM transcript_sessions ts
                            JOIN agent_sessions s ON s.id = ts.session_id WHERE ts.transcript_id = tr.id), '{}') AS session_ids
     FROM transcripts tr WHERE tr.workspace_id = $1 ORDER BY tr.created_at, tr.id`,
    [ctx.scope.workspaceId],
  );
  for (const [i, t] of rows.entries()) {
    const n = i + 1;
    for (const id of t.session_ids) ctx.usedSessions.add(id);
    const items = await changedItems(ctx.db, t.session_ids);
    ctx.add(
      `transcripts/${n}.md`,
      {
        agent: ctx.agent(t.agent_id),
        chatId: t.chat_id,
        createdAt: iso(t.created_at),
        updatedAt: iso(t.updated_at),
        sessions: t.session_ids,
        tickets: items.tickets.map((ticket) => ticket.key),
        documents: items.documents.flatMap((d) => ctx.documentPaths.get(d.id) ?? []),
      },
      t.markdown,
    );
    for (const [k, earlier] of t.earlier.entries()) ctx.folder.set(`transcripts/${n}.earlier/${k + 1}.md`, earlier);
  }
}

/** Imports `transcripts/`, after `people.md` and every record its Sessions changed, linking each to the Sessions as imported here. */
export async function importTranscripts(ctx: ImportContext): Promise<void> {
  for (const [n, file] of ctx.numbered("transcripts")) {
    const where = file.path;
    const agent = ctx.agent(file.data.agent, `${where} agent`);
    const chatId = text(file.data.chatId, `${where} chatId`);
    const sessions = file.data.sessions ?? [];
    if (!Array.isArray(sessions)) refuse(`${where} sessions must be a list of Agent Session ids`);
    const sessionIds = sessions.map((s) => ctx.sessionIds.get(String(s)) ?? refuse(`${where} names an Agent Session that isn't in people.md`));
    const texts: string[] = [];
    for (let k = 1; ctx.folder.has(`transcripts/${n}.earlier/${k}.md`); k++) texts.push(ctx.folder.get(`transcripts/${n}.earlier/${k}.md`)!);
    texts.push(file.body);
    // As if each text were uploaded again in turn, onto what this Workspace may already hold of the chat.
    const existing = await findForUpdate(ctx.db, agent.id, chatId);
    let upload: Upload | undefined = existing;
    for (const t of texts) upload = afterUpload(upload, t, sessionIds);
    await storeTranscript(ctx.db, {
      workspaceId: ctx.workspaceId,
      agentId: agent.id,
      chatId,
      existing,
      upload: upload!,
      at: date(file.data.updatedAt, `${where} updatedAt`),
      createdAt: date(file.data.createdAt, `${where} createdAt`),
    });
  }
}
