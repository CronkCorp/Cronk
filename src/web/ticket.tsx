import { useEffect, useRef, useState, type ReactNode } from "react";
import { Actor, agentActor, SessionName, userActor } from "./components/actor.js";
import { Button } from "./components/button.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { FieldPicker, type PickerOption } from "./components/picker.js";
import { Chip, PRIORITY_NAMES, PriorityTag, ProtectedMark, StatusPill } from "./components/tags.js";
import { ReopenDialog } from "./components/reopen-dialog.js";
import { RelativeTime, useNow } from "./components/time.js";
import {
  api,
  watchTicket,
  type Activity,
  type Comment,
  type Priority,
  type RelationKind,
  type Report,
  type SearchResult,
  type Ticket,
  type TicketChanges,
  type TicketDetail,
  type BlockingRef,
  type HiddenBlocker,
  type TicketRef,
} from "./api.js";
import { PRIORITIES } from "../shared/values.js";
import { CronkMarkdown, MarkdownPlace } from "./markdown.js";
import { MentionList } from "./mentions.js";
import { FromTranscripts } from "./transcripts.js";
import { Link } from "./router.js";
import { TicketTimeline } from "./timeline.js";
import { AttachmentThumbnails, AttachmentViewer, FilesPanel, PageAttachments, type AttachmentsView, useAttach, usePageDrop } from "./attachments.js";
import type { Attachment } from "./api.js";
import { both, Field, Show, TextArea, useAction, useLoad, useSubmit } from "./ui.js";

/**
 * A Ticket's page (docs/ui.md § Ticket): its title and description, one timeline and the Comment box in
 * the main column, and a side panel with its fields, its Claim and the Tickets and Documents around it.
 *
 * Everything on it follows the Ticket's stream. New Activities, Comments and Reports join the timeline in
 * place; a `changed` event, whoever made the change, loads the Ticket and its Changes again, so the side
 * panel, the Claim card and the change lines follow. The User's own edits come back the same way.
 */
export function TicketPage(props: { ticketKey: string }) {
  const key = props.ticketKey;
  const [detail, reloadDetail] = useLoad(() => api.ticket(key), [key]);
  const [changes, reloadChanges] = useLoad(() => api.ticketChanges(key), [key]);
  const [attachments, reloadAttachments] = useLoad(() => api.attachments(key), [key]);
  const [loaded, reloadLists] = useLoad(
    async () => {
      const [activities, reports, comments] = await Promise.all([api.activities(key), api.ticketReports(key), api.ticketComments(key)]);
      return { activities, reports, comments };
    },
    [key],
  );
  // Entries pushed while the page is open. The lists, loaded at any point, may or may not hold them yet.
  const [arrived, setArrived] = useState<Entries>(NO_ENTRIES);
  const [live, onLive] = useLiveState();
  useEffect(() => {
    setArrived(NO_ENTRIES);
    return watchTicket(key, {
      onLive,
      // Load everything again once watching, and on every reconnect, so nothing that happened before the stream
      // was (back) in place is missed. What is shown stays meanwhile, so nothing flashes empty.
      ready: () => {
        reloadDetail();
        reloadChanges();
        reloadLists();
        reloadAttachments();
      },
      on: {
        changed: () => {
          reloadDetail();
          reloadChanges();
          reloadAttachments();
        },
        activity: ({ activity }) => setArrived((a) => ({ ...a, activities: [...a.activities, activity] })),
        report: ({ report }) => setArrived((a) => ({ ...a, reports: [...a.reports, report] })),
        comment: ({ comment }) => setArrived((a) => ({ ...a, comments: [...a.comments, comment] })),
      },
    });
  }, [key]);

  const entries = both(loaded, changes);
  return (
    <Show state={detail}>
      {(d) => (
        <TicketView
          detail={d}
          attachments={attachments.kind === "loaded" ? attachments.value : []}
          onAttached={reloadAttachments}
          live={<LiveIndicator state={live} />}
          // An Agent Session's calls keep its Claim but aren't pushed, so the page reads the Claim again when it would lapse.
          onClaimDue={reloadDetail}
          timeline={(canWrite) => (
            <Show state={entries}>
              {([lists, recorded]) => (
                <TicketTimeline
                  activities={latestById([...lists.activities, ...arrived.activities], answeredLater)}
                  reports={latestById([...lists.reports, ...arrived.reports], laterVersion)}
                  comments={latestById([...lists.comments, ...arrived.comments], never)}
                  changes={recorded}
                  canWrite={canWrite}
                  ticketKey={key}
                  onPosted={(comment) => setArrived((a) => ({ ...a, comments: [...a.comments, comment] }))}
                />
              )}
            </Show>
          )}
        />
      )}
    </Show>
  );
}

