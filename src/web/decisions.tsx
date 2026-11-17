import { useEffect, useState } from "react";
import { Actor } from "./components/actor.js";
import { Banner } from "./components/banner.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { Button, buttonClass } from "./components/button.js";
import { Menu, type MenuItem } from "./components/overlays.js";
import { RejectDecisionForm } from "./components/reject-decision.js";
import { DECISION_STATUS_NAMES, DecisionStatusPill, FilterChip, ProtectedMark } from "./components/tags.js";
import { ProtectionHistory } from "./components/protection.js";
import { RelativeTime } from "./components/time.js";
import { DECISION_STATUSES } from "../shared/values.js";
import { api, decisionsExportUrl, watchDecision, type Decision, type DecisionStatus, type DecisionSummary, type DecisionVersion, type FieldConflict } from "./api.js";
import { DiscardMine, ResolveMerge, StaleSaveNotice, useStaleSave, VersionDiff, type Draft, type MergedField } from "./merge.js";
import { CronkMarkdown, forgetLinkedKnowledge, MarkdownPlace } from "./markdown.js";
import { MentionedIn } from "./mentions.js";
import { LoadFromTranscripts } from "./transcripts.js";
import { MarkdownEditor } from "./markdown-editor.js";
import { Link, navigate } from "./router.js";
import { Field, Show, useAction, useCanWrite, useLoad, useSubmit } from "./ui.js";

// The Decisions register and a Decision's page: docs/ui.md § Decisions.

/** The register's address for a Project's Decisions, or the Workspace's without a Project key, with a status or group filter. */
export function decisionsAddress(projectKey: string | null | undefined, filter: DecisionFilter = {}): string {
  const query = new URLSearchParams({ ...(projectKey && { project: projectKey }), ...(filter.status && { status: filter.status }), ...(filter.group && { group: filter.group }) });
  const text = query.toString();
  return text ? `/decisions?${text}` : "/decisions";
}

export interface DecisionFilter {
  status?: DecisionStatus | undefined;
  group?: string | undefined;
}

/** The register's filter from its address. */
export function decisionFilterFrom(search: URLSearchParams): DecisionFilter {
  const status = search.get("status");
  return { status: DECISION_STATUSES.find((s) => s === status), group: search.get("group") ?? undefined };
}

/** The Project a Decision key belongs to: everything before its last "-D", or none for a Workspace key such as D7. */
const projectKeyOfDecision = (key: string): string | undefined => {
  const at = key.toUpperCase().lastIndexOf("-D");
  return at > 0 ? key.slice(0, at).toUpperCase() : undefined;
};

/**
 * The register of a Project's Decisions, or the Workspace's, with its scope switch and filters;
 * with `selected`, that Decision's page below it.
 */
export function DecisionsPage(props: { projectKey?: string | undefined; filter: DecisionFilter; selected?: string }) {
  const projectKey = props.selected ? projectKeyOfDecision(props.selected) : props.projectKey?.toUpperCase();
  const [decisions, reload] = useLoad(() => api.decisions(projectKey), [projectKey]);
  const canWrite = useCanWrite(projectKey);
  const [creating, setCreating] = useState(false);
  return (
    <section className="decisions">
      <div className="page-head">
        <div>
          <div className="muted crumbs">
            <Link to={decisionsAddress(projectKey)} className="link">Decisions</Link> / {projectKey ?? "Workspace"}
          </div>
          <h1>Decisions</h1>
        </div>
        <div className="actions">
          <ScopeSwitch projectKey={projectKey} />
          {/* For everyone who can read the register; the server builds the archive and names the file. */}
          <a className={buttonClass("secondary")} href={decisionsExportUrl(projectKey)} download>Export docs/adr</a>
          {canWrite && !creating && <Button onClick={() => setCreating(true)}>New Decision</Button>}
        </div>
      </div>
      {creating && <NewDecision projectKey={projectKey} onCancel={() => setCreating(false)} />}
      <Show state={decisions}>
        {(all) => <Register projectKey={projectKey} decisions={all} filter={props.filter} selected={props.selected} />}
      </Show>
      {props.selected && <DecisionPage key={props.selected} decisionKey={props.selected} onChanged={reload} />}
    </section>
  );
}

