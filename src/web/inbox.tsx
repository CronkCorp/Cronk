import { Banner } from "./components/banner.js";
import { Button, buttonClass } from "./components/button.js";
import { Chip, KindLabel, StatusPill, type Kind } from "./components/tags.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { Menu } from "./components/overlays.js";
import { RelativeTime } from "./components/time.js";
import { useEffect, useRef, useState } from "react";
import { Actor, agentActor } from "./components/actor.js";
import { api, watchInbox, type InboxFilter, type InboxItem, type InboxKind } from "./api.js";
import { CronkMarkdown, plainText } from "./markdown.js";
import { Link, navigate } from "./router.js";
import { CommentForm, ReportCard, useArrivals } from "./timeline.js";
import { Show, TextArea, useAction, useLoad } from "./ui.js";

// The Inbox as a split view (docs/ui.md § Inbox): the waiting items, grouped, on the left, and the selected
// one on the right, where the User reads it in full and acts on it without leaving the Inbox.

const KIND_NAMES: Record<InboxKind, string> = { question: "Questions", review: "To review", unverified: "Unverified" };

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
type UnverifiedItem = Extract<InboxItem, { kind: "unverified" }>;

/** An item's id in the address: stable across reloads, and readable for a review. */
const itemId = (item: InboxItem) => (item.kind === "question" ? `question-${item.question.id}` : `${item.kind}-${item.ticket.key}`);

/** The list's groups, in the order they are shown: what blocks an Agent first, then the other questions, then reviews, then Unverified completions. */
const GROUPS: { name: string; holds: (item: InboxItem) => boolean }[] = [
  { name: "Blocking", holds: (item) => item.kind === "question" && item.question.blocking },
  { name: "Questions", holds: (item) => item.kind === "question" && !item.question.blocking },
  { name: "To review", holds: (item) => item.kind === "review" },
  { name: "Unverified", holds: (item) => item.kind === "unverified" },
];

/**
 * The signed-in User's Inbox: Tickets In Review they are Assignee of, Agents' Unverified completions of them, and their Agents' open questions. It
 * loads again whenever the server says it may have changed. The kind filter narrows what the API returned
 * for the Project and Agent filters, so each kind's chip can show its count.
 */
export function InboxPage(props: { address: InboxAddress }) {
  const { filter } = props.address;
  const { kind: _kind, ...scope } = filter;
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
            trigger={<FilterChip menu pressed={!!filter.project}>{filter.project ? `Project: ${filter.project} ▾` : "Project ▾"}</FilterChip>}
            items={[
              { label: "All Projects", onSelect: () => setFilter({ project: undefined }) },
              ...(projects.kind === "loaded" ? projects.value.map((p) => ({ label: `${p.key} ${p.name}`, onSelect: () => setFilter({ project: p.key }) })) : []),
            ]}
          />
          <Menu
            label="Filter by Agent"
            trigger={<FilterChip menu pressed={!!filter.agent}>{filter.agent ? `Agent: ${agentName ?? "unknown"} ▾` : "Agent ▾"}</FilterChip>}
            items={[
              { label: "All Agents", onSelect: () => setFilter({ agent: undefined }) },
              ...(agents.kind === "loaded" ? agents.value.map((a) => ({ label: a.name, onSelect: () => setFilter({ agent: a.id }) })) : []),
            ]}
          />
        </div>
      </div>
      <Show state={items}>
        {(loaded) => (
          <InboxSplit
            key={`${filter.project ?? ""}/${filter.agent ?? ""}/${filter.kind ?? ""}`}
            items={loaded.filter((item) => !filter.kind || item.kind === filter.kind)}
            kind={filter.kind}
            address={props.address}
            onChanged={reload}
          />
        )}
      </Show>
    </section>
  );
}

