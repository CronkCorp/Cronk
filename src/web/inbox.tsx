import { Button, buttonClass } from "./components/button.js";
import { Chip, KindLabel, StatusPill, type Kind } from "./components/tags.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { Menu } from "./components/overlays.js";
import { RelativeTime } from "./components/time.js";
import { useEffect, useRef, useState, type Ref } from "react";
import { Actor, agentActor } from "./components/actor.js";
import { api, watchInbox, type InboxFilter, type InboxItem, type InboxKind } from "./api.js";
import { CronkMarkdown, plainText } from "./markdown.js";
import { Link, navigate } from "./router.js";
import { CommentForm, ReportCard } from "./timeline.js";
import { Show, TextArea, useAction, useLoad } from "./ui.js";

// The Inbox as a split view (docs/ui.md § Inbox): the waiting items, grouped, on the left, and the selected
// one on the right, where the User reads it in full and acts on it without leaving the Inbox.

const KIND_NAMES: Record<InboxKind, string> = { question: "Questions", review: "To review" };

/** Where the Inbox is: its filter, and the item selected in it, if the address names one. */
export interface InboxAddress {
  filter: InboxFilter;
  item?: string;
}

/** The Inbox filter and selected item in a page address. */
export function inboxAddressFrom(search: URLSearchParams): InboxAddress {
  const kind = search.get("kind");
  const item = search.get("item");
  return {
    filter: {
      ...(kind && kind in KIND_NAMES ? { kind: kind as InboxKind } : {}),
      ...(search.get("project") ? { project: search.get("project")! } : {}),
      ...(search.get("agent") ? { agent: search.get("agent")! } : {}),
    },
    ...(item ? { item } : {}),
  };
}

const inboxPath = (address: InboxAddress) => {
  const entries = [...Object.entries(address.filter), ["item", address.item]];
  const query = new URLSearchParams(entries.filter((entry): entry is [string, string] => !!entry[1]));
  return `/inbox${query.size ? `?${query}` : ""}`;
};

type QuestionItem = Extract<InboxItem, { kind: "question" }>;
type ReviewItem = Extract<InboxItem, { kind: "review" }>;

/** An item's id in the address: stable across reloads, and readable for a review. */
const itemId = (item: InboxItem) => (item.kind === "question" ? `question-${item.question.id}` : `review-${item.ticket.key}`);

/** The list's groups, in the order they are shown: what blocks an Agent first, then the other questions, then reviews. */
const GROUPS: { name: string; holds: (item: InboxItem) => boolean }[] = [
  { name: "Blocking", holds: (item) => item.kind === "question" && item.question.blocking },
  { name: "Questions", holds: (item) => item.kind === "question" && !item.question.blocking },
  { name: "To review", holds: (item) => item.kind === "review" },
];

/**
 * The signed-in User's Inbox: Tickets In Review they are Assignee of and their Agents' open questions. It
 * loads again whenever the server says it may have changed. The kind filter narrows what the API returned
 * for the Project and Agent filters, so each kind's chip can show its count.
 */