interface Entries {
  activities: Activity[];
  reports: Report[];
  comments: Comment[];
}
const NO_ENTRIES: Entries = { activities: [], reports: [], comments: [] };

/**
 * One of each id, in the order each id first appeared, keeping the newer copy where a list loaded and a push
 * disagree. Which copy is newer is read from the item itself, never from where it came from: a list loaded
 * after a reconnect can be newer than a copy pushed before it.
 */
function latestById<T extends { id: string }>(items: T[], newer: (a: T, b: T) => boolean): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const kept = byId.get(item.id);
    if (!kept || newer(item, kept)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/** An Activity only ever changes by getting answered. */
const answeredLater = (a: Activity, b: Activity) => a.answer !== null && b.answer === null;
/** A Report changes by getting a new Version. */
const laterVersion = (a: Report, b: Report) => a.version > b.version;
/** A Comment never changes once posted. */
const never = () => false;

function TicketView(props: {
  detail: TicketDetail;
  attachments: Attachment[];
  onAttached: () => void;
  live: ReactNode;
  timeline: (canWrite: boolean) => ReactNode;
  onClaimDue: () => void;
}) {
  const t = props.detail.ticket;
  const [project] = useLoad(() => api.project(t.projectKey), [t.projectKey]);
  const [workspace] = useLoad(api.workspace, []);
  const [editing, setEditing] = useState(false);
  const [opened, setOpened] = useState<Attachment>();
  const archived = project.kind === "loaded" && project.value.project.archived;
  const canWrite = project.kind === "loaded" && project.value.project.access === "write";
  const attaching = useAttach((file) => api.attach(t.key, file), props.onAttached);
  const dragging = usePageDrop(canWrite, (files) => void attaching.attach(files));
  const files: AttachmentsView = {
    attachments: props.attachments,
    canWrite,
    attaching,
    maxBytes: workspace.kind === "loaded" ? workspace.value.attachmentMaxBytes : undefined,
    dragging,
    onOpen: setOpened,
  };

  return (
    <MarkdownPlace.Provider value={t.projectKey}>
    <article className="ticket">
      <div className="muted crumbs">
        <Link to={archived ? "/archived" : "/"} className="link">Projects</Link> /{" "}
        <Link to={`/projects/${t.projectKey}`} className="link">{t.projectKey}</Link> / {t.key}
      </div>
      {!editing && (
        <div className="page-head">
          <h1 className="ticket-title">{t.title}</h1>
          <div className="actions">
            {props.live}
            {canWrite && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
          </div>
        </div>
      )}
      <div className="ticket-layout">
        <div className="ticket-main">
          {editing ? (
            <EditTicket ticket={t} onCancel={() => setEditing(false)} onDone={() => setEditing(false)} />
          ) : (
            <div className="markdown" data-testid="ticket-description">
              {t.description.trim() ? <CronkMarkdown>{t.description}</CronkMarkdown> : <p className="muted">No description.</p>}
            </div>
          )}
          <AttachmentThumbnails {...files} attachments={props.attachments.filter((a) => a.on === "ticket")} />
          <h2>Timeline</h2>
          <PageAttachments.Provider value={{ attachments: props.attachments, onOpen: setOpened }}>{props.timeline(canWrite)}</PageAttachments.Provider>
        </div>
        <aside className="ticket-side" aria-label="Ticket fields">
          <TicketFields ticket={t} canWrite={canWrite} statuses={project.kind === "loaded" ? project.value.statuses : [t.status]} />
          {props.detail.claim && <ClaimCard claim={props.detail.claim} onDue={props.onClaimDue} />}
          <FilesPanel {...files} />
          <section className="side-panel side-related">
            <ParentEditor ticket={t} readOnly={!canWrite} />
            {props.detail.subTickets.length > 0 && (
              <div className="side-group">
                <h3>Sub-Tickets</h3>
                <TicketRefList name="Sub-Tickets" refs={props.detail.subTickets} />
              </div>
            )}
            <RelationsEditor detail={props.detail} readOnly={!canWrite} />
            <TicketDocuments detail={props.detail} readOnly={!canWrite} />
            <div className="side-group">
              <h3>Mentioned in</h3>
              <MentionList mentions={props.detail.mentions} what="its key" />
            </div>
            <FromTranscripts links={props.detail.transcripts} heading="h3" />
          </section>
        </aside>
      </div>
      <AttachmentViewer
        attachment={opened}
        canWrite={canWrite}
        onClose={() => setOpened(undefined)}
        onDeleted={() => {
          setOpened(undefined);
          props.onAttached();
        }}
      />
    </article>
    </MarkdownPlace.Provider>
  );
}

/**
 * Status, Priority, Assignee, Delegate, Autonomous Delegation and Labels, each edited in place, and an Agent's completion's
 * Verification when it has one. A change shows once the Ticket's stream tells of it.
 */
function TicketFields(props: { ticket: Ticket; canWrite: boolean; statuses: Ticket["status"][] }) {
  const t = props.ticket;
  const update = useAction((changes: TicketChanges) => api.updateTicket(t.key, changes), () => {});
  const [users] = useLoad(api.users, []);
  const [agents] = useLoad(() => api.agents(), []);
  const [projectLabels] = useLoad(() => api.labels(t.projectKey), [t.projectKey, t.labels.join("\n")]);
  const disabled = update.busy || !props.canWrite;
  // The Labels as last asked for, so picking several in a row before the Ticket comes back keeps each one.
  const asked = useRef(t.labels);
  useEffect(() => {
    asked.current = t.labels;
  }, [t.labels.join("\n")]);

  // Show the current Assignee and Delegate even before the lists arrive, or when the lists leave them out.
  const known = users.kind === "loaded" ? users.value.filter((u) => u.active) : [];
  const assignees = [...(t.assignee && !known.some((u) => u.id === t.assignee!.id) ? [t.assignee] : []), ...known];
  // Only the signed-in User's own Agents are listed to them, so this offers Agents only on their own Tickets,
  // and on unassigned ones, which delegating assigns to them.
  const own = agents.kind === "loaded" ? agents.value.filter((a) => !t.assignee || a.owner.id === t.assignee.id) : [];
  const delegates = [...(t.delegate && !own.some((a) => a.id === t.delegate!.id) ? [t.delegate] : []), ...own];
  const labels = [...new Set([...t.labels, ...(projectLabels.kind === "loaded" ? projectLabels.value : [])])].sort((a, b) => a.localeCompare(b));

  const none = (text: string) => <span className="muted">{text}</span>;
  const statusOptions: PickerOption[] = props.statuses.map((s) => ({ value: s.id, label: s.name, content: <StatusPill status={s} /> }));
  const priorityOptions: PickerOption[] = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_NAMES[p], content: p === "none" ? none(PRIORITY_NAMES[p]) : <PriorityTag priority={p} /> }));
  const assigneeOptions: PickerOption[] = [
    { value: "", label: "Unassigned", content: none("Unassigned") },
    ...assignees.map((u) => ({ value: u.id, label: u.name, content: <Actor actor={userActor(u.name)} /> })),
  ];
  const autonomyOptions: PickerOption[] = [
    { value: "off", label: "Stops at In Review", content: none("Stops at In Review") },
    { value: "on", label: "Autonomous", content: <Chip>Autonomous</Chip> },
  ];
  const delegateOptions: PickerOption[] = [
    { value: "", label: "Not delegated", content: none("Not delegated") },
    ...delegates.map((a) => ({ value: a.id, label: a.name, content: <Actor actor={agentActor(a)} owner={false} /> })),
  ];

  return (
    <section className="side-panel side-fields" aria-label="Fields">
      <FieldPicker
        label="Status"
        value={<StatusPill status={t.status} />}
        options={statusOptions}
        selected={[t.status.id]}
        disabled={disabled}
        onPick={(statusId) => statusId !== t.status.id && void update.run({ statusId })}
      />
      <FieldPicker
        label="Priority"
        value={t.priority === "none" ? none(PRIORITY_NAMES.none) : <PriorityTag priority={t.priority} />}
        options={priorityOptions}
        selected={[t.priority]}
        disabled={disabled}
        onPick={(priority) => priority !== t.priority && void update.run({ priority: priority as Priority })}
      />
      <FieldPicker
        label="Assignee"
        value={t.assignee ? <Actor actor={userActor(t.assignee.name)} /> : none("Unassigned")}
        options={assigneeOptions}
        selected={[t.assignee?.id ?? ""]}
        disabled={disabled}
        onPick={(id) => id !== (t.assignee?.id ?? "") && void update.run({ assigneeId: id || null })}
      />
      <FieldPicker
        label="Delegate"
        value={t.delegate ? <Actor actor={agentActor(t.delegate)} owner={false} /> : none("Not delegated")}
        options={delegateOptions}
        selected={[t.delegate?.id ?? ""]}
        disabled={disabled}
        empty={t.assignee ? "None of the Assignee's Agents match" : "None of your Agents match"}
        onPick={(id) => id !== (t.delegate?.id ?? "") && void update.run({ delegateId: id || null })}
      />
      {/* Always shown, so the User knows what the Delegate may do; delegating pre-fills it from the Project's default. */}
      <FieldPicker
        label="Autonomy"
        value={t.autonomous ? <Chip>Autonomous</Chip> : none("Stops at In Review")}
        options={autonomyOptions}
        selected={[t.autonomous ? "on" : "off"]}
        disabled={disabled}
        onPick={(value) => (value === "on") !== t.autonomous && void update.run({ autonomous: value === "on" })}
      />
      {t.verification && <VerificationField ticket={t} canWrite={props.canWrite} />}
      {t.discovered && <DiscoveredField ticket={t} />}
      <FieldPicker
        label="Labels"
        multiple
        value={
          t.labels.length > 0 ? (
            <span className="chips">
              {t.labels.map((label) => (
                <Chip key={label}>{label}</Chip>
              ))}
            </span>
          ) : (
            none("None")
          )
        }
        options={labels.map((label) => ({ value: label, label }))}
        selected={t.labels}
        disabled={disabled}
        allowNew
        placeholder="Filter or add a Label"
        onPick={(label) => {
          const now = asked.current;
          asked.current = now.includes(label) ? now.filter((l) => l !== label) : [...now, label];
          void update.run({ labels: asked.current });
        }}
      />
      {update.error && <p className="error" role="alert">{update.error}</p>}
    </section>
  );
}