/** A filter chip: a toggle button, pressed while its filter applies. Extra props let it be a menu's trigger. */
function FilterChip(props: { pressed: boolean; children: string; onClick?: () => void; menu?: boolean }) {
  const { pressed, children, menu, ...rest } = props;
  return (
    <button type="button" className={`filter-chip${pressed ? " pressed" : ""}`} aria-pressed={menu ? undefined : pressed} {...rest}>
      {children}
    </button>
  );
}

/** The actions the selected item offers the keyboard, registered by its detail pane. */
interface DetailKeys {
  answer?: () => void;
  complete?: () => void;
  sendBack?: () => void;
}

/** Hands the detail pane's keyboard actions to the page while the pane is shown, and takes them back when it goes. */
function useDetailKeys(keys: { current: DetailKeys }, actions: DetailKeys) {
  useEffect(() => {
    keys.current = actions;
    return () => void (keys.current = {});
  });
}

/** What each detail pane takes: its item, whether it was resolved elsewhere, where it registers its keys, and who hears it acted. */
interface DetailProps<I extends InboxItem> {
  item: I;
  resolved: boolean;
  keys: { current: DetailKeys };
  /** Runs one of the pane's actions, so the item isn't taken for resolved elsewhere if the reload it causes lands first. */
  acting: <T>(run: () => Promise<T>) => Promise<T>;
  onDone: () => void;
}

/** The selected item as last seen in the list, and its neighbours there then. */
interface Seen {
  id: string;
  item: InboxItem;
  index: number;
  before?: string;
  after?: string;
}

/** The empty state's heading, by the kind the Inbox is narrowed to. */
const NOTHING: Record<InboxKind | "all", string> = {
  all: "Nothing waiting on you",
  question: "No questions waiting",
  review: "Nothing to review",
  unverified: "No Unverified completions",
};