export function InboxPage(props: { address: InboxAddress }) {
  const { filter } = props.address;
  const scope = { ...(filter.project ? { project: filter.project } : {}), ...(filter.agent ? { agent: filter.agent } : {}) };
  const [items, reload] = useLoad(() => api.inbox(scope), [filter.project, filter.agent]);
  const [projects] = useLoad(() => api.projects(), []);
  const [agents] = useLoad(() => api.agents(), []);
  // Reload on every (re)connect, so changes made while the stream was away aren't missed, and on each change.
  const [live, onLive] = useLiveState();
  useEffect(() => watchInbox({ ready: reload, onLive, on: { changed: reload } }), [filter.project, filter.agent]);
  // A new filter starts a new list, so nothing selected before carries over.
  const setFilter = (changes: InboxFilter) => navigate(inboxPath({ filter: { ...filter, ...changes } }));
  const all = items.kind === "loaded" ? items.value : [];
  const count = (kind?: InboxKind) => all.filter((item) => !kind || item.kind === kind).length;
  const projectName = projects.kind === "loaded" ? projects.value.find((p) => p.key === filter.project)?.key : undefined;
  const agentName = agents.kind === "loaded" ? agents.value.find((a) => a.id === filter.agent)?.name : undefined;

  return (
    <section className="inbox">
      <div className="page-head">
        <h1>Inbox</h1>
        <div className="inbox-filters" role="group" aria-label="Filters">
          <LiveIndicator state={live} />
          <FilterChip pressed={!filter.kind} onClick={() => setFilter({ kind: undefined })}>{`Everything ${count()}`}</FilterChip>
          {(Object.keys(KIND_NAMES) as InboxKind[]).map((kind) => (
            <FilterChip key={kind} pressed={filter.kind === kind} onClick={() => setFilter({ kind })}>
              {`${KIND_NAMES[kind]} ${count(kind)}`}
            </FilterChip>
          ))}
          <Menu
            label="Filter by Project"
            trigger={<FilterChip pressed={!!filter.project}>{filter.project ? `Project: ${projectName ?? filter.project} ▾` : "Project ▾"}</FilterChip>}
            items={[
              { label: "All Projects", onSelect: () => setFilter({ project: undefined }) },
              ...(projects.kind === "loaded" ? projects.value.map((p) => ({ label: `${p.key} ${p.name}`, onSelect: () => setFilter({ project: p.key }) })) : []),
            ]}
          />
          <Menu
            label="Filter by Agent"
            trigger={<FilterChip pressed={!!filter.agent}>{filter.agent ? `Agent: ${agentName ?? "unknown"} ▾` : "Agent ▾"}</FilterChip>}
            items={[
              { label: "All Agents", onSelect: () => setFilter({ agent: undefined }) },
              ...(agents.kind === "loaded" ? agents.value.map((a) => ({ label: a.name, onSelect: () => setFilter({ agent: a.id }) })) : []),
            ]}
          />
        </div>
      </div>
      <Show state={items}>
        {(loaded) => (
          <Triage
            key={`${filter.project ?? ""}/${filter.agent ?? ""}/${filter.kind ?? ""}`}
            items={loaded.filter((item) => !filter.kind || item.kind === filter.kind)}
            address={props.address}
            onChanged={reload}
          />
        )}
      </Show>
    </section>
  );
}

/** A filter chip: a toggle button, pressed while its filter applies. Extra props let it be a menu's trigger. */
function FilterChip(props: { pressed: boolean; children: string; onClick?: () => void }) {
  const { pressed, children, ...rest } = props;
  return (
    <button type="button" className={`filter-chip${pressed ? " pressed" : ""}`} aria-pressed={pressed} {...rest}>
      {children}
    </button>
  );
}

/** The actions the selected item offers the keyboard, registered by its detail pane. */
interface DetailKeys {
  complete?: () => void;
}

