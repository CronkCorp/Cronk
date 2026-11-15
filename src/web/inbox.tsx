import { KindLabel } from "./components/tags.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { RelativeTime } from "./components/time.js";
import { useEffect, useState } from "react";
import { Actor, agentActor } from "./components/actor.js";
import { api, watchInbox, type InboxFilter, type InboxItem, type InboxKind } from "./api.js";
import { CronkMarkdown } from "./markdown.js";
import { Link, navigate } from "./router.js";
import { Show, TextArea, useAction, useLoad } from "./ui.js";
import { StatusPill } from "./work.js";

const KIND_NAMES: Record<InboxKind, string> = { question: "Questions", review: "Tickets to review" };

/** The Inbox filter in a page address. */
export function inboxFilterFrom(search: URLSearchParams): InboxFilter {
  const kind = search.get("kind");
  return {
    ...(kind && kind in KIND_NAMES ? { kind: kind as InboxKind } : {}),
    ...(search.get("project") ? { project: search.get("project")! } : {}),
    ...(search.get("agent") ? { agent: search.get("agent")! } : {}),
  };
}

const inboxPath = (filter: InboxFilter) => {
  const query = new URLSearchParams(Object.entries(filter).filter((entry): entry is [string, string] => !!entry[1]));
  return `/inbox${query.size ? `?${query}` : ""}`;
};

/**
 * The signed-in User's Inbox: Tickets In Review they are Assignee of and their Agents' open
 * questions, blocking ones first. It loads again whenever the server says it may have changed.
 */
export function InboxPage(props: { filter: InboxFilter }) {
  const filter = props.filter;
  const [items, reload] = useLoad(() => api.inbox(filter), [filter.kind, filter.project, filter.agent]);
  const [projects] = useLoad(() => api.projects(), []);
  const [agents] = useLoad(() => api.agents(), []);
  // Reload on every (re)connect, so changes made while the stream was away aren't missed, and on each change.
  const [live, onLive] = useLiveState();
  useEffect(() => watchInbox({ ready: reload, onLive, on: { changed: reload } }), [filter.kind, filter.project, filter.agent]);
  const setFilter = (changes: InboxFilter) => navigate(inboxPath({ ...filter, ...changes }));

  return (
    <section>
      <div className="page-head">
        <h1>Inbox</h1>
        <LiveIndicator state={live} />
      </div>
      <div className="filters">
        <label className="filter">
          <span>Filter by kind</span>
          <select value={filter.kind ?? ""} onChange={(e) => setFilter({ kind: (e.target.value || undefined) as InboxKind | undefined })}>
            <option value="">Everything</option>
            {(Object.keys(KIND_NAMES) as InboxKind[]).map((kind) => (
              <option key={kind} value={kind}>{KIND_NAMES[kind]}</option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span>Filter by Project</span>
          <select value={filter.project ?? ""} onChange={(e) => setFilter({ project: e.target.value || undefined })}>
            <option value="">All Projects</option>
            {projects.kind === "loaded" && projects.value.map((p) => <option key={p.id} value={p.key}>{p.name}</option>)}
          </select>
        </label>
        <label className="filter">
          <span>Filter by Agent</span>
          <select value={filter.agent ?? ""} onChange={(e) => setFilter({ agent: e.target.value || undefined })}>
            <option value="">All Agents</option>
            {agents.kind === "loaded" && agents.value.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      </div>
      <Show state={items}>
        {(list) =>
          list.length === 0 ? (
            <div className="empty">
              <h2>Nothing waiting on you</h2>
              <p className="muted">Tickets to review and your Agents' questions show up here.</p>
            </div>
          ) : (
            <ol className="timeline" aria-label="Inbox">
              {list.map((item) =>
                item.kind === "question" ? (
                  <QuestionEntry key={`q-${item.question.id}`} item={item} onDone={reload} />
                ) : (
                  <ReviewEntry key={`r-${item.ticket.id}`} item={item} onDone={reload} />
                ),
              )}
            </ol>
          )
        }
      </Show>
    </section>
  );
}

function QuestionEntry(props: { item: Extract<InboxItem, { kind: "question" }>; onDone: () => void }) {
  const { question, ticket } = props.item;
  const [answering, setAnswering] = useState(false);
  const [body, setBody] = useState("");
  const answer = useAction(() => api.postTicketComment(ticket.key, { body, replyToActivityId: question.id }), props.onDone);
  return (
    <li className={`activity question${question.blocking ? " blocking" : ""}`} aria-label={`Question on ${ticket.key}`}>
      <div className="activity-head">
        <KindLabel kind={question.blocking ? "blocking" : "question"}>{question.blocking ? "Blocking question" : "Question"}</KindLabel>
        <Actor actor={agentActor(question.agent, question.session)} owner={false} />
        <Link to={`/tickets/${ticket.key}`} className="link">{ticket.key} {ticket.title}</Link>
        <RelativeTime at={question.at} />
      </div>
      <div className="activity-body">
        <CronkMarkdown>{question.body}</CronkMarkdown>
      </div>
      {answering ? (
        <form
          className="comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            void answer.run();
          }}
        >
          <TextArea label="Answer" value={body} onChange={setBody} rows={3} />
          {answer.error && <p className="error" role="alert">{answer.error}</p>}
          <div className="actions">
            <button type="submit" disabled={answer.busy || !body.trim()}>Post answer</button>
            <button type="button" className="secondary" onClick={() => setAnswering(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button className="link" onClick={() => setAnswering(true)}>Answer</button>
        </div>
      )}
    </li>
  );
}

function ReviewEntry(props: { item: Extract<InboxItem, { kind: "review" }>; onDone: () => void }) {
  const { ticket, reports } = props.item;
  const [sendingBack, setSendingBack] = useState(false);
  const [comment, setComment] = useState("");
  const complete = useAction(async () => {
    const { statuses } = await api.project(ticket.projectKey);
    const completed = statuses.find((s) => s.category === "completed");
    if (!completed) throw new Error(`${ticket.projectKey} has no Completed Status`);
    return api.updateTicket(ticket.key, { statusId: completed.id });
  }, props.onDone);
  const sendBack = useAction(() => api.sendBack(ticket.key, { comment }), props.onDone);
  const error = complete.error ?? sendBack.error;
  return (
    <li className="activity review" aria-label={`Review ${ticket.key}`}>
      <div className="activity-head">
        <KindLabel kind="review">To review</KindLabel>
        <Link to={`/tickets/${ticket.key}`} className="link">{ticket.key} {ticket.title}</Link>
        <StatusPill status={ticket.status} />
        {ticket.delegate && <span className="muted">by <Actor actor={{ kind: "agent", name: ticket.delegate.name }} /></span>}
      </div>
      {reports.length > 0 ? (
        <ul className="history" aria-label={`Reports on ${ticket.key}`}>
          {reports.map((r) => (
            <li key={r.id}>
              <Link to={`/documents/${r.id}`} className="link">Report: {r.title}</Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No Report.</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {sendingBack ? (
        <form
          className="comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            void sendBack.run();
          }}
        >
          <TextArea label="What is left to do" value={comment} onChange={setComment} rows={3} />
          <div className="actions">
            <button type="submit" disabled={sendBack.busy || !comment.trim()}>Send back</button>
            <button type="button" className="secondary" onClick={() => setSendingBack(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button onClick={() => void complete.run()} disabled={complete.busy}>Complete</button>
          <button className="secondary" onClick={() => setSendingBack(true)}>Send back</button>
        </div>
      )}
    </li>
  );
}
