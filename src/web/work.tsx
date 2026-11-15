import { useEffect, useState, type FormEvent } from "react";
import { AgentAccessSelect } from "./agents.js";
import {
  api,
  type AgentAccess,
  type Priority,
  type Project,
  type RecordedChange,
  type RelationKind,
  type Status,
  type StatusCategory,
  type Ticket,
  type TicketChanges,
  type TicketDetail,
  type TicketFilter,
  type TicketRef,
  type User,
  sessionName,
  watchProject,
} from "./api.js";
import { PRIORITIES, STATUS_CATEGORIES } from "../shared/values.js";
import { GuidanceSection } from "./guidance.js";
import { TicketTimeline } from "./timeline.js";
import { CronkMarkdown, forgetProjectKeys } from "./markdown.js";
import { ProjectAccessPanel } from "./people.js";
import { Link, navigate } from "./router.js";
import { Field, Show, TextArea, useAction, useLoad, useSubmit } from "./ui.js";

const PRIORITY_NAMES: Record<Priority, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No Priority" };

const CATEGORY_NAMES: Record<StatusCategory, string> = {
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  in_review: "In Review",
  completed: "Completed",
  canceled: "Canceled",
};

const RELATION_NAMES: Record<RelationKind, string> = { blocks: "Blocks", blocked_by: "Blocked by", relates_to: "Relates to" };

