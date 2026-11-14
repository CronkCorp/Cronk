import { useEffect, useState } from "react";
import { api, sessionName, watchTicket, type Activity, type ActivityKind, type Comment, type NewComment, type Report } from "./api.js";
import { CronkMarkdown } from "./markdown.js";
import { Link } from "./router.js";
import { Show, TextArea, useLoad, useSubmit } from "./ui.js";

/**
 * A Ticket's timeline and a Document's Comments. Activities (an Agent's own work log), Reports
 * and Comments (conversation) show together but look different; replies sit under what they reply to.
 */

const ACTIVITY_NAMES: Record<ActivityKind, string> = { plan: "Plan", progress: "Progress", finding: "Finding", question: "Question", error: "Error" };

/** What a timeline entry is: an Activity, a Report, or a Comment that replies to neither a Comment nor an Activity. */
type Entry = { kind: "activity"; activity: Activity } | { kind: "report"; report: Report } | { kind: "comment"; comment: Comment };

const entryAt = (e: Entry) => (e.kind === "activity" ? e.activity.at : e.kind === "report" ? e.report.createdAt : e.comment.at);

/** Keeps the last of each id, in the order each id first appeared. */
function latestById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()];
}

/**
 * The Activities and Reports Agent Sessions wrote on a Ticket and its Comments, oldest first, kept up to
 * date as new ones arrive. Replies show under what they reply to; a reply to a question answers it.
 */
export function TicketTimeline(props: { ticketKey: string; canWrite: boolean }) {
  const [loaded, reload] = useLoad(
    async () => {
      const [activities, reports, comments] = await Promise.all([
        api.activities(props.ticketKey),
        api.ticketReports(props.ticketKey),
        api.ticketComments(props.ticketKey),
      ]);
      return { activities, reports, comments };
    },
    [props.ticketKey],
  );
  // Activities and Comments pushed while this page is open; the lists, loaded at any point, may or may not hold them yet.
  const [arrivedActivities, setArrivedActivities] = useState<Activity[]>([]);
  const [arrivedReports, setArrivedReports] = useState<Report[]>([]);
  const [arrivedComments, setArrivedComments] = useState<Comment[]>([]);
  useEffect(() => {
    setArrivedActivities([]);
    setArrivedReports([]);
    setArrivedComments([]);
    return watchTicket(props.ticketKey, {
      // Load the lists again once watching, and on every reconnect, so nothing posted before the stream was
      // (back) in place is missed. Arrivals are kept meanwhile, so nothing shown disappears while it loads.
      ready: reload,
      on: {
        activity: ({ activity }) => setArrivedActivities((list) => [...list, activity]),
        report: ({ report }) => setArrivedReports((list) => [...list, report]),
        comment: ({ comment }) => setArrivedComments((list) => [...list, comment]),
      },
    });
  }, [props.ticketKey]);
  const post = (input: NewComment) => api.postTicketComment(props.ticketKey, input);

  return (
    <Show state={loaded}>
      {(lists) => {
        // A pushed Activity replaces the loaded one: it is newer, as when a question gets answered.
        const activities = latestById([...lists.activities, ...arrivedActivities]);
        const reports = latestById([...lists.reports, ...arrivedReports]);
        const comments = latestById([...lists.comments, ...arrivedComments]);
        const entries: Entry[] = [
          ...activities.map((activity): Entry => ({ kind: "activity", activity })),
          ...reports.map((report): Entry => ({ kind: "report", report })),
          ...comments.filter((c) => !c.replyToCommentId && !c.replyToActivityId).map((comment): Entry => ({ kind: "comment", comment })),
          // Stable, so entries at the same instant keep the order they were written or arrived in.
        ].sort((a, b) => Date.parse(entryAt(a)) - Date.parse(entryAt(b)));
        const posted = (comment: Comment) => setArrivedComments((list) => [...list, comment]);
        return (
          <>
            <ol className="timeline" aria-label="Timeline">
              {entries.length === 0 && <li className="muted">Nothing yet.</li>}
              {entries.map((e) =>
                e.kind === "activity" ? (
                  <ActivityItem key={e.activity.id} activity={e.activity} comments={comments} canWrite={props.canWrite} post={post} onPosted={posted} />
                ) : e.kind === "report" ? (
                  <ReportItem key={e.report.id} report={e.report} />
                ) : (
                  <CommentItem key={e.comment.id} comment={e.comment} comments={comments} canWrite={props.canWrite} post={post} onPosted={posted} />
                ),
              )}
            </ol>
            {props.canWrite && <CommentForm label="Comment" submitLabel="Post Comment" post={post} onPosted={posted} />}
          </>
        );
      }}
    </Show>
  );
}

