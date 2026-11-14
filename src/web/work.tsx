import { useState, type FormEvent } from "react";
import {
  api,
  PRIORITIES,
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
} from "./api.js";
import { CronkMarkdown, forgetProjectKeys } from "./markdown.js";
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
                    <span>{project.name}</span>
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

/** A Project page's address for a view and filter. */
function projectPath(projectKey: string, view: "list" | "board", filter: TicketFilter): string {
  const query = new URLSearchParams();
  if (view === "board") query.set("view", "board");
  for (const field of FILTER_FIELDS) if (filter[field]) query.set(field, filter[field]);
  return `/projects/${projectKey}${query.size ? `?${query}` : ""}`;
}

/** One Project's Tickets, as a list or as a board grouped by Status, narrowed by the filters in its address. */
export function ProjectPage(props: { projectKey: string; view: "list" | "board"; filter: TicketFilter }) {
  const filterKey = JSON.stringify(props.filter);
  const [project, , setProject] = useLoad(() => api.project(props.projectKey), [props.projectKey]);
  const [tickets, reloadTickets] = useLoad(() => api.tickets(props.projectKey, props.filter), [props.projectKey, filterKey]);
  const [creating, setCreating] = useState(false);
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
                {p.name} {p.archived && <span className="badge">Archived</span>}
              </h1>
            </div>
            <div className="actions">
              <button className="secondary" onClick={() => archive.submit()} disabled={archive.busy}>
                {p.archived ? "Restore Project" : "Archive Project"}
              </button>
              {!creating && <button onClick={() => setCreating(true)}>New Ticket</button>}
            </div>
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
          <nav className="tabs" aria-label="View">
            <Link to={projectPath(p.key, "list", props.filter)} className={props.view === "list" ? "tab active" : "tab"}>List</Link>
            <Link to={projectPath(p.key, "board", props.filter)} className={props.view === "board" ? "tab active" : "tab"}>Board</Link>
          </nav>
          <FilterBar
            projectKey={p.key}
            statuses={statuses}
            filter={props.filter}
            onChange={(filter) => navigate(projectPath(p.key, props.view, filter))}
          />
          <Show state={tickets}>
            {(list) => (
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
            )}
          </Show>
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

function FilterSelect(props: { name: string; value: string | undefined; onChange: (value: string) => void; options: [string, string][] }) {
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

function StatusPill(props: { status: Status }) {
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
            <button className="secondary" onClick={() => setEditing(true)}>Edit</button>
          </div>
          <div className="ticket-fields">
            <Show state={project}>
              {({ statuses }) => (
                <Picker
                  label="Status"
                  value={t.status.id}
                  busy={update.busy}
                  options={statuses.map((s) => [s.id, s.name])}
                  onChange={(statusId) => void update.run({ statusId })}
                />
              )}
            </Show>
            <Picker
              label="Priority"
              value={t.priority}
              busy={update.busy}
              options={PRIORITIES.map((p) => [p, PRIORITY_NAMES[p]])}
              onChange={(priority) => void update.run({ priority: priority as Priority })}
            />
            <AssigneePicker ticket={t} busy={update.busy} onChange={(assigneeId) => void update.run({ assigneeId })} />
          </div>
          {update.error && <p className="error" role="alert">{update.error}</p>}
          <LabelEditor ticket={t} busy={update.busy} onChange={(labels) => void update.run({ labels })} />
          <div className="markdown" data-testid="ticket-description">
            {t.description.trim() ? <CronkMarkdown>{t.description}</CronkMarkdown> : <p className="muted">No description.</p>}
          </div>
        </>
      )}
      <ParentEditor ticket={t} onChanged={changed} />
      {props.detail.subTickets.length > 0 && (
        <>
          <h2>Sub-Tickets</h2>
          <TicketRefList name="Sub-Tickets" refs={props.detail.subTickets} />
        </>
      )}
      <RelationsEditor detail={props.detail} onChanged={changed} />
      <h2>History</h2>
      <Show state={history}>
        {(changes) => (
          <ol className="history" aria-label="History">
            {changes.map((change, i) => (
              <li key={i}>
                <span className="muted">{new Date(change.at).toLocaleString()}</span> <strong>{change.actor.name}</strong>{" "}
                {describe(change)}
              </li>
            ))}
          </ol>
        )}
      </Show>
    </article>
  );
}

function Picker(props: { label: string; value: string; busy: boolean; options: [string, string][]; onChange: (value: string) => void }) {
  return (
    <label className="field inline">
      <span>{props.label}</span>
      <select value={props.value} disabled={props.busy} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map(([value, name]) => (
          <option key={value} value={value}>{name}</option>
        ))}
      </select>
    </label>
  );
}

function AssigneePicker(props: { ticket: Ticket; busy: boolean; onChange: (assigneeId: string | null) => void }) {
  const [users] = useLoad(api.users, []);
  const known = users.kind === "loaded" ? users.value : [];
  const assignee = props.ticket.assignee;
  // Show the current Assignee even before the User list arrives.
  const options: [string, string][] = [
    ["", "Unassigned"],
    ...(assignee && !known.some((u) => u.id === assignee.id) ? [[assignee.id, assignee.name] as [string, string]] : []),
    ...known.map((u): [string, string] => [u.id, u.name]),
  ];
  return (
    <Picker label="Assignee" value={assignee?.id ?? ""} busy={props.busy} options={options} onChange={(id) => props.onChange(id || null)} />
  );
}

function LabelEditor(props: { ticket: Ticket; busy: boolean; onChange: (labels: string[]) => void }) {
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
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${label}`}
                disabled={props.busy}
                onClick={() => props.onChange(labels.filter((l) => l !== label))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="inline-form">
        <input aria-label="Add Label" placeholder="Add Label" value={adding} onChange={(e) => setAdding(e.target.value)} />
      </form>
    </div>
  );
}

function ParentEditor(props: { ticket: Ticket; onChanged: () => void }) {
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
          <button className="link" onClick={() => void set.run(null)} disabled={set.busy}>Clear</button>
        </p>
      )}
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
      {set.error && <p className="error" role="alert">{set.error}</p>}
    </section>
  );
}

function RelationsEditor(props: { detail: TicketDetail; onChanged: () => void }) {
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
                onRemove={(ref) => void remove.run(listKind, ref.key)}
                busy={remove.busy}
              />
            </div>
          ),
      )}
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
      {(add.error ?? remove.error) && <p className="error" role="alert">{add.error ?? remove.error}</p>}
    </section>
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
    case "parent":
      return change.to ? `made it a Sub-Ticket of ${change.to.key}` : `took it out of ${change.from!.key}`;
    case "relation added":
      return `marked it as ${RELATION_PHRASES[change.kind]} ${change.ticket.key}`;
    case "relation removed":
      return `removed that it is ${RELATION_PHRASES[change.kind]} ${change.ticket.key}`;
  }
}
