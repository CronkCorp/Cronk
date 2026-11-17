import { ConfirmDialog, Popover } from "./components/overlays.js";
import { Button, buttonClass } from "./components/button.js";
import { Chip, ProtectedMark } from "./components/tags.js";
import { ProtectionHistory } from "./components/protection.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { RelativeTime } from "./components/time.js";
import { Actor } from "./components/actor.js";
import { ProjectCrumbs } from "./components/crumbs.js";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  api,
  staleVersionOf,
  type Attachment,
  type Comment,
  type Document,
  type DocumentTreeEntry,
  type Version,
  watchDocument,
} from "./api.js";
import { DiscardMine, ResolveMerge, SavedMeanwhile, StaleSaveNotice, VersionDiff, useNewerVersion, useStaleSave } from "./merge.js";
import { DocumentMargin, PassageCommentForm } from "./timeline.js";
import { LoadFromTranscripts } from "./transcripts.js";
import { attachmentMarkdown, AttachmentThumbnails, AttachmentViewer, PageAttachments, useAttach, usePageDrop, type AttachmentsView } from "./attachments.js";
import { packMarkdownFolder } from "./folder-archive.js";
import { CronkMarkdown, highlightIds, MarkdownPlace, type Highlight } from "./markdown.js";
import { Link, navigate } from "./router.js";
import { useSelectedPassage, type SelectedPassage } from "./selected-passage.js";
import { MarkdownEditor, type MarkdownEditorHandle } from "./markdown-editor.js";
import { Field, Show, messageOf, useAction, useCanWrite, useLoad, useSubmit } from "./ui.js";

/** The address of a page tree: a Project's, or the Workspace's without a Project key. */
const treeAddress = (projectKey: string | null | undefined) => (projectKey ? `/projects/${projectKey}/documents` : "/documents");

/**
 * Handles a write refused because someone saved since this page loaded: reloads the page so it
 * shows their Version, and explains why, before anyone writes over it. Other errors pass through.
 */
export const explainStale = (reload: () => void, doing: string) => (err: unknown): never => {
  const current = staleVersionOf(err);
  if (!current) throw err;
  reload();
  throw new Error(`${current.actor.name} saved Version ${current.number} meanwhile; check it before ${doing}`);
};

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
  const [tree, reload] = useLoad(() => api.documentTree(props.projectKey), [props.projectKey]);
  const canWrite = useCanWrite(props.projectKey);
  const [creating, setCreating] = useState(false);
  const [importError, setImportError] = useState<string>();
  /** Imports an archive, or packs a picked folder into one first; either way the input is cleared so the same pick works again. */
  const importFrom = async (input: HTMLInputElement, pack: (files: File[]) => Promise<Blob | undefined>) => {
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length === 0) return;
    setImportError(undefined);
    try {
      const archive = await pack(files);
      if (!archive) return setImportError("That folder holds no Markdown files (.md or .markdown) to import");
      await api.importDocuments(props.projectKey, archive);
      reload();
    } catch (err) {
      setImportError(messageOf(err));
    }
  };
  return (
    <section>
      <div className="page-head">
        <div>
          {props.projectKey && <ProjectCrumbs projectKey={props.projectKey} />}
          <h1>{props.projectKey ? "Documents" : "Workspace Documents"}</h1>
        </div>
        {canWrite && !creating && (
          <div className="actions">
            <Button onClick={() => setCreating(true)}>New Document</Button>
            <label className={buttonClass("secondary")} title="A folder of Markdown files; its folders become the page tree">
              Import Markdown folder…
              <input
                type="file"
                hidden
                ref={(input) => {
                  if (input) input.webkitdirectory = true;
                }}
                onChange={(e) => void importFrom(e.target, packMarkdownFolder)}
              />
            </label>
            <label className={buttonClass("secondary")} title="A .zip, .tar.gz or .tar of a folder of Markdown files; its folders become the page tree">
              Import archive…
              <input type="file" accept=".zip,.gz,.tgz,.tar" hidden onChange={(e) => void importFrom(e.target, async ([file]) => file)} />
            </label>
          </div>
        )}
      </div>
      {importError && <p className="error" role="alert">{importError}</p>}
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
                    {entry.protected && <ProtectedMark compact />}
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
          <Button type="submit" disabled={busy}>Create Document</Button>
          <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
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
      {(d) => (
        <MarkdownPlace.Provider value={d.projectKey}>
          <DocumentView key={d.id} document={d} startEditing={props.edit} onChanged={setDocument} onReload={reload} />
        </MarkdownPlace.Provider>
      )}
    </Show>
  );
}

type Panel = "none" | "edit" | "move" | "versions" | "new";

const NO_COMMENTS: Comment[] = [];

/**
 * A Document's body, rendered again only when it or its highlighted passages change, so hovering a
 * Comment doesn't rebuild it.
 */
