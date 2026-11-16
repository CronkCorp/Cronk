import type { ReactNode } from "react";
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
};

/** Where a mention leads: the thing itself, or for a Comment the Ticket or Document it is on. */
function addressOf(m: Mention): string {
  switch (m.kind) {
    case "ticket":
      return `/tickets/${m.key}`;
    case "document":
      return `/documents/${m.id}`;
    case "comment":
      return m.ticketKey ? `/tickets/${m.ticketKey}` : `/documents/${m.documentId}`;
    case "term":
      return `/terms/${m.id}`;
    case "decision":
      return `/decisions/${m.key}`;
  }
}

/** Where a mention lies, as a list says: the Ticket a Report or Comment is on, its Project, or the Workspace. */
function whereItIs(m: Mention): string {
  if (m.kind === "ticket" || m.kind === "decision") return m.projectKey ?? "Workspace";
  if (m.ticketKey) return m.kind === "comment" ? `on ${m.ticketKey}` : `Report on ${m.ticketKey}`;
  return m.kind === "comment" ? `on a Document in ${m.projectKey ?? "the Workspace"}` : (m.projectKey ?? "Workspace");
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

/**
 * What mentions a Term or Decision, as `load` lists it: each Ticket, Document, Comment, Term and Decision
 * naming it, most recently changed first. `what` says what they name, for the empty state. `compact` fits it
 * into a side panel.
 */
export function MentionedIn(props: { load: () => Promise<Mention[]>; deps: unknown[]; what: string; compact?: boolean }) {
  const [mentions] = useLoad(props.load, props.deps);
  const body = (list: Mention[]): ReactNode =>
    list.length === 0 ? (
      <p className="muted small">Nothing names {props.what} yet. Tickets, Documents, Comments, Terms and Decisions that do show here.</p>
    ) : (
      <ul className="side-list" aria-label="Mentioned in">
        {list.map((m) => (
          <MentionRow key={`${m.kind}:${m.id}`} mention={m} />
        ))}
      </ul>
    );
  return (
    <Show state={mentions}>
      {(list) =>
        props.compact ? (
          <div className="side-group">
            <h4>Mentioned in</h4>
            {body(list)}
          </div>
        ) : (
          <section className="panel wide">
            <h2>Mentioned in · {list.length >= LISTED_AT_MOST ? `${LISTED_AT_MOST} most recent` : list.length}</h2>
            {body(list)}
          </section>
        )
      }
    </Show>
  );
}