/** What an Activity or Comment item needs to show its replies and post new ones. */
interface Thread {
  /** Every Comment on the Ticket or Document, to find the replies among. */
  comments: Comment[];
  canWrite: boolean;
  post: (input: NewComment) => Promise<Comment>;
  onPosted: (comment: Comment) => void;
}

function ActivityItem(props: { activity: Activity } & Thread) {
  const a = props.activity;
  const isQuestion = a.kind === "question";
  const replies = props.comments.filter((c) => c.replyToActivityId === a.id);
  return (
    <li className={`activity ${a.kind}${a.blocking ? " blocking" : ""}${a.answer ? " answered" : ""}`}>
      <div className="activity-head">
        <span className="activity-kind">{a.blocking ? "Blocking question" : ACTIVITY_NAMES[a.kind]}</span>
        <strong>{a.agent.name}</strong>
        <span className="muted">({sessionName(a.session.id)}, for {a.agent.owner.name})</span>
        <span className="muted">{new Date(a.at).toLocaleString()}</span>
        {isQuestion && (a.answer ? <span className="badge answered">Answered</span> : <span className="badge">Waiting for an answer</span>)}
      </div>
      <div className="activity-body">
        <CronkMarkdown>{a.body}</CronkMarkdown>
      </div>
      <Replies {...props} replies={replies} replyTo={{ replyToActivityId: a.id }} replyLabel={isQuestion && !a.answer ? "Answer" : "Reply"} />
    </li>
  );
}

/** A Report in a Ticket's timeline, showing its current Version. */
function ReportItem(props: { report: Report }) {
  const r = props.report;
  const [document] = useLoad(() => api.document(r.id), [r.id, r.version]);
  return (
    <li className="activity report" aria-label={`Report: ${r.title}`}>
      <div className="activity-head">
        <span className="activity-kind">Report</span>
        <strong>{r.agent.name}</strong>
        <span className="muted">({sessionName(r.session.id)}, for {r.agent.owner.name})</span>
        <span className="muted">{new Date(r.createdAt).toLocaleString()}</span>
      </div>
      <h3 className="report-title">
        <Link to={`/documents/${r.id}`} className="link">{r.title}</Link>
      </h3>
      <div className="activity-body">
        <Show state={document}>{(d) => <CronkMarkdown>{d.body}</CronkMarkdown>}</Show>
      </div>
    </li>
  );
}

function CommentItem(props: { comment: Comment } & Thread) {
  const c = props.comment;
  const replies = props.comments.filter((r) => r.replyToCommentId === c.id);
  return (
    <li className="comment">
      <div className="comment-head">
        <span className="comment-kind">Comment</span>
        <strong>{c.actor.name}</strong>
        {c.actor.kind === "agent" && (
          <span className="muted">
            ({c.actor.session ? `${sessionName(c.actor.session.id)}, for` : "Agent of"} {c.actor.owner.name})
          </span>
        )}
        <span className="muted">{new Date(c.at).toLocaleString()}</span>
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
          <button className="link" onClick={() => setReplying(true)}>
            {props.replyLabel}
          </button>
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
      <TextArea label={props.label} value={body} onChange={setBody} rows={3} placeholder="Markdown; @name mentions an Agent" />
      {send.error && <p className="error" role="alert">{send.error}</p>}
      <div className="actions">
        <button type="submit" disabled={send.busy || !body.trim()}>{props.submitLabel}</button>
        {props.onCancel && <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** A Document's Comments, oldest first, each reply under the Comment it replies to; a new one may anchor to a passage. */
export function DocumentComments(props: { documentId: string; canWrite: boolean }) {
  const [comments, reload] = useLoad(() => api.documentComments(props.documentId), [props.documentId]);
  const [passage, setPassage] = useState("");
  const post = (input: NewComment) => api.postDocumentComment(props.documentId, { ...input, ...(passage.trim() && { anchor: { passage } }) });
  const posted = () => {
    setPassage("");
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
              <TextArea label="About the passage (optional)" value={passage} onChange={setPassage} rows={2} placeholder="Quote the text exactly" />
              <CommentForm label="Comment" submitLabel="Post Comment" post={post} onPosted={posted} />
            </>
          )}
        </>
      )}
    </Show>
  );
}
