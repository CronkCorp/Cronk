import { useEffect, useRef, useState, type ReactNode } from "react";
import { Actor, agentActor, userActor } from "./components/actor.js";
import { Button, buttonClass } from "./components/button.js";
import { fileKind, formatBytes, typeLabel } from "./components/files.js";
import { ConfirmDialog, Dialog } from "./components/overlays.js";
import { api, attachmentFileUrl, type Attachment, type RecordedActor } from "./api.js";
import { messageOf } from "./ui.js";

/**
 * A Ticket's Attachments (docs/ui.md § Ticket Attachments): thumbnails under the description, a Files list in the
 * side panel, and attaching by picking, dropping anywhere on the page or pasting. Opening one shows it in a dialog,
 * where video and audio play with seeking.
 */

/** Uploads files to a Ticket one after another, saying how far it got and what was refused. */
export function useAttach(ticketKey: string, onAttached: () => void) {
  const [uploading, setUploading] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);
  const attach = async (files: File[]) => {
    if (files.length === 0) return;
    setErrors([]);
    for (const file of files) {
      setUploading(file.name || "pasted file");
      try {
        await api.attach(ticketKey, file);
      } catch (err) {
        setErrors((e) => [...e, `${file.name || "The pasted file"}: ${messageOf(err)}`]);
      }
    }
    setUploading(undefined);
    onAttached();
  };
  return { attach, uploading, errors };
}

export type Attaching = ReturnType<typeof useAttach>;

/**
 * Attaches files dropped anywhere on the page, or pasted while no text field holds a selection to paste into, while
 * `enabled`. Answers whether files are being dragged over the page, to show where they'll go.
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
      e.preventDefault();
      setDragging(false);
      latest.current([...(e.dataTransfer?.files ?? [])]);
    };
    const paste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return;
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
}

/** The Ticket's own Attachments as thumbnails under its description, with where to drop more. */
export function TicketAttachments(props: AttachmentsView) {
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
        wide
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
        description="It is removed from the Ticket for everyone, and its file is deleted."
        confirmLabel="Delete"
        busy={busy}
        onConfirm={() => void remove()}
      />
    </>
  );
}
