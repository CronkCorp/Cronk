/**
 * The export format: a folder of Markdown files with YAML frontmatter (ADR 0003). A Workspace
 * export holds everything below; a Project export holds one `projects/<KEY>/` and `people.md`.
 * The README written into every export describes the layout for whoever opens it.
 */

import type { TicketChange } from "../work/tickets.js";

/** The format's version, written into every export's README; an import refuses others. */
export const FORMAT = 1;

/** Who did something, as files name them: a User by email, or an Agent by its id in `people.md` with its Agent Session's id, if any. */
export type ActorRef = string | { agent: string; session: string | null };

/**
 * What a field of a Ticket change holds in `<KEY>.history.md`. Records are written as Cronk recorded them, with the
 * names they had at the time, plus what an import finds them by: a `user` by its `email`, an `agent` by its id in
 * `people.md`, and a `status` by its `current` name in the Project, when it still has one. A `flag` is written only when true;
 * a `boolean` always.
 */
type ChangeField = "title" | "text" | "priority" | "labels" | "relation kind" | "ticket" | "document" | "user" | "agent" | "status" | "flag" | "boolean" | "verification";

const fromTo = (holds: ChangeField, nullable = false) => ({ from: { holds, nullable }, to: { holds, nullable } });
const relation = { kind: { holds: "relation kind" }, ticket: { holds: "ticket" } } as const;

/** The fields of each kind of Ticket change, besides the `at`, `by` and `change` every one has. */
export const CHANGE_FIELDS: Record<TicketChange["change"], Record<string, { holds: ChangeField; nullable?: boolean }>> = {
  created: { title: { holds: "title" }, description: { holds: "text" }, status: { holds: "status" } },
  title: fromTo("title"),
  description: fromTo("text"),
  // `sentBack` is written only for a Send back's move, `reopened` only for a Reopen's.
  status: { ...fromTo("status"), sentBack: { holds: "flag" }, reopened: { holds: "flag" } },
  priority: fromTo("priority"),
  labels: fromTo("labels"),
  assignee: fromTo("user", true),
  delegate: fromTo("agent", true),
  parent: fromTo("ticket", true),
  autonomous: fromTo("boolean"),
  verification: fromTo("verification", true),
  "relation added": relation,
  "relation removed": relation,
  "document linked": { document: { holds: "document" } },
  "document unlinked": { document: { holds: "document" } },
};

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A file-name-safe version of a title: lower case letters, digits and dashes. */
export function slug(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "untitled";
}

export const README = `This is an export from Cronk: Markdown files with YAML frontmatter. Import it into Cronk as a whole
(POST /api/import), or read and reuse the files with any tool.

- \`README.md\`: this file; its frontmatter says what the export holds and which version of the format it is.
- \`people.md\`: the Users (by email) and Agents (by id) the other files name, and the Agent Sessions Agents worked in.
- \`workspace.md\`, \`guidance.md\`, \`documents/\`, \`docs/adr/\`, \`GLOSSARY.md\`, \`terms.md\`: the Workspace's settings, Guidance,
  page tree, Decisions and Terms (Workspace exports only).
- \`projects/<KEY>/project.md\`: a Project's settings, Statuses and members; beside it its \`guidance.md\`, \`documents/\`,
  \`docs/adr/\`, \`GLOSSARY.md\`, \`terms.md\` and \`tickets/\`.
- \`GLOSSARY.md\`: a place's Terms as a glossary to read, or keep in a repository; a Project's replace the Workspace's of the
  same name within it. \`terms.md\` beside it holds the same Terms whole in its frontmatter, with their Versions when the export
  includes them; an import reads that, not the glossary.
- \`documents/\`: the page tree. Each Document is \`<n>-<title>.md\`, numbered in tree order, with the Documents under it in a
  folder of the same name. \`<name>.versions/\` holds its Versions when the export includes them, \`<name>.comments/\` its Comments,
  and \`<name>.attachments/\` its Attachments, laid out as a Ticket's are (below).
- \`docs/adr/\`: the Decisions, each \`<NNNN>-<title>.md\` named by its number, its status, group and the Decisions it supersedes
  or was superseded by (named by key) in its frontmatter. \`<name>.versions/\` holds its Versions when the export includes them.
- \`tickets/<KEY>.md\`: a Ticket, its description as the body; relations name other Tickets by key, and \`documents\` lists the
  Documents and Reports linked to it by the path of their file, in the order they were linked. Beside it,
  \`<KEY>.activities/\`, \`<KEY>.comments/\` and \`<KEY>.reports/\` hold its Activities, Comments and Reports, each numbered from 1
  in the order they were written; replies and answers name them by that number. \`<KEY>.history.md\` holds its history, oldest
  first, with the names recorded at the time; a User in it also has their \`email\`, a Status its \`current\` name if it is
  still in the Project, an Agent its id from \`people.md\`, and a Document the \`path\` of its file if the export holds it.
  A Ticket under Autonomous Delegation has \`autonomous: true\`, and an Agent's completion its \`verification\` (\`unverified\`
  or \`verified\`); a Project's \`autonomousByDefault\` is written when on.
  \`<KEY>.attachments/\` holds its Attachments as the files themselves, each named \`<n>-<name>\` in the order they were
  attached, and \`index.md\`, whose frontmatter lists each file's id, name, media type, size, when and by whom it was attached;
  an import keeps the id unless it is taken. A Report's Attachments are beside it the same way, and a Comment's, of a Ticket or
  a Document, in \`<n>.attachments/\` beside its \`<n>.md\`.
- \`artifacts/<n>-<title>.md\`: an Artifact, numbered in the order they were created (the Workspace's at the top, a Project's in
  \`projects/<KEY>/artifacts/\`). Its frontmatter holds its id, title, latest Version and Protected mark, and each Version
  exported with who published it, when, the Ticket it came from (by key) and its files; \`<n>-<title>/<version>/\` holds those
  files as they were published. Every Version is exported when the export includes Versions, else only the latest.
  An import keeps the id unless it is taken.
- \`transcripts/<n>.md\`: the chats that led Agents to change things (Workspace exports only), numbered in the order they were
  first uploaded. The frontmatter names the Agent and its Agent Sessions by their ids in \`people.md\`, the client's \`chatId\`,
  the Tickets (by key), Documents (by path) and Terms (by name, after their Project's key) those Sessions changed; the body is the latest text. \`<n>.earlier/\` holds, as
  they are and oldest first, earlier texts a later upload didn't continue. Every text is as stored, with known secrets scrubbed and
  the Owner's hand redactions applied; \`redactions\` lists those by length and digests, never the passages, so an import keeps
  redacting later uploads, and an import scrubs whatever secrets a text still holds.

Not included: Claims, work waiting for Agents, sign-ins, invitations and Agent tokens. Users who aren't
already in the installation an export is imported into come in deactivated, since they have no password there; an Admin
invites them, and accepting sets their password and reactivates them.
`;
