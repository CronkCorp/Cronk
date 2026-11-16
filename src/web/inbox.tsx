import { Banner } from "./components/banner.js";
import { Button, buttonClass } from "./components/button.js";
import { Chip, DecisionStatusPill, KindLabel, ProtectedMark, StatusPill, type Kind } from "./components/tags.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { Menu } from "./components/overlays.js";
import { RelativeTime } from "./components/time.js";
import { useEffect, useRef, useState } from "react";
import { Actor, agentActor } from "./components/actor.js";
import { api, watchInbox, type InboxFilter, type InboxItem, type InboxKind, type TriageItem, type SuggestedContent, type User } from "./api.js";
import { ContentEditor, contentText, creditNote, Diff, Reasoning, useDiffView } from "./suggestions.js";
import { RejectDecisionForm } from "./components/reject-decision.js";
import { CONTINUED, ReopenDialog } from "./components/reopen-dialog.js";
import { CronkMarkdown, plainText } from "./markdown.js";
import { Link, navigate } from "./router.js";
import { CommentForm, ReportCard, useArrivals } from "./timeline.js";
import { Show, TextArea, useAction, useLoad } from "./ui.js";

// The Inbox as a split view (docs/ui.md § Inbox): the waiting items, grouped, on the left, and the selected
// one on the right, where the User reads it in full and acts on it without leaving the Inbox. Triage (triage.tsx)
// is the same split view over the waiting items with no clear User (docs/ui.md § Inbox and Triage in Phase 2).

const KIND_NAMES: Record<InboxKind, string> = {
  question: "Questions",
  review: "To review",
  unverified: "Unverified",
  suggestion: "Suggestions",
  discovered: "Discovered",
  decision: "Proposed Decisions",
};

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

/** The address of a split view at `base` with a filter and a selected item, such as the Inbox's or Triage's. */
export const viewPath = (base: string, address: { filter: object; item?: string }) => {
  const entries = [...Object.entries(address.filter), ["item", address.item]];
  const query = new URLSearchParams(entries.filter((entry): entry is [string, string] => !!entry[1]));
  return `${base}${query.size ? `?${query}` : ""}`;
};

const inboxPath = (address: InboxAddress) => viewPath("/inbox", address);

/** An item a split view lists: one from an Inbox, or from Triage. */
export type WaitingItem = InboxItem | TriageItem;
type WaitingKind = WaitingItem["kind"];

type QuestionItem = Extract<WaitingItem, { kind: "question" }>;
type ReviewItem = Extract<WaitingItem, { kind: "review" }>;
type UnverifiedItem = Extract<WaitingItem, { kind: "unverified" }>;
type DecisionItem = Extract<WaitingItem, { kind: "decision" }>;
type SuggestionItem = Extract<WaitingItem, { kind: "suggestion" }>;
type UnattendedItem = Extract<WaitingItem, { kind: "unattended" }>;
type DiscoveredItem = Extract<WaitingItem, { kind: "discovered" }>;

/** An item's id in the address: stable across reloads, and readable for a review or a Decision. */
export const itemId = (item: WaitingItem) =>
  item.kind === "question"
    ? `question-${item.question.id}`
    : item.kind === "decision"
      ? `decision-${item.decision.key}`
      : item.kind === "suggestion"
        ? `suggestion-${item.suggestion.id}`
        : `${item.kind}-${item.ticket.key}`;

/** A group of the list: its name, the kind of item it holds, and which items of that kind. */
export interface Group {
  name: string;
  kind: WaitingKind;
  holds: (item: WaitingItem) => boolean;
}

/**
 * The list's groups, in the order they are shown: what blocks an Agent first, then the other questions, then reviews, then Unverified
 * completions, then Agents' Suggestions, then Tickets Agents discovered, then Decisions Agents proposed.
 */
export const GROUPS: Group[] = [
  { name: "Blocking", kind: "question", holds: (item) => item.kind === "question" && item.question.blocking },
  { name: "Questions", kind: "question", holds: (item) => item.kind === "question" && !item.question.blocking },
  { name: "To review", kind: "review", holds: (item) => item.kind === "review" },
  { name: "Unverified", kind: "unverified", holds: (item) => item.kind === "unverified" },
  { name: "Unattended", kind: "unattended", holds: (item) => item.kind === "unattended" },
  { name: "Suggestions", kind: "suggestion", holds: (item) => item.kind === "suggestion" },
  { name: "Discovered", kind: "discovered", holds: (item) => item.kind === "discovered" },
  { name: "Proposed Decisions", kind: "decision", holds: (item) => item.kind === "decision" },
];