/** A Discovered Ticket's marker: the Agent that filed it, the Ticket it was working on, and whether a User kept it in Backlog. */
function DiscoveredField(props: { ticket: Ticket }) {
  const { agent, sourceTicket, kept } = props.ticket.discovered!;
  return (
    <div className="side-field">
      <span className="side-field-label">Discovered</span>
      <span>
        by <Actor actor={agentActor(agent)} owner={false} />
        {sourceTicket && (
          <>
            {" from "}
            <Link to={`/tickets/${sourceTicket.key}`} className="link mono">{sourceTicket.key}</Link>
          </>
        )}
      </span>
      {kept && <Chip>Kept</Chip>}
    </div>
  );
}

/** An Agent's completion's Verification: Unverified, with Accept and Reopen…, until a User Accepts or Reopens it, then Verified. */
function VerificationField(props: { ticket: Ticket; canWrite: boolean }) {
  const accept = useAction(() => api.accept(props.ticket.key), () => {});
  const [reopening, setReopening] = useState(false);
  const unverified = props.ticket.verification === "unverified";
  return (
    <div className="side-field">
      <span className="side-field-label">Verification</span>
      <Chip tone={unverified ? "warn" : "ok"}>{unverified ? "Unverified" : "Verified"}</Chip>
      {unverified && props.canWrite && (
        <>
          <Button variant="secondary" onClick={() => void accept.run()} disabled={accept.busy}>Accept</Button>
          <Button variant="secondary" onClick={() => setReopening(true)} disabled={accept.busy}>Reopen…</Button>
          <ReopenDialog
            ticket={props.ticket}
            open={reopening}
            onOpenChange={setReopening}
            reopen={(input) => api.reopen(props.ticket.key, input)}
            onDone={() => {}}
          />
        </>
      )}
      {accept.error && <p className="error" role="alert">{accept.error}</p>}
    </div>
  );
}

