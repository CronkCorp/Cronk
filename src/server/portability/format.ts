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
 * `people.md`, and a `status` by its `current` name in the Project, when it still has one.
 */
type ChangeField = "title" | "text" | "priority" | "labels" | "relation kind" | "ticket" | "user" | "agent" | "status";

const fromTo = (holds: ChangeField, nullable = false) => ({ from: { holds, nullable }, to: { holds, nullable } });
const relation = { kind: { holds: "relation kind" }, ticket: { holds: "ticket" } } as const;

/** The fields of each kind of Ticket change, besides the `at`, `by` and `change` every one has. */
export const CHANGE_FIELDS: Record<TicketChange["change"], Record<string, { holds: ChangeField; nullable?: boolean }>> = {
  created: { title: { holds: "title" }, description: { holds: "text" }, status: { holds: "status" } },
  title: fromTo("title"),
  description: fromTo("text"),
  status: fromTo("status"),
  priority: fromTo("priority"),
  labels: fromTo("labels"),
  assignee: fromTo("user", true),
  delegate: fromTo("agent", true),
  parent: fromTo("ticket", true),
  "relation added": relation,
  "relation removed": relation,
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
- \`workspace.md\`, \`guidance.md\`, \`documents/\`: the Workspace's settings, Guidance and page tree (Workspace exports only).
- \`projects/<KEY>/project.md\`: a Project's settings, Statuses and members; beside it its \`guidance.md\`, \`documents/\` and \`tickets/\`.
- \`documents/\`: the page tree. Each Document is \`<n>-<title>.md\`, numbered in tree order, with the Documents under it in a
  folder of the same name. \`<name>.versions/\` holds its Versions when the export includes them, \`<name>.comments/\` its Comments.
- \`tickets/<KEY>.md\`: a Ticket, its description as the body; relations name other Tickets by key. Beside it,
  \`<KEY>.activities/\`, \`<KEY>.comments/\` and \`<KEY>.reports/\` hold its Activities, Comments and Reports, each numbered from 1
  in the order they were written; replies and answers name them by that number. \`<KEY>.history.md\` holds its history, oldest
  first, with the names recorded at the time; a User in it also has their \`email\`, a Status its \`current\` name if it is
  still in the Project, and an Agent its id from \`people.md\`.

Not included: Claims, work waiting for Agents, sign-ins, invitations and Agent tokens. Users who aren't
already in the installation an export is imported into come in deactivated, since they have no password there.
`;
