import { useState } from "react";
import { Actor } from "./components/actor.js";
import { Banner } from "./components/banner.js";
import { Button } from "./components/button.js";
import { Menu, type MenuItem } from "./components/overlays.js";
import { DECISION_STATUS_NAMES, DecisionStatusPill, FilterChip } from "./components/tags.js";
import { RelativeTime } from "./components/time.js";
import { DECISION_STATUSES } from "../shared/values.js";
import { api, staleVersionOf, type Decision, type DecisionStatus, type DecisionSummary } from "./api.js";
import { CronkMarkdown } from "./markdown.js";
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
            trigger={<button type="button" className={`filter-chip${filter.group ? " active" : ""}`}>{filter.group ? `Group: ${filter.group}` : "Group"} ▾</button>}
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
    (decision) => navigate(`/decisions/${decision.key}?edit=1`),
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
  const [decision, , setDecision] = useLoad(() => api.decision(props.decisionKey), [props.decisionKey]);
  const editing = new URLSearchParams(location.search).get("edit") === "1";
  return (
    <Show state={decision}>
      {(d) => (
        <DecisionView
          decision={d}
          startEditing={editing}
          onChanged={(changed) => {
            setDecision(changed);
            props.onChanged();
          }}
        />
      )}
    </Show>
  );
}

function DecisionView(props: { decision: Decision; startEditing: boolean; onChanged: (d: Decision) => void }) {
  const d = props.decision;
  const canWrite = useCanWrite(d.projectKey);
  const [editing, setEditing] = useState(props.startEditing);
  const status = useAction((to: DecisionStatus) => api.setDecisionStatus(d.key, to), props.onChanged);
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
          {canWrite && (
            <div className="actions">
              <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
              {otherMoves.length > 0 && (
                <Menu
                  label="Change status"
                  trigger={<Button variant="secondary" aria-label="More actions">…</Button>}
                  items={otherMoves.map(([to, label]) => ({ label, onSelect: () => void status.run(to), disabled: status.busy }))}
                />
              )}
              {d.status === "proposed" && <Button onClick={() => void status.run("accepted")} disabled={status.busy}>Accept</Button>}
            </div>
          )}
        </div>
        {status.error && <p className="error" role="alert">{status.error}</p>}
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
          </div>
          <div className="side-group">
            <h4>Group</h4>
            <span>{d.group ?? <span className="muted">None</span>}</span>
          </div>
          <div className="side-group">
            <h4>Proposed by</h4>
            <Actor actor={d.proposedBy} />
          </div>
          <div className="side-group">
            <h4>Version</h4>
            <span>Version {d.version}, <RelativeTime at={d.updatedAt} /></span>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Edits a Decision's title, group, what it supersedes and its Markdown, based on the Version it started from. */
function EditDecision(props: { decision: Decision; onSaved: (d: Decision) => void; onCancel: () => void }) {
  const d = props.decision;
  const [title, setTitle] = useState(d.title);
  const [group, setGroup] = useState(d.group ?? "");
  const [supersedes, setSupersedes] = useState(d.supersedes.map((s) => s.key).join(", "));
  const [body, setBody] = useState(d.body);
  const { submit, error, busy } = useSubmit(
    () =>
      api
        .saveDecision(d.key, {
          baseVersion: d.version,
          title,
          body,
          group,
          supersedes: supersedes.split(/[\s,]+/).filter(Boolean),
        })
        .catch((err) => {
          const current = staleVersionOf(err);
          if (!current) throw err;
          throw new Error(`${current.actor.name} saved Version ${current.number} meanwhile; copy your changes, cancel and edit again`);
        }),
    props.onSaved,
  );
  return (
    <section className="panel wide">
      <h2>Edit {d.key}</h2>
      <form onSubmit={submit}>
        <Field label="Title" value={title} onChange={setTitle} disabled={busy} />
        <Field label="Group" value={group} onChange={setGroup} required={false} disabled={busy} />
        <Field label="Supersedes (keys, such as CRONK-D4)" value={supersedes} onChange={setSupersedes} required={false} disabled={busy} />
        <MarkdownEditor label="Body (Markdown)" value={body} onChange={setBody} disabled={busy} projectKey={d.projectKey} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <Button type="submit" disabled={busy}>Save</Button>
          <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}