const SECOND = 1000;

/** "3 min 36 s", "45 s": how long until a moment, to the second. */
function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / SECOND));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

/**
 * The Ticket's Claim: the Agent and its Agent Session, since when, and a meter counting down until the Claim
 * lapses if the Agent Session stays silent. The meter spans the silence threshold, from when the Agent Session
 * was last heard from to the lapse time. When the time is up, `onDue` reads the Claim again: the Agent Session
 * may have called in meanwhile, which moves the lapse time without anything being pushed.
 */
function ClaimCard(props: { claim: NonNullable<TicketDetail["claim"]>; onDue: () => void }) {
  const { claim } = props;
  const now = useNow(SECOND).getTime();
  const endsAt = Date.parse(claim.endsIfSilentAt);
  const lastSeenAt = Date.parse(claim.lastSeenAt);
  const onDue = useRef(props.onDue);
  onDue.current = props.onDue;
  useEffect(() => {
    const timer = setTimeout(() => onDue.current(), Math.max(endsAt - Date.now(), 0) + SECOND);
    return () => clearTimeout(timer);
  }, [endsAt]);
  const span = Math.max(endsAt - lastSeenAt, 1);
  const left = Math.max(endsAt - now, 0);
  const share = Math.min(left / span, 1);
  return (
    <section className="side-panel claim-card" aria-label="Claim" data-testid="ticket-claim">
      <div className="claim-head">
        <span className="claim-state">
          <span className="live-dot" aria-hidden="true" />
          Claimed
        </span>
        {claim.session && <SessionName id={claim.session.id} />}
      </div>
      <div className="claim-who">
        <Actor actor={agentActor(claim.agent)} owner={false} /> <span className="muted">since</span> <RelativeTime at={claim.claimedAt} />
      </div>
      <div
        className="meter"
        role="meter"
        aria-label="Time until the Claim lapses if silent"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
        aria-valuetext={formatRemaining(left)}
      >
        <div className="meter-fill" style={{ width: `${share * 100}%` }} />
      </div>
      <p className="claim-note muted">
        {left > 0 ? <>Lapses if silent for {formatRemaining(left)} more</> : <>Checking whether its Agent Session called in…</>}
      </p>
    </section>
  );
}