/** Workspace, then each Project, as a segmented control. */
function ScopeSwitch(props: { projectKey: string | undefined }) {
  const [projects] = useLoad(() => api.projects(), []);
  const scopes: [string | undefined, string][] = [[undefined, "Workspace"], ...(projects.kind === "loaded" ? projects.value.map((p): [string, string] => [p.key, p.key]) : [])];
  return (
    <nav className="segmented" aria-label="Scope">
      {scopes.map(([key, name]) => {
        const current = key === props.projectKey;
        return (
          <Link key={name} to={decisionsAddress(key)} className={current ? "segment active" : "segment"} {...(current ? { "aria-current": "page" as const } : {})}>
            {name}
          </Link>
        );
      })}
    </nav>
  );
}

/** The filter chips with their counts, and the table of the Decisions they let through. */
function Register(props: { projectKey: string | undefined; decisions: DecisionSummary[]; filter: DecisionFilter; selected: string | undefined }) {
  const { decisions, filter } = props;
  const groups = [...new Set(decisions.flatMap((d) => (d.group ? [d.group] : [])))].sort((a, b) => a.localeCompare(b));
  const inGroup = (d: DecisionSummary) => !filter.group || d.group?.toLowerCase() === filter.group.toLowerCase();
  const shown = decisions.filter((d) => inGroup(d) && (!filter.status || d.status === filter.status));
  const count = (status?: DecisionStatus) => decisions.filter((d) => inGroup(d) && (!status || d.status === status)).length;
  const groupItems: MenuItem[] = [
    { label: "Any group", onSelect: () => navigate(decisionsAddress(props.projectKey, { status: filter.status })) },
    ...groups.map((group) => ({ label: group, onSelect: () => navigate(decisionsAddress(props.projectKey, { status: filter.status, group })) })),
  ];
  if (decisions.length === 0) {
    return (
      <div className="empty">
        <h2>No Decisions yet</h2>
        <p className="muted">Record a choice and its reasons with New Decision; it starts as proposed until a User accepts it.</p>
      </div>
    );
  }
  return (
    <>
      <div className="filter-chips" role="group" aria-label="Filter by status">
        <FilterChip to={decisionsAddress(props.projectKey, { group: filter.group })} current={!filter.status}>{`All ${count()}`}</FilterChip>
        {DECISION_STATUSES.filter((s) => count(s) > 0 || filter.status === s).map((s) => (
          <FilterChip key={s} to={decisionsAddress(props.projectKey, { status: s, group: filter.group })} current={filter.status === s}>
            {`${DECISION_STATUS_NAMES[s]} ${count(s)}`}
          </FilterChip>
        ))}
        {groups.length > 0 && (
          <Menu
            label="Filter by group"
            trigger={<button type="button" className={`filter-chip${filter.group ? " pressed" : ""}`}>{filter.group ? `Group: ${filter.group}` : "Group"} ▾</button>}
            items={groupItems}
          />
        )}
      </div>
      <div className="register">
        <div className="register-row register-head" aria-hidden="true">
          <span className="register-key">Key</span>
          <span className="register-title">Decision</span>
          <span className="register-status">Status</span>
          <span className="register-group">Group</span>
          <span className="register-date">Date</span>
        </div>
        <ul className="register-rows" aria-label="Decisions">
          {shown.map((d) => (
            <li key={d.id}>
              <Link
                to={`/decisions/${d.key}`}
                className={`register-row${d.key === props.selected?.toUpperCase() ? " selected" : ""}`}
                {...(d.key === props.selected?.toUpperCase() ? { "aria-current": "page" as const } : {})}
              >
                <span className="register-key">{d.key}</span>
                <span className="register-title">
                  {d.title}
                  {d.supersededBy && <span className="superseded-by"> → {d.supersededBy.key}</span>}
                  {d.protected && <> <ProtectedMark compact /></>}
                </span>
                <span className="register-status"><DecisionStatusPill status={d.status} /></span>
                <span className="register-group">{d.group ?? ""}</span>
                <RelativeTime at={d.createdAt} className="register-date" />
              </Link>
            </li>
          ))}
        </ul>
        {shown.length === 0 && <p className="muted register-none">No Decisions match these filters.</p>}
      </div>
    </>
  );
}

