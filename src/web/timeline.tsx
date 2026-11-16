import { Fragment, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode, type Ref, type RefObject } from "react";
import { Actor, agentActor, Avatar, type ActorLike } from "./components/actor.js";
import { Button, buttonClass } from "./components/button.js";
import { Chip, DecisionStatusPill, KindLabel, PRIORITY_NAMES } from "./components/tags.js";
import { formatDay, RelativeTime, sameDay, useNow } from "./components/time.js";
import { api, type Activity, type ActivityKind, type Comment, type NewComment, type RecordedChange, type RelationKind, type Report } from "./api.js";
import { InlineAttachments } from "./attachments.js";
import { CronkMarkdown } from "./markdown.js";
import { Link } from "./router.js";
import { messageOf, Show, TextArea, useLoad, useSubmit } from "./ui.js";

/**
 * A Ticket's timeline and a Document's Comments. A Ticket has one chronology (docs/ui.md § Ticket): its
 * Activities (an Agent's own work log), Comments (conversation), Reports and Changes, oldest first, each
 * looking different. Replies sit under what they reply to.
 */

export const ACTIVITY_NAMES: Record<ActivityKind, string> = { plan: "Plan", progress: "Progress", finding: "Finding", question: "Question", error: "Error" };

/** What a Ticket's timeline holds: an Activity, a Report, a Comment that replies to nothing, or a Change. */
type Entry =
  | { kind: "activity"; key: string; at: string; activity: Activity }
  | { kind: "report"; key: string; at: string; report: Report }
  | { kind: "comment"; key: string; at: string; comment: Comment }
  | { kind: "change"; key: string; at: string; change: RecordedChange };

/**
 * The entries that arrived while the timeline was open, by key, so they get the fading ring. The entries
 * first shown are not new; every later one is, and stays marked, so its ring plays out once.
 */
export function useArrivals(keys: string[]): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const arrived = useRef(new Set<string>());
  if (known.current === null) known.current = new Set(keys);
  for (const key of keys) {
    if (!known.current.has(key)) {
      known.current.add(key);
      arrived.current.add(key);
    }
  }
  return arrived.current;
}

/**
 * A Ticket's one timeline, oldest first, with a separator for each day and clock times, then the Comment box.
 * Questions and Comments offer Reply; an open question shows its answer box. New entries appear in place,
 * with a fading ring, and never scroll the page.
 */
