import { useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  sessionName,
  staleVersionOf,
  type Document,
  type DocumentTreeEntry,
  type Merge,
  type RecordedActor,
  type Version,
} from "./api.js";
import { ResolveMerge, VersionDiff } from "./merge.js";
import { DocumentComments } from "./timeline.js";
import { CronkMarkdown } from "./markdown.js";
import { Link, navigate } from "./router.js";
import { Field, Show, TextArea, messageOf, useAction, useLoad, useSubmit } from "./ui.js";

/** The address of a page tree: a Project's, or the Workspace's without a Project key. */
const treeAddress = (projectKey: string | null | undefined) => (projectKey ? `/projects/${projectKey}/documents` : "/documents");

/**
 * Handles a write refused because someone saved since this page loaded: reloads the page so it
 * shows their Version, and explains why, before anyone writes over it. Other errors pass through.
 */
const explainStale = (reload: () => void, doing: string) => (err: unknown): never => {
  const current = staleVersionOf(err);
  if (!current) throw err;
  reload();
  throw new Error(`${actorName(current.actor)} saved Version ${current.number} meanwhile; check it before ${doing}`);
};

/** Whether the signed-in User may change Documents in a Project's tree, or the Workspace's (every User may). */
function useCanWrite(projectKey: string | null | undefined): boolean {
  const [project] = useLoad(() => (projectKey ? api.project(projectKey) : Promise.resolve(undefined)), [projectKey]);
  if (!projectKey) return true;
  return project.kind === "loaded" && project.value?.project.access === "write";
}

/** The way back to a Project, optionally followed by more crumbs. */
function ProjectCrumbs(props: { projectKey: string; children?: ReactNode }) {
  return (
    <div className="muted">
      <Link to="/" className="link">Projects</Link> / <Link to={`/projects/${props.projectKey}`} className="link">{props.projectKey}</Link>
      {props.children}
    </div>
  );
}

/** The way back to the page tree a Document sits in, or to the Ticket a Report is on. */
function Breadcrumb(props: { projectKey: string | null; ticketKey: string | null }) {
  if (props.projectKey && props.ticketKey) {
    return (
      <ProjectCrumbs projectKey={props.projectKey}>
        {" / "}
        <Link to={`/projects/${props.projectKey}?view=reports`} className="link">Reports</Link>
        {" / "}
        <Link to={`/tickets/${props.ticketKey}`} className="link">{props.ticketKey}</Link>
      </ProjectCrumbs>
    );
  }
  if (!props.projectKey) {
    return (
      <div className="muted">
        <Link to="/documents" className="link">Workspace Documents</Link>
      </div>
    );
  }
  return (
    <ProjectCrumbs projectKey={props.projectKey}>
      {" / "}
      <Link to={treeAddress(props.projectKey)} className="link">Documents</Link>
    </ProjectCrumbs>
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
          {props.projectKey && <ProjectCrumbs projectKey={props.projectKey} />}
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
      <h2>{props.parentId ? "New Document under this one" : "New Document"}</h2>
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

/** One Document at its current Version, to read, edit, move, delete, and see or restore its Versions. */
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
      await api.deleteDocument(d.id, d.version).catch(explainStale(props.onReload, "deleting"));
      return true;
    },
    (deleted) => deleted && navigate(d.ticketKey ? `/tickets/${d.ticketKey}` : treeAddress(d.projectKey)),
  );
  const toggle = (p: Panel) => setPanel(panel === p ? "none" : p);

  return (
    <article className="document">
      <Breadcrumb projectKey={d.projectKey} ticketKey={d.ticketKey} />
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
            <h1>
              {d.title} {d.ticketKey && <span className="badge">Report on {d.ticketKey}</span>}
            </h1>
            <div className="actions">
              <span className="muted">Version {d.version}</span>
              <button className="secondary" onClick={() => toggle("versions")}>Versions</button>
              {canWrite && (
                <>
                  {!d.ticketKey && (
                    <>
                      <button className="secondary" onClick={() => toggle("move")}>Move</button>
                      <button className="secondary" onClick={() => toggle("new")}>New Document under this one</button>
                    </>
                  )}
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
          {panel === "versions" && <Versions document={d} canWrite={canWrite} onRestored={props.onChanged} onOutdated={props.onReload} />}
          <div className="markdown" data-testid="document-body">
            {d.body.trim() ? <CronkMarkdown>{d.body}</CronkMarkdown> : <p className="muted">This Document is empty.</p>}
          </div>
          <h2>Comments</h2>
          {/* Keyed by Version, so whether each anchor is still in the Document is asked again after a save. */}
          <DocumentComments key={d.version} documentId={d.id} canWrite={canWrite} />
        </>
      )}
    </article>
  );
}

/** Someone else's save that refused this one: the Version this edit started from, and the Version they saved. */
interface OtherEdit {
  base: Version;
  theirs: Version;
}

/**
 * Edits a Document's title and Markdown. The save names the Version editing started from; if
 * someone saved since, it is refused, and the editor shows their edit and merges it into this one
 * section by section. Sections both changed differently wait for the User to choose or combine.
 */
