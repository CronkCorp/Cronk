import { useState } from "react";
import Markdown from "react-markdown";
import { api, STATUS_CATEGORIES, type RecordedChange, type Project, type Status, type StatusCategory, type Ticket } from "./api.js";
import { Link, navigate } from "./router.js";
import { Field, Show, TextArea, useAction, useLoad, useSubmit } from "./ui.js";

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
          onDone={(project) => navigate(`/projects/${project.key}`)}
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

export type ProjectView = "list" | "board" | "statuses";

/** One Project's Tickets, as a list or as a board grouped by Status, or its Statuses to tailor. */
export function ProjectPage(props: { projectKey: string; view: ProjectView }) {
  const [project, reloadProject, setProject] = useLoad(() => api.project(props.projectKey), [props.projectKey]);
  const [tickets, reloadTickets] = useLoad(() => api.tickets(props.projectKey), [props.projectKey]);
  const [creating, setCreating] = useState(false);
  const archive = useSubmit(
    async () => {
      if (project.kind !== "loaded") throw new Error("The Project hasn't loaded");
      return { ...project.value, project: await api.updateProject(props.projectKey, { archived: !project.value.project.archived }) };
    },
    setProject,
  );

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
            <Link to={`/projects/${p.key}`} className={props.view === "list" ? "tab active" : "tab"}>List</Link>
            <Link to={`/projects/${p.key}?view=board`} className={props.view === "board" ? "tab active" : "tab"}>Board</Link>
            <Link to={`/projects/${p.key}?view=statuses`} className={props.view === "statuses" ? "tab active" : "tab"}>Statuses</Link>
          </nav>
          <Show state={tickets}>
            {(list) =>
              props.view === "statuses" ? (
                <StatusesView
                  projectKey={p.key}
                  statuses={statuses}
                  tickets={list}
                  onChanged={() => {
                    reloadProject();
                    reloadTickets();
                  }}
                />
              ) : props.view === "board" ? (
                <Board statuses={statuses} tickets={list} />
              ) : list.length === 0 ? (
                <div className="empty"><h2>No Tickets yet</h2></div>
              ) : (
                <ul className="rows" aria-label="Tickets">
                  {list.map((ticket) => (
                    <li key={ticket.key}>
                      <Link to={`/tickets/${ticket.key}`} className="row">
                        <span className="key">{ticket.key}</span>
                        <span className="grow">{ticket.title}</span>
                        <StatusPill status={ticket.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            }
          </Show>
        </section>
      )}
    </Show>
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
                <span className="key">{ticket.key}</span>
                <span>{ticket.title}</span>
              </Link>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** The Project's Statuses by Status Category, to add, rename, reorder and remove. */
function StatusesView(props: { projectKey: string; statuses: Status[]; tickets: Ticket[]; onChanged: () => void }) {
  return (
    <div className="status-categories">
      {STATUS_CATEGORIES.map(([category, label]) => (
        <StatusCategorySection
          key={category}
          {...props}
          category={category}
          label={label}
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
      <form className="add-status" onSubmit={add.submit}>
        <input aria-label={`New ${props.label} Status`} placeholder="New Status" value={name} required onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={add.busy}>Add</button>
      </form>
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
  onChanged: () => void;
}) {
  const s = props.status;
  const [mode, setMode] = useState<"view" | "rename" | "remove">("view");
  const [name, setName] = useState(s.name);
  const others = props.statuses.filter((o) => o.id !== s.id);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
  const done = () => {
    setMode("view");
    props.onChanged();
  };
  const update = useAction((changes: { name?: string; position?: number }) => api.updateStatus(props.projectKey, s.id, changes), done);
  const remove = useAction(() => api.removeStatus(props.projectKey, s.id, props.ticketCount > 0 ? moveTo : undefined), done);
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
          <button className="link" aria-label={`Rename ${s.name}`} onClick={() => setMode("rename")}>Rename</button>
          <button className="link" aria-label={`Remove ${s.name}`} onClick={() => setMode("remove")}>Remove</button>
        </div>
      )}
      {mode === "remove" && (
        <div className="row remove-status">
          {props.ticketCount > 0 ? (
            <label className="field inline grow">
              <span>Move its Tickets to</span>
              <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
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

function StatusPill(props: { status: Status }) {
  return (
    <span className="status-pill">
      <span className={`dot ${props.status.category}`} />
      {props.status.name}
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

/** One Ticket: its description, Status and history. */
export function TicketPage(props: { ticketKey: string }) {
  const [ticket, , setTicket] = useLoad(() => api.ticket(props.ticketKey), [props.ticketKey]);
  return <Show state={ticket}>{(t) => <TicketView ticket={t} onChanged={setTicket} />}</Show>;
}

function TicketView(props: { ticket: Ticket; onChanged: (ticket: Ticket) => void }) {
  const t = props.ticket;
  const [project] = useLoad(() => api.project(t.projectKey), [t.projectKey]);
  const [history, reloadHistory] = useLoad(() => api.ticketHistory(t.key), [t.key]);
  const [editing, setEditing] = useState(false);
  const archived = project.kind === "loaded" && project.value.project.archived;

  const changed = (updated: Ticket) => {
    props.onChanged(updated);
    reloadHistory();
  };

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
          onDone={(updated) => {
            setEditing(false);
            changed(updated);
          }}
        />
      ) : (
        <>
          <div className="page-head">
            <h1>{t.title}</h1>
            <button className="secondary" onClick={() => setEditing(true)}>Edit</button>
          </div>
          <Show state={project}>
            {({ statuses }) => <StatusPicker ticket={t} statuses={statuses} onChanged={changed} />}
          </Show>
          <div className="markdown" data-testid="ticket-description">
            {t.description.trim() ? <Markdown>{t.description}</Markdown> : <p className="muted">No description.</p>}
          </div>
        </>
      )}
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

function StatusPicker(props: { ticket: Ticket; statuses: Status[]; onChanged: (ticket: Ticket) => void }) {
  const { run: move, error, busy } = useAction(
    (statusId: string) => api.updateTicket(props.ticket.key, { statusId }),
    props.onChanged,
  );
  return (
    <div className="status-picker">
      <label className="field inline">
        <span>Status</span>
        <select value={props.ticket.status.id} disabled={busy} onChange={(e) => void move(e.target.value)}>
          {props.statuses.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
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
  }
}