/**
 * The signed-in User's Inbox: Tickets In Review they are Assignee of, Agents' Unverified completions of them, their Agents' open questions,
 * the Suggestions and Decisions Agents made that they review, and the Tickets Agents discovered for them. It
 * loads again whenever the server says it may have changed. The kind filter narrows what the API returned
 * for the Project and Agent filters, so each kind's chip can show its count.
 */
export function InboxPage(props: { address: InboxAddress; me: User }) {
  const { filter } = props.address;
  const { kind: _kind, ...scope } = filter;
  const [items, reload] = useLoad(() => api.inbox(scope), [filter.project, filter.agent]);
  const [agents] = useLoad(() => api.agents(), []);
  // Reload on every (re)connect, so changes made while the stream was away aren't missed, and on each change.
  const [live, onLive] = useLiveState();
  useEffect(() => watchInbox({ ready: reload, onLive, on: { changed: reload } }), [filter.project, filter.agent]);
  // A new filter starts a new list, so nothing selected before carries over.
  const setFilter = (changes: InboxFilter) => navigate(inboxPath({ filter: { ...filter, ...changes } }));
  const all = items.kind === "loaded" ? items.value : [];
  const agentName = agents.kind === "loaded" ? agents.value.find((a) => a.id === filter.agent)?.name : undefined;

  return (
    <section className="inbox">
      <div className="page-head">
        <h1>Inbox</h1>
        <div className="inbox-filters" role="group" aria-label="Filters">
          <LiveIndicator state={live} />
          <KindAndProjectFilters kinds={KIND_NAMES} items={all} filter={filter} setFilter={setFilter} />
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
            item={props.address.item}
            pathTo={(item) => inboxPath({ filter, ...(item ? { item: itemId(item) } : {}) })}
            groups={GROUPS}
            label="Inbox items"
            empty={{
              heading: NOTHING[filter.kind ?? "all"],
              hint: "Agents' questions, Tickets handed over for review, Agents' Unverified completions, the Suggestions and Decisions they propose, and the Tickets they discover show up here.",
            }}
            keysHint="J / K moves through the list, A answers, C completes, Accepts or delegates, S sends back, reopens or rejects."
            me={props.me}
            onChanged={reload}
          />
        )}
      </Show>
    </section>
  );
}

/**
 * The filter chips a split view shares: Everything and one per kind, each with its count among `items`, then the Project menu.
 * `kinds` names the kinds the view holds, in the order their chips are shown.
 */