function EditDocument(props: { document: Document; onSaved: (d: Document) => void; onCancel: () => void }) {
  const id = props.document.id;
  const [title, setTitle] = useState(props.document.title);
  const [body, setBody] = useState(props.document.body);
  const [base, setBase] = useState(props.document.version);
  const [other, setOther] = useState<OtherEdit>();
  const [resolving, setResolving] = useState<Merge>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      props.onSaved(await api.saveDocument(id, { baseVersion: base, title, body }));
    } catch (err) {
      if (!staleVersionOf(err)) {
        setError(messageOf(err));
        return;
      }
      try {
        const [merge, started] = await Promise.all([api.mergeDocument(id, { baseVersion: base, title, body }), api.version(id, base)]);
        setOther({ base: started, theirs: merge.onto });
        if (merge.conflicts === 0) {
          setTitle(merge.title!);
          setBody(merge.body!);
          setBase(merge.onto.number);
        } else {
          setResolving(merge);
        }
      } catch (mergeErr) {
        setError(messageOf(mergeErr));
      }
    } finally {
      setBusy(false);
    }
  };
  const takeTheirs = (theirs: Version) => {
    setTitle(theirs.title);
    setBody(theirs.body);
    setBase(theirs.number);
    setResolving(undefined);
    setOther(undefined);
  };

  return (
    <section className="panel wide">
      {other && (
        <div className={resolving ? "conflict" : "merged"} role="alert">
          <p>
            <strong>{actorName(other.theirs.actor)}</strong> saved Version {other.theirs.number} while you were editing, so your save was not made.{" "}
            {resolving
              ? "You both changed the same part; choose or combine below, then save."
              : "Their changes touched other sections and are merged into yours below; check them and save again."}
          </p>
          <details open={!!resolving}>
            <summary>Their changes (Version {other.base.number} to {other.theirs.number})</summary>
            <VersionDiff before={other.base} after={other.theirs} label={`Their changes, Version ${other.base.number} to ${other.theirs.number}`} />
          </details>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => takeTheirs(other.theirs)}>Discard mine and edit theirs</button>
          </div>
        </div>
      )}
      {resolving ? (
        <ResolveMerge
          merge={resolving}
          onResolved={(resolved) => {
            setTitle(resolved.title);
            setBody(resolved.body);
            setBase(resolving.onto.number);
            setResolving(undefined);
          }}
          onCancel={props.onCancel}
        />
      ) : (
        <form onSubmit={save}>
          <Field label="Title" value={title} onChange={setTitle} />
          <TextArea label="Body (Markdown)" value={body} onChange={setBody} rows={18} />
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button type="submit" disabled={busy}>Save</button>
            <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
          </div>
        </form>
      )}
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
function Versions(props: { document: Document; canWrite: boolean; onRestored: (d: Document) => void; onOutdated: () => void }) {
  const d = props.document;
  const [versions] = useLoad(() => api.versions(d.id), [d.id, d.version]);
  const [viewing, setViewing] = useState<Version>();
  const view = useAction(
    (number: number) => api.version(d.id, number),
    (v) => {
      setComparing(undefined);
      setViewing(v);
    },
  );
  const restore = useAction(
    async (number: number) => {
      return api.restoreVersion(d.id, number, d.version).catch(explainStale(props.onOutdated, "restoring"));
    },
    (restored) => {
      setViewing(undefined);
      props.onRestored(restored);
    },
  );
  const [comparing, setComparing] = useState<[Version, Version]>();
  const compare = useAction((from: number, to: number) => Promise.all([api.version(d.id, from), api.version(d.id, to)]), (pair) => {
    setViewing(undefined);
    setComparing(pair);
  });
  const error = view.error ?? restore.error ?? compare.error;
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
      {d.version > 1 && <CompareVersions current={d.version} busy={compare.busy} onCompare={(from, to) => void compare.run(from, to)} />}
      {error && <p className="error" role="alert">{error}</p>}
      {comparing && (
        <div className="version-view">
          <h3>Version {comparing[0].number} compared with Version {comparing[1].number}</h3>
          <VersionDiff before={comparing[0]} after={comparing[1]} label={`Changes from Version ${comparing[0].number} to Version ${comparing[1].number}`} />
        </div>
      )}
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

/** Picks two of a Document's Versions to compare; the one before the current with the current at first. */
function CompareVersions(props: { current: number; busy: boolean; onCompare: (from: number, to: number) => void }) {
  const [from, setFrom] = useState(props.current - 1);
  const [to, setTo] = useState(props.current);
  const numbers = Array.from({ length: props.current }, (_, i) => props.current - i);
  const pick = (label: string, value: number, onChange: (n: number) => void) => (
    <label className="field inline">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {numbers.map((n) => (
          <option key={n} value={n}>Version {n}</option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="compare"
      onSubmit={(event) => {
        event.preventDefault();
        props.onCompare(from, to);
      }}
    >
      {pick("Compare", from, setFrom)}
      {pick("with", to, setTo)}
      <button type="submit" className="secondary" disabled={props.busy}>Compare</button>
    </form>
  );
}

/** Who saved a Version, as the UI names them. */
function actorName(actor: RecordedActor): string {
  if (actor.kind === "user") return actor.name;
  return `${actor.name} (${actor.session ? `${sessionName(actor.session.id)}, for` : "Agent of"} ${actor.owner.name})`;
}