export function TicketTimeline(props: {
  ticketKey: string;
  activities: Activity[];
  reports: Report[];
  comments: Comment[];
  changes: RecordedChange[];
  canWrite: boolean;
  onPosted: (comment: Comment) => void;
}) {
  const entries: Entry[] = [
    ...props.activities.map((activity): Entry => ({ kind: "activity", key: `activity-${activity.id}`, at: activity.at, activity })),
    ...props.reports.map((report): Entry => ({ kind: "report", key: `report-${report.id}`, at: report.createdAt, report })),
    ...props.comments
      .filter((c) => !c.replyToCommentId && !c.replyToActivityId)
      .map((comment): Entry => ({ kind: "comment", key: `comment-${comment.id}`, at: comment.at, comment })),
    // A Ticket's Changes only ever grow, oldest first, so each keeps its index.
    ...props.changes.map((change, i): Entry => ({ kind: "change", key: `change-${i}`, at: change.at, change })),
    // Stable, so entries at the same instant keep the order they were written or arrived in.
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const arrived = useArrivals(entries.map((e) => e.key));
  const thread: Thread = {
    comments: props.comments,
    canWrite: props.canWrite,
    post: (input) => api.postTicketComment(props.ticketKey, input),
    onPosted: props.onPosted,
  };
  const now = useNow();

  return (
    <>
      <ol className="ticket-timeline" aria-label="Timeline">
        {entries.length === 0 && <li className="muted">Nothing yet.</li>}
        {entries.map((e, i) => {
          const at = new Date(e.at);
          const previous = entries[i - 1];
          const newDay = !previous || !sameDay(new Date(previous.at), at);
          const className = arrived.has(e.key) ? " arrived" : "";
          return (
            <Fragment key={e.key}>
              {newDay && (
                <li className="tl-day" role="separator" aria-label={formatDay(at, now)}>
                  <span>{formatDay(at, now)}</span>
                </li>
              )}
              {e.kind === "activity" ? (
                <ActivityEntry activity={e.activity} className={className} {...thread} />
              ) : e.kind === "report" ? (
                <ReportEntry report={e.report} className={className} />
              ) : e.kind === "comment" ? (
                <CommentEntry comment={e.comment} className={className} {...thread} />
              ) : (
                <ChangeEntry change={e.change} className={className} />
              )}
            </Fragment>
          );
        })}
      </ol>
      {props.canWrite && (
        <CommentForm
          label="Comment"
          attachable
          submitLabel="Post Comment"
          placeholder='Comment… @name, @owner/name or @"name with spaces" mentions an Agent'
          post={thread.post}
          onPosted={props.onPosted}
        />
      )}
    </>
  );
}

/** One timeline entry: an avatar (or, for a Change, a small ring) in the gutter, and its content. */
function TimelineEntry(props: { className: string; gutter: ReactNode; label?: string; children: ReactNode }) {
  return (
    <li className={`tl-entry ${props.className}`} aria-label={props.label}>
      <div className="tl-gutter">{props.gutter}</div>
      <div className="tl-content">{props.children}</div>
    </li>
  );
}

/**
 * An Activity: its kind, Agent and Agent Session, time, and body as rendered Markdown. A question's body sits
 * in a tinted box; an open one shows its answer box, an answered one offers Reply. Plan, Progress, Finding and
 * Error offer no Reply, though replies already written still show under them.
 */
function ActivityEntry(props: { activity: Activity; className: string } & Thread) {
  const a = props.activity;
  const isQuestion = a.kind === "question";
  const replies = props.comments.filter((c) => c.replyToActivityId === a.id);
  const actor = agentActor(a.agent, a.session);
  const kind = isQuestion ? `question${a.blocking ? " blocking" : ""}` : a.kind;
  return (
    <TimelineEntry className={`tl-activity ${kind}${props.className}`} gutter={<Avatar actor={actor} />}>
      <div className="tl-head">
        <KindLabel kind={a.blocking ? "blocking" : a.kind}>{a.blocking ? "Blocking question" : ACTIVITY_NAMES[a.kind]}</KindLabel>
        <Actor actor={actor} owner={false} />
        <RelativeTime at={a.at} clock />
        {isQuestion && (a.answer ? <Chip tone="ok">Answered</Chip> : <Chip tone={a.blocking ? "danger" : "warn"}>Waiting for an answer</Chip>)}
      </div>
      <div className={`tl-body${isQuestion ? " tl-question" : a.kind === "error" ? " tl-error" : ""}`}>
        <CronkMarkdown>{a.body}</CronkMarkdown>
      </div>
      {replies.length > 0 && <ReplyList replies={replies} thread={props} />}
      {isQuestion &&
        props.canWrite &&
        (a.answer ? (
          <ReplyButton thread={props} replyTo={{ replyToActivityId: a.id }} />
        ) : (
          <CommentForm
            label="Answer"
            submitLabel="Post answer"
            placeholder={`Answer ${a.agent.name}… (Markdown)`}
            hint={`The answer reaches ${a.agent.name} as Waiting Work.`}
            post={(input) => props.post({ ...input, replyToActivityId: a.id })}
            onPosted={props.onPosted}
          />
        ))}
    </TimelineEntry>
  );
}

/** A Report: a card with its title, an "Open Report" link, and its current Version's body with headings scaled down. */
function ReportEntry(props: { report: Report; className: string }) {
  const r = props.report;
  const actor = agentActor(r.agent, r.session);
  return (
    <TimelineEntry className={`tl-report-entry${props.className}`} gutter={<Avatar actor={actor} />} label={`Report: ${r.title}`}>
      <div className="tl-head">
        <KindLabel kind="report">Report</KindLabel>
        <Actor actor={actor} owner={false} />
        <RelativeTime at={r.createdAt} clock />
      </div>
      <ReportCard report={r} />
    </TimelineEntry>
  );
}

/**
 * A Report as a card: its title, an "Open Report" link, and its current Version's body with headings scaled
 * down, loaded through the same pipeline wherever a Report is read in place (the timeline, the Inbox).
 */
export function ReportCard(props: { report: Report }) {
  const r = props.report;
  const [document] = useLoad(() => api.document(r.id), [r.id, r.version]);
  return (
    <div className="tl-report">
      <div className="tl-report-head">
        <h3 className="tl-report-title">{r.title}</h3>
        <Link to={`/documents/${r.id}`} className="link">Open Report</Link>
      </div>
      <div className="tl-report-body">
        <Show state={document}>{(d) => <CronkMarkdown>{d.body}</CronkMarkdown>}</Show>
        <InlineAttachments documentId={r.id} />
      </div>
      {r.decisions.length > 0 && (
        <div className="tl-report-decisions">
          <h4>Decisions proposed during the work</h4>
          <ul>
            {r.decisions.map((d) => (
              <li key={d.key}>
                <Link to={`/decisions/${d.key}`} className="link"><span className="mono">{d.key}</span> {d.title}</Link> <DecisionStatusPill status={d.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A Comment: its body in a bubble, its replies indented under it inside the bubble, and Reply. */
function CommentEntry(props: { comment: Comment; className: string } & Thread) {
  const c = props.comment;
  const replies = props.comments.filter((r) => r.replyToCommentId === c.id);
  return (
    <TimelineEntry className={`tl-comment-entry${props.className}`} gutter={<Avatar actor={recordedActor(c.actor)} />}>
      <div className="tl-head">
        <KindLabel kind="comment">{c.sendBack ? "Sent back" : "Comment"}</KindLabel>
        <Actor actor={recordedActor(c.actor)} />
        <RelativeTime at={c.at} clock />
      </div>
      <div className="tl-bubble">
        <div className="tl-body">
          <CronkMarkdown>{c.body}</CronkMarkdown>
          <InlineAttachments commentId={c.id} />
        </div>
        {replies.length > 0 && <ReplyList replies={replies} thread={props} />}
      </div>
      {props.canWrite && <ReplyButton thread={props} replyTo={{ replyToCommentId: c.id }} />}
    </TimelineEntry>
  );
}

/** Replies under an Activity or Comment, oldest first, each with any replies of its own. */
function ReplyList(props: { replies: Comment[]; thread: Thread }) {
  return (
    <ol className="tl-replies" aria-label="Replies">
      {props.replies.map((r) => (
        <li key={r.id} className="tl-reply">
          <div className="tl-head">
            <Actor actor={recordedActor(r.actor)} />
            <RelativeTime at={r.at} clock />
          </div>
          <div className="tl-body">
            <CronkMarkdown>{r.body}</CronkMarkdown>
            <InlineAttachments commentId={r.id} />
          </div>
          {props.thread.comments.some((c) => c.replyToCommentId === r.id) && (
            <ReplyList replies={props.thread.comments.filter((c) => c.replyToCommentId === r.id)} thread={props.thread} />
          )}
        </li>
      ))}
    </ol>
  );
}

/** A Reply button that opens a reply box under its Comment or question. */
function ReplyButton(props: { thread: Thread; replyTo: Omit<NewComment, "body"> }) {
  const [replying, setReplying] = useState(false);
  return replying ? (
    <CommentForm
      label="Reply"
      attachable
      submitLabel="Post reply"
      post={(input) => props.thread.post({ ...input, ...props.replyTo })}
      onPosted={(comment) => {
        setReplying(false);
        props.thread.onPosted(comment);
      }}
      onCancel={() => setReplying(false)}
    />
  ) : (
    <Button variant="ghost" className="tl-reply-button" onClick={() => setReplying(true)}>
      Reply
    </Button>
  );
}

/** A Change to the Ticket's fields: a single muted line with a small ring in the gutter. */
function ChangeEntry(props: { change: RecordedChange; className: string }) {
  const { change } = props;
  return (
    <TimelineEntry className={`tl-change${props.className}`} gutter={<span className="tl-ring" aria-hidden="true" />}>
      <p className="tl-change-line">
        {change.actor.kind === "system" ? <span className="actor system">Cronk</span> : <Actor actor={recordedActor(change.actor)} />}{" "}
        {change.change === "status" && change.sentBack ? (
          <>sent it back: {change.from.name} → {change.to.name}</>
        ) : change.change === "status" && change.reopened ? (
          <>reopened it: {change.from.name} → {change.to.name}</>
        ) : (
          describeChange(change)
        )}{" "}
        <RelativeTime at={change.at} clock />
      </p>
    </TimelineEntry>
  );
}

/** A User or Agent as the API records who acted, made into an Actor. */
const recordedActor = (actor: Comment["actor"]): ActorLike => (actor.kind === "user" ? { kind: "user", name: actor.name } : agentActor(actor, actor.session));

const RELATION_PHRASES: Record<RelationKind, string> = { blocks: "blocking", blocked_by: "blocked by", relates_to: "related to" };

/** What a Change did, as the rest of a sentence after who made it. Users and Agents named in it show as Actors. */
export function describeChange(change: RecordedChange): ReactNode {
  switch (change.change) {
    case "created":
      return `created the Ticket in ${change.status.name}`;
    case "title":
      return `renamed it from “${change.from}” to “${change.to}”`;
    case "description":
      return "edited the description";
    case "status":
      return `moved it from ${change.from.name} to ${change.to.name}`;
    case "priority":
      return change.to === "none" ? "cleared the Priority" : `set the Priority to ${PRIORITY_NAMES[change.to]}`;
    case "labels": {
      const added = change.to.filter((l) => !change.from.includes(l));
      const removed = change.from.filter((l) => !change.to.includes(l));
      const parts = [
        ...(added.length ? [`added ${added.length > 1 ? "Labels" : "the Label"} ${added.join(", ")}`] : []),
        ...(removed.length ? [`removed ${removed.length > 1 ? "Labels" : "the Label"} ${removed.join(", ")}`] : []),
      ];
      return parts.length ? parts.join(" and ") : "reordered the Labels";
    }
    case "assignee":
      return change.to ? <>assigned it to <Actor actor={{ kind: "user", name: change.to.name }} /></> : "unassigned it";
    case "delegate":
      return change.to ? (
        <>delegated it to <Actor actor={agentActor(change.to)} /></>
      ) : (
        <>took it back from <Actor actor={agentActor(change.from!)} /></>
      );
    case "parent":
      return change.to ? `made it a Sub-Ticket of ${change.to.key}` : `took it out of ${change.from!.key}`;
    case "relation added":
      return `marked it as ${RELATION_PHRASES[change.kind]} ${change.ticket.key}`;
    case "relation removed":
      return `removed that it is ${RELATION_PHRASES[change.kind]} ${change.ticket.key}`;
    case "document linked":
      return `linked the Document “${change.document.title}”`;
    case "document unlinked":
      return `unlinked the Document “${change.document.title}”`;
    case "autonomous":
      return change.to ? "turned on Autonomous Delegation" : "turned off Autonomous Delegation";
    case "verification":
      if (change.to === "unverified") return "completed it on its own, Unverified until a User Accepts it";
      if (change.to === "verified") return "Accepted the completion";
      return "ended its Verification";
  }
}

/** What an Activity or Comment item needs to show its replies and post new ones. */
interface Thread {
  /** Every Comment on the Ticket or Document, to find the replies among. */
  comments: Comment[];
  canWrite: boolean;
  post: (input: NewComment) => Promise<Comment>;
  onPosted: (comment: Comment) => void;
}

/** How a Comment is shown as a card in a Document's margin: highlighted with its passage, and telling when it is hovered or focused. */
interface Card {
  active: boolean;
  onHover: (on: boolean) => void;
  onFocus: (on: boolean) => void;
}

function CommentItem(props: { comment: Comment; card?: Card } & Thread) {
  const c = props.comment;
  const replies = props.comments.filter((r) => r.replyToCommentId === c.id);
  const card = props.card;
  const detached = c.anchor && !c.anchor.inCurrentVersion;
  return (
    <li
      className={`comment${card ? " margin-card" : ""}${card?.active ? " active" : ""}`}
      {...(card && {
        "data-comment-id": c.id,
        tabIndex: 0,
        onMouseEnter: () => card.onHover(true),
        onMouseLeave: () => card.onHover(false),
        onFocus: () => card.onFocus(true),
        onBlur: (e: FocusEvent<HTMLLIElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget)) card.onFocus(false);
        },
      })}
    >
      {c.anchor && <blockquote className={`passage${detached ? " detached" : ""}`}>{c.anchor.passage}</blockquote>}
      {c.anchor && detached && <p className="detached-note muted">No longer in the Document (was in Version {c.anchor.version})</p>}
      <div className="comment-head">
        <KindLabel kind="comment">Comment</KindLabel>
        <Actor actor={c.actor} />
        <RelativeTime at={c.at} />
      </div>
      <div className="comment-body">
        <CronkMarkdown>{c.body}</CronkMarkdown>
        <InlineAttachments commentId={c.id} />
      </div>
      <Replies comments={props.comments} canWrite={props.canWrite} post={props.post} onPosted={props.onPosted} replies={replies} replyTo={{ replyToCommentId: c.id }} replyLabel="Reply" />
    </li>
  );
}

/** The replies under an Activity or Comment, oldest first, and a button to add one. */
function Replies(props: Thread & { replies: Comment[]; replyTo: Omit<NewComment, "body">; replyLabel: string }) {
  const [replying, setReplying] = useState(false);
  return (
    <>
      {props.replies.length > 0 && (
        <ol className="timeline replies" aria-label="Replies">
          {props.replies.map((r) => (
            <CommentItem key={r.id} {...props} comment={r} />
          ))}
        </ol>
      )}
      {props.canWrite &&
        (replying ? (
          <CommentForm
            label={props.replyLabel}
            attachable
            submitLabel={`Post ${props.replyLabel.toLowerCase()}`}
            post={(input) => props.post({ ...input, ...props.replyTo })}
            onPosted={(comment) => {
              setReplying(false);
              props.onPosted(comment);
            }}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <Button variant="ghost" onClick={() => setReplying(true)}>
            {props.replyLabel}
          </Button>
        ))}
    </>
  );
}

/**
 * A Comment box: a Markdown field, its submit button and an optional hint beside it. `disabled` holds it closed, as for
 * an item resolved elsewhere. With `attachable`, files can be picked to go with the Comment: they are attached to it
 * once it is posted, and show in it where it was posted.
 */
export function CommentForm(props: {
  label: string;
  submitLabel: string;
  post: (input: NewComment) => Promise<Comment>;
  onPosted: (comment: Comment) => void;
  onCancel?: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  placeholder?: string;
  /** A line beside the submit button saying where the Comment goes. */
  hint?: string;
  disabled?: boolean;
  attachable?: boolean;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const send = useSubmit(
    async () => {
      const comment = await props.post({ body });
      const failed: string[] = [];
      for (const file of files) {
        await api.attachToComment(comment.id, file).catch((err: unknown) => failed.push(`${file.name || "The pasted file"}: ${messageOf(err)}`));
      }
      return { comment, failed };
    },
    ({ comment, failed }) => {
      setBody("");
      setFiles([]);
      setRefused(failed);
      props.onPosted(comment);
    },
  );
  return (
    <form className="comment-form" onSubmit={send.submit}>
      <TextArea inputRef={props.inputRef} label={props.label} value={body} onChange={setBody} rows={3} disabled={props.disabled} placeholder={props.placeholder ?? 'Markdown; @name, @owner/name or @"name with spaces" mentions an Agent'} />
      {files.length > 0 && (
        <ul className="comment-files" aria-label="Files to attach">
          {files.map((file, i) => (
            <li key={`${i}-${file.name}`}>
              <span>{file.name || "pasted file"}</span>
              <Button type="button" variant="ghost" onClick={() => setFiles((f) => f.filter((_, j) => j !== i))} aria-label={`Remove ${file.name}`}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      {send.error && <p className="error" role="alert">{send.error}</p>}
      {refused.map((error) => (
        <p key={error} className="error" role="alert">{error}</p>
      ))}
      <div className="actions">
        <Button type="submit" disabled={props.disabled || send.busy || !body.trim()}>{props.submitLabel}</Button>
        {props.attachable && (
          <label className={buttonClass("ghost")} aria-disabled={props.disabled || send.busy}>
            Attach files…
            <input
              type="file"
              multiple
              hidden
              aria-label={`Attach files to the ${props.label.toLowerCase()}`}
              disabled={props.disabled || send.busy}
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                e.target.value = "";
                setFiles((f) => [...f, ...picked]);
              }}
            />
          </label>
        )}
        {props.onCancel && <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>}
        {props.hint && <span className="muted form-hint">{props.hint}</span>}
      </div>
    </form>
  );
}

/**
 * Moves each card in `margin` down to the passage it is about in `body`, but never up into the card
 * above it. Only while the margin sits beside the body: on narrow screens it sits under it, and cards stay in flow.
 */
function alignCards(margin: HTMLElement, body: HTMLElement) {
  const cards = [...margin.querySelectorAll<HTMLElement>(".margin-card")];
  for (const card of cards) card.style.marginTop = "";
  if (margin.getBoundingClientRect().left < body.getBoundingClientRect().right) return;
  for (const card of cards) {
    const id = card.dataset.commentId;
    const passage = id && body.querySelector(`mark[data-highlights~="${CSS.escape(id)}"]`);
    if (!passage) continue;
    const below = passage.getBoundingClientRect().top - card.getBoundingClientRect().top;
    if (below > 0) card.style.marginTop = `${below}px`;
  }
}

/**
 * A Document's Comments as cards down its margin. Those whose passage is highlighted in the body
 * (`placed`, in the order they appear there) come first, each aligned with its passage; then the
 * rest, oldest first: Comments on the whole Document, passages the page can't place, and passages
 * no longer in the Document. "Comment on the whole Document" ends the margin. Hovering or focusing
 * a card is reported through `onHover` and `onFocus`; `active` names the Comments to highlight.
 */
export function DocumentMargin(props: {
  documentId: string;
  comments: Comment[];
  placed: string[];
  bodyRef: RefObject<HTMLElement | null>;
  active: string[];
  onHover: (id: string | undefined) => void;
  onFocus: (id: string | undefined) => void;
  canWrite: boolean;
  onPosted: () => void;
}) {
  const marginAt = useRef<HTMLDivElement>(null);
  const [writing, setWriting] = useState(false);
  const all = props.comments;
  const threads = all.filter((c) => !c.replyToCommentId);
  const byId = new Map(threads.map((c) => [c.id, c]));
  const ordered = [...props.placed.flatMap((id) => byId.get(id) ?? []), ...threads.filter((c) => !props.placed.includes(c.id))];
  const post = (input: NewComment) => api.postDocumentComment(props.documentId, input);

  useLayoutEffect(() => {
    const margin = marginAt.current;
    const body = props.bodyRef.current;
    if (!margin || !body) return;
    const align = () => alignCards(margin, body);
    align();
    const resized = new ResizeObserver(align);
    resized.observe(body);
    margin.querySelectorAll(".margin-card").forEach((card) => resized.observe(card));
    void document.fonts?.ready.then(align);
    return () => {
      resized.disconnect();
    };
  });

  let cards: ReactNode;
  if (threads.length === 0) cards = <li className="muted">No Comments yet.</li>;
  else
    cards = ordered.map((c) => (
      <CommentItem
        key={c.id}
        comment={c}
        comments={all}
        canWrite={props.canWrite}
        post={post}
        onPosted={props.onPosted}
        card={{
          active: props.active.includes(c.id),
          onHover: (on) => props.onHover(on ? c.id : undefined),
          onFocus: (on) => props.onFocus(on ? c.id : undefined),
        }}
      />
    ));
  return (
    <aside className="comment-margin" ref={marginAt} aria-label="Comments on this Document">
      <ol className="timeline margin-cards" aria-label="Comments">{cards}</ol>
      {props.canWrite &&
        (writing ? (
          <div className="margin-form">
            <CommentForm
              label="Comment on the whole Document"
              attachable
              submitLabel="Post Comment"
              post={post}
              onPosted={() => {
                setWriting(false);
                props.onPosted();
              }}
              onCancel={() => setWriting(false)}
            />
          </div>
        ) : (
          <Button variant="secondary" className="whole-document" onClick={() => setWriting(true)}>Comment on the whole Document</Button>
        ))}
    </aside>
  );
}

/**
 * The form for a Comment on a passage selected in a Document: the passage, which the User may
 * correct, and the Comment. Shown in the popover "Comment on this passage" opens.
 */
export function PassageCommentForm(props: {
  documentId: string;
  passage: string;
  onPassageChange: (passage: string) => void;
  onPosted: () => void;
  commentRef?: Ref<HTMLTextAreaElement>;
}) {
  const post = (input: NewComment) =>
    api.postDocumentComment(props.documentId, { ...input, ...(props.passage.trim() && { anchor: { passage: props.passage } }) });
  return (
    <div className="passage-comment">
      <TextArea label="About the passage (optional)" value={props.passage} onChange={props.onPassageChange} rows={2} placeholder="Quote the text exactly" />
      <CommentForm label="Comment" submitLabel="Post Comment" post={post} onPosted={props.onPosted} inputRef={props.commentRef} attachable />
    </div>
  );
}
