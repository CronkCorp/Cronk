import { useState } from "react";
import Markdown from "react-markdown";
import { api, type RecordedChange, type Project, type Status, type Ticket } from "./api.js";
import { Link, navigate } from "./router.js";
import { Field, messageOf, Show, TextArea, useLoad, useSubmit } from "./ui.js";

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

/** One Project's Tickets, as a list or as a board grouped by Status. */
export function ProjectPage(props: { projectKey: string; view: "list" | "board" }) {
  const [project, , setProject] = useLoad(() => api.project(props.projectKey), [props.projectKey]);
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
          </nav>
          <Show state={tickets}>
            {(list) =>
              props.view === "board" ? (
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
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const move = async (statusId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      props.onChanged(await api.updateTicket(props.ticket.key, { statusId }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
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