const DocumentBody = memo(function DocumentBody(props: { body: string; highlights: Highlight[]; embeds: Document["embeds"] }) {
  return props.body.trim() ? (
    <CronkMarkdown sourceOffsets highlights={props.highlights} embeds={props.embeds}>{props.body}</CronkMarkdown>
  ) : (
    <p className="muted">This Document is empty.</p>
  );
});

/** The ids of the passages highlighted inside `root`, in the order they first appear, read again after every render. */
function usePlacedHighlights(root: RefObject<HTMLElement | null>): string[] {
  const [placed, setPlaced] = useState<string[]>([]);
  useLayoutEffect(() => {
    const ids: string[] = [];
    root.current?.querySelectorAll<HTMLElement>("mark.highlight").forEach((mark) => {
      for (const id of highlightIds(mark)) if (!ids.includes(id)) ids.push(id);
    });
    setPlaced((before) => (before.join(" ") === ids.join(" ") ? before : ids));
  });
  return placed;
}

function DocumentView(props: { document: Document; startEditing: boolean; onChanged: (d: Document) => void; onReload: () => void }) {
  const d = props.document;
  const canWrite = useCanWrite(d.projectKey);
  const [panel, setPanel] = useState<Panel>(props.startEditing ? "edit" : "none");
  // How often the Document's Comments changed, as its stream tells it.
  const [commentsGeneration, setCommentsGeneration] = useState(0);
  const [attachments, reloadAttachments] = useLoad(() => api.documentAttachments(d.id), [d.id]);
  const [live, onLive] = useLiveState();
  const { newer, saw, catchUp } = useNewerVersion({ version: d.version, editing: panel === "edit", onReload: props.onReload, current: () => api.document(d.id) });
  useEffect(
    () =>
      watchDocument(d.id, {
        onLive,
        // On (re)connecting, catch up on what was saved and posted meanwhile.
        ready: () => {
          setCommentsGeneration((g) => g + 1);
          reloadAttachments();
          catchUp();
        },
        on: {
          comment: () => setCommentsGeneration((g) => g + 1),
          version: ({ version }) => saw(version),
          attachments: () => reloadAttachments(),
        },
      }),
    [d.id],
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const remove = useAction(
    async () => {
      try {
        await api.deleteDocument(d.id, d.version).catch(explainStale(props.onReload, "deleting"));
      } finally {
        setConfirmingDelete(false);
      }
    },
    () => navigate(d.ticketKey ? `/tickets/${d.ticketKey}` : treeAddress(d.projectKey)),
  );
  const toggle = (p: Panel) => setPanel(panel === p ? "none" : p);
  // Marked itself, as opposed to covered by a marked Document above it.
  const marked = d.protectedBy?.id === d.id;
  const protect = useAction((value: boolean) => api.protectDocument(d.id, value), props.onChanged);
  const bodyAt = useRef<HTMLDivElement>(null);
  const commentAt = useRef<HTMLTextAreaElement>(null);
  const selected = useSelectedPassage(bodyAt, d.body);
  // Loaded again after a save, so whether each anchor is still in the Document is asked again.
  const [comments, reloadComments] = useLoad(() => api.documentComments(d.id), [d.id, d.version, commentsGeneration]);
  const loadedComments = comments.kind === "loaded" ? comments.value : NO_COMMENTS;
  const highlights = useMemo(
    () => loadedComments.flatMap((c) => (c.anchor?.inCurrentVersion && !c.replyToCommentId ? [{ id: c.id, passage: c.anchor.passage }] : [])),
    [loadedComments],
  );
  const placed = usePlacedHighlights(bodyAt);
  // The Comments whose passage and card are highlighted: those hovered, else those focused.
  const [hovered, setHovered] = useState<string[]>([]);
  const [focused, setFocused] = useState<string[]>([]);
  const active = hovered.length > 0 ? hovered : focused;
  useEffect(() => {
    bodyAt.current?.querySelectorAll("mark.highlight").forEach((mark) => {
      mark.classList.toggle("active", highlightIds(mark).some((id) => active.includes(id)));
    });
  });
  /** The Comments a highlight in the body under an event belongs to, if any. */
  const highlightAt = (target: EventTarget) => {
    const mark = (target as Element).closest?.("mark.highlight");
    return mark ? highlightIds(mark) : [];
  };
  // The passage a new Comment anchors to, and where it was selected, while its popover is open.
  const [composing, setComposing] = useState<SelectedPassage>();
  const [passage, setPassage] = useState("");
  // Selecting anything else in the body closes the popover, to offer to comment on the new selection, if it can be.
  useEffect(() => {
    const reselected = () => {
      const selection = getSelection();
      if (selection && !selection.isCollapsed && bodyAt.current?.contains(selection.anchorNode)) setComposing(undefined);
    };
    document.addEventListener("selectionchange", reselected);
    return () => document.removeEventListener("selectionchange", reselected);
  }, []);
  useEffect(() => setComposing(undefined), [d.version]);
  const offer = composing ?? selected;
  // Its Attachments, and those in its Comments; files dropped or pasted on the page attach to it, and into the editor
  // are embedded where its cursor is too.
  const [workspace] = useLoad(api.workspace, []);
  const [opened, setOpened] = useState<Attachment>();
  const attaching = useAttach((file) => api.attachToDocument(d.id, file), reloadAttachments);
  const dragging = usePageDrop(canWrite, (files) => void attaching.attach(files));
  const editor = useRef<MarkdownEditorHandle>(null);
  const loadedAttachments = attachments.kind === "loaded" ? attachments.value : [];
  const files: AttachmentsView = {
    attachments: loadedAttachments.filter((a) => a.on === "document"),
    canWrite,
    attaching,
    maxBytes: workspace.kind === "loaded" ? workspace.value.attachmentMaxBytes : undefined,
    dragging,
    onOpen: setOpened,
  };

  return (
    <article className="document">
      <PageAttachments.Provider value={{ attachments: loadedAttachments, onOpen: setOpened }}>
        <Breadcrumb projectKey={d.projectKey} ticketKey={d.ticketKey} />
        {panel === "edit" ? (
          <EditDocument
            document={d}
            editor={editor}
            attach={attaching.attach}
            attachments={<AttachmentThumbnails {...files} onInsert={(a) => editor.current?.insert(attachmentMarkdown(a))} />}
            newerVersion={newer}
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
                {d.title} {d.ticketKey && <Chip>{`Report on ${d.ticketKey}`}</Chip>} {d.protected && <ProtectedMark covers={marked ? d.covers : 0} />}
              </h1>
              <div className="actions">
                <LiveIndicator state={live} />
                <span className="muted">Version {d.version}</span>
                <Button variant="secondary" onClick={() => toggle("versions")}>Versions</Button>
                {canWrite && (
                  <>
                    {!d.ticketKey && (
                      <>
                        <Button variant="secondary" onClick={() => toggle("move")}>Move</Button>
                        <Button variant="secondary" onClick={() => toggle("new")}>New Document under this one</Button>
                      </>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() => void protect.run(!marked)}
                      disabled={protect.busy}
                      title={marked ? "Let Agents edit it again" : "Let Agents read but not edit it, and every Document under it"}
                    >
                      {marked ? "Unprotect" : "Protect"}
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirmingDelete(true)} disabled={remove.busy}>Delete</Button>
                    <ConfirmDialog
                      open={confirmingDelete}
                      onOpenChange={setConfirmingDelete}
                      title={`Delete ${d.title}?`}
                      description="This deletes the Document and all its Versions."
                      confirmLabel="Delete"
                      busy={remove.busy}
                      onConfirm={() => void remove.run()}
                    />
                    <Button onClick={() => setPanel("edit")}>Edit</Button>
                  </>
                )}
              </div>
            </div>
            {d.protectedBy && !marked && (
              <p className="muted small">
                Protected as part of <Link to={`/documents/${d.protectedBy.id}`} className="link">{d.protectedBy.title}</Link>, which covers the Documents under it.
              </p>
            )}
            <LoadFromTranscripts collection="documents" keyOrId={d.id} heading="h4" reloadOn={d.version} />
            {remove.error && <p className="error" role="alert">{remove.error}</p>}
            {protect.error && <p className="error" role="alert">{protect.error}</p>}
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
            <div className="document-read">
              <div
                className="selectable document-body"
                onMouseOver={(e) => setHovered(highlightAt(e.target))}
                onMouseLeave={() => setHovered([])}
                onFocus={(e) => setFocused(highlightAt(e.target))}
                onBlur={() => setFocused([])}
              >
                <div className="markdown" data-testid="document-body" ref={bodyAt}>
                  <DocumentBody body={d.body} highlights={highlights} embeds={d.embeds} />
                </div>
                <AttachmentThumbnails {...files} />
                {canWrite && offer && (
                  <Popover
                    open={composing !== undefined}
                    onOpenChange={(open) => {
                      if (!open) return setComposing(undefined);
                      if (!selected) return;
                      setPassage(selected.passage);
                      setComposing(selected);
                      getSelection()?.removeAllRanges();
                    }}
                    label="Comment on this passage"
                    onOpenAutoFocus={(e) => {
                      e.preventDefault();
                      commentAt.current?.focus();
                    }}
                    trigger={
                      <Button
                        type="button"
                        className="comment-on-selection"
                        style={{ top: offer.top, left: offer.left }}
                        // Pressing the button would otherwise clear the selection before it is read.
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        Comment on this passage
                      </Button>
                    }
                  >
                    <PassageCommentForm
                      documentId={d.id}
                      passage={passage}
                      onPassageChange={setPassage}
                      commentRef={commentAt}
                      onPosted={() => {
                        setComposing(undefined);
                        reloadComments();
                      }}
                    />
                  </Popover>
                )}
              </div>
              <Show state={comments}>
                {(all) => (
                  <DocumentMargin
                    documentId={d.id}
                    comments={all}
                    placed={placed}
                    bodyRef={bodyAt}
                    active={active}
                    onHover={(id) => setHovered(id ? [id] : [])}
                    onFocus={(id) => setFocused(id ? [id] : [])}
                    canWrite={canWrite}
                    onPosted={reloadComments}
                  />
                )}
              </Show>
            </div>
          </>
        )}
      </PageAttachments.Provider>
      <AttachmentViewer
        attachment={opened}
        canWrite={canWrite}
        onClose={() => setOpened(undefined)}
        onDeleted={() => {
          setOpened(undefined);
          reloadAttachments();
        }}
      />
    </article>
  );
}

/**
 * Edits a Document's title and Markdown. The save names the Version editing started from; if
 * someone saved since, it is refused, and the editor shows their edit and merges it into this one
 * section by section. Sections both changed differently wait for the User to choose or combine.
 */
function EditDocument(props: {
  document: Document;
  /** Where the page reaches the open editor, to insert an Attachment's Markdown. */
  editor: RefObject<MarkdownEditorHandle | null>;
  attach: (files: File[]) => Promise<Attachment[]>;
  /** The Document's Attachments, shown under the editor. */
  attachments: ReactNode;
  newerVersion: number | undefined;
  onSaved: (d: Document) => void;
  onCancel: () => void;
}) {
  const id = props.document.id;
  const { draft, setDraft, save, busy, error, notice, resolve, discardMine } = useStaleSave({
    draft: { title: props.document.title, text: props.document.body },
    baseVersion: props.document.version,
    save: (d, baseVersion) => api.saveDocument(id, { baseVersion, title: d.title, body: d.text }),
    merge: async (d, baseVersion) => {
      const [merge, started] = await Promise.all([api.mergeDocument(id, { baseVersion, title: d.title, body: d.text }), api.version(id, baseVersion)]);
      return {
        base: started,
        theirs: merge.onto,
        by: merge.onto.actor,
        merge,
        merged: merge.conflicts === 0 ? { title: merge.title!, text: merge.body! } : null,
      };
    },
    onSaved: props.onSaved,
  });

  return (
    <>
      <div className="page-head">
        <h1>{props.document.title}</h1>
      </div>
      {props.newerVersion !== undefined && !notice && !resolve && (
        <SavedMeanwhile of={props.document.id} started={props.document.version} version={props.newerVersion} load={(n) => api.version(props.document.id, n)} show={(v) => v} />
      )}
      {notice && <StaleSaveNotice {...notice} />}
      {resolve ? (
        <ResolveMerge {...resolve} />
      ) : (
        <section className="panel wide">
          <form onSubmit={save}>
            {/* Read-only while saving: the merge sends the draft as it was when Save was pressed. */}
            <Field label="Title" value={draft.title} onChange={(title) => setDraft((d) => ({ ...d, title }))} disabled={busy} />
            <MarkdownEditor
              label="Body (Markdown)"
              value={draft.text}
              onChange={(text) => setDraft((d) => ({ ...d, text }))}
              disabled={busy}
              projectKey={props.document.projectKey}
              attach={props.attach}
              previewEmbeds
              ref={props.editor}
            />
            {props.attachments}
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
          <Button type="submit" disabled={busy}>Move</Button>
          <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
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
                  <strong>Version {v.number}</strong> <RelativeTime at={v.at} /> <Actor actor={v.actor} />
                  {v.restoredFrom !== null && <span className="muted"> (restored Version {v.restoredFrom})</span>}
                  {v.number === d.version && <Chip>Current</Chip>}
                </span>
                <Button variant="ghost" onClick={() => void view.run(v.number)} disabled={view.busy}>View</Button>
                {props.canWrite && v.number !== d.version && (
                  <Button variant="ghost" onClick={() => void restore.run(v.number)} disabled={restore.busy}>Restore</Button>
                )}
              </li>
            ))}
          </ol>
        )}
      </Show>
      <ProtectionHistory load={() => api.documentProtection(d.id)} reloadOn={[d.id, d.protectedBy?.id]} />
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
            {viewing.body.trim() ? <CronkMarkdown embeds={viewing.embeds}>{viewing.body}</CronkMarkdown> : <p className="muted">Empty.</p>}
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
      <Button type="submit" variant="secondary" disabled={props.busy}>Compare</Button>
    </form>
  );
}
