import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Actor, agentActor, userActor } from "./components/actor.js";
import { Button, buttonClass } from "./components/button.js";
import { fileKind, formatBytes, typeLabel } from "./components/files.js";
import { ConfirmDialog, Dialog } from "./components/overlays.js";
import { api, attachmentFileUrl, type Attachment, type RecordedActor, type RecordedChange } from "./api.js";
import { messageOf } from "./ui.js";

/**
 * Attachments (docs/ui.md § Ticket Attachments): thumbnails under a Ticket's description or a Document's body, a Files
 * list in a Ticket's side panel, images and video shown where they were posted in a Comment or Report, and attaching by
 * picking, dropping anywhere on the page or pasting. Opening one shows it in a dialog, where video and audio play with seeking.
 */

/**
 * Uploads files one after another with `upload`, saying how far it got and what was refused. Attaching answers what
 * each upload that went through gave back, in the order the files came.
 */
export function useAttach<T>(upload: (file: File) => Promise<T>, onAttached: () => void) {
  const [uploading, setUploading] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);
  const attach = async (files: File[]): Promise<T[]> => {
    const attached: T[] = [];
    if (files.length === 0) return attached;
    setErrors([]);
    for (const file of files) {
      setUploading(file.name || "pasted file");
      try {
        attached.push(await upload(file));
      } catch (err) {
        setErrors((e) => [...e, `${file.name || "The pasted file"}: ${messageOf(err)}`]);
      }
    }
    setUploading(undefined);
    onAttached();
    return attached;
  };
  return { attach, uploading, errors };
}

export type Attaching = ReturnType<typeof useAttach<unknown>>;

/** The Markdown that embeds an Attachment: an image whose address is its file, named after it. */
export const attachmentMarkdown = (a: Attachment) => `![${a.name.replace(/[\\[\]]/g, "\\$&")}](${attachmentFileUrl(a.id)})`;

/**
 * Attaches files dropped anywhere on the page, or pasted anywhere on it, while `enabled`; not those something in the
 * page, such as a Markdown editor, already took. A paste into an editable field (a text area, a text-type input or
 * something content-editable) that carries text too, as a copy from a spreadsheet does, is the field's: it pastes the
 * text and attaches nothing. Files pasted alone attach, in a field or not. Answers whether files are being dragged over
 * the page, to show where they'll go.
 */
export function usePageDrop(enabled: boolean, attach: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(attach);
  latest.current = attach;
  useEffect(() => {
    if (!enabled) return;
    const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const over = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      // Leaving the window, not just moving between elements.
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      setDragging(false);
      if (e.defaultPrevented) return;
      e.preventDefault();
      latest.current([...(e.dataTransfer?.files ?? [])]);
    };
    const paste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0 || e.defaultPrevented) return;
      if (e.clipboardData?.types.includes("text/plain") && takesPastedText(e.target)) return;
      e.preventDefault();
      latest.current(files);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    document.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      document.removeEventListener("paste", paste);
    };
  }, [enabled]);
  return dragging;
}

/** Input types that take typed text, so take a paste's text. */
const textInputTypes = new Set(["text", "search", "url", "tel", "email", "password"]);

/**
 * Whether `target` takes a paste's text: a text area or text-type input that isn't read-only, or something
 * content-editable.
 */
function takesPastedText(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return !target.readOnly;
  if (target instanceof HTMLInputElement) return !target.readOnly && textInputTypes.has(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

/** The Actor who attached a file, as `<Actor>` shows them. */
const attachedBy = (actor: RecordedActor) => (actor.kind === "agent" ? agentActor(actor) : userActor(actor.name));

/** "Attach…": a button that opens the file picker. */
function AttachButton(props: { attaching: Attaching; label?: string }) {
  return (
    <label className={buttonClass("ghost")} aria-disabled={props.attaching.uploading !== undefined}>
      {props.label ?? "Attach…"}
      <input
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        disabled={props.attaching.uploading !== undefined}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void props.attaching.attach(files);
        }}
      />
    </label>
  );
}

/** Where dropped or pasted files go, with what is uploading and what was refused. */
function DropZone(props: { attaching: Attaching; maxBytes: number | undefined; dragging: boolean }) {
  const { uploading, errors } = props.attaching;
  return (
    <>
      <div className={`drop-zone${props.dragging ? " dragging" : ""}`} data-testid="drop-zone">
        {uploading ? <>Attaching {uploading}…</> : <>Drop files or paste to attach{props.maxBytes !== undefined && <> · up to {formatBytes(props.maxBytes)} each</>}</>}
      </div>
      {errors.map((error) => (
        <p key={error} className="error" role="alert">{error}</p>
      ))}
    </>
  );
}

