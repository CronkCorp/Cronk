import { useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  sessionName,
  staleVersionOf,
  type Document,
  type DocumentTreeEntry,
  type RecordedActor,
  type Version,
} from "./api.js";
import { CronkMarkdown } from "./markdown.js";
import { Link, navigate } from "./router.js";
import { Field, Show, TextArea, messageOf, useAction, useLoad, useSubmit } from "./ui.js";

/** The address of a page tree: a Project's, or the Workspace's without a Project key. */
const treeAddress = (projectKey: string | null | undefined) => (projectKey ? `/projects/${projectKey}/documents` : "/documents");

/** Whether the signed-in User may change Documents in a Project's tree, or the Workspace's (every User may). */
function useCanWrite(projectKey: string | null | undefined): boolean {
  const [project] = useLoad(() => (projectKey ? api.project(projectKey) : Promise.resolve(undefined)), [projectKey]);
  if (!projectKey) return true;
  return project.kind === "loaded" && project.value?.project.access === "write";
}

function Breadcrumb(props: { projectKey: string | null | undefined; children?: ReactNode }) {
  return (
    <div className="muted">
      {props.projectKey ? (
        <>
          <Link to="/" className="link">Projects</Link> / <Link to={`/projects/${props.projectKey}`} className="link">{props.projectKey}</Link> /{" "}
          <Link to={treeAddress(props.projectKey)} className="link">Documents</Link>
        </>
      ) : (
        <Link to="/documents" className="link">Workspace Documents</Link>
      )}
      {props.children}
    </div>
  );
}