export function KindAndProjectFilters<K extends WaitingKind>(props: {
  kinds: Record<K, string>;
  items: WaitingItem[];
  filter: { kind?: K; project?: string };
  setFilter: (changes: { kind?: K; project?: string }) => void;
}) {
  const { filter, setFilter } = props;
  const [projects] = useLoad(() => api.projects(), []);
  const count = (kind?: K) => props.items.filter((item) => !kind || item.kind === kind).length;
  return (
    <>
      <FilterChip pressed={!filter.kind} onClick={() => setFilter({ kind: undefined })}>{`Everything ${count()}`}</FilterChip>
      {(Object.keys(props.kinds) as K[]).map((kind) => (
        <FilterChip key={kind} pressed={filter.kind === kind} onClick={() => setFilter({ kind })}>
          {`${props.kinds[kind]} ${count(kind)}`}
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
    </>
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
interface DetailProps<I extends WaitingItem> {
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
  item: WaitingItem;
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
  suggestion: "No Suggestions",
  discovered: "No Discovered Tickets",
  decision: "No proposed Decisions",
};

/** What the split view shows and where: its items, the one the address names, and how it groups and names them. */
interface SplitProps {
  items: WaitingItem[];
  /** The id of the item the address selects, if any. */
  item: string | undefined;
  /** The address of the view with `item` selected, or with none. */
  pathTo: (item?: WaitingItem) => string;
  groups: Group[];
  /** The list's accessible name. */
  label: string;
  /** What the view says when nothing is waiting. */
  empty: { heading: string; hint: string };
  /** The line below the view naming its keyboard shortcuts. */
  keysHint: string;
  me: User;
  onChanged: () => void;
}

/** The split view over the loaded items: the grouped list, and the selected item's detail. */
export function InboxSplit(props: SplitProps) {
  const { items, pathTo } = props;
  // Items acted on here leave the list as the action succeeds rather than waiting for the reload, which would
  // otherwise find them gone and show them as resolved elsewhere; while the action runs, `busy` holds its item
  // for a reload that lands before the action's reply. Once a load no longer holds an acted-on item, it is
  // forgotten, so a Ticket handed over for review again shows again.
  const acted = useRef(new Set<string>());
  const busy = useRef<string>(undefined);
  for (const id of acted.current) if (!items.some((item) => itemId(item) === id)) acted.current.delete(id);
  const ordered = props.groups.flatMap((group) => items.filter((item) => group.holds(item) && !acted.current.has(itemId(item))));
  // The selected item as last seen in the list, and where it was. When a reload drops it because it was
  // resolved elsewhere, the detail pane keeps showing it until the User moves on (docs/ui.md § Live updates).
  const seen = useRef<Seen>(undefined);
  const at = (id: string | undefined) => ordered.findIndex((item) => itemId(item) === id);
  // An address naming an item that isn't here, as an old link does, opens what was shown, or else the first.
  let wanted = props.item;
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
  const select = (item: WaitingItem | undefined) => {
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
        <h2>{props.empty.heading}</h2>
        <p className="muted">{props.empty.hint}</p>
      </div>
    );
  }

  return (
    <div className="inbox-view">
      <div className={`inbox-split${props.item ? " picked" : ""}`}>
        <section className="inbox-list" aria-label={props.label}>
          {ordered.length === 0 && <p className="muted inbox-none">Nothing else is waiting.</p>}
          {props.groups.map((group) => {
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
          ) : selected.kind === "decision" ? (
            <DecisionDetail key={selectedId} item={selected} resolved={resolved} keys={keys} acting={acting} onDone={actedOn} />
          ) : selected.kind === "unattended" ? (
            <UnattendedDetail key={selectedId} item={selected} resolved={resolved} keys={keys} acting={acting} onDone={actedOn} me={props.me} />
          ) : selected.kind === "suggestion" ? (
            <SuggestionDetail key={selectedId} item={selected} resolved={resolved} keys={keys} acting={acting} onDone={actedOn} me={props.me} />
          ) : selected.kind === "discovered" ? (
            <DiscoveredDetail key={selectedId} item={selected} resolved={resolved} keys={keys} acting={acting} onDone={actedOn} me={props.me} />
          ) : (
            <ReviewDetail key={selectedId} item={selected} resolved={resolved} keys={keys} acting={acting} onDone={actedOn} />
          )}
        </section>
      </div>
      <p className="muted inbox-keys">{props.keysHint}</p>
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
function kindOf(item: WaitingItem): { kind: Kind; label: string; full: string } {
  if (item.kind === "review") return { kind: "review", label: "To review", full: "To review" };
  if (item.kind === "unverified") return { kind: "unverified", label: "Unverified", full: "Unverified completion" };
  if (item.kind === "unattended") return { kind: "unattended", label: "Unattended", full: "Unattended Ticket" };
  if (item.kind === "decision") return { kind: "decision", label: "Decision", full: "Proposed Decision" };
  if (item.kind === "suggestion") return { kind: "suggestion", label: "Suggestion", full: "Suggestion" };
  if (item.kind === "discovered") return { kind: "discovered", label: "Discovered", full: "Discovered Ticket" };
  return item.question.blocking
    ? { kind: "blocking", label: "Blocking", full: "Blocking question" }
    : { kind: "question", label: "Question", full: "Question" };
}

/** Whether a Suggestion proposes a new Document under a protected branch, not created until a User accepts it. */
const isNewDocument = (suggestion: SuggestionItem["suggestion"]) => suggestion.item.kind === "document" && suggestion.item.id === null;

/** A Suggestion's item as the Inbox names it: its key and title, and where it is; a new Document's goes to the Document it would go under. */
function suggestedItem(suggestion: SuggestionItem["suggestion"]): { key: string; title: string; to: string } {
  const { item } = suggestion;
  if (item.kind === "decision") return { key: item.key!, title: item.title, to: `/decisions/${item.key}` };
  if (item.kind === "term") return { key: "Term", title: item.title, to: `/terms/${item.id}` };
  if (isNewDocument(suggestion)) return { key: "New Document", title: item.title, to: `/documents/${suggestion.parent!.id}` };
  if (item.kind === "document") return { key: "Document", title: item.title, to: `/documents/${item.id}` };
  return item.projectKey === null
    ? { key: "Guidance", title: "The Workspace's Guidance", to: "/guidance" }
    : { key: "Guidance", title: `${item.projectKey}'s Guidance`, to: `/projects/${item.projectKey}?view=guidance` };
}

/**
 * One item in the list: its kind, key, time and title, then a snippet: of the question, the Reports' titles, a
 * Suggestion's reasoning, or a proposed Decision's body. The key and title are the Ticket's, or the Suggestion's
 * item's, or the proposed Decision's.
 */
function ListItem(props: { item: WaitingItem; selected: boolean; arrived: boolean; to: string }) {
  const { item } = props;
  const { kind, label } = kindOf(item);
  const named = item.kind === "decision" ? item.decision : item.kind === "suggestion" ? suggestedItem(item.suggestion) : item.ticket;
  const snippet =
    item.kind === "question"
      ? plainText(item.question.body)
      : item.kind === "decision"
        ? `${item.decision.proposedBy.name}: ${plainText(item.decision.body)}`
        : item.kind === "suggestion"
          ? `${item.suggestion.proposedBy.name}: ${plainText(item.suggestion.reasoning)}`
          : item.kind === "unattended"
          ? unattendedBecause(item)
          : item.kind === "discovered"
            ? foundBy(item)
          : item.reports.length
          ? `Report: ${item.reports.map((r) => r.title).join(", ")}`
          : "No Report";
  return (
    <Link
      to={props.to}
      className={`inbox-item${props.selected ? " selected" : ""}${props.arrived ? " arrived" : ""}${kind === "blocking" ? " blocking" : ""}`}
      aria-current={props.selected ? "true" : undefined}
    >
      <span className="inbox-item-head">
        <KindLabel kind={kind}>{label}</KindLabel>
        <span className="key">{named.key}</span>
        <RelativeTime at={item.at} />
      </span>
      <span className="inbox-item-title">{named.title}</span>
      <span className="inbox-item-snippet">{snippet}</span>
    </Link>
  );
}

/** The detail pane's head: the item's kind, and its Ticket's key and title, linking to the Ticket, or else its Decision's. */
function DetailHead(props: { item: WaitingItem }) {
  const { item } = props;
  const { kind, full } = kindOf(item);
  const [key, title, to] =
    item.kind === "decision"
      ? [item.decision.key, item.decision.title, `/decisions/${item.decision.key}`]
      : item.kind === "suggestion"
        ? Object.values(suggestedItem(item.suggestion))
        : [item.ticket.key, item.ticket.title, `/tickets/${item.ticket.key}`];
  return (
    <div className="inbox-detail-head">
      <KindLabel kind={kind}>{full}</KindLabel>
      <span className="key">{key}</span>
      <Link to={to!} className="link">{title}</Link>
      {item.kind === "suggestion" && item.suggestion.item.status && <DecisionStatusPill status={item.suggestion.item.status} />}
      {item.kind === "suggestion" && item.suggestion.item.protected && item.suggestion.item.kind !== "guidance" && <ProtectedMark />}
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
        <CronkMarkdown projectKey={props.item.ticket.key.replace(/-[0-9]+$/, "")}>{question.body}</CronkMarkdown>
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

/**
 * An Agent's Unverified completion: the Reports like a review, the Tickets that already continued on it,
 * and Accept, Reopen… and a link to the Ticket.
 */
function UnverifiedDetail(props: DetailProps<UnverifiedItem>) {
  const { ticket, reports } = props.item;
  const [detail] = useLoad(() => api.ticket(ticket.key), [ticket.key]);
  const continued = detail.kind === "loaded" ? detail.value.relations.blocks.filter((t) => CONTINUED.includes(t.status.category)) : [];
  const accept = useAction(() => props.acting(() => api.accept(ticket.key)), props.onDone);
  const [reopening, setReopening] = useState(false);
  const runAccept = () => {
    if (!accept.busy) void accept.run();
  };
  useDetailKeys(props.keys, props.resolved ? {} : { complete: runAccept, sendBack: () => setReopening(true) });

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
        <Button variant="secondary" onClick={() => setReopening(true)} disabled={props.resolved}>Reopen…</Button>
        <Link to={`/tickets/${ticket.key}`} className={buttonClass("ghost")}>Open Ticket</Link>
      </div>
      <ReopenDialog
        ticket={ticket}
        open={reopening}
        onOpenChange={setReopening}
        reopen={(input) => props.acting(() => api.reopen(ticket.key, input))}
        onDone={props.onDone}
      />
    </div>
  );
}

/** Why nobody would act on an unattended Ticket: its Assignee is deactivated, or can't see its Project. */
function unattendedBecause(item: UnattendedItem): string {
  const name = item.ticket.assignee?.name ?? "Its Assignee";
  return item.reason === "deactivated" ? `${name} is deactivated` : `${name} can't see ${item.ticket.projectKey}`;
}

/**
 * A delegated or In Review Ticket whose Assignee is deactivated or can't see its Project: why it is in Triage, its Status, Delegate
 * and Reports, and Reassign to… (primary), which offers the active Users, and a link to the Ticket. Reassigning it to someone who
 * can see the Project takes it out of Triage; one who can't is refused, saying so.
 */
function UnattendedDetail(props: DetailProps<UnattendedItem> & { me: User }) {
  const { ticket, reports } = props.item;
  const [users] = useLoad(api.users, []);
  const reassign = useAction((assigneeId: string) => props.acting(() => api.updateTicket(ticket.key, { assigneeId })), props.onDone);
  const active = users.kind === "loaded" ? users.value.filter((u) => u.active && u.id !== ticket.assignee?.id) : [];
  // The signed-in User first, as the one most likely to take it.
  const candidates = [...active.filter((u) => u.id === props.me.id), ...active.filter((u) => u.id !== props.me.id)];
  useDetailKeys(props.keys, {});

  return (
    <div className="inbox-detail-body">
      <DetailHead item={props.item} />
      {props.resolved && <ResolvedElsewhere />}
      <Banner tone="warn" role="status">
        <p>{`${unattendedBecause(props.item)}, so nobody would act on this Ticket. Reassign it to someone who can.`}</p>
      </Banner>
      <div className="inbox-detail-who">
        <StatusPill status={ticket.status} />
        {ticket.delegate && <span className="muted">delegated to <Actor actor={agentActor(ticket.delegate)} /></span>}
      </div>
      {reports.length > 0 ? (
        <div className="inbox-reports">
          {reports.map((r) => <ReportCard key={r.id} report={r} />)}
        </div>
      ) : (
        <p className="muted">No Report.</p>
      )}
      {reassign.error && <p className="error" role="alert">{reassign.error}</p>}
      <div className="actions">
        <Menu
          label="Reassign to"
          trigger={<Button disabled={props.resolved || reassign.busy}>Reassign to…</Button>}
          items={candidates.map((u) => ({ label: u.id === props.me.id ? `${u.name} (you)` : u.name, onSelect: () => void reassign.run(u.id) }))}
        />
        <Link to={`/tickets/${ticket.key}`} className={buttonClass("ghost")}>Open Ticket</Link>
        {ticket.delegate && <span className="muted small">{`Its Delegate, ${ticket.delegate.name}, stays only if it goes to ${ticket.delegate.name}'s Owner.`}</span>}
      </div>
    </div>
  );
}

/**
 * A Decision an Agent proposed: who proposed it and from which Ticket, its body, and Accept, Reject… with a required
 * reason, which reaches the Agent, and a link to the Decision.
 */
function DecisionDetail(props: DetailProps<DecisionItem>) {
  const { decision, ticket } = props.item;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const accept = useAction(() => props.acting(() => api.setDecisionStatus(decision.key, "accepted")), props.onDone);
  const reject = useAction(() => props.acting(() => api.setDecisionStatus(decision.key, "rejected", reason)), props.onDone);
  const error = accept.error ?? reject.error;
  const runAccept = () => {
    if (!accept.busy) void accept.run();
  };
  const reasonBox = useRef<HTMLTextAreaElement>(null);
  // Opening the Reject box puts the cursor in it, whether from the button or from S.
  useEffect(() => {
    if (rejecting) reasonBox.current?.focus();
  }, [rejecting]);
  useDetailKeys(props.keys, props.resolved ? {} : { complete: runAccept, sendBack: () => (rejecting ? reasonBox.current?.focus() : setRejecting(true)) });

  return (
    <div className="inbox-detail-body">
      <DetailHead item={props.item} />
      {props.resolved && <ResolvedElsewhere />}
      <div className="inbox-detail-who">
        <DecisionStatusPill status={decision.status} />
        <span className="muted">
          by <Actor actor={decision.proposedBy} /> <RelativeTime at={props.item.at} />
          {ticket && (
            <>
              {" from "}
              <Link to={`/tickets/${ticket.key}`} className="link"><span className="mono">{ticket.key}</span> {ticket.title}</Link>
            </>
          )}
        </span>
      </div>
      {decision.supersedes.length > 0 && (
        <Banner tone="info" role="status">
          <p>{`Supersedes ${decision.supersedes.map((s) => `${s.key} ${s.title}`).join(", ")} once accepted`}</p>
        </Banner>
      )}
      <div className="markdown inbox-agent-text">
        <CronkMarkdown>{decision.body}</CronkMarkdown>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {rejecting ? (
        <RejectDecisionForm
          proposedBy={decision.proposedBy}
          reason={reason}
          onReasonChange={setReason}
          onReject={() => void reject.run()}
          onCancel={() => setRejecting(false)}
          busy={reject.busy}
          disabled={props.resolved}
          inputRef={reasonBox}
        />
      ) : (
        <div className="actions">
          <Button onClick={runAccept} disabled={props.resolved || accept.busy}>Accept</Button>
          <Button variant="secondary" onClick={() => setRejecting(true)} disabled={props.resolved}>Reject…</Button>
          <Link to={`/decisions/${decision.key}`} className={buttonClass("ghost")}>Open Decision</Link>
        </div>
      )}
    </div>
  );
}

/**
 * A Suggestion an Agent made: its item, the Agent and its Agent Session, the base Version and the Ticket it came from,
 * then the Agent's reasoning and the Diff, and Accept, Edit and accept… and Reject… with a required reason, which
 * reaches the Agent (docs/ui.md § Inbox and Triage in Phase 2). The note beside the actions says who the new Version
 * will be credited to.
 */
function SuggestionDetail(props: DetailProps<SuggestionItem> & { me: User }) {
  const { suggestion } = props.item;
  const { item, proposedBy } = suggestion;
  const [mode, setMode] = useState<"read" | "edit" | "reject">("read");
  const [edited, setEdited] = useState<SuggestedContent>(suggestion.content);
  const [reason, setReason] = useState("");
  const [view, setView] = useDiffView(props.me.id);
  const accept = useAction(() => props.acting(() => api.acceptSuggestion(suggestion.id, mode === "edit" ? edited : undefined)), props.onDone);
  const reject = useAction(() => props.acting(() => api.rejectSuggestion(suggestion.id, reason)), props.onDone);
  const error = accept.error ?? reject.error;
  const blocked = props.resolved || suggestion.outdated;
  const runAccept = () => {
    if (!accept.busy && !blocked) void accept.run();
  };
  const reasonBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (mode === "reject") reasonBox.current?.focus();
  }, [mode]);
  useDetailKeys(props.keys, props.resolved ? {} : { complete: runAccept, sendBack: () => (mode === "reject" ? reasonBox.current?.focus() : setMode("reject")) });
  const next = item.version + 1;
  const changed = JSON.stringify(edited) !== JSON.stringify(suggestion.content);

  return (
    <div className="inbox-detail-body">
      <DetailHead item={props.item} />
      {props.resolved && <ResolvedElsewhere />}
      <div className="inbox-detail-who">
        <Actor actor={proposedBy} />
        <span className="muted">
          <RelativeTime at={suggestion.at} />
          {isNewDocument(suggestion) ? (
            <>
              {" · new, under "}
              <Link to={`/documents/${suggestion.parent!.id}`} className="link">{suggestion.parent!.title}</Link>
            </>
          ) : (
            ` · from Version ${suggestion.baseVersion}`
          )}
          {suggestion.sourceTicket && (
            <>
              {" · while working on "}
              <Link to={`/tickets/${suggestion.sourceTicket.key}`} className="link mono">{suggestion.sourceTicket.key}</Link>
            </>
          )}
        </span>
      </div>
      {suggestion.outdated && (
        <Banner tone="info" role="status">
          <p>{`Outdated: the item is at Version ${item.version} now, newer than Version ${suggestion.baseVersion} this Suggestion started from. It stays open; accepting it needs a merge with Version ${item.version}.`}</p>
        </Banner>
      )}
      <Reasoning projectKey={item.projectKey}>{suggestion.reasoning}</Reasoning>
      {mode === "edit" ? (
        <ContentEditor kind={item.kind} value={edited} onChange={setEdited} disabled={props.resolved} />
      ) : (
        <Diff
          before={isNewDocument(suggestion) ? "" : contentText(item.kind, suggestion.base)}
          after={contentText(item.kind, suggestion.content)}
          beforeLabel={isNewDocument(suggestion) ? "Nothing yet" : `Version ${suggestion.baseVersion}${suggestion.outdated ? "" : ", current"}`}
          afterLabel={`Suggested by ${proposedBy.name}`}
          view={view}
          onViewChange={setView}
        />
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {mode === "reject" ? (
        <RejectDecisionForm
          proposedBy={proposedBy}
          reason={reason}
          onReasonChange={setReason}
          onReject={() => void reject.run()}
          onCancel={() => setMode("read")}
          busy={reject.busy}
          disabled={props.resolved}
          inputRef={reasonBox}
        />
      ) : mode === "edit" ? (
        <div className="actions suggestion-actions">
          <Button onClick={runAccept} disabled={blocked || accept.busy}>Accept</Button>
          <Button variant="secondary" onClick={() => setMode("read")}>Cancel</Button>
          <span className="muted small">{creditNote(next, proposedBy, changed)}</span>
        </div>
      ) : (
        <div className="actions suggestion-actions">
          <Button onClick={runAccept} disabled={blocked || accept.busy}>Accept</Button>
          <Button variant="secondary" onClick={() => setMode("edit")} disabled={blocked}>Edit and accept…</Button>
          <Button variant="secondary" onClick={() => setMode("reject")} disabled={props.resolved}>Reject…</Button>
          {!suggestion.outdated && <span className="muted small">{creditNote(next, proposedBy, false)}</span>}
        </div>
      )}
    </div>
  );
}

/** "1 Ticket", "2 Tickets". */
const ticketCount = (n: number) => (n === 1 ? "1 Ticket" : `${n} Tickets`);

/** Who found a Discovered Ticket and where, as its list item says it: "By claude-laptop · from CRONK-12". */
function foundBy(item: DiscoveredItem): string {
  const { agent, sourceTicket } = item.ticket.discovered!;
  const pauses = item.blocks.length === 0 ? "" : ` · pauses ${ticketCount(item.blocks.length)}`;
  return `By ${agent.name}${sourceTicket ? ` · from ${sourceTicket.key}` : ""}${pauses}`;
}

/**
 * A Ticket an Agent discovered (docs/ui.md § Inbox and Triage in Phase 2): who found it and while working on which Ticket, its
 * description, and what to do with it. In the Inbox: Delegate to the Agent that found it, when it is one of the User's own, Delegate
 * to… another of their Agents, Keep in Backlog, and Cancel. In Triage, where nobody who can act on it is Assignee: Take it, which assigns it to the
 * User and moves it to their Inbox, and Cancel.
 */
function DiscoveredDetail(props: DetailProps<DiscoveredItem> & { me: User }) {
  const { ticket, blocks } = props.item;
  const { agent, session, sourceTicket } = ticket.discovered!;
  // An Inbox holds only the User's own; Triage, those with no Assignee or one who can't act on them.
  const inTriage = ticket.assignee?.id !== props.me.id;
  const [agents] = useLoad(() => api.agents(), []);
  // Delegating needs one of the Assignee's own Agents, and the Inbox shows the User only their own Tickets.
  const own = agents.kind === "loaded" ? agents.value.filter((a) => a.owner.id === props.me.id) : [];
  const finder = own.find((a) => a.id === agent.id);
  const delegate = useAction((delegateId: string) => props.acting(() => api.updateTicket(ticket.key, { delegateId })), props.onDone);
  const take = useAction(() => props.acting(() => api.updateTicket(ticket.key, { assigneeId: props.me.id })), props.onDone);
  const keep = useAction(() => props.acting(() => api.keepInBacklog(ticket.key)), props.onDone);
  // From the blocked Ticket's side, which needs Write there only; the Inbox's stream then shows the block gone.
  const unblock = useAction((blockedKey: string) => api.removeRelation(blockedKey, "blocked_by", ticket.key), () => {});
  const cancel = useAction(
    () =>
      props.acting(async () => {
        const { statuses } = await api.project(ticket.projectKey);
        const canceled = statuses.find((s) => s.category === "canceled");
        if (!canceled) throw new Error(`${ticket.projectKey} has no Canceled Status`);
        return api.updateTicket(ticket.key, { statusId: canceled.id });
      }),
    props.onDone,
  );
  const busy = delegate.busy || take.busy || keep.busy || cancel.busy || unblock.busy;
  const error = delegate.error ?? take.error ?? keep.error ?? cancel.error ?? unblock.error;
  const primary = inTriage ? () => void take.run() : finder ? () => void delegate.run(finder.id) : undefined;
  useDetailKeys(props.keys, props.resolved || !primary ? {} : { complete: () => !busy && primary() });
  const others = own.filter((a) => a.id !== finder?.id);

  return (
    <div className="inbox-detail-body">
      <DetailHead item={props.item} />
      {props.resolved && <ResolvedElsewhere />}
      <div className="inbox-detail-who">
        <StatusPill status={ticket.status} />
        <span className="muted">
          by <Actor actor={agentActor(agent, session)} /> <RelativeTime at={props.item.at} />
          {sourceTicket && (
            <>
              {" while working on "}
              <Link to={`/tickets/${sourceTicket.key}`} className="link"><span className="mono">{sourceTicket.key}</span> {sourceTicket.title}</Link>
            </>
          )}
        </span>
      </div>
      {blocks.length > 0 && (
        <Banner tone="warn" role="status">
          <p>{`Pauses ${ticketCount(blocks.length)} until it is finished:`}</p>
          <ul className="paused-list" aria-label="Paused Tickets">
            {blocks.map((b) => (
              <li key={b.key}>
                <div className="paused-ticket">
                  <Link to={`/tickets/${b.key}`} className="link"><span className="mono">{b.key}</span> {b.title}</Link>
                  <button type="button" className="link-button" aria-label={`Remove the block on ${b.key}`} disabled={busy} onClick={() => void unblock.run(b.key)}>
                    Remove block
                  </button>
                </div>
                {b.block && <p className="muted small">{b.block.reason}</p>}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {ticket.description.trim() ? (
        <div className="markdown inbox-agent-text">
          <CronkMarkdown projectKey={ticket.projectKey}>{ticket.description}</CronkMarkdown>
        </div>
      ) : (
        <p className="muted">No description.</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        {inTriage ? (
          <Button onClick={() => void take.run()} disabled={props.resolved || busy}>Take it</Button>
        ) : (
          <>
            {finder && <Button onClick={() => void delegate.run(finder.id)} disabled={props.resolved || busy}>{`Delegate to ${finder.name}`}</Button>}
            <Menu
              label="Delegate to"
              trigger={<Button variant="secondary" disabled={props.resolved || busy || others.length === 0}>Delegate to…</Button>}
              items={others.map((a) => ({ label: a.name, onSelect: () => void delegate.run(a.id) }))}
            />
            <Button variant="secondary" onClick={() => void keep.run()} disabled={props.resolved || busy}>Keep in Backlog</Button>
          </>
        )}
        <Button variant="ghost" onClick={() => void cancel.run()} disabled={props.resolved || busy}>Cancel</Button>
      </div>
      <p className="muted small">
        {inTriage
          ? "Take it assigns it to you; it then waits in your Inbox to be delegated."
          : `${agent.name} may edit it until you delegate it, but not work on it.`}
      </p>
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