/** The Workspace's Projects: active ones by default, or the archived ones. */
export function ProjectsPage(props: { archived: boolean }) {
  const [projects] = useLoad(() => api.projects(props.archived), [props.archived]);
  const [creating, setCreating] = useState(false);

  return (
    <section>
      <div className="page-head">
        <h1>{props.archived ? "Archived Projects" : "Projects"}</h1>
        <div className="actions">
          {props.archived ? (
            <Link to="/" className="link">Active Projects</Link>
          ) : (
            <>
              <Link to="/archived" className="link">Archived Projects</Link>
              {!creating && <button onClick={() => setCreating(true)}>New Project</button>}
            </>
          )}
        </div>
      </div>
      {creating && (
        <NewProject
          onCancel={() => setCreating(false)}
          onDone={(project) => {
            forgetProjectKeys();
            navigate(`/projects/${project.key}`);
          }}
        />
      )}
      <Show state={projects}>
        {(list) =>
          list.length === 0 ? (
            <div className="empty">
              <h2>{props.archived ? "No archived Projects" : "No Projects yet"}</h2>
              {!props.archived && <p className="muted">Create a Project to start tracking Tickets.</p>}
            </div>
          ) : (
            <ul className="rows">
              {list.map((project) => (
                <li key={project.id}>
                  <Link to={`/projects/${project.key}`} className="row">
                    <span className="key">{project.key}</span>
                    <span className="grow">{project.name}</span>
                    {project.visibility === "private" && <span className="badge">Private</span>}
                    {project.access === "read" && <span className="badge">Read only</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </Show>
    </section>
  );
}

function NewProject(props: { onDone: (project: Project) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const { submit, error, busy } = useSubmit(() => api.createProject({ name, key }), props.onDone);
  return (
    <section className="panel">
      <h2>New Project</h2>
      <form onSubmit={submit}>
        <Field label="Project name" value={name} onChange={setName} />
        <Field label="Key" value={key} onChange={(v) => setKey(v.toUpperCase())} placeholder="e.g. CRONK" />
        <p className="muted hint">Tickets are numbered from it, like {key || "CRONK"}-1. It can't be changed later.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="submit" disabled={busy}>Create Project</button>
          <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

export type ProjectView = "list" | "board" | "statuses" | "reports" | "guidance";

/** Whether a view shows the Project's Tickets, and so takes a filter: the list and the board do. */
const showsTickets = (view: ProjectView) => view === "list" || view === "board";

/** The filter fields a Project page keeps in its address, in the order the filter bar shows them. */
const FILTER_FIELDS = ["status", "category", "assignee", "priority", "label"] as const;

/** Reads a Project page's filters from its query string. */
export function filterFrom(search: URLSearchParams): TicketFilter {
  const filter: Record<string, string> = {};
  for (const field of FILTER_FIELDS) {
    const value = search.get(field);
    if (value) filter[field] = value;
  }
  return filter as TicketFilter;
}

/** A Project page's address for a view and filter. Only the Ticket views (list and board) take a filter. */
function projectPath(projectKey: string, view: ProjectView, filter: TicketFilter): string {
  const query = new URLSearchParams();
  if (view !== "list") query.set("view", view);
  if (showsTickets(view)) for (const field of FILTER_FIELDS) if (filter[field]) query.set(field, filter[field]);
  return `/projects/${projectKey}${query.size ? `?${query}` : ""}`;
}

/**
 * One Project's Tickets, as a list or as a board grouped by Status, narrowed by the
 * filters in its address; or its Statuses to tailor, counting all its Tickets.
 */
export function ProjectPage(props: { projectKey: string; view: ProjectView; filter: TicketFilter; me: User }) {
  const filter = showsTickets(props.view) ? props.filter : {};
  const filterKey = JSON.stringify(filter);
  const [project, reloadProject, setProject] = useLoad(() => api.project(props.projectKey), [props.projectKey]);
  const [tickets, reloadTickets] = useLoad(() => api.tickets(props.projectKey, filter), [props.projectKey, filterKey]);
  // The list and board follow the Project's changes; a change to its Statuses reloads the Project, which holds them.
  useEffect(
    () =>
      watchProject(props.projectKey, {
        ready: () => {
          reloadProject();
          reloadTickets();
        },
        on: {
          changed: ({ ticket }) => {
            if (ticket === null) reloadProject();
            reloadTickets();
          },
        },
      }),
    [props.projectKey],
  );
  const [creating, setCreating] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const agentAccess = useAction(
    async (access: AgentAccess) => {
      if (project.kind !== "loaded") throw new Error("The Project hasn't loaded");
      return { ...project.value, project: await api.updateProject(props.projectKey, { agentAccess: access }) };
    },
    setProject,
  );
  const archive = useSubmit(
    async () => {
      if (project.kind !== "loaded") throw new Error("The Project hasn't loaded");
      return { ...project.value, project: await api.updateProject(props.projectKey, { archived: !project.value.project.archived }) };
    },
    setProject,
  );
  const filtered = Object.keys(props.filter).length > 0;

  return (
    <Show state={project}>
      {({ project: p, statuses }) => (
        <section>
          <div className="page-head">
            <div>
              <div className="muted"><Link to={p.archived ? "/archived" : "/"} className="link">Projects</Link> / {p.key}</div>
              <h1>
                {p.name} {p.archived && <span className="badge">Archived</span>}{" "}
                {p.visibility === "private" && <span className="badge">Private</span>}{" "}
                {p.access === "read" && <span className="badge">Read only</span>}
              </h1>
            </div>
            <div className="actions">
              {p.access === "write" && (
                <AgentAccessSelect value={p.agentAccess} disabled={agentAccess.busy} onChange={(a) => void agentAccess.run(a)} />
              )}
              {props.me.role === "admin" && (
                <button className="secondary" onClick={() => setShowAccess(!showAccess)}>Access</button>
              )}
              {p.access === "write" && (
                <>
                  <button className="secondary" onClick={() => archive.submit()} disabled={archive.busy}>
                    {p.archived ? "Restore Project" : "Archive Project"}
                  </button>
                  {!creating && <button onClick={() => setCreating(true)}>New Ticket</button>}
                </>
              )}
            </div>
          </div>
          {(archive.error ?? agentAccess.error) && <p className="error" role="alert">{archive.error ?? agentAccess.error}</p>}
          {showAccess && (
            <ProjectAccessPanel
              project={p}
              onProjectChanged={(updated) => setProject({ project: updated, statuses })}
            />
          )}
          {creating && (
            <NewTicket
              projectKey={p.key}
              onCancel={() => setCreating(false)}
              onDone={() => {
                setCreating(false);
                reloadTickets();
              }}
            />
          )}
          <nav className="tabs" aria-label="View">
            <Link to={projectPath(p.key, "list", props.filter)} className={props.view === "list" ? "tab active" : "tab"}>List</Link>
            <Link to={projectPath(p.key, "board", props.filter)} className={props.view === "board" ? "tab active" : "tab"}>Board</Link>
            <Link to={projectPath(p.key, "statuses", {})} className={props.view === "statuses" ? "tab active" : "tab"}>Statuses</Link>
            <Link to={`/projects/${p.key}/documents`} className="tab">Documents</Link>
            <Link to={projectPath(p.key, "reports", {})} className={props.view === "reports" ? "tab active" : "tab"}>Reports</Link>
            <Link to={projectPath(p.key, "guidance", {})} className={props.view === "guidance" ? "tab active" : "tab"}>Guidance</Link>
          </nav>
          {props.view === "guidance" && (
            <GuidanceSection
              projectKey={p.key}
              canEdit={p.access === "write"}
              intro="Standing instructions for Agents working in this Project, on top of the Workspace Guidance. Every Agent Session gets them when it connects."
            />
          )}
          {showsTickets(props.view) && (
            <FilterBar
              projectKey={p.key}
              statuses={statuses}
              filter={props.filter}
              onChange={(filter) => navigate(projectPath(p.key, props.view, filter))}
            />
          )}
          {props.view === "reports" && <ReportsView projectKey={p.key} />}
          {props.view !== "guidance" && props.view !== "reports" && (
            <Show state={tickets}>
              {(list) =>
                props.view === "statuses" ? (
                  <StatusesView
                    projectKey={p.key}
                    statuses={statuses}
                    tickets={list}
                    canChange={p.access === "write"}
                    onChanged={() => {
                      reloadProject();
                      reloadTickets();
                    }}
                  />
                ) : (
                  <>
                    {list.length === 0 && filtered && (
                      <div className="empty">
                        <h2>No Tickets match these filters</h2>
                        <Link to={projectPath(p.key, props.view, {})} className="link">Clear filters</Link>
                      </div>
                    )}
                    {props.view === "board" ? (
                      <Board statuses={statuses} tickets={list} />
                    ) : list.length === 0 ? (
                      !filtered && <div className="empty"><h2>No Tickets yet</h2></div>
                    ) : (
                      <ul className="rows" aria-label="Tickets">
                        {list.map((ticket) => (
                          <li key={ticket.key}>
                            <Link to={`/tickets/${ticket.key}`} className="row">
                              <PriorityIcon priority={ticket.priority} />
                              <span className="key">{ticket.key}</span>
                              <span className="grow">{ticket.title}</span>
                              <LabelChips labels={ticket.labels} />
                              {ticket.assignee && <span className="muted assignee">{ticket.assignee.name}</span>}
                              <StatusPill status={ticket.status} />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )
              }
            </Show>
          )}
        </section>
      )}
    </Show>
  );
}

function FilterBar(props: { projectKey: string; statuses: Status[]; filter: TicketFilter; onChange: (filter: TicketFilter) => void }) {
  const [users] = useLoad(api.users, []);
  const [labels] = useLoad(() => api.labels(props.projectKey), [props.projectKey]);
  const set = (field: keyof TicketFilter) => (value: string) => {
    const { [field]: _, ...rest } = props.filter;
    props.onChange(value ? { ...rest, [field]: value } : rest);
  };
  const loaded = <T,>(state: { kind: string; value?: T }) => (state.kind === "loaded" ? state.value! : undefined);
  const labelList = loaded<string[]>(labels) ?? [];
  // Keep a filtered Label selectable even when no Ticket has it any more.
  const labelOptions = props.filter.label && !labelList.includes(props.filter.label) ? [props.filter.label, ...labelList] : labelList;

  return (
    <div className="filters" role="group" aria-label="Filters">
      <FilterSelect
        name="Status"
        value={props.filter.status}
        onChange={set("status")}
        options={props.statuses.map((s) => [s.id, s.name])}
      />
      <FilterSelect
        name="Status Category"
        value={props.filter.category}
        onChange={set("category")}
        options={Object.entries(CATEGORY_NAMES)}
      />
      <FilterSelect
        name="Assignee"
        value={props.filter.assignee}
        onChange={set("assignee")}
        options={[["none", "Unassigned"], ...(loaded<User[]>(users) ?? []).map((u): [string, string] => [u.id, u.name])]}
      />
      <FilterSelect
        name="Priority"
        value={props.filter.priority}
        onChange={set("priority")}
        options={PRIORITIES.map((p) => [p, PRIORITY_NAMES[p]])}
      />
      <FilterSelect name="Label" value={props.filter.label} onChange={set("label")} options={labelOptions.map((l) => [l, l])} />
    </div>
  );
}

export function FilterSelect(props: { name: string; value: string | undefined; onChange: (value: string) => void; options: [string, string][] }) {
  return (
    <label className="filter">
      <span>{props.name}</span>
      <select aria-label={`Filter by ${props.name}`} value={props.value ?? ""} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">Any</option>
        {props.options.map(([value, name]) => (
          <option key={value} value={value}>{name}</option>
        ))}
      </select>
    </label>
  );
}

function Board(props: { statuses: Status[]; tickets: Ticket[] }) {
  return (
    <div className="board">
      {props.statuses.map((status) => {
        const inStatus = props.tickets.filter((t) => t.status.id === status.id);
        return (
          <section key={status.id} className="column" aria-label={status.name}>
            <h3 className="column-head">
              <span className={`dot ${status.category}`} />
              {status.name} <span className="muted">{inStatus.length}</span>
            </h3>
            {inStatus.map((ticket) => (
              <Link key={ticket.key} to={`/tickets/${ticket.key}`} className="card">
                <span className="card-head">
                  <span className="key">{ticket.key}</span>
                  <PriorityIcon priority={ticket.priority} />
                </span>
                <span>{ticket.title}</span>
                <LabelChips labels={ticket.labels} />
              </Link>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** The Project's Statuses by Status Category, to add, rename, reorder and remove. */
function StatusesView(props: { projectKey: string; statuses: Status[]; tickets: Ticket[]; canChange: boolean; onChanged: () => void }) {
  return (
    <div className="status-categories">
      {STATUS_CATEGORIES.map((category) => (
        <StatusCategorySection
          key={category}
          {...props}
          category={category}
          label={CATEGORY_NAMES[category]}
          inCategory={props.statuses.filter((s) => s.category === category)}
        />
      ))}
    </div>
  );
}

function StatusCategorySection(props: {
  projectKey: string;
  category: StatusCategory;
  label: string;
  statuses: Status[];
  inCategory: Status[];
  tickets: Ticket[];
  canChange: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const add = useSubmit(
    () => api.addStatus(props.projectKey, { name, category: props.category }),
    () => {
      setName("");
      props.onChanged();
    },
  );
  return (
    <section className="panel wide status-category" aria-label={props.label}>
      <h2 className="column-head">
        <span className={`dot ${props.category}`} />
        {props.label}
      </h2>
      <ul className="rows">
        {props.inCategory.map((status, position) => (
          <StatusRow
            key={status.id}
            {...props}
            status={status}
            position={position}
            ticketCount={props.tickets.filter((t) => t.status.id === status.id).length}
          />
        ))}
      </ul>
      {props.canChange && (
        <form className="add-status" onSubmit={add.submit}>
          <input aria-label={`New ${props.label} Status`} placeholder="New Status" value={name} required onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={add.busy}>Add</button>
        </form>
      )}
      {add.error && <p className="error" role="alert">{add.error}</p>}
    </section>
  );
}

function StatusRow(props: {
  projectKey: string;
  status: Status;
  position: number;
  statuses: Status[];
  inCategory: Status[];
  ticketCount: number;
  canChange: boolean;
  onChanged: () => void;
}) {
  const s = props.status;
  const [mode, setMode] = useState<"view" | "rename" | "remove">("view");
  const [name, setName] = useState(s.name);
  const others = props.statuses.filter((o) => o.id !== s.id);
  const [chosen, setChosen] = useState<string>();
  // The chosen Status may have been removed since; fall back to the first other one.
  const moveTo = others.some((o) => o.id === chosen) ? chosen! : (others[0]?.id ?? "");
  const done = () => {
    setMode("view");
    props.onChanged();
  };
  const update = useAction((changes: { name?: string; position?: number }) => api.updateStatus(props.projectKey, s.id, changes), done);
  const remove = useAction(async () => {
    try {
      await api.removeStatus(props.projectKey, s.id, props.ticketCount > 0 ? moveTo : undefined);
    } catch (err) {
      // Our Ticket counts may be out of date; reload so the picker shows if Tickets need moving.
      props.onChanged();
      throw err;
    }
  }, done);
  const error = update.error ?? remove.error;

  return (
    <li className="status-row">
      {mode === "rename" ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void update.run({ name });
          }}
        >
          <input aria-label={`Name of ${s.name}`} className="grow" value={name} required onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={update.busy}>Save</button>
          <button type="button" className="secondary" onClick={() => setMode("view")}>Cancel</button>
        </form>
      ) : (
        <div className="row">
          <span className="grow">{s.name}</span>
          <span className="muted">{props.ticketCount} {props.ticketCount === 1 ? "Ticket" : "Tickets"}</span>
          {props.canChange && (
            <>
              <button
                className="link"
                aria-label={`Move ${s.name} up`}
                disabled={props.position === 0 || update.busy}
                onClick={() => void update.run({ position: props.position - 1 })}
              >
                ↑
              </button>
              <button
                className="link"
                aria-label={`Move ${s.name} down`}
                disabled={props.position === props.inCategory.length - 1 || update.busy}
                onClick={() => void update.run({ position: props.position + 1 })}
              >
                ↓
              </button>
              <button
                className="link"
                aria-label={`Rename ${s.name}`}
                onClick={() => {
                  setName(s.name);
                  setMode("rename");
                }}
              >
                Rename
              </button>
              {/* A Status Category keeps at least one Status, so its last can't be removed. */}
              {props.inCategory.length > 1 && (
                <button className="link" aria-label={`Remove ${s.name}`} onClick={() => setMode("remove")}>Remove</button>
              )}
            </>
          )}
        </div>
      )}
      {mode === "remove" && (
        <div className="row remove-status">
          {props.ticketCount > 0 ? (
            <label className="field inline grow">
              <span>Move its Tickets to</span>
              <select value={moveTo} onChange={(e) => setChosen(e.target.value)}>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <span className="grow muted">No Tickets are in {s.name}.</span>
          )}
          <button disabled={remove.busy} onClick={() => void remove.run()}>Remove Status</button>
          <button className="secondary" onClick={() => setMode("view")}>Cancel</button>
        </div>
      )}
      {error && <p className="error row" role="alert">{error}</p>}
    </li>
  );
}

export function StatusPill(props: { status: Status }) {
  return (
    <span className="status-pill">
      <span className={`dot ${props.status.category}`} />
      {props.status.name}
    </span>
  );
}

function PriorityIcon(props: { priority: Priority }) {
  if (props.priority === "none") return null;
  return (
    <span className={`priority ${props.priority}`} title={`Priority: ${PRIORITY_NAMES[props.priority]}`}>
      {PRIORITY_NAMES[props.priority]}
    </span>
  );
}

function LabelChips(props: { labels: string[] }) {
  if (props.labels.length === 0) return null;
  return (
    <span className="chips">
      {props.labels.map((label) => (
        <span key={label} className="chip">{label}</span>
      ))}
    </span>
  );
}

function NewTicket(props: { projectKey: string; onDone: (ticket: Ticket) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const { submit, error, busy } = useSubmit(() => api.createTicket(props.projectKey, { title, description }), props.onDone);
  return (
    <section className="panel wide">
      <h2>New Ticket</h2>
      <form onSubmit={submit}>
        <Field label="Title" value={title} onChange={setTitle} />
        <TextArea label="Description (Markdown)" value={description} onChange={setDescription} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="submit" disabled={busy}>Create Ticket</button>
          <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

/** One Ticket: its description, fields, the Tickets around it, and its history. */
export function TicketPage(props: { ticketKey: string }) {
  const [detail, reload] = useLoad(() => api.ticket(props.ticketKey), [props.ticketKey]);
  return <Show state={detail}>{(d) => <TicketView detail={d} onChanged={reload} />}</Show>;
}

function TicketView(props: { detail: TicketDetail; onChanged: () => void }) {
  const t = props.detail.ticket;
  const [project] = useLoad(() => api.project(t.projectKey), [t.projectKey]);
  const [history, reloadHistory] = useLoad(() => api.ticketHistory(t.key), [t.key]);
  const [editing, setEditing] = useState(false);
  const archived = project.kind === "loaded" && project.value.project.archived;
  const canWrite = project.kind === "loaded" && project.value.project.access === "write";

  const changed = () => {
    props.onChanged();
    reloadHistory();
  };
  const update = useAction((changes: TicketChanges) => api.updateTicket(t.key, changes), changed);

  return (
    <article className="ticket">
      <div className="muted">
        <Link to={archived ? "/archived" : "/"} className="link">Projects</Link> /{" "}
        <Link to={`/projects/${t.projectKey}`} className="link">{t.projectKey}</Link> / {t.key}
      </div>
      {editing ? (
        <EditTicket
          ticket={t}
          onCancel={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            changed();
          }}
        />
      ) : (
        <>
          <div className="page-head">
            <h1>{t.title}</h1>
            {canWrite && <button className="secondary" onClick={() => setEditing(true)}>Edit</button>}
          </div>
          <div className="ticket-fields">
            <Show state={project}>
              {({ statuses }) => (
                <Picker
                  label="Status"
                  value={t.status.id}
                  disabled={update.busy || !canWrite}
                  options={statuses.map((s) => [s.id, s.name])}
                  onChange={(statusId) => void update.run({ statusId })}
                />
              )}
            </Show>
            <Picker
              label="Priority"
              value={t.priority}
              disabled={update.busy || !canWrite}
              options={PRIORITIES.map((p) => [p, PRIORITY_NAMES[p]])}
              onChange={(priority) => void update.run({ priority: priority as Priority })}
            />
            <AssigneePicker ticket={t} disabled={update.busy || !canWrite} onChange={(assigneeId) => void update.run({ assigneeId })} />
            <DelegatePicker ticket={t} disabled={update.busy || !canWrite} onChange={(delegateId) => void update.run({ delegateId })} />
          </div>
          <ClaimLine claim={props.detail.claim} />
          {update.error && <p className="error" role="alert">{update.error}</p>}
          <LabelEditor ticket={t} busy={update.busy} readOnly={!canWrite} onChange={(labels) => void update.run({ labels })} />
          <div className="markdown" data-testid="ticket-description">
            {t.description.trim() ? <CronkMarkdown>{t.description}</CronkMarkdown> : <p className="muted">No description.</p>}
          </div>
        </>
      )}
      <ParentEditor ticket={t} readOnly={!canWrite} onChanged={changed} />
      {props.detail.subTickets.length > 0 && (
        <>
          <h2>Sub-Tickets</h2>
          <TicketRefList name="Sub-Tickets" refs={props.detail.subTickets} />
        </>
      )}
      <RelationsEditor detail={props.detail} readOnly={!canWrite} onChanged={changed} />
      <MentionedIn detail={props.detail} />
      <h2>Timeline</h2>
      {/* Its stream also tells of changes to the Ticket itself: its fields, Claim and History are loaded again. */}
      <TicketTimeline ticketKey={t.key} canWrite={canWrite} onTicketChanged={changed} />
      <h2>History</h2>
      <Show state={history}>
        {(changes) => (
          <ol className="history" aria-label="History">
            {changes.map((change, i) => (
              <li key={i}>
                <span className="muted">{new Date(change.at).toLocaleString()}</span> <strong>{change.actor.name}</strong>
                {change.actor.kind === "agent" && (
                  <span className="muted">
                    {" "}
                    ({change.actor.session ? `${sessionName(change.actor.session.id)}, for` : "Agent of"} {change.actor.owner.name})
                  </span>
                )}{" "}
                {describe(change)}
              </li>
            ))}
          </ol>
        )}
      </Show>
    </article>
  );
}

/** The Reports on a Project's Tickets, newest first. */
function ReportsView(props: { projectKey: string }) {
  const [reports] = useLoad(() => api.projectReports(props.projectKey), [props.projectKey]);
  return (
    <Show state={reports}>
      {(list) =>
        list.length === 0 ? (
          <div className="empty">
            <h2>No Reports yet</h2>
            <p className="muted">Agents write a Report on a Ticket when they hand their work over.</p>
          </div>
        ) : (
          <ul className="rows" aria-label="Reports">
            {list.map((r) => (
              <li key={r.id}>
                <Link to={`/documents/${r.id}`} className="row">
                  <span className="key">{r.ticketKey}</span>
                  <span className="grow">
                    {r.title} <span className="muted">on {r.ticketTitle}</span>
                  </span>
                  <span className="muted">{r.agent.name}</span>
                  <span className="muted">{new Date(r.createdAt).toLocaleDateString()}</span>
                </Link>
              </li>
            ))}
          </ul>
        )
      }
    </Show>
  );
}

function Picker(props: { label: string; value: string; disabled: boolean; options: [string, string][]; onChange: (value: string) => void }) {
  return (
    <label className="field inline">
      <span>{props.label}</span>
      <select value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map(([value, name]) => (
          <option key={value} value={value}>{name}</option>
        ))}
      </select>
    </label>
  );
}

function AssigneePicker(props: { ticket: Ticket; disabled: boolean; onChange: (assigneeId: string | null) => void }) {
  const [users] = useLoad(api.users, []);
  const known = users.kind === "loaded" ? users.value : [];
  const assignee = props.ticket.assignee;
  // Show the current Assignee even before the User list arrives.
  const options: [string, string][] = [
    ["", "Unassigned"],
    ...(assignee && !known.some((u) => u.id === assignee.id) ? [[assignee.id, assignee.name] as [string, string]] : []),
    ...known.filter((u) => u.active).map((u): [string, string] => [u.id, u.name]),
  ];
  return (
    <Picker label="Assignee" value={assignee?.id ?? ""} disabled={props.disabled} options={options} onChange={(id) => props.onChange(id || null)} />
  );
}

/** Picks the Delegate among the Assignee's own Agents; the API refuses anyone else's. */
function DelegatePicker(props: { ticket: Ticket; disabled: boolean; onChange: (delegateId: string | null) => void }) {
  const [agents] = useLoad(() => api.agents(), []);
  const { assignee, delegate } = props.ticket;
  // Only the signed-in User's own Agents are listed to them, so this offers Agents only on their own Tickets.
  const own = agents.kind === "loaded" ? agents.value.filter((a) => a.owner.id === assignee?.id) : [];
  const options: [string, string][] = [
    ["", "Not delegated"],
    ...(delegate && !own.some((a) => a.id === delegate.id) ? [[delegate.id, delegate.name] as [string, string]] : []),
    ...own.map((a): [string, string] => [a.id, a.name]),
  ];
  return (
    <Picker
      label="Delegate"
      value={delegate?.id ?? ""}
      disabled={props.disabled || !assignee}
      options={options}
      onChange={(id) => props.onChange(id || null)}
    />
  );
}

/** Which Agent Session holds the Ticket's Claim, if any, and until when it lasts without a call. */
function ClaimLine(props: { claim: TicketDetail["claim"] }) {
  const { claim } = props;
  return (
    <p className="muted claim" data-testid="ticket-claim">
      {claim
        ? `Claimed by ${claim.agent.name} (${sessionName(claim.session.id)}) since ${new Date(claim.claimedAt).toLocaleString()}; ` +
          `lapses if silent until ${new Date(claim.endsIfSilentAt).toLocaleTimeString()}`
        : "Not Claimed"}
    </p>
  );
}

function LabelEditor(props: { ticket: Ticket; busy: boolean; readOnly: boolean; onChange: (labels: string[]) => void }) {
  const [adding, setAdding] = useState("");
  const labels = props.ticket.labels;
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!adding.trim()) return;
    props.onChange([...labels, adding]);
    setAdding("");
  };
  return (
    <div className="labels">
      {labels.length > 0 && (
        <ul className="chips" aria-label="Labels">
          {labels.map((label) => (
            <li key={label} className="chip">
              {label}
              {!props.readOnly && (
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove ${label}`}
                  disabled={props.busy}
                  onClick={() => props.onChange(labels.filter((l) => l !== label))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!props.readOnly && (
        <form onSubmit={add} className="inline-form">
          <input aria-label="Add Label" placeholder="Add Label" value={adding} onChange={(e) => setAdding(e.target.value)} />
        </form>
      )}
    </div>
  );
}

function ParentEditor(props: { ticket: Ticket; readOnly: boolean; onChanged: () => void }) {
  const [key, setKey] = useState("");
  const set = useAction((parentKey: string | null) => api.updateTicket(props.ticket.key, { parentKey }), () => {
    setKey("");
    props.onChanged();
  });
  const parent = props.ticket.parent;
  return (
    <section className="parent">
      {parent && (
        <p data-testid="ticket-parent">
          Sub-Ticket of{" "}
          <Link to={`/tickets/${parent.key}`} className="link">{parent.key} {parent.title}</Link>{" "}
          {!props.readOnly && <button className="link" onClick={() => void set.run(null)} disabled={set.busy}>Clear</button>}
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
          <input aria-label="Parent" placeholder="Parent Ticket, e.g. CRONK-1" value={key} onChange={(e) => setKey(e.target.value)} required />
          <button type="submit" className="secondary" disabled={set.busy}>Set parent</button>
        </form>
      )}
      {set.error && <p className="error" role="alert">{set.error}</p>}
    </section>
  );
}

function RelationsEditor(props: { detail: TicketDetail; readOnly: boolean; onChanged: () => void }) {
  const t = props.detail.ticket;
  const [kind, setKind] = useState<RelationKind>("blocks");
  const [other, setOther] = useState("");
  const add = useAction(() => api.addRelation(t.key, kind, other.trim()), () => {
    setOther("");
    props.onChanged();
  });
  const remove = useAction((kind: RelationKind, otherKey: string) => api.removeRelation(t.key, kind, otherKey), props.onChanged);
  const lists: [RelationKind, TicketRef[]][] = [
    ["blocks", props.detail.relations.blocks],
    ["blocked_by", props.detail.relations.blockedBy],
    ["relates_to", props.detail.relations.relatesTo],
  ];
  return (
    <section>
      <h2>Relations</h2>
      {lists.map(
        ([listKind, refs]) =>
          refs.length > 0 && (
            <div key={listKind} className="relation-group">
              <h3>{RELATION_NAMES[listKind]}</h3>
              <TicketRefList
                name={RELATION_NAMES[listKind]}
                refs={refs}
                onRemove={props.readOnly ? undefined : (ref) => void remove.run(listKind, ref.key)}
                busy={remove.busy}
              />
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
          <button type="submit" className="secondary" disabled={add.busy}>Add relation</button>
        </form>
      )}
      {(add.error ?? remove.error) && <p className="error" role="alert">{add.error ?? remove.error}</p>}
    </section>
  );
}

/** The Documents, other Tickets' Reports included, that mention the Ticket's key; its own Reports show in its timeline. */
function MentionedIn(props: { detail: TicketDetail }) {
  const mentions = props.detail.documents.filter((d) => d.ticketKey !== props.detail.ticket.key);
  if (mentions.length === 0) return null;
  return (
    <>
      <h2>Mentioned in</h2>
      <ul className="rows" aria-label="Mentioned in">
        {mentions.map((d) => (
          <li key={d.id} className="row">
            <Link to={`/documents/${d.id}`} className="row-link">
              <span className="grow">{d.title}</span>
              <span className="muted">{d.ticketKey ? `Report on ${d.ticketKey}` : (d.projectKey ?? "Workspace")}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function TicketRefList(props: { name: string; refs: TicketRef[]; onRemove?: (ref: TicketRef) => void; busy?: boolean }) {
  return (
    <ul className="rows" aria-label={props.name}>
      {props.refs.map((ref) => (
        <li key={ref.key} className="row">
          <Link to={`/tickets/${ref.key}`} className="row-link">
            <span className="key">{ref.key}</span>
            <span className="grow">{ref.title}</span>
            <StatusPill status={ref.status} />
          </Link>
          {props.onRemove && (
            <button className="link" aria-label={`Remove ${ref.key}`} disabled={props.busy} onClick={() => props.onRemove!(ref)}>
              Remove
            </button>
          )}
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
          <button type="submit" disabled={busy}>Save</button>
          <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

const RELATION_PHRASES: Record<RelationKind, string> = { blocks: "blocking", blocked_by: "blocked by", relates_to: "related to" };

function describe(change: RecordedChange): string {
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
      return change.to ? `assigned it to ${change.to.name}` : "unassigned it";
    case "delegate":
      return change.to ? `delegated it to ${change.to.name}` : `took it back from ${change.from!.name}`;
    case "parent":
      return change.to ? `made it a Sub-Ticket of ${change.to.key}` : `took it out of ${change.from!.key}`;
    case "relation added":
      return `marked it as ${RELATION_PHRASES[change.kind]} ${change.ticket.key}`;
    case "relation removed":
      return `removed that it is ${RELATION_PHRASES[change.kind]} ${change.ticket.key}`;
  }
}