/** A Project's page tree, or the Workspace's without a Project key. */
export function DocumentsPage(props: { projectKey?: string }) {
  const [tree] = useLoad(() => api.documentTree(props.projectKey), [props.projectKey]);
  const canWrite = useCanWrite(props.projectKey);
  const [creating, setCreating] = useState(false);
  return (
    <section>
      <div className="page-head">
        <div>
          {props.projectKey && (
            <div className="muted">
              <Link to="/" className="link">Projects</Link> / <Link to={`/projects/${props.projectKey}`} className="link">{props.projectKey}</Link>
            </div>
          )}
          <h1>{props.projectKey ? "Documents" : "Workspace Documents"}</h1>
        </div>
        {canWrite && !creating && (
          <div className="actions">
            <button onClick={() => setCreating(true)}>New Document</button>
          </div>
        )}
      </div>
      {creating && <NewDocument projectKey={props.projectKey} onCancel={() => setCreating(false)} />}
      <Show state={tree}>
        {(entries) =>
          entries.length === 0 ? (
            <div className="empty"><h2>No Documents yet</h2></div>
          ) : (
            <ul className="rows page-tree" aria-label="Documents">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <Link to={`/documents/${entry.id}`} className={`row depth-${Math.min(entry.depth, 6)}`}>
                    <span className="grow">{entry.title}</span>
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

function NewDocument(props: { projectKey: string | undefined; parentId?: string; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const { submit, error, busy } = useSubmit(
    () => api.createDocument(props.projectKey, { title, ...(props.parentId && { parentId: props.parentId }) }),
    (document) => navigate(`/documents/${document.id}?edit=1`),
  );
  return (
    <section className="panel">
      <h2>{props.parentId ? "New sub-Document" : "New Document"}</h2>
      <form onSubmit={submit}>
        <Field label="Title" value={title} onChange={setTitle} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="submit" disabled={busy}>Create Document</button>
          <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

export function DocumentPage(props: { id: string; edit: boolean }) {
  const [document, reload, setDocument] = useLoad(() => api.document(props.id), [props.id]);
  return (
    <Show state={document}>
      {(d) => <DocumentView key={d.id} document={d} startEditing={props.edit} onChanged={setDocument} onReload={reload} />}
    </Show>
  );
}

type Panel = "none" | "edit" | "move" | "versions" | "new";

function DocumentView(props: { document: Document; startEditing: boolean; onChanged: (d: Document) => void; onReload: () => void }) {
  const d = props.document;
  const canWrite = useCanWrite(d.projectKey);
  const [panel, setPanel] = useState<Panel>(props.startEditing ? "edit" : "none");
  const remove = useAction(
    async () => {
      if (!confirm(`Delete ${d.title} and all its Versions?`)) return false;
      await api.deleteDocument(d.id);
      return true;
    },
    (deleted) => deleted && navigate(treeAddress(d.projectKey)),
  );
  const toggle = (p: Panel) => setPanel(panel === p ? "none" : p);

  return (
    <article className="document">
      <Breadcrumb projectKey={d.projectKey} />
      {panel === "edit" ? (
        <EditDocument
          document={d}
          onCancel={() => setPanel("none")}
          onSaved={(saved) => {
            props.onChanged(saved);
            setPanel("none");
          }}
        />
      ) : (
        <>
          <div className="page-head">
            <h1>{d.title}</h1>
            <div className="actions">
              <span className="muted">Version {d.version}</span>
              <button className="secondary" onClick={() => toggle("versions")}>Versions</button>
              {canWrite && (
                <>
                  <button className="secondary" onClick={() => toggle("move")}>Move</button>
                  <button className="secondary" onClick={() => toggle("new")}>New sub-Document</button>
                  <button className="secondary" onClick={() => void remove.run()} disabled={remove.busy}>Delete</button>
                  <button onClick={() => setPanel("edit")}>Edit</button>
                </>
              )}
            </div>
          </div>
          {remove.error && <p className="error" role="alert">{remove.error}</p>}
          {panel === "new" && <NewDocument projectKey={d.projectKey ?? undefined} parentId={d.id} onCancel={() => setPanel("none")} />}
          {panel === "move" && (
            <MoveDocument
              document={d}
              onCancel={() => setPanel("none")}
              onMoved={(moved) => {
                props.onChanged(moved);
                setPanel("none");
              }}
            />
          )}
          {panel === "versions" && <Versions document={d} canWrite={canWrite} onRestored={props.onChanged} />}
          <div className="markdown" data-testid="document-body">
            {d.body.trim() ? <CronkMarkdown>{d.body}</CronkMarkdown> : <p className="muted">This Document is empty.</p>}
          </div>
        </>
      )}
    </article>
  );
}

/**
 * Edits a Document's title and Markdown. The save names the Version editing started from; if
 * someone saved since, it is refused and the editor shows their Version so the User can merge.
 */
function EditDocument(props: { document: Document; onSaved: (d: Document) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(props.document.title);
  const [body, setBody] = useState(props.document.body);
  const [base, setBase] = useState(props.document.version);
  const [theirs, setTheirs] = useState<Version>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      props.onSaved(await api.saveDocument(props.document.id, { baseVersion: base, title, body }));
    } catch (err) {
      const current = staleVersionOf(err);
      if (current) setTheirs(current);
      else setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  const keepMine = (current: Version) => {
    setBase(current.number);
    setTheirs(undefined);
  };
  const takeTheirs = (current: Version) => {
    setTitle(current.title);
    setBody(current.body);
    keepMine(current);
  };

  return (
    <section className="panel wide">
      {theirs && (
        <div className="conflict" role="alert">
          <p>
            <strong>{actorName(theirs.actor)}</strong> saved Version {theirs.number} while you were editing, so your save was not made.
            Merge their changes into yours below, then save again.
          </p>
          <div className="field">
            <span>Version {theirs.number} (theirs)</span>
            <pre className="theirs" aria-label={`Version ${theirs.number}`}>{theirs.body}</pre>
          </div>
          <div className="actions">
            <button type="button" onClick={() => keepMine(theirs)}>I've merged; save mine over it</button>
            <button type="button" className="secondary" onClick={() => takeTheirs(theirs)}>Discard mine and edit theirs</button>
          </div>
        </div>
      )}
      <form onSubmit={save}>
        <Field label="Title" value={title} onChange={setTitle} />
        <TextArea label="Body (Markdown)" value={body} onChange={setBody} rows={18} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="submit" disabled={busy || theirs !== undefined}>Save</button>
          <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

/** The Documents a Document may move under: any in its tree but itself and those under it. */
function possibleParents(tree: DocumentTreeEntry[], id: string): DocumentTreeEntry[] {
  const at = tree.findIndex((e) => e.id === id);
  if (at < 0) return tree;
  let end = at + 1;
  while (end < tree.length && tree[end]!.depth > tree[at]!.depth) end++;
  return [...tree.slice(0, at), ...tree.slice(end)];
}

function MoveDocument(props: { document: Document; onMoved: (d: Document) => void; onCancel: () => void }) {
  const [tree] = useLoad(() => api.documentTree(props.document.projectKey ?? undefined), [props.document.projectKey]);
  const [parentId, setParentId] = useState(props.document.parentId ?? "");
  const { submit, error, busy } = useSubmit(() => api.moveDocument(props.document.id, parentId || null), props.onMoved);
  return (
    <section className="panel">
      <h2>Move</h2>
      <form onSubmit={submit}>
        <Show state={tree}>
          {(entries) => (
            <label className="field">
              <span>Put it under</span>
              <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">Nothing (the top of the tree)</option>
                {possibleParents(entries, props.document.id).map((e) => (
                  <option key={e.id} value={e.id}>{`${" ".repeat(e.depth)}${e.title}`}</option>
                ))}
              </select>
            </label>
          )}
        </Show>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="submit" disabled={busy}>Move</button>
          <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

/** A Document's Versions, newest first, each viewable and, but for the current one, restorable. */
function Versions(props: { document: Document; canWrite: boolean; onRestored: (d: Document) => void }) {
  const d = props.document;
  const [versions] = useLoad(() => api.versions(d.id), [d.id, d.version]);
  const [viewing, setViewing] = useState<Version>();
  const view = useAction((number: number) => api.version(d.id, number), setViewing);
  const restore = useAction(
    (number: number) => api.restoreVersion(d.id, number, d.version),
    (restored) => {
      setViewing(undefined);
      props.onRestored(restored);
    },
  );
  const error = view.error ?? restore.error;
  return (
    <section className="panel wide">
      <h2>Versions</h2>
      <Show state={versions}>
        {(list) => (
          <ol className="history versions" aria-label="Versions">
            {list.map((v) => (
              <li key={v.number} className="version">
                <span className="grow">
                  <strong>Version {v.number}</strong> <span className="muted">{new Date(v.at).toLocaleString()}</span> {actorName(v.actor)}
                  {v.restoredFrom !== null && <span className="muted"> (restored Version {v.restoredFrom})</span>}
                  {v.number === d.version && <span className="badge">Current</span>}
                </span>
                <button className="link" onClick={() => void view.run(v.number)} disabled={view.busy}>View</button>
                {props.canWrite && v.number !== d.version && (
                  <button className="link" onClick={() => void restore.run(v.number)} disabled={restore.busy}>Restore</button>
                )}
              </li>
            ))}
          </ol>
        )}
      </Show>
      {error && <p className="error" role="alert">{error}</p>}
      {viewing && (
        <div className="version-view" aria-label={`Version ${viewing.number}`}>
          <h3>Version {viewing.number}: {viewing.title}</h3>
          <div className="markdown">
            {viewing.body.trim() ? <CronkMarkdown>{viewing.body}</CronkMarkdown> : <p className="muted">Empty.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

/** Who saved a Version, as the UI names them. */
function actorName(actor: RecordedActor): string {
  if (actor.kind === "user") return actor.name;
  return `${actor.name} (${actor.session ? `${sessionName(actor.session.id)}, for` : "Agent of"} ${actor.owner.name})`;
}
