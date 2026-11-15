import { Fragment, useRef, useState, type ReactNode, type Ref } from "react";
import { Actor, agentActor, Avatar, type ActorLike } from "./components/actor.js";
import { Button } from "./components/button.js";
import { Chip, KindLabel, PRIORITY_NAMES } from "./components/tags.js";
import { formatDay, RelativeTime, sameDay } from "./components/time.js";
import { api, type Activity, type ActivityKind, type Comment, type NewComment, type RecordedChange, type RelationKind, type Report } from "./api.js";
import { CronkMarkdown } from "./markdown.js";
import { Link } from "./router.js";
import { Show, TextArea, useLoad, useSubmit } from "./ui.js";

/**
 * A Ticket's timeline and a Document's Comments. A Ticket has one chronology (docs/ui.md § Ticket): its
 * Activities (an Agent's own work log), Comments (conversation), Reports and Changes, oldest first, each
 * looking different. Replies sit under what they reply to.
 */

const ACTIVITY_NAMES: Record<ActivityKind, string> = { plan: "Plan", progress: "Progress", finding: "Finding", question: "Question", error: "Error" };

/** What a Ticket's timeline holds: an Activity, a Report, a Comment that replies to nothing, or a Change. */
type Entry =
  | { kind: "activity"; key: string; at: string; activity: Activity }
  | { kind: "report"; key: string; at: string; report: Report }
  | { kind: "comment"; key: string; at: string; comment: Comment; sentBack: boolean }
  | { kind: "change"; key: string; at: string; change: RecordedChange; sentBack: boolean };

/** How close a Send back's Comment is to its move back to a Started Status: both are written in one request. */
const SEND_BACK_WINDOW_MS = 1_000;

/**
 * The Send backs among a Ticket's Changes and Comments. A Send back moves the Ticket from In Review to a
 * Started Status and posts a Comment by the same User in the same request; the API marks neither, so each
 * such move is paired with that User's nearest Comment written within a second of it. Returns the paired
 * Comments' ids and the paired Changes' indexes.
 */
function findSendBacks(changes: RecordedChange[], comments: Comment[]): { comments: Set<string>; changes: Set<number> } {
  const found = { comments: new Set<string>(), changes: new Set<number>() };
  changes.forEach((change, index) => {
    if (change.change !== "status" || change.from.category !== "in_review" || change.to.category !== "started" || change.actor.kind !== "user") return;
    const at = Date.parse(change.at);
    const distance = (c: Comment) => Math.abs(Date.parse(c.at) - at);
    const nearest = comments
      .filter(
        (c) =>
          !found.comments.has(c.id) &&
          !c.replyToCommentId &&
          !c.replyToActivityId &&
          c.actor.kind === "user" &&
          c.actor.id === change.actor.id &&
          distance(c) <= SEND_BACK_WINDOW_MS,
      )
      .sort((a, b) => distance(a) - distance(b))[0];
    if (nearest) {
      found.comments.add(nearest.id);
      found.changes.add(index);
    }
  });
  return found;
}

/**
 * The entries that arrived while the timeline was open, by key, so they get the fading ring. The entries
 * first shown are not new; every later one is, and stays marked, so its ring plays out once.
 */