function NewDecision(props: { projectKey: string | undefined; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [group, setGroup] = useState("");
  const { submit, error, busy } = useSubmit(
    () => api.createDecision(props.projectKey, { title, group }),
    (decision) => {
      forgetLinkedKnowledge();
      navigate(`/decisions/${decision.key}?edit=1`);
    },
  );
  return (
    <section className="panel">
      <h2>New Decision</h2>
      <p className="muted hint">It starts as proposed, with the sections of a decision record to fill in.</p>
      <form onSubmit={submit}>
        <Field label="Title" value={title} onChange={setTitle} />
        <Field label="Group" value={group} onChange={setGroup} required={false} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <Button type="submit" disabled={busy}>Create Decision</Button>
          <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}

/** One Decision: its head, banners for what it supersedes or what superseded it, its body, and the side panel. */
function DecisionPage(props: { decisionKey: string; onChanged: () => void }) {
  const [decision, reload, setDecision] = useLoad(() => api.decision(props.decisionKey), [props.decisionKey]);
  const editing = new URLSearchParams(location.search).get("edit") === "1";
  return (
    <Show state={decision}>
      {(d) => (
        <MarkdownPlace.Provider value={d.projectKey}>
          <DecisionView
            decision={d}
            startEditing={editing}
            onReload={() => {
              // The register row above it shows the title and status too.
              reload();
              props.onChanged();
            }}
            onChanged={(changed) => {
              setDecision(changed);
              props.onChanged();
            }}
          />
        </MarkdownPlace.Provider>
      )}
    </Show>
  );
}

function DecisionView(props: { decision: Decision; startEditing: boolean; onChanged: (d: Decision) => void; onReload: () => void }) {
  const d = props.decision;
  const canWrite = useCanWrite(d.projectKey);
  const [editing, setEditing] = useState(props.startEditing);
  // The newest Version anyone saved, as the Decision's stream tells it.
  const [latest, setLatest] = useState(d.version);
  const [live, onLive] = useLiveState();
  useEffect(
    () =>
      watchDecision(d.key, {
        onLive,
        // On (re)connecting, catch up on what was saved meanwhile.
        ready: () => void api.decision(d.key).then((current) => setLatest((v) => Math.max(v, current.version)), () => {}),
        on: { version: ({ version }) => setLatest((v) => Math.max(v, version)) },
      }),
    [d.key],
  );
  // Someone else's Version is shown at once, unless it would pull the Decision out from under an edit.
  const newer = latest > d.version ? latest : undefined;
  useEffect(() => {
    if (newer !== undefined && !editing) props.onReload();
  }, [newer, editing]);
  const status = useAction((to: DecisionStatus) => api.setDecisionStatus(d.key, to), props.onChanged);
  // Rejecting needs a reason, typed into a box the Reject action opens.
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const reject = useAction(
    () => api.setDecisionStatus(d.key, "rejected", reason),
    (changed: Decision) => {
      setRejecting(false);
      setReason("");
      props.onChanged(changed);
    },
  );
  const protect = useAction((value: boolean) => api.protectDecision(d.key, value), props.onChanged);
  const moves: [DecisionStatus, string][] = [
    ["accepted", "Accept"],
    ["rejected", "Reject"],
    ["deprecated", "Deprecate"],
    ["proposed", "Back to proposed"],
  ];
  const otherMoves = moves.filter(([to]) => to !== d.status && !(d.status === "proposed" && to === "accepted"));
  if (editing) {
    return (
      <EditDecision
        decision={d}
        newerVersion={newer}
        onCancel={() => setEditing(false)}
        onSaved={(saved) => {
          props.onChanged(saved);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div className="decision-layout">
      <article className="decision panel wide">
        <div className="decision-head">
          <span className="key">{d.key}</span>
          <DecisionStatusPill status={d.status} />
          {d.protected && <ProtectedMark />}
          <div className="actions">
            <LiveIndicator state={live} />
            {canWrite && (
              <>
                <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
                <Menu
                  label="More actions"
                  trigger={<Button variant="secondary" aria-label="More actions">…</Button>}
                  items={[
                    ...otherMoves.map(([to, label]) => ({
                      label: to === "rejected" ? `${label}…` : label,
                      onSelect: () => (to === "rejected" ? setRejecting(true) : void status.run(to)),
                      disabled: status.busy,
                    })),
                    { label: d.protected ? "Unprotect" : "Protect", onSelect: () => void protect.run(!d.protected), disabled: protect.busy },
                  ]}
                />
                {d.status === "proposed" && <Button onClick={() => void status.run("accepted")} disabled={status.busy}>Accept</Button>}
              </>
            )}
          </div>
        </div>
        {status.error && <p className="error" role="alert">{status.error}</p>}
        {protect.error && <p className="error" role="alert">{protect.error}</p>}
        {reject.error && <p className="error" role="alert">{reject.error}</p>}
        {rejecting && (
          <RejectDecisionForm
            proposedBy={d.proposedBy}
            reason={reason}
            onReasonChange={setReason}
            onReject={() => void reject.run()}
            onCancel={() => setRejecting(false)}
            busy={reject.busy}
          />
        )}
        <h1 className="decision-title">{d.title}</h1>
        {d.supersedes.length > 0 && (
          <Banner tone="info" role="status">
            <p>
              Supersedes{" "}
              {d.supersedes.map((s, i) => (
                <span key={s.key}>
                  {i > 0 && ", "}
                  <Link to={`/decisions/${s.key}`} className="link"><span className="mono">{s.key}</span> {s.title}</Link>
                </span>
              ))}
              {d.status !== "accepted" && <span className="muted"> once accepted</span>}
            </p>
          </Banner>
        )}
        {d.supersededBy && (
          <Banner tone="warn" role="status">
            <p>
              Superseded by{" "}
              <Link to={`/decisions/${d.supersededBy.key}`} className="link"><span className="mono">{d.supersededBy.key}</span> {d.supersededBy.title}</Link>
            </p>
          </Banner>
        )}
        <div className="document-body">
          <div className="markdown decision-body" data-testid="decision-body">
            <CronkMarkdown>{d.body}</CronkMarkdown>
          </div>
        </div>
      </article>
      <aside className="decision-side">
        <div className="side-panel side-related">
          <div className="side-group">
            <h4>Status</h4>
            <div><DecisionStatusPill status={d.status} /></div>
            <span className="muted small">by {d.statusChangedBy.name}, <RelativeTime at={d.statusChangedAt} /></span>
            {d.statusReason && (
              <div className="markdown decision-status-reason">
                <CronkMarkdown>{d.statusReason}</CronkMarkdown>
              </div>
            )}
          </div>
          <div className="side-group">
            <h4>Group</h4>
            <span>{d.group ?? <span className="muted">None</span>}</span>
          </div>
          <div className="side-group">
            <h4>Proposed by</h4>
            <Actor actor={d.proposedBy} />
            {d.sourceTicket && (
              <span className="muted small">
                from <Link to={`/tickets/${d.sourceTicket.key}`} className="link"><span className="mono">{d.sourceTicket.key}</span> {d.sourceTicket.title}</Link>
              </span>
            )}
          </div>
          <div className="side-group">
            <h4>Version</h4>
            <span>Version {d.version}, <RelativeTime at={d.updatedAt} /></span>
          </div>
          <MentionedIn load={() => api.decisionMentions(d.key)} deps={[d.key, d.version]} what="its key" compact />
          <LoadFromTranscripts kind="decisions" keyOrId={d.key} heading="h4" reloadOn={d.version} />
          <div className="side-group">
            <h4>Protected</h4>
            <span>{d.protected ? "Yes: Agents may read it but not edit it" : <span className="muted">No</span>}</span>
            <ProtectionHistory load={() => api.decisionProtection(d.key)} reloadOn={[d.key, d.protected]} />
          </div>
        </div>
      </aside>
    </div>
  );
}

/** The labels a Decision's group and superseded Decisions go by in its editor and in a merge. */
const GROUP = "Group";
const SUPERSEDES = "Supersedes (keys, such as CRONK-D4)";

/** A Decision Version's group and superseded Decisions as the editor's fields. */
const fieldsOf = (v: { group: string | null; supersedes: string[] }) => ({ [GROUP]: v.group ?? "", [SUPERSEDES]: v.supersedes.join(", ") });

/** The keys typed into the Supersedes field. */
const keysIn = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/**
 * A whole field of a Decision merge as the merge panel settles it: as text, with a conflict's sides
 * as text too. Only a list of keys can keep both sides; a group is one side's or the other's.
 */
function mergedField<T>(label: string, merged: T | null, conflict: FieldConflict<T> | null, text: (value: T) => string, combinable: boolean): MergedField {
  if (!conflict) return { label, text: text(merged as T), conflict: null, combinable };
  const [base, mine, theirs] = [conflict.base, conflict.mine, conflict.theirs].map(text) as [string, string, string];
  return { label, text: null, conflict: { base, mine, theirs, both: mine && theirs ? `${mine}, ${theirs}` : mine || theirs }, combinable };
}

/**
 * Edits a Decision's title, group, what it supersedes and its Markdown, based on the Version it
 * started from. A save refused because someone saved since merges their Version into this edit:
 * the body section by section, the other fields whole, leaving what both changed differently for
 * the User to choose or combine.
 */
function EditDecision(props: { decision: Decision; newerVersion: number | undefined; onSaved: (d: Decision) => void; onCancel: () => void }) {
  const d = props.decision;
  const edit = (draft: Draft) => ({
    title: draft.title!,
    body: draft.text,
    group: draft.fields![GROUP]!,
    supersedes: keysIn(draft.fields![SUPERSEDES]!),
  });
  const { draft, setDraft, save, busy, error, notice, resolve, discardMine } = useStaleSave({
    draft: { title: d.title, text: d.body, fields: fieldsOf({ group: d.group, supersedes: d.supersedes.map((s) => s.key) }) },
    baseVersion: d.version,
    save: (draft, baseVersion) => api.saveDecision(d.key, { baseVersion, ...edit(draft) }),
    merge: async (draft, baseVersion) => {
      const [merge, started] = await Promise.all([api.mergeDecision(d.key, { baseVersion, ...edit(draft) }), api.decisionVersion(d.key, baseVersion)]);
      const saved = (v: DecisionVersion) => ({ number: v.number, title: v.title, body: v.body, fields: fieldsOf(v) });
      const fields = [
        mergedField(GROUP, merge.group, merge.groupConflict, (g) => g ?? "", false),
        mergedField(SUPERSEDES, merge.supersedes, merge.supersedesConflict, (keys) => keys.join(", "), true),
      ];
      return {
        base: saved(started),
        theirs: saved(merge.onto),
        by: merge.onto.actor,
        merge: { ...merge, fields },
        merged: merge.conflicts === 0 ? { title: merge.title!, text: merge.body!, fields: Object.fromEntries(fields.map((f) => [f.label, f.text!])) } : null,
      };
    },
    onSaved: props.onSaved,
  });
  const setField = (label: string) => (value: string) => setDraft((dr) => ({ ...dr, fields: { ...dr.fields, [label]: value } }));
  return (
    <>
      {props.newerVersion !== undefined && !notice && !resolve && <SavedMeanwhile decision={d} version={props.newerVersion} />}
      {notice && <StaleSaveNotice {...notice} />}
      {resolve ? (
        <ResolveMerge {...resolve} />
      ) : (
        <section className="panel wide">
          <h2>Edit {d.key}</h2>
          <form onSubmit={save}>
            {/* Read-only while saving: the merge sends the draft as it was when Save was pressed. */}
            <Field label="Title" value={draft.title} onChange={(title) => setDraft((dr) => ({ ...dr, title }))} disabled={busy} />
            <Field label={GROUP} value={draft.fields![GROUP]} onChange={setField(GROUP)} required={false} disabled={busy} />
            <Field label={SUPERSEDES} value={draft.fields![SUPERSEDES]} onChange={setField(SUPERSEDES)} required={false} disabled={busy} />
            <MarkdownEditor label="Body (Markdown)" value={draft.text} onChange={(text) => setDraft((dr) => ({ ...dr, text }))} disabled={busy} projectKey={d.projectKey} />
            {error && <p className="error" role="alert">{error}</p>}
            <div className="actions">
              <Button type="submit" disabled={busy}>Save</Button>
              <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
              {discardMine && <DiscardMine {...discardMine} />}
            </div>
          </form>
        </section>
      )}
    </>
  );
}

/** A Decision Version as a diff or a merge shows it: its title, body, and other fields as the editor's. */
const saved = (v: DecisionVersion) => ({ number: v.number, title: v.title, body: v.body, fields: fieldsOf(v) });

/**
 * Warns, while a Decision is being edited, that someone saved a newer Version meanwhile: who, and
 * what they changed since the Version the edit started from. Saving then merges it in.
 */
function SavedMeanwhile(props: { decision: Decision; version: number }) {
  const { key, version: started } = props.decision;
  const [versions] = useLoad(() => Promise.all([api.decisionVersion(key, started), api.decisionVersion(key, props.version)]), [key, started, props.version]);
  return (
    <Banner tone="warn" role="status">
      <Show state={versions}>
        {([base, theirs]) => (
          <>
            <p>
              <strong>
                <Actor actor={theirs.actor} /> saved Version {theirs.number} while you were editing Version {base.number}.
              </strong>{" "}
              Saving merges their changes into yours.
            </p>
            <details>
              <summary>See what they changed</summary>
              <VersionDiff before={saved(base)} after={saved(theirs)} label={`Their changes, Version ${base.number} to ${theirs.number}`} />
            </details>
          </>
        )}
      </Show>
    </Banner>
  );
}