const RELATION_NAMES: Record<RelationKind, string> = { blocks: "Blocks", blocked_by: "Blocked by", relates_to: "Relates to" };

function ParentEditor(props: { ticket: Ticket; readOnly: boolean }) {
  const [key, setKey] = useState("");
  const set = useAction((parentKey: string | null) => api.updateTicket(props.ticket.key, { parentKey }), () => setKey(""));
  const parent = props.ticket.parent;
  if (props.readOnly && !parent) return null;
  return (
    <div className="side-group">
      <h3>Parent</h3>
      {parent && (
        <p data-testid="ticket-parent" className="side-ref">
          <Link to={`/tickets/${parent.key}`} className="link">
            <span className="key">{parent.key}</span> {parent.title}
          </Link>{" "}
          {!props.readOnly && <Button variant="ghost" onClick={() => void set.run(null)} disabled={set.busy}>Clear</Button>}
        </p>
      )}
      {!props.readOnly && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void set.run(key.trim());
          }}
        >
          <input aria-label="Parent" placeholder="e.g. CRONK-1" value={key} onChange={(e) => setKey(e.target.value)} required />
          <Button type="submit" variant="secondary" disabled={set.busy}>Set parent</Button>
        </form>
      )}
      {set.error && <p className="error" role="alert">{set.error}</p>}
    </div>
  );
}