/** The split view over the loaded items: the grouped list, and the selected item's detail. */
function Triage(props: { items: InboxItem[]; address: InboxAddress; onChanged: () => void }) {
  const { items } = props;
  const ordered = GROUPS.flatMap((group) => items.filter(group.holds));
  const selectedId = props.address.item && ordered.some((item) => itemId(item) === props.address.item) ? props.address.item : ordered[0] && itemId(ordered[0]);
  const index = ordered.findIndex((item) => itemId(item) === selectedId);
  const selected = ordered[index];
  const keys = useRef<DetailKeys>({});
  const select = (item: InboxItem | undefined) => navigate(inboxPath({ filter: props.address.filter, ...(item ? { item: itemId(item) } : {}) }), { replace: true });

  /** After acting on `item`, select the one after it, or the one before when it was the last. */
  const actedOn = (item: InboxItem) => {
    const at = ordered.findIndex((other) => itemId(other) === itemId(item));
    select(ordered[at + 1] ?? ordered[at - 1]);
    props.onChanged();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "c" && keys.current.complete) {
        event.preventDefault();
        keys.current.complete();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (ordered.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing waiting on you</h2>
        <p className="muted">Agents' questions and Tickets handed over for review show up here.</p>
      </div>
    );
  }

  return (
    <div className="inbox-split">
      <section className="inbox-list" aria-label="Inbox items">
        {GROUPS.map((group) => {
          const held = ordered.filter(group.holds);
          if (held.length === 0) return null;
          return (
            <div key={group.name} className="inbox-group">
              <h2 className="inbox-group-head">{`${group.name} · ${held.length}`}</h2>
              <ul className="inbox-items" aria-label={group.name}>
                {held.map((item) => (
                  <li key={itemId(item)}>
                    <ListItem item={item} selected={itemId(item) === selectedId} to={inboxPath({ filter: props.address.filter, item: itemId(item) })} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>
      <section className="inbox-detail" aria-label="Selected item">
        {selected &&
          (selected.kind === "question" ? (
            <QuestionDetail key={itemId(selected)} item={selected} onDone={() => actedOn(selected)} />
          ) : (
            <ReviewDetail key={itemId(selected)} item={selected} keys={keys} onDone={() => actedOn(selected)} />
          ))}
      </section>
    </div>
  );
}

/** Whether a key press lands in a field the User is typing in, where the Inbox's shortcuts stay out of the way. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** What an item's kind label says and how it is coloured. */
function kindOf(item: InboxItem): { kind: Kind; label: string } {
  if (item.kind === "review") return { kind: "review", label: "To review" };
  return item.question.blocking ? { kind: "blocking", label: "Blocking" } : { kind: "question", label: "Question" };
}

/** One item in the list: its kind, Ticket key, time, Ticket title, and a snippet of the question or the Report's title. */
function ListItem(props: { item: InboxItem; selected: boolean; to: string }) {
  const { item } = props;
  const { kind, label } = kindOf(item);
  const snippet = item.kind === "question" ? plainText(item.question.body) : item.reports.length ? `Report: ${item.reports.map((r) => r.title).join(", ")}` : "No Report";
  return (
    <Link
      to={props.to}
      className={`inbox-item${props.selected ? " selected" : ""}${kind === "blocking" ? " blocking" : ""}`}
      aria-current={props.selected ? "true" : undefined}
    >
      <span className="inbox-item-head">
        <KindLabel kind={kind}>{label}</KindLabel>
        <span className="key">{item.ticket.key}</span>
        <RelativeTime at={item.at} />
      </span>
      <span className="inbox-item-title">{item.ticket.title}</span>
      <span className="inbox-item-snippet">{snippet}</span>
    </Link>
  );
}

/** The detail pane's head: the item's kind, its Ticket's key and title, linking to the Ticket. */
function DetailHead(props: { item: InboxItem; label: string; kind: Kind }) {
  const { ticket } = props.item;
  return (
    <div className="inbox-detail-head">
      <KindLabel kind={props.kind}>{props.label}</KindLabel>
      <span className="key">{ticket.key}</span>
      <Link to={`/tickets/${ticket.key}`} className="link">{ticket.title}</Link>
    </div>
  );
}

/** A question in full: the Agent, its Agent Session, the question, and an answer box. */
function QuestionDetail(props: { item: QuestionItem; onDone: () => void; answerRef?: Ref<HTMLTextAreaElement> }) {
  const { question, ticket } = props.item;
  return (
    <div className="inbox-detail-body">
      <DetailHead item={props.item} kind={question.blocking ? "blocking" : "question"} label={question.blocking ? "Blocking question" : "Question"} />
      <div className="inbox-detail-who">
        <Actor actor={agentActor(question.agent, question.session)} />
        <RelativeTime at={question.at} />
        <Chip tone={question.blocking ? "danger" : "warn"}>{`${question.agent.name} is waiting`}</Chip>
      </div>
      <div className="inbox-question">
        <CronkMarkdown>{question.body}</CronkMarkdown>
      </div>
      <CommentForm
        label="Answer"
        submitLabel="Post answer"
        placeholder={`Answer ${question.agent.name}… (Markdown)`}
        hint={`The answer reaches ${question.agent.name} as Waiting Work.`}
        inputRef={props.answerRef}
        post={(input) => api.postTicketComment(ticket.key, { ...input, replyToActivityId: question.id })}
        onPosted={props.onDone}
      />
    </div>
  );
}

/** A Ticket to review: its Status, its Delegate, its Reports in full, and Complete, Send back and a link to the Ticket. */
function ReviewDetail(props: { item: ReviewItem; keys: { current: DetailKeys }; onDone: () => void }) {
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
  const runComplete = () => {
    if (!complete.busy) void complete.run();
  };
  props.keys.current = { complete: runComplete };
  useEffect(() => () => void (props.keys.current = {}), []);

  return (
    <div className="inbox-detail-body">
      <DetailHead item={props.item} kind="review" label="To review" />
      <div className="inbox-detail-who">
        <StatusPill status={ticket.status} />
        {ticket.delegate && <span className="muted">by <Actor actor={agentActor(ticket.delegate)} /></span>}
      </div>
      {reports.length > 0 ? (
        <div className="inbox-reports">
          {reports.map((r) => <ReportCard key={r.id} report={r} />)}
        </div>
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
            <Button type="submit" disabled={sendBack.busy || !comment.trim()}>Send back</Button>
            <Button type="button" variant="secondary" onClick={() => setSendingBack(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <Button onClick={runComplete} disabled={complete.busy}>Complete</Button>
          <Button variant="secondary" onClick={() => setSendingBack(true)}>Send back…</Button>
          <Link to={`/tickets/${ticket.key}`} className={buttonClass("ghost")}>Open Ticket</Link>
        </div>
      )}
    </div>
  );
}
