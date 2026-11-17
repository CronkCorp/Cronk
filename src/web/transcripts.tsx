import { useEffect } from "react";
import { turnsOf } from "../shared/transcript-turns.js";
import { api, type Transcript, type TranscriptLink } from "./api.js";
import { Actor, agentActor, userActor } from "./components/actor.js";
import { RelativeTime } from "./components/time.js";
import { CronkMarkdown } from "./markdown.js";
import { Link } from "./router.js";
import { Show, useLoad } from "./ui.js";

/** Where a Transcript opens: at a turn, or at the top. */
export const transcriptAddress = (id: string, turn: number | null) => `/transcripts/${id}${turn === null ? "" : `#turn-${turn}`}`;

/** One item a Transcript led to, as its chips and list show it. */
interface LedTo {
  kind: "Ticket" | "Document" | "Term" | "Decision";
  /** The key of a Ticket or Decision. */
  key?: string;
  name: string;
  address: string;
  turn: number | null;
}

/** Everything the Transcript led to that the reader can read, Tickets first. */
const ledToOf = (t: Transcript): LedTo[] => [
  ...t.tickets.map((i): LedTo => ({ kind: "Ticket", key: i.key, name: i.title, address: `/tickets/${i.key}`, turn: i.turn })),
  ...t.decisions.map((i): LedTo => ({ kind: "Decision", key: i.key, name: i.title, address: `/decisions/${i.key}`, turn: i.turn })),
  ...t.documents.map((i): LedTo => ({ kind: "Document", name: i.title, address: `/documents/${i.id}`, turn: i.turn })),
  ...t.terms.map((i): LedTo => ({ kind: "Term", name: i.name, address: `/terms/${i.id}`, turn: i.turn })),
];

/** A chip for an item a turn led to, opening the item. */
function ItemChip(props: { item: LedTo }) {
  const { item } = props;
  return (
    <Link to={item.address} className="transcript-chip" title={`${item.kind}: ${item.name}`}>
      {item.key ? <span className="transcript-chip-key">{item.key}</span> : <span className="transcript-chip-kind">{item.kind}</span>}
      <span className="transcript-chip-name">{item.name}</span>
    </Link>
  );
}

/** Opens the turn the address names once the page shows it, as a browser would for a page that loads at once. */
function useScrollToTurn(ready: boolean) {
  useEffect(() => {
    if (!ready || !location.hash) return;
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: "start" });
  }, [ready]);
}

/**
 * A Transcript, at `/transcripts/:id`: the chat turn by turn, each turn marked with chips for the items whose key or id first
 * appears there, and everything it led to at the top.
 */
export function TranscriptPage(props: { id: string }) {
  const [transcript] = useLoad(() => api.transcript(props.id), [props.id]);
  useScrollToTurn(transcript.kind === "loaded");
  return <Show state={transcript}>{(t) => <TranscriptView transcript={t} />}</Show>;
}

function TranscriptView(props: { transcript: Transcript }) {
  const t = props.transcript;
  const turns = turnsOf(t.markdown);
  const ledTo = ledToOf(t);
  return (
    <article className="transcript">
      <div className="crumbs muted">Transcript</div>
      <div className="page-head">
        <h1>{t.title}</h1>
      </div>
      <div className="transcript-meta muted">
        <Actor actor={agentActor(t.agent)} owner={false} />
        <span>for</span>
        <Actor actor={userActor(t.agent.owner.name)} />
        <span>· updated <RelativeTime at={t.updatedAt} /></span>
        <span>· {turns.length === 1 ? "1 turn" : `${turns.length} turns`}</span>
      </div>
      <section className="panel wide transcript-led-to" aria-label="Led to">
        <h2>Led to</h2>
        {ledTo.length === 0 ? (
          <p className="muted small">Nothing its Agent Sessions changed is yours to read.</p>
        ) : (
          <ul className="side-list">
            {ledTo.map((item) => (
              <li key={item.address}>
                <ItemChip item={item} />
                {item.turn === null ? (
                  <span className="muted small">not named in the chat</span>
                ) : (
                  <a href={`#turn-${item.turn}`} className="link small">first in turn {item.turn}</a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <ol className="transcript-turns" aria-label="Turns">
        {turns.map((turn) => {
          const chips = ledTo.filter((item) => item.turn === turn.n);
          return (
            <li key={turn.n} id={`turn-${turn.n}`} className={`transcript-turn ${turn.role.toLowerCase()}`}>
              <div className="transcript-turn-head">
                <span className={`kind-label ${turn.role === "Assistant" ? "report" : "comment"}`}>{turn.role}</span>
                <a href={`#turn-${turn.n}`} className="transcript-turn-number muted">Turn {turn.n}</a>
                {chips.length > 0 && (
                  <span className="transcript-chips" aria-label="First appears here">
                    {chips.map((item) => (
                      <ItemChip key={item.address} item={item} />
                    ))}
                  </span>
                )}
              </div>
              <div className="markdown transcript-turn-body">
                <CronkMarkdown>{turn.text.slice(turn.text.indexOf("\n") + 1)}</CronkMarkdown>
              </div>
            </li>
          );
        })}
      </ol>
      {t.earlier.length > 0 && (
        <details className="panel wide transcript-earlier">
          <summary>Earlier texts · {t.earlier.length}</summary>
          <p className="muted small">Uploads of this chat that a later one didn't continue, oldest first.</p>
          {t.earlier.map((text, i) => (
            <pre key={i} className="transcript-earlier-text">{text}</pre>
          ))}
        </details>
      )}
    </article>
  );
}

/**
 * The Transcripts an item came from ("From Transcript"), each opening at the turn where the item first appears. `heading` is the
 * level its side panel uses; nothing shows when there are none.
 */
export function FromTranscripts(props: { links: TranscriptLink[]; heading: "h3" | "h4" }) {
  if (props.links.length === 0) return null;
  const Heading = props.heading;
  return (
    <div className="side-group from-transcripts">
      <Heading>From Transcript</Heading>
      <ul className="side-list" aria-label="From Transcript">
        {props.links.map((l) => (
          <li key={l.id}>
            <Link to={transcriptAddress(l.id, l.turn)} className="link">{l.title}</Link>
            <span className="muted">{l.turn === null ? "by" : `turn ${l.turn}, by`}</span>
            <Actor actor={agentActor(l.agent)} owner={false} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** FromTranscripts for an item the page doesn't already have the links of: a Document, Term or Decision. */
export function LoadFromTranscripts(props: { kind: "documents" | "terms" | "decisions"; keyOrId: string; heading: "h3" | "h4"; reloadOn?: unknown }) {
  const [links] = useLoad(() => api.transcriptsOf(props.kind, props.keyOrId), [props.kind, props.keyOrId, props.reloadOn]);
  return links.kind === "loaded" ? <FromTranscripts links={links.value} heading={props.heading} /> : null;
}