function RelationsEditor(props: { detail: TicketDetail; readOnly: boolean }) {
  const t = props.detail.ticket;
  const [kind, setKind] = useState<RelationKind>("blocks");
  const [other, setOther] = useState("");
  const add = useAction(() => api.addRelation(t.key, kind, other.trim()), () => setOther(""));
  const remove = useAction((kind: RelationKind, otherKey: string) => api.removeRelation(t.key, kind, otherKey), () => {});
  const removeHidden = useAction((blockId: string) => api.removeBlock(t.key, blockId), () => {});
  const { blocks, blockedBy, relatesTo } = props.detail.relations;
  const hidden = blockedBy.filter((b): b is HiddenBlocker => "hidden" in b);
  const lists: [RelationKind, (TicketRef & { block?: BlockingRef["block"] })[]][] = [
    ["blocks", blocks],
    ["blocked_by", blockedBy.filter((b): b is BlockingRef => !("hidden" in b))],
    ["relates_to", relatesTo],
  ];
  const any = hidden.length > 0 || lists.some(([, refs]) => refs.length > 0);
  const busy = remove.busy || removeHidden.busy;
  if (props.readOnly && !any) return null;
  return (
    <div className="side-group">
      <h3>Relations</h3>
      {lists.map(
        ([listKind, refs]) =>
          (refs.length > 0 || (listKind === "blocked_by" && hidden.length > 0)) && (
            <div key={listKind} className="relation-group">
              <h4>{RELATION_NAMES[listKind]}</h4>
              <TicketRefList
                name={RELATION_NAMES[listKind]}
                refs={refs}
                onRemove={props.readOnly ? undefined : (ref) => void remove.run(listKind, ref.key)}
                busy={busy}
              />
              {listKind === "blocked_by" && hidden.length > 0 && (
                <HiddenBlockerList blockers={hidden} onRemove={props.readOnly ? undefined : (b) => void removeHidden.run(b.blockId)} busy={busy} />
              )}
            </div>
          ),
      )}
      {!props.readOnly && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add.run();
          }}
        >
          <select aria-label="Relation" value={kind} onChange={(e) => setKind(e.target.value as RelationKind)}>
            {Object.entries(RELATION_NAMES).map(([value, name]) => (
              <option key={value} value={value}>{name}</option>
            ))}
          </select>
          <input aria-label="Related Ticket" placeholder="e.g. CRONK-1" value={other} onChange={(e) => setOther(e.target.value)} required />
          <Button type="submit" variant="secondary" disabled={add.busy}>Add relation</Button>
        </form>
      )}
      {(add.error ?? remove.error ?? removeHidden.error) && <p className="error" role="alert">{add.error ?? remove.error ?? removeHidden.error}</p>}
    </div>
  );
}

/** Where a Document belongs, as a list of them says: the Ticket a Report is on, its Project, or the Workspace. */
const whereDocumentIs = (d: { ticketKey: string | null; projectKey: string | null }) =>
  d.ticketKey ? `Report on ${d.ticketKey}` : (d.projectKey ?? "Workspace");

/**
 * The Documents linked to the Ticket, other Tickets' Reports included; its own Reports show in its timeline.
 * With Write, Documents found by search can be linked, and linked ones unlinked. A link or unlink shows once
 * the Ticket's stream tells of it.
 */