function useArrivals(keys: string[]): Set<string> {
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
  const sendBacks = findSendBacks(props.changes, props.comments);
  const entries: Entry[] = [
    ...props.activities.map((activity): Entry => ({ kind: "activity", key: `activity-${activity.id}`, at: activity.at, activity })),
    ...props.reports.map((report): Entry => ({ kind: "report", key: `report-${report.id}`, at: report.createdAt, report })),
    ...props.comments
      .filter((c) => !c.replyToCommentId && !c.replyToActivityId)
      .map((comment): Entry => ({ kind: "comment", key: `comment-${comment.id}`, at: comment.at, comment, sentBack: sendBacks.comments.has(comment.id) })),
    // A Ticket's Changes only ever grow, oldest first, so each keeps its index.
    ...props.changes.map((change, i): Entry => ({ kind: "change", key: `change-${i}`, at: change.at, change, sentBack: sendBacks.changes.has(i) })),
    // Stable, so entries at the same instant keep the order they were written or arrived in.
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const arrived = useArrivals(entries.map((e) => e.key));
  const thread: Thread = {
    comments: props.comments,
    canWrite: props.canWrite,
    post: (input) => api.postTicketComment(props.ticketKey, input),
    onPosted: props.onPosted,
  };
  const now = new Date();

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
                <CommentEntry comment={e.comment} sentBack={e.sentBack} className={className} {...thread} />
              ) : (
                <ChangeEntry change={e.change} sentBack={e.sentBack} className={className} />
              )}
            </Fragment>
          );
        })}
      </ol>
      {props.canWrite && (
        <CommentForm
          label="Comment"
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
  const [document] = useLoad(() => api.document(r.id), [r.id, r.version]);
  const actor = agentActor(r.agent, r.session);
  return (
    <TimelineEntry className={`tl-report-entry${props.className}`} gutter={<Avatar actor={actor} />} label={`Report: ${r.title}`}>
      <div className="tl-head">
        <KindLabel kind="report">Report</KindLabel>
        <Actor actor={actor} owner={false} />
        <RelativeTime at={r.createdAt} clock />
      </div>
      <div className="tl-report">
        <div className="tl-report-head">
          <h3 className="tl-report-title">{r.title}</h3>
          <Link to={`/documents/${r.id}`} className="link">Open Report</Link>
        </div>
        <div className="tl-report-body">
          <Show state={document}>{(d) => <CronkMarkdown>{d.body}</CronkMarkdown>}</Show>
        </div>
      </div>
    </TimelineEntry>
  );
}

/** A Comment: its body in a bubble, its replies indented under it inside the bubble, and Reply. */
function CommentEntry(props: { comment: Comment; sentBack: boolean; className: string } & Thread) {
  const c = props.comment;
  const replies = props.comments.filter((r) => r.replyToCommentId === c.id);
  return (
    <TimelineEntry className={`tl-comment-entry${props.className}`} gutter={<Avatar actor={recordedActor(c.actor)} />}>
      <div className="tl-head">
        <KindLabel kind="comment">{props.sentBack ? "Sent back" : "Comment"}</KindLabel>
        <Actor actor={recordedActor(c.actor)} />
        <RelativeTime at={c.at} clock />
      </div>
      <div className="tl-bubble">
        <div className="tl-body">
          <CronkMarkdown>{c.body}</CronkMarkdown>
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
function ChangeEntry(props: { change: RecordedChange; sentBack: boolean; className: string }) {
  const { change } = props;
  return (
    <TimelineEntry className={`tl-change${props.className}`} gutter={<span className="tl-ring" aria-hidden="true" />}>
      <p className="tl-change-line">
        <Actor actor={recordedActor(change.actor)} /> {props.sentBack && change.change === "status" ? <>sent it back: {change.from.name} → {change.to.name}</> : describeChange(change)}{" "}
        <RelativeTime at={change.at} clock />
      </p>
    </TimelineEntry>
  );
}

/** A User or Agent as the API records who acted, made into an Actor. */
const recordedActor = (actor: Comment["actor"]): ActorLike => (actor.kind === "user" ? { kind: "user", name: actor.name } : agentActor(actor, actor.session));

const RELATION_PHRASES: Record<RelationKind, string> = { blocks: "blocking", blocked_by: "blocked by", relates_to: "related to" };

/** What a Change did, as the rest of a sentence after who made it. Users and Agents named in it show as Actors. */
function describeChange(change: RecordedChange): ReactNode {
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

function CommentItem(props: { comment: Comment } & Thread) {
  const c = props.comment;
  const replies = props.comments.filter((r) => r.replyToCommentId === c.id);
  return (
    <li className="comment">
      <div className="comment-head">
        <KindLabel kind="comment">Comment</KindLabel>
        <Actor actor={c.actor} />
        <RelativeTime at={c.at} />
      </div>
      {c.anchor && (
        <blockquote className={`anchor${c.anchor.inCurrentVersion ? "" : " detached"}`}>
          {c.anchor.passage}
          {!c.anchor.inCurrentVersion && <span className="muted"> (no longer in the Document; was in Version {c.anchor.version})</span>}
        </blockquote>
      )}
      <div className="comment-body">
        <CronkMarkdown>{c.body}</CronkMarkdown>
      </div>
      <Replies {...props} replies={replies} replyTo={{ replyToCommentId: c.id }} replyLabel="Reply" />
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

function CommentForm(props: {
  label: string;
  submitLabel: string;
  post: (input: NewComment) => Promise<Comment>;
  onPosted: (comment: Comment) => void;
  onCancel?: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  placeholder?: string;
  /** A line beside the submit button saying where the Comment goes. */
  hint?: string;
}) {
  const [body, setBody] = useState("");
  const send = useSubmit(
    () => props.post({ body }),
    (comment) => {
      setBody("");
      props.onPosted(comment);
    },
  );
  return (
    <form className="comment-form" onSubmit={send.submit}>
      <TextArea inputRef={props.inputRef} label={props.label} value={body} onChange={setBody} rows={3} placeholder={props.placeholder ?? 'Markdown; @name, @owner/name or @"name with spaces" mentions an Agent'} />
      {send.error && <p className="error" role="alert">{send.error}</p>}
      <div className="actions">
        <Button type="submit" disabled={send.busy || !body.trim()}>{props.submitLabel}</Button>
        {props.onCancel && <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>}
        {props.hint && <span className="muted form-hint">{props.hint}</span>}
      </div>
    </form>
  );
}

/**
 * A Document's Comments, oldest first, each reply under the Comment it replies to. A new one may
 * anchor to a passage, typed here or picked by selecting it in the Document. They are loaded again
 * whenever `generation` changes, as when a new one arrives.
 */
export function DocumentComments(props: {
  documentId: string;
  canWrite: boolean;
  generation?: number;
  passage: string;
  onPassageChange: (passage: string) => void;
  commentRef?: Ref<HTMLTextAreaElement>;
}) {
  const [comments, reload] = useLoad(() => api.documentComments(props.documentId), [props.documentId, props.generation]);
  const { passage } = props;
  const post = (input: NewComment) => api.postDocumentComment(props.documentId, { ...input, ...(passage.trim() && { anchor: { passage } }) });
  const posted = () => {
    props.onPassageChange("");
    reload();
  };
  return (
    <Show state={comments}>
      {(all) => (
        <>
          <ol className="timeline" aria-label="Comments">
            {all.length === 0 && <li className="muted">No Comments yet.</li>}
            {all
              .filter((c) => !c.replyToCommentId)
              .map((c) => (
                <CommentItem key={c.id} comment={c} comments={all} canWrite={props.canWrite} post={(input) => api.postDocumentComment(props.documentId, input)} onPosted={reload} />
              ))}
          </ol>
          {props.canWrite && (
            <>
              <TextArea label="About the passage (optional)" value={passage} onChange={props.onPassageChange} rows={2} placeholder="Quote the text exactly" />
              <CommentForm label="Comment" submitLabel="Post Comment" post={post} onPosted={posted} inputRef={props.commentRef} />
            </>
          )}
        </>
      )}
    </Show>
  );
}
