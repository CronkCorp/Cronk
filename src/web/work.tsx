import { Button } from "./components/button.js";
import { Chip, PRIORITY_NAMES, PriorityTag, StatusPill } from "./components/tags.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { RelativeTime } from "./components/time.js";
import { Actor, agentActor, userActor } from "./components/actor.js";
import { useEffect, useState } from "react";
import { AgentAccessSelect } from "./agents.js";
import {
  api,
  type AgentAccess,
  type Project,
  type Status,
  type StatusCategory,
  type Ticket,
  type TicketFilter,
  type User,
  watchProject,
} from "./api.js";
import { PRIORITIES, STATUS_CATEGORIES } from "../shared/values.js";
import { GuidanceSection } from "./guidance.js";
import { forgetProjectKeys } from "./markdown.js";
import { ProjectAccessPanel } from "./people.js";
import { Link, navigate } from "./router.js";
import { Field, Show, TextArea, useAction, useLoad, useSubmit } from "./ui.js";


const CATEGORY_NAMES: Record<StatusCategory, string> = {
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  in_review: "In Review",
  completed: "Completed",
  canceled: "Canceled",
};


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
              {!creating && <Button onClick={() => setCreating(true)}>New Project</Button>}
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
                    {project.visibility === "private" && <Chip>Private</Chip>}
                    {project.access === "read" && <Chip>Read only</Chip>}
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
          <Button type="submit" disabled={busy}>Create Project</Button>
          <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
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
  const [live, onLive] = useLiveState();
  useEffect(
    () =>
      watchProject(props.projectKey, {
        onLive,
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
                {p.name} {p.archived && <Chip>Archived</Chip>}{" "}
                {p.visibility === "private" && <Chip>Private</Chip>}{" "}
                {p.access === "read" && <Chip>Read only</Chip>}
              </h1>
            </div>
            <div className="actions">
              <LiveIndicator state={live} />
              {p.access === "write" && (
                <AgentAccessSelect value={p.agentAccess} disabled={agentAccess.busy} onChange={(a) => void agentAccess.run(a)} />
              )}
              {props.me.role === "admin" && (
                <Button variant="secondary" onClick={() => setShowAccess(!showAccess)}>Access</Button>
              )}
              {p.access === "write" && (
                <>
                  <Button variant="secondary" onClick={() => archive.submit()} disabled={archive.busy}>
                    {p.archived ? "Restore Project" : "Archive Project"}
                  </Button>
                  {!creating && <Button onClick={() => setCreating(true)}>New Ticket</Button>}
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
                              <PriorityTag priority={ticket.priority} />
                              <span className="key">{ticket.key}</span>
                              <span className="grow">{ticket.title}</span>
                              <LabelChips labels={ticket.labels} />
                              {ticket.assignee && <span className="assignee"><Actor actor={userActor(ticket.assignee.name)} /></span>}
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
                  <PriorityTag priority={ticket.priority} />
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
          <Button type="submit" disabled={add.busy}>Add</Button>
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
          <Button type="submit" disabled={update.busy}>Save</Button>
          <Button type="button" variant="secondary" onClick={() => setMode("view")}>Cancel</Button>
        </form>
      ) : (
        <div className="row">
          <span className="grow">{s.name}</span>
          <span className="muted">{props.ticketCount} {props.ticketCount === 1 ? "Ticket" : "Tickets"}</span>
          {props.canChange && (
            <>
              <Button
                variant="ghost"
                aria-label={`Move ${s.name} up`}
                disabled={props.position === 0 || update.busy}
                onClick={() => void update.run({ position: props.position - 1 })}
              >
                ↑
              </Button>
              <Button
                variant="ghost"
                aria-label={`Move ${s.name} down`}
                disabled={props.position === props.inCategory.length - 1 || update.busy}
                onClick={() => void update.run({ position: props.position + 1 })}
              >
                ↓
              </Button>
              <Button
                variant="ghost"
                aria-label={`Rename ${s.name}`}
                onClick={() => {
                  setName(s.name);
                  setMode("rename");
                }}
              >
                Rename
              </Button>
              {/* A Status Category keeps at least one Status, so its last can't be removed. */}
              {props.inCategory.length > 1 && (
                <Button variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => setMode("remove")}>Remove</Button>
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
          <Button disabled={remove.busy} onClick={() => void remove.run()}>Remove Status</Button>
          <Button variant="secondary" onClick={() => setMode("view")}>Cancel</Button>
        </div>
      )}
      {error && <p className="error row" role="alert">{error}</p>}
    </li>
  );
}

function LabelChips(props: { labels: string[] }) {
  if (props.labels.length === 0) return null;
  return (
    <span className="chips">
      {props.labels.map((label) => (
        <Chip key={label}>{label}</Chip>
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
          <Button type="submit" disabled={busy}>Create Ticket</Button>
          <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
        </div>
      </form>
    </section>
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
                  <Actor actor={agentActor(r.agent, r.session)} owner={false} />
                  <RelativeTime at={r.createdAt} />
                </Link>
              </li>
            ))}
          </ul>
        )
      }
    </Show>
  );
}