/** What both the thumbnails and the Files panel show and do. */
export interface AttachmentsView {
  attachments: Attachment[];
  canWrite: boolean;
  attaching: Attaching;
  /** The Workspace's Attachment size limit, once known. */
  maxBytes: number | undefined;
  /** Whether files are being dragged over the page. */
  dragging: boolean;
  onOpen: (attachment: Attachment) => void;
  /** Puts an Attachment's Markdown in an open editor; each thumbnail offers "Insert" only when given. */
  onInsert?: (attachment: Attachment) => void;
}

/** An item's own Attachments as thumbnails, under a Ticket's description or a Document's body, with where to drop more. */
export function AttachmentThumbnails(props: AttachmentsView) {
  const { onInsert } = props;
  if (!props.canWrite && props.attachments.length === 0) return null;
  return (
    <section className="attachments" aria-label="Attachments">
      <div className="attachments-head">
        <h2>Attachments · {props.attachments.length}</h2>
        {props.canWrite && <AttachButton attaching={props.attaching} />}
      </div>
      {props.attachments.length > 0 && (
        <ul className="thumbnails">
          {props.attachments.map((a) => (
            <li key={a.id}>
              <button type="button" className="thumbnail" onClick={() => props.onOpen(a)} aria-label={`Open ${a.name}`}>
                <Preview attachment={a} />
                <span className="thumbnail-caption">
                  <span className="thumbnail-name">{a.name}</span>
                  <span className="muted file-by">
                    {formatBytes(a.size)} · <Actor actor={attachedBy(a.actor)} owner={false} />
                  </span>
                </span>
              </button>
              {onInsert && (
                <Button type="button" variant="ghost" className="thumbnail-insert" aria-label={`Insert ${a.name}`} onClick={() => onInsert(a)}>
                  Insert
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.canWrite && <DropZone attaching={props.attaching} maxBytes={props.maxBytes} dragging={props.dragging} />}
    </section>
  );
}

/** A thumbnail's picture: the image, the video's first frame, or the file's type. */
function Preview(props: { attachment: Attachment }) {
  const a = props.attachment;
  const url = attachmentFileUrl(a.id);
  switch (fileKind(a.contentType)) {
    case "image":
      return <img className="preview" src={url} alt="" loading="lazy" />;
    case "video":
      return (
        <span className="preview preview-video">
          <video src={`${url}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} />
          <span className="play" aria-hidden="true">▶</span>
        </span>
      );
    default:
      return <span className="preview preview-type">{typeLabel(a.name, a.contentType)}</span>;
  }
}

/** Every file on the Ticket, in the side panel, with where to drop more. */
export function FilesPanel(props: AttachmentsView) {
  if (!props.canWrite && props.attachments.length === 0) return null;
  return (
    <section className="side-panel side-files" aria-label="Files">
      <div className="files-head">
        <h3>Files</h3>
        {props.canWrite && <AttachButton attaching={props.attaching} />}
      </div>
      {props.attachments.length === 0 ? (
        <p className="muted files-empty">No files yet.</p>
      ) : (
        <ul className="files-list">
          {props.attachments.map((a) => (
            <li key={a.id}>
              <span className="file-type" aria-hidden="true">{typeLabel(a.name, a.contentType).slice(0, 4)}</span>
              <span className="file-meta">
                <button type="button" className="link-button" onClick={() => props.onOpen(a)}>{a.name}</button>
                <span className="muted file-by">
                  {formatBytes(a.size)} · <Actor actor={attachedBy(a.actor)} owner={false} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {props.canWrite && <DropZone attaching={props.attaching} maxBytes={props.maxBytes} dragging={props.dragging} />}
    </section>
  );
}

/** One Attachment opened: shown or played in the page where the browser can, with a download link and, with Write, Delete. */
export function AttachmentViewer(props: { attachment: Attachment | undefined; canWrite: boolean; onClose: () => void; onDeleted: () => void }) {
  const a = props.attachment;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setConfirming(false);
    setError(undefined);
  }, [a?.id]);
  if (!a) return null;
  const url = attachmentFileUrl(a.id);
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteAttachment(a.id);
      setConfirming(false);
      props.onDeleted();
    } catch (err) {
      setError(messageOf(err));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  let shown: ReactNode;
  switch (fileKind(a.contentType)) {
    case "image":
      shown = <img className="viewer-media" src={url} alt={a.name} />;
      break;
    case "video":
      shown = <video className="viewer-media" src={url} controls autoPlay playsInline data-testid="attachment-player" />;
      break;
    case "audio":
      shown = <audio className="viewer-audio" src={url} controls autoPlay data-testid="attachment-player" />;
      break;
    default:
      shown = <p className="muted">Cronk doesn't show {typeLabel(a.name, a.contentType)} files here; download it to open it.</p>;
  }
  return (
    <>
      <Dialog
        open
        size="wide"
        onOpenChange={(open) => !open && props.onClose()}
        title={a.name}
        description={
          <span className="viewer-meta">
            {formatBytes(a.size)} · <Actor actor={attachedBy(a.actor)} />
          </span>
        }
      >
        <div className="viewer">{shown}</div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions dialog-actions">
          {props.canWrite && (
            <Button variant="secondary" onClick={() => setConfirming(true)}>Delete…</Button>
          )}
          <a className={buttonClass("primary")} href={url} download={a.name}>Download</a>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${a.name}?`}
        description="It is removed for everyone, from wherever it was attached, and its file is deleted."
        confirmLabel="Delete"
        busy={busy}
        onConfirm={() => void remove()}
      />
    </>
  );
}

/** The Attachments a page has loaded, for Comments and Reports on it to show their own where they were posted. */
export const PageAttachments = createContext<{ attachments: Attachment[]; onOpen: (attachment: Attachment) => void } | undefined>(undefined);

/**
 * The Attachment a Ticket's change line names, by the name it recorded: a button opening it while it is still on the
 * Ticket, in a page that provides `PageAttachments`; otherwise, once deleted or where nothing can open it, its name alone.
 */
export function ChangeLineAttachment(props: { attachment: Extract<RecordedChange, { attachment: unknown }>["attachment"] }) {
  const page = useContext(PageAttachments);
  const found = page?.attachments.find((a) => a.id === props.attachment.id && a.on === "ticket");
  if (!page || !found) return <>{props.attachment.name}</>;
  return (
    <button type="button" className="link-button" onClick={() => page.onOpen(found)}>
      {props.attachment.name}
    </button>
  );
}

/** A video or audio Attachment playing in place, video at most 360px tall, named `label`. */
export function InlinePlayer(props: { kind: "video" | "audio"; attachment: Attachment; label: string | undefined }) {
  const url = attachmentFileUrl(props.attachment.id);
  return props.kind === "video" ? (
    <video className="inline-media" src={url} controls preload="metadata" playsInline aria-label={props.label} />
  ) : (
    <audio className="inline-audio" src={url} controls preload="metadata" aria-label={props.label} />
  );
}

/**
 * The Attachments on one Comment, or on one Document or Report itself, shown where they were posted: images and video in
 * the page, audio playing, other files by name. Opening one shows it in the page's dialog. Nothing outside a page that
 * provides `PageAttachments`.
 */
export function InlineAttachments(props: { commentId: string } | { documentId: string }) {
  const page = useContext(PageAttachments);
  const shown = (page?.attachments ?? []).filter((a) =>
    "commentId" in props ? a.commentId === props.commentId : a.on === "document" && a.documentId === props.documentId,
  );
  if (!page || shown.length === 0) return null;
  return (
    <ul className="inline-attachments" aria-label="Attached files">
      {shown.map((a) => {
        const url = attachmentFileUrl(a.id);
        const kind = fileKind(a.contentType);
        return (
          <li key={a.id} className={`inline-attachment inline-${kind}`}>
            {kind === "image" ? (
              <button type="button" className="inline-media-button" onClick={() => page.onOpen(a)} aria-label={`Open ${a.name}`}>
                <img className="inline-media" src={url} alt={a.name} loading="lazy" />
              </button>
            ) : kind === "video" || kind === "audio" ? (
              <InlinePlayer kind={kind} attachment={a} label={a.name} />
            ) : null}
            <span className="inline-caption">
              <button type="button" className="link-button inline-name" onClick={() => page.onOpen(a)}>
                {kind === "other" ? <span className="file-type">{typeLabel(a.name, a.contentType).slice(0, 4)}</span> : null}
                {a.name}
              </button>
              <span className="muted">{formatBytes(a.size)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
