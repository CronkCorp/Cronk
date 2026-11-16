import { Button } from "./components/button.js";
import { ConfirmDialog, Menu } from "./components/overlays.js";
import { Chip, PRIORITY_NAMES, PriorityTag, StatusDot } from "./components/tags.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { RelativeTime } from "./components/time.js";
import { Actor, Avatar, agentActor, userActor } from "./components/actor.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AgentAccessSelect } from "./agents.js";
import {
  api,
  projectExportUrl,
  type Agent,
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

export type ProjectView = "list" | "board" | "reports" | "settings";

/** The sections of a Project's settings, in the order the settings view shows them. */
export type SettingsSection = "access" | "agent-access" | "autonomous-delegation" | "statuses" | "guidance";

/**
 * The view a Project page's `view` parameter asks for, and the settings section it lands on. Statuses and
 * Guidance were views of their own, so their old addresses open the settings at their section.
 */
export function projectViewOf(view: string | null): { view: ProjectView; section?: SettingsSection } {
  if (view === "board" || view === "reports" || view === "settings") return { view };
  if (view === "statuses" || view === "guidance") return { view: "settings", section: view };
  return { view: "list" };
}

/** Whether a view shows the Project's Tickets, and so takes a filter: the list and the board do. */
const showsTickets = (view: ProjectView) => view === "list" || view === "board";

/** The filter fields a Project page keeps in its address, in the order the filter bar shows them. */
const FILTER_FIELDS = ["status", "category", "assignee", "delegate", "priority", "label"] as const;

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
 * filters in its address; its Reports; or its settings.
 */
export function ProjectPage(props: { projectKey: string; view: ProjectView; section?: SettingsSection; filter: TicketFilter; me: User }) {
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
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  // The board's collapsed columns the User opened; kept while they stay on the page, never stored.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const agentAccess = useAction(
    async (access: AgentAccess) => {
      if (project.kind !== "loaded") throw new Error("The Project hasn't loaded");
      return { ...project.value, project: await api.updateProject(props.projectKey, { agentAccess: access }) };
    },
    setProject,
  );
  const autonomousByDefault = useAction(
    async (on: boolean) => {
      if (project.kind !== "loaded") throw new Error("The Project hasn't loaded");
      return { ...project.value, project: await api.updateProject(props.projectKey, { autonomousByDefault: on }) };
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
          <div className="muted crumbs">
            <Link to={p.archived ? "/archived" : "/"} className="link">Projects</Link> /{" "}
            {props.view === "settings" ? (
              <>
                <Link to={projectPath(p.key, "list", {})} className="link">{p.key}</Link> / Settings
              </>
            ) : (
              p.key
            )}
          </div>
          <div className="page-head" data-testid="page-head">
            <h1>
              {p.name} {p.archived && <Chip>Archived</Chip>}{" "}
              {p.visibility === "private" && <Chip>Private</Chip>}{" "}
              {p.access === "read" && <Chip>Read only</Chip>}
            </h1>
            <div className="actions">
              <LiveIndicator state={live} />
              <ViewSwitcher projectKey={p.key} view={props.view} filter={props.filter} />
              <Menu
                label="Project actions"
                trigger={<Button variant="secondary" aria-label="Project actions">…</Button>}
                items={[
                  { label: "Documents", onSelect: () => navigate(`/projects/${p.key}/documents`) },
                  // Everyone who sees the Project may read its settings; only Write access changes them or archives it.
                  { label: "Project settings", onSelect: () => navigate(projectPath(p.key, "settings", {})) },
                  // Only an Admin may export; the archive downloads as an attachment.
                  ...(props.me.role === "admin" ? [{ label: "Export Project", onSelect: () => window.location.assign(projectExportUrl(p.key)) }] : []),
                  ...(p.access === "write"
                    ? [{ label: archiveOrRestore(p).label, danger: !p.archived, onSelect: () => setConfirmingArchive(true) }]
                    : []),
                ]}
              />
              {p.access === "write" && !creating && <Button onClick={() => setCreating(true)}>New Ticket</Button>}
            </div>
            <ConfirmDialog
              open={confirmingArchive}
              onOpenChange={setConfirmingArchive}
              title={`${archiveOrRestore(p).verb} ${p.name}?`}
              description={archiveOrRestore(p).description}
              confirmLabel={archiveOrRestore(p).label}
              busy={archive.busy}
              onConfirm={() => {
                void archive.submit().finally(() => setConfirmingArchive(false));
              }}
            />
          </div>
          {archive.error && <p className="error" role="alert">{archive.error}</p>}
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
          {showsTickets(props.view) && (
            <FilterBar
              me={props.me}
              projectKey={p.key}
              statuses={statuses}
              filter={props.filter}
              onChange={(filter) => navigate(projectPath(p.key, props.view, filter))}
            />
          )}
          {props.view === "reports" && <ReportsView projectKey={p.key} />}
          {props.view !== "reports" && (
            <Show state={tickets}>
              {(list) =>
                props.view === "settings" ? (
                  <div className="settings">
                    {props.me.role === "admin" && (
                      <SettingsPart id="access" title="Access" landOn={props.section}>
                        <ProjectAccessPanel project={p} onProjectChanged={(updated) => setProject({ project: updated, statuses })} />
                      </SettingsPart>
                    )}
                    <SettingsPart id="agent-access" title="Agent Access" landOn={props.section}>
                      <div className="panel wide">
                        <p className="muted">The most Agents may do in this Project. An Agent never gets more than its Owner has.</p>
                        <AgentAccessSelect
                          value={p.agentAccess}
                          disabled={p.access !== "write" || agentAccess.busy}
                          onChange={(a) => void agentAccess.run(a)}
                        />
                        {agentAccess.error && <p className="error" role="alert">{agentAccess.error}</p>}
                      </div>
                    </SettingsPart>
                    <SettingsPart id="autonomous-delegation" title="Autonomous Delegation" landOn={props.section}>
                      <div className="panel wide">
                        <p className="muted">
                          Whether delegating one of this Project's Tickets lets the Agent complete it itself, rather than stopping at In Review.
                          Each completion stays Unverified until a User Accepts it. You can still change it on each Ticket.
                        </p>
                        <label className="field inline">
                          <span>When delegating</span>
                          <select
                            value={p.autonomousByDefault ? "on" : "off"}
                            disabled={p.access !== "write" || autonomousByDefault.busy}
                            onChange={(e) => void autonomousByDefault.run(e.target.value === "on")}
                          >
                            <option value="off">Stops at In Review</option>
                            <option value="on">Autonomous</option>
                          </select>
                        </label>
                        {autonomousByDefault.error && <p className="error" role="alert">{autonomousByDefault.error}</p>}
                      </div>
                    </SettingsPart>
                    <SettingsPart id="statuses" title="Statuses" landOn={props.section}>
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
                    </SettingsPart>
                    <SettingsPart id="guidance" title="Guidance" landOn={props.section}>
                      <div className="panel wide">
                        <GuidanceSection
                          projectKey={p.key}
                          canEdit={p.access === "write"}
                          intro="Standing instructions for Agents working in this Project, on top of the Workspace Guidance. Every Agent Session gets them when it connects."
                        />
                      </div>
                    </SettingsPart>
                  </div>
                ) : (
                  <>
                    {list.length === 0 && filtered && (
                      <div className="empty">
                        <h2>No Tickets match these filters</h2>
                        <Link to={projectPath(p.key, props.view, {})} className="link">Clear filters</Link>
                      </div>
                    )}
                    {props.view === "board" ? (
                      <Board
                        statuses={statuses}
                        tickets={list}
                        expanded={expanded}
                        onToggle={(id) =>
                          setExpanded((now) => {
                            const next = new Set(now);
                            if (!next.delete(id)) next.add(id);
                            return next;
                          })
                        }
                      />
                    ) : list.length === 0 ? (
                      !filtered && <div className="empty"><h2>No Tickets yet</h2></div>
                    ) : (
                      <ul className="rows" aria-label="Tickets">
                        {list.map((ticket) => (
                          <li key={ticket.key}>
                            <Link to={`/tickets/${ticket.key}`} className="row ticket-row">
                              <StatusDot status={ticket.status} />
                              <span className="key">{ticket.key}</span>
                              <span className="grow">{ticket.title}</span>
                              <LabelChips labels={ticket.labels} />
                              <PriorityTag priority={ticket.priority} />
                              <TicketPeople ticket={ticket} />
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

/** What the … menu's Archive and Restore items, and the dialog confirming them, say. */
const ARCHIVE = {
  verb: "Archive",
  label: "Archive Project",
  description: "It leaves the sidebar and the Projects page, and moves to Archived Projects. It can be restored.",
};
const RESTORE = { verb: "Restore", label: "Restore Project", description: "It comes back to the sidebar and the Projects page." };
const archiveOrRestore = (project: Project) => (project.archived ? RESTORE : ARCHIVE);

/** One section of a Project's settings, which scrolls into view when the address asks to land on it. */
function SettingsPart(props: { id: SettingsSection; title: string; landOn: SettingsSection | undefined; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const landing = props.landOn === props.id;
  useEffect(() => {
    if (landing) ref.current?.scrollIntoView({ block: "start" });
  }, [landing]);
  return (
    <section ref={ref} className="settings-section" aria-label={props.title}>
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

/** List, Board and Reports as a segmented control; List and Board keep the filter between them. */
function ViewSwitcher(props: { projectKey: string; view: ProjectView; filter: TicketFilter }) {
  const views: [ProjectView, string][] = [["list", "List"], ["board", "Board"], ["reports", "Reports"]];
  return (
    <nav className="segmented" aria-label="View">
      {views.map(([view, name]) => (
        <Link
          key={view}
          to={projectPath(props.projectKey, view, props.filter)}
          className={props.view === view ? "segment active" : "segment"}
          {...(props.view === view ? { "aria-current": "page" as const } : {})}
        >
          {name}
        </Link>
      ))}
    </nav>
  );
}

function FilterBar(props: { me: User; projectKey: string; statuses: Status[]; filter: TicketFilter; onChange: (filter: TicketFilter) => void }) {
  const [users] = useLoad(api.users, []);
  const [labels] = useLoad(() => api.labels(props.projectKey), [props.projectKey]);
  // An Admin sees every User's Agents; anyone else, their own.
  const everyone = props.me.role === "admin";
  const [agents] = useLoad(() => api.agents(everyone), [everyone]);
  const set = (field: keyof TicketFilter) => (value: string) => {
    const { [field]: _, ...rest } = props.filter;
    props.onChange(value ? { ...rest, [field]: value } : rest);
  };
  const loaded = <T,>(state: { kind: string; value?: T }) => (state.kind === "loaded" ? state.value! : undefined);
  const labelList = loaded<string[]>(labels) ?? [];
  // Keep a filtered Label selectable even when no Ticket has it any more.
  const labelOptions = props.filter.label && !labelList.includes(props.filter.label) ? [props.filter.label, ...labelList] : labelList;
  // A filtered Agent the User can't list stays selectable.
  const agentOptions = (loaded<Agent[]>(agents) ?? []).map((a): [string, string] => [
    a.id,
    a.owner.id === props.me.id ? a.name : `${a.name} (${a.owner.name})`,
  ]);
  if (props.filter.delegate && props.filter.delegate !== "none" && !agentOptions.some(([id]) => id === props.filter.delegate)) {
    agentOptions.unshift([props.filter.delegate, "Another User's Agent"]);
  }

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
        name="Delegate"
        value={props.filter.delegate}
        onChange={set("delegate")}
        options={[["none", "Not delegated"], ...agentOptions]}
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

/** The Status Categories whose columns start collapsed to their count, so the open work fits the screen. */
const COLLAPSED_CATEGORIES: ReadonlySet<StatusCategory> = new Set(["completed", "canceled"]);

/**
 * The Tickets in one column per Status, filling the main column. Completed and Canceled columns start collapsed
 * to their dot and count; `expanded` holds the ones the User opened, for as long as they stay on the page.
 */
function Board(props: { statuses: Status[]; tickets: Ticket[]; expanded: ReadonlySet<string>; onToggle: (statusId: string) => void }) {
  return (
    <div className="board" role="group" aria-label="Board">
      {props.statuses.map((status) => {
        const inStatus = props.tickets.filter((t) => t.status.id === status.id);
        const collapsible = COLLAPSED_CATEGORIES.has(status.category);
        const open = !collapsible || props.expanded.has(status.id);
        const count = `${inStatus.length} ${inStatus.length === 1 ? "Ticket" : "Tickets"}`;
        const head = (
          <>
            <span className={`dot ${status.category}`} aria-hidden="true" />
            {open && <span className="column-name">{status.name}</span>}
            <span className="muted">{inStatus.length}</span>
          </>
        );
        return (
          <section key={status.id} className={open ? "column" : "column collapsed"} aria-label={status.name}>
            <h3 className="column-head">
              {collapsible ? (
                <button
                  type="button"
                  className="column-toggle"
                  aria-expanded={open}
                  aria-label={`${status.name}, ${count}`}
                  title={open ? `Collapse ${status.name}` : `${status.name}: ${count}`}
                  onClick={() => props.onToggle(status.id)}
                >
                  {head}
                </button>
              ) : (
                head
              )}
            </h3>
            {open &&
              inStatus.map((ticket) => (
                <Link key={ticket.key} to={`/tickets/${ticket.key}`} className="card">
                  <span className="card-head">
                    <span className="key">{ticket.key}</span>
                    <PriorityTag priority={ticket.priority} />
                  </span>
                  <span>{ticket.title}</span>
                  <span className="card-foot">
                    <LabelChips labels={ticket.labels} />
                    <TicketPeople ticket={ticket} />
                  </span>
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
      <h3 className="column-head">
        <span className={`dot ${props.category}`} />
        {props.label}
      </h3>
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

/** Who has a Ticket, as avatars: its Delegate (an Agent, square and violet), then its Assignee. */
function TicketPeople(props: { ticket: Ticket }) {
  const { assignee, delegate } = props.ticket;
  if (!assignee && !delegate) return null;
  return (
    <span className="people">
      {delegate && <Avatar actor={agentActor(delegate)} label={`Delegate: ${delegate.name}`} />}
      {assignee && <Avatar actor={userActor(assignee.name)} label={`Assignee: ${assignee.name}`} />}
    </span>
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
