import type { Mention } from "./api.js";
import { Chip } from "./components/tags.js";
import { Link } from "./router.js";
import { Show, useLoad } from "./ui.js";

/** How many mentions the API lists at most; a full list may hold more. */
const LISTED_AT_MOST = 50;

/** What each kind of mention is called, as its chip says. */
const KIND_NAMES: Record<Mention["kind"], string> = {
  ticket: "Ticket",
  document: "Document",
  comment: "Comment",
  term: "Term",
  decision: "Decision",
  activity: "Activity",
};

/** Where a mention leads: the thing itself, or for a Comment or Activity the Ticket, Document or Artifact it is on. */
function addressOf(m: Mention): string {
  switch (m.kind) {
    case "ticket":
      return `/tickets/${m.key}`;
    case "document":
      return `/documents/${m.id}`;
    case "comment":
      if (m.ticketKey) return `/tickets/${m.ticketKey}`;
      return m.artifactId ? `/artifacts/${m.artifactId}` : `/documents/${m.documentId}`;
    case "term":
      return `/terms/${m.id}`;
    case "decision":
      return `/decisions/${m.key}`;
    case "activity":
      return `/tickets/${m.ticketKey}`;
  }
}

/** Where a mention lies, as a list says: the Ticket a Report, Comment or Activity is on, its Project, or the Workspace. */
function whereItIs(m: Mention): string {
  if (m.kind === "ticket" || m.kind === "decision") return m.projectKey ?? "Workspace";
  if (m.ticketKey) return m.kind === "document" ? `Report on ${m.ticketKey}` : `on ${m.ticketKey}`;
  if (m.kind === "comment") return `on ${m.artifactId ? "an Artifact" : "a Document"} in ${m.projectKey ?? "the Workspace"}`;
  return m.projectKey ?? "Workspace";
}

function MentionRow(props: { mention: Mention }) {
  const m = props.mention;
  return (
    <li>
      {(m.kind === "ticket" || m.kind === "decision") && <span className="key">{m.key}</span>}
      <Link to={addressOf(m)} className="link">{m.title}</Link> <span className="muted">{whereItIs(m)}</span> <Chip>{KIND_NAMES[m.kind]}</Chip>
    </li>
  );
}

/** A list of what mentions something, or for none what would show there. `what` says what they name. */
export function MentionList(props: { mentions: Mention[]; what: string }) {
  return props.mentions.length === 0 ? (
    <p className="muted small">Nothing names {props.what} yet. Tickets, Documents, Comments, Terms, Decisions and Activities that do show here.</p>
  ) : (
    <ul className="side-list" aria-label="Mentioned in">
      {props.mentions.map((m) => (
        <MentionRow key={`${m.kind}:${m.id}`} mention={m} />
      ))}
    </ul>
  );
}

/**
 * What mentions a Term or Decision, as `load` lists it: each Ticket, Document, Comment, Term, Decision and
 * Activity naming it, most recently changed first. `what` says what they name, for the empty state. `compact`
 * fits it into a side panel.
 */
export function MentionedIn(props: { load: () => Promise<Mention[]>; deps: unknown[]; what: string; compact?: boolean }) {
  const [mentions] = useLoad(props.load, props.deps);
  return (
    <Show state={mentions}>
      {(list) =>
        props.compact ? (
          <div className="side-group">
            <h4>Mentioned in</h4>
            <MentionList mentions={list} what={props.what} />
          </div>
        ) : (
          <section className="panel wide">
            <h2>Mentioned in · {list.length >= LISTED_AT_MOST ? `${LISTED_AT_MOST} most recent` : list.length}</h2>
            <MentionList mentions={list} what={props.what} />
          </section>
        )
      }
    </Show>
  );
}