function TicketDocuments(props: { detail: TicketDetail; readOnly: boolean }) {
  const t = props.detail.ticket;
  const documents = props.detail.documents.filter((d) => d.reason !== "report");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<SearchResult[]>();
  const search = useAction(
    () => api.search(query.trim()),
    (results) =>
      // Its own Reports are listed already, in its timeline.
      setFound(
        results.filter(
          (r) => (r.kind === "document" || r.kind === "report") && r.ticketKey !== t.key && !props.detail.documents.some((d) => d.id === r.documentId),
        ),
      ),
  );
  const link = useAction((documentId: string) => api.linkDocument(t.key, documentId), () => {
    setQuery("");
    setFound(undefined);
  });
  const unlink = useAction((documentId: string) => api.unlinkDocument(t.key, documentId), () => {});
  const error = search.error ?? link.error ?? unlink.error;
  if (props.readOnly && documents.length === 0) return null;
  return (
    <div className="side-group">
      <h3>Documents</h3>
      {documents.length > 0 && (
        <ul className="side-list" aria-label="Documents">
          {documents.map((d) => (
            <li key={d.id}>
              <Link to={`/documents/${d.id}`} className="link">{d.title}</Link>
              {d.protected && <> <ProtectedMark compact /></>}{" "}
              <span className="muted">{whereDocumentIs(d)}</span> <Chip>Linked</Chip>
              {!props.readOnly && (
                <Button variant="ghost" aria-label={`Unlink ${d.title}`} disabled={unlink.busy} onClick={() => void unlink.run(d.id)}>
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!props.readOnly && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void search.run();
          }}
        >
          <input aria-label="Find a Document to link" placeholder="Find a Document to link" value={query} onChange={(e) => setQuery(e.target.value)} required />
          <Button type="submit" variant="secondary" disabled={search.busy}>Find</Button>
        </form>
      )}
      {found &&
        (found.length === 0 ? (
          <p className="muted">No Documents found to link.</p>
        ) : (
          <ul className="side-list" aria-label="Documents to link">
            {found.map((r) => (
              <li key={r.documentId}>
                {r.title}
                {r.protected && <> <ProtectedMark compact /></>} <span className="muted">{whereDocumentIs(r)}</span>{" "}
                <Button variant="ghost" aria-label={`Link ${r.title}`} disabled={link.busy} onClick={() => void link.run(r.documentId!)}>
                  Link
                </Button>
              </li>
            ))}
          </ul>
        ))}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

/**
 * Tickets listed beside a Ticket, each linked, with Remove when given `onRemove`. A block an Agent added from its Discovered Ticket
 * also says which Agent added it and why (docs/ui.md § Ticket).
 */
function TicketRefList(props: { name: string; refs: (TicketRef & { block?: BlockingRef["block"] })[]; onRemove?: (ref: TicketRef) => void; busy?: boolean }) {
  return (
    <ul className="side-list" aria-label={props.name}>
      {props.refs.map((ref) => (
        <li key={ref.key}>
          <Link to={`/tickets/${ref.key}`} className="side-ref-link">
            <span className="dot-only" title={ref.status.name}>
              <StatusPill status={ref.status} />
            </span>
            <span className="key">{ref.key}</span> <span className="side-ref-title">{ref.title}</span>
          </Link>
          {props.onRemove && (
            <Button variant="ghost" aria-label={`Remove ${ref.key}`} disabled={props.busy} onClick={() => props.onRemove!(ref)}>
              Remove
            </Button>
          )}
          {ref.block && (
            <p className="side-ref-why muted small">
              <Actor actor={agentActor(ref.block.agent)} />: {ref.block.reason}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Blocks Agents added from Discovered Tickets the User can't see: each says so in place of the Ticket, with the Agent and why, and Remove
 * when given `onRemove` (docs/ui.md § Ticket).
 */
function HiddenBlockerList(props: { blockers: HiddenBlocker[]; onRemove?: (blocker: HiddenBlocker) => void; busy?: boolean }) {
  return (
    <ul className="side-list" aria-label="Blocked by Tickets you can't see">
      {props.blockers.map((b) => (
        <li key={b.blockId}>
          <span className="side-ref-link muted">A Ticket you can't see</span>
          {props.onRemove && (
            <Button variant="ghost" aria-label="Remove the block by a Ticket you can't see" disabled={props.busy} onClick={() => props.onRemove!(b)}>
              Remove
            </Button>
          )}
          <p className="side-ref-why muted small">
            <Actor actor={agentActor(b.block.agent)} />: {b.block.reason}
          </p>
        </li>
      ))}
    </ul>
  );
}

function EditTicket(props: { ticket: Ticket; onDone: (ticket: Ticket) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(props.ticket.title);
  const [description, setDescription] = useState(props.ticket.description);
  const { submit, error, busy } = useSubmit(() => api.updateTicket(props.ticket.key, { title, description }), props.onDone);
  return (
    <section className="panel wide">
      <form onSubmit={submit}>
        <Field label="Title" value={title} onChange={setTitle} />
        <TextArea label="Description (Markdown)" value={description} onChange={setDescription} rows={12} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <Button type="submit" disabled={busy}>Save</Button>
          <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}