/** The split view over the loaded items: the grouped list, and the selected item's detail. */
function InboxSplit(props: { items: InboxItem[]; kind: InboxKind | undefined; address: InboxAddress; onChanged: () => void }) {
  const { items } = props;
  const pathTo = (item?: InboxItem) => inboxPath({ filter: props.address.filter, ...(item ? { item: itemId(item) } : {}) });
  // Items acted on here leave the list as the action succeeds rather than waiting for the reload, which would
  // otherwise find them gone and show them as resolved elsewhere; while the action runs, `busy` holds its item
  // for a reload that lands before the action's reply. Once a load no longer holds an acted-on item, it is
  // forgotten, so a Ticket handed over for review again shows again.
  const acted = useRef(new Set<string>());
  const busy = useRef<string>(undefined);
  for (const id of acted.current) if (!items.some((item) => itemId(item) === id)) acted.current.delete(id);
  const ordered = GROUPS.flatMap((group) => items.filter((item) => group.holds(item) && !acted.current.has(itemId(item))));
  // The selected item as last seen in the list, and where it was. When a reload drops it because it was
  // resolved elsewhere, the detail pane keeps showing it until the User moves on (docs/ui.md § Live updates).
  const seen = useRef<Seen>(undefined);
  const at = (id: string | undefined) => ordered.findIndex((item) => itemId(item) === id);
  // An address naming an item that isn't here, as an old link does, opens what was shown, or else the first.
  let wanted = props.address.item;
  if (!wanted || (at(wanted) < 0 && wanted !== seen.current?.id)) wanted = seen.current?.id ?? (ordered[0] && itemId(ordered[0]));
  let index = at(wanted);
  // Whether the selected item has left the list, and whether that was someone else's doing.
  let gone = false;
  if (index < 0 && seen.current && seen.current.id === wanted) {
    index = seen.current.index;
    gone = true;
  } else {
    if (index < 0) index = 0;
    const item = ordered[index];
    const [before, after] = [ordered[index - 1], ordered[index + 1]];
    seen.current = item && { id: itemId(item), item, index, ...(before ? { before: itemId(before) } : {}), ...(after ? { after: itemId(after) } : {}) };
  }
  const selected = seen.current?.item;
  const selectedId = selected && itemId(selected);
  const resolved = gone && busy.current !== selectedId;
  const arrived = useArrivals(items.map(itemId));
  const keys = useRef<DetailKeys>({});
  const select = (item: InboxItem | undefined) => {
    seen.current = undefined;
    navigate(pathTo(item), { replace: true });
  };

  // The item `step` away from the selected one. A resolved item has left the list: its neighbours then, if
  // still here, or else whatever took its place, so items arriving above it at the same time don't throw J and K off.
  const neighbour = (step: 1 | -1) => {
    if (!gone) return ordered[index + step];
    const was = ordered[at(step > 0 ? seen.current?.after : seen.current?.before)];
    return was ?? ordered[step > 0 ? index : index - 1];
  };
  // The latest of these, for the keyboard handler registered once below and for actions finishing after a reload.
  const latest = useRef({ neighbour });
  latest.current = { neighbour };
  const move = (step: 1 | -1) => {
    const next = latest.current.neighbour(step);
    if (next) select(next);
  };

  const acting = <T,>(run: () => Promise<T>) => {
    const id = seen.current?.id;
    busy.current = id;
    return run().finally(() => {
      if (busy.current === id) busy.current = undefined;
    });
  };

  /** After acting on the selected item, select the one after it, or the one before when it was the last. */
  const actedOn = () => {
    if (seen.current) acted.current.add(seen.current.id);
    select(latest.current.neighbour(1) ?? latest.current.neighbour(-1));
    props.onChanged();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || inOverlay(event.target)) return;
      const key = event.key.toLowerCase();
      const run = key === "j" ? () => move(1) : key === "k" ? () => move(-1) : { a: keys.current.answer, c: keys.current.complete, s: keys.current.sendBack }[key];
      if (!run) return;
      // Kept from the field a shortcut focuses, so A and S don't type their own letter into it.
      event.preventDefault();
      run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!selected) {
    return (
      <div className="empty">
        <h2>{NOTHING[props.kind ?? "all"]}</h2>
        <p className="muted">Agents' questions, Tickets handed over for review and Agents' Unverified completions show up here.</p>
      </div>
    );
  }

  return (
    <div className="inbox-view">
      <div className={`inbox-split${props.address.item ? " picked" : ""}`}>
        <section className="inbox-list" aria-label="Inbox items">
          {ordered.length === 0 && <p className="muted inbox-none">Nothing else is waiting.</p>}
          {GROUPS.map((group) => {
            const held = ordered.filter(group.holds);
            if (held.length === 0) return null;
            return (
              <div key={group.name} className="inbox-group">
                <h2 className="inbox-group-head">{`${group.name} · ${held.length}`}</h2>
                <ul className="inbox-items" aria-label={group.name}>
                  {held.map((item) => (
                    <li key={itemId(item)}>
                      <ListItem item={item} selected={itemId(item) === selectedId} arrived={arrived.has(itemId(item))} to={pathTo(item)} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
        <section className="inbox-detail" aria-label="Selected item">
          <Link to={pathTo()} className="link inbox-back">
            Back to the list
          </Link>
          {selected.kind === "question" ? (
            <QuestionDetail key={selectedId} item={selected} resolved={resolved} keys={keys} acting={acting} onDone={actedOn} />
          ) : selected.kind === "unverified" ? (
            <UnverifiedDetail key={selectedId} item={selected} resolved={resolved} keys={keys} acting={acting} onDone={actedOn} />
          ) : (
            <ReviewDetail key={selectedId} item={selected} resolved={resolved} keys={keys} acting={acting} onDone={actedOn} />
          )}
        </section>
      </div>
      <p className="muted inbox-keys">J / K moves through the list, A answers, C completes or Accepts, S sends back.</p>
    </div>
  );
}

/** Whether a key press lands in a field the User is typing in, where the Inbox's shortcuts stay out of the way. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Whether a key press lands in an open menu or dialog, such as a filter's, which has keys of its own. */
const inOverlay = (target: EventTarget | null) => target instanceof Element && !!target.closest('[role="menu"], [role="dialog"]');

/** What an item's kind label says, short in the list and in full in the detail pane, and how it is coloured. */
function kindOf(item: InboxItem): { kind: Kind; label: string; full: string } {
  if (item.kind === "review") return { kind: "review", label: "To review", full: "To review" };
  if (item.kind === "unverified") return { kind: "unverified", label: "Unverified", full: "Unverified completion" };
  return item.question.blocking
    ? { kind: "blocking", label: "Blocking", full: "Blocking question" }
    : { kind: "question", label: "Question", full: "Question" };
}

/** One item in the list: its kind, Ticket key, time, Ticket title, and a snippet of the question or the Report's title. */
function ListItem(props: { item: InboxItem; selected: boolean; arrived: boolean; to: string }) {
  const { item } = props;
  const { kind, label } = kindOf(item);
  const snippet = item.kind === "question" ? plainText(item.question.body) : item.reports.length ? `Report: ${item.reports.map((r) => r.title).join(", ")}` : "No Report";
  return (
    <Link
      to={props.to}
      className={`inbox-item${props.selected ? " selected" : ""}${props.arrived ? " arrived" : ""}${kind === "blocking" ? " blocking" : ""}`}
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
function DetailHead(props: { item: InboxItem }) {
  const { ticket } = props.item;
  const { kind, full } = kindOf(props.item);
  return (
    <div className="inbox-detail-head">
      <KindLabel kind={kind}>{full}</KindLabel>
      <span className="key">{ticket.key}</span>
      <Link to={`/tickets/${ticket.key}`} className="link">{ticket.title}</Link>
    </div>
  );
}

/** A question in full: the Agent, its Agent Session, the question, and an answer box. */
function QuestionDetail(props: DetailProps<QuestionItem>) {
  const { question, ticket } = props.item;
  const answerBox = useRef<HTMLTextAreaElement>(null);
  useDetailKeys(props.keys, props.resolved ? {} : { answer: () => answerBox.current?.focus() });
  return (
    <div className="inbox-detail-body">
      <DetailHead item={props.item} />
      {props.resolved && <ResolvedElsewhere ticketKey={ticket.key} />}
      <div className="inbox-detail-who">
        <Actor actor={agentActor(question.agent, question.session)} />
        <RelativeTime at={question.at} />
        {!props.resolved && <Chip tone={question.blocking ? "danger" : "warn"}>{`${question.agent.name} is waiting`}</Chip>}
      </div>
      <div className="inbox-question">
        <CronkMarkdown>{question.body}</CronkMarkdown>
      </div>
      <CommentForm
        label="Answer"
        submitLabel="Post answer"
        placeholder={`Answer ${question.agent.name}… (Markdown)`}
        hint={`The answer reaches ${question.agent.name} as Waiting Work.`}
        inputRef={answerBox}
        disabled={props.resolved}
        post={(input) => props.acting(() => api.postTicketComment(ticket.key, { ...input, replyToActivityId: question.id }))}
        onPosted={props.onDone}
      />
    </div>
  );
}

/** A Ticket to review: its Status, its Delegate, its Reports in full, and Complete, Send back and a link to the Ticket. */
function ReviewDetail(props: DetailProps<ReviewItem>) {
  const { ticket, reports } = props.item;
  const [sendingBack, setSendingBack] = useState(false);
  const [comment, setComment] = useState("");
  const complete = useAction(
    () =>
      props.acting(async () => {
        const { statuses } = await api.project(ticket.projectKey);
        const completed = statuses.find((s) => s.category === "completed");
        if (!completed) throw new Error(`${ticket.projectKey} has no Completed Status`);
        return api.updateTicket(ticket.key, { statusId: completed.id });
      }),
    props.onDone,
  );
  const sendBack = useAction(() => props.acting(() => api.sendBack(ticket.key, { comment })), props.onDone);
  const error = complete.error ?? sendBack.error;
  const runComplete = () => {
    if (!complete.busy) void complete.run();
  };
  const commentBox = useRef<HTMLTextAreaElement>(null);
  // Opening the Send back box puts the cursor in it, whether from the button or from S.
  useEffect(() => {
    if (sendingBack) commentBox.current?.focus();
  }, [sendingBack]);
  useDetailKeys(props.keys, props.resolved ? {} : { complete: runComplete, sendBack: () => (sendingBack ? commentBox.current?.focus() : setSendingBack(true)) });

  return (
    <div className="inbox-detail-body">
      <DetailHead item={props.item} />
      {/* The action bar, with its link to the Ticket, gives way to an open Send back box, whose text is kept. */}
      {props.resolved && <ResolvedElsewhere {...(sendingBack ? { ticketKey: ticket.key } : {})} />}
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
          <TextArea label="What is left to do" value={comment} onChange={setComment} rows={3} inputRef={commentBox} disabled={props.resolved} />
          <div className="actions">
            <Button type="submit" disabled={props.resolved || sendBack.busy || !comment.trim()}>Send back</Button>
            <Button type="button" variant="secondary" onClick={() => setSendingBack(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <Button onClick={runComplete} disabled={props.resolved || complete.busy}>Complete</Button>
          <Button variant="secondary" onClick={() => setSendingBack(true)} disabled={props.resolved}>Send back…</Button>
          <Link to={`/tickets/${ticket.key}`} className={buttonClass("ghost")}>Open Ticket</Link>
        </div>
      )}
    </div>
  );
}

/** Started, In Review or finished: work that went on after its blocker was completed. */
const CONTINUED = ["started", "in_review", "completed"];

/**
 * An Agent's Unverified completion: the Reports like a review, the Tickets that already continued on it,
 * and Accept and a link to the Ticket.
 */
function UnverifiedDetail(props: DetailProps<UnverifiedItem>) {
  const { ticket, reports } = props.item;
  const [detail] = useLoad(() => api.ticket(ticket.key), [ticket.key]);
  const continued = detail.kind === "loaded" ? detail.value.relations.blocks.filter((t) => CONTINUED.includes(t.status.category)) : [];
  const accept = useAction(() => props.acting(() => api.accept(ticket.key)), props.onDone);
  const runAccept = () => {
    if (!accept.busy) void accept.run();
  };
  useDetailKeys(props.keys, props.resolved ? {} : { complete: runAccept });

  return (
    <div className="inbox-detail-body">
      <DetailHead item={props.item} />
      {props.resolved && <ResolvedElsewhere />}
      <div className="inbox-detail-who">
        <StatusPill status={ticket.status} />
        {ticket.delegate && <span className="muted">by <Actor actor={agentActor(ticket.delegate)} /> on its own</span>}
      </div>
      {continued.length > 0 && (
        <Banner tone="info" role="status">
          <p>{`Already continued on it: ${continued.map((t) => `${t.key} (${t.status.name})`).join(", ")}`}</p>
        </Banner>
      )}
      {reports.length > 0 ? (
        <div className="inbox-reports">
          {reports.map((r) => <ReportCard key={r.id} report={r} />)}
        </div>
      ) : (
        <p className="muted">No Report.</p>
      )}
      {accept.error && <p className="error" role="alert">{accept.error}</p>}
      <div className="actions">
        <Button onClick={runAccept} disabled={props.resolved || accept.busy}>Accept</Button>
        <Link to={`/tickets/${ticket.key}`} className={buttonClass("ghost")}>Open Ticket</Link>
      </div>
    </div>
  );
}

/**
 * Marks an item that left the Inbox while selected: answered, completed or sent back in another tab, by
 * another User, or on the Ticket page. It doesn't say who; the Ticket does. `ticketKey` adds a link to it
 * where the pane has none of its own.
 */
function ResolvedElsewhere(props: { ticketKey?: string }) {
  return (
    <div className="inbox-resolved">
      <p role="status">Resolved elsewhere</p>
      {props.ticketKey && <Link to={`/tickets/${props.ticketKey}`} className={buttonClass("ghost")}>Open Ticket</Link>}
    </div>
  );
}
