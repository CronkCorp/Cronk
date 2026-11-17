import { Button } from "./components/button.js";
import { useId, useImperativeHandle, useRef, type ClipboardEvent, type DragEvent, type Ref } from "react";
import { attachmentMarkdown } from "./attachments.js";
import type { Attachment } from "./api.js";
import { CronkMarkdown } from "./markdown.js";

/** What a page can do to an open editor: put text at its cursor, in place of the selection, undoably. */
export interface MarkdownEditorHandle {
  /** Puts `text` in place of the selection, leaving the cursor after it, as one edit Ctrl+Z undoes. */
  insert: (text: string) => void;
}

/** A change a toolbar button makes: the text that replaces [start, end), and what to select afterwards, relative to `start`. */
interface TextChange {
  start: number;
  end: number;
  insert: string;
  select: [number, number];
}

/** Wraps the selection in `before` and `after`, or a placeholder when nothing is selected, keeping the wrapped text selected. */
const wrap = (before: string, after: string, placeholder: string) => (text: string, start: number, end: number): TextChange => {
  const inner = text.slice(start, end) || placeholder;
  return { start, end, insert: `${before}${inner}${after}`, select: [before.length, before.length + inner.length] };
};

/** Puts `prefix` before every line the selection touches, or takes it off again if they all have it. */
const prefixLines = (prefix: string) => (text: string, start: number, end: number): TextChange => {
  const from = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end > start ? end - 1 : end);
  const to = newline < 0 ? text.length : newline;
  const lines = text.slice(from, to).split("\n");
  const prefixed = lines.every((line) => line.startsWith(prefix));
  const insert = lines.map((line) => (prefixed ? line.slice(prefix.length) : prefix + line)).join("\n");
  return { start: from, end: to, insert, select: [insert.length, insert.length] };
};

/** Turns the selection into a link, selecting the address to type over. */
const link = (text: string, start: number, end: number): TextChange => {
  const label = text.slice(start, end) || "text";
  const insert = `[${label}](https://)`;
  return { start, end, insert, select: [label.length + 3, insert.length - 1] };
};

/** Inline code for a selection within a line; a fenced block for one spanning lines. */
const code = (text: string, start: number, end: number): TextChange =>
  text.slice(start, end).includes("\n") ? wrap("```\n", "\n```", "")(text, start, end) : wrap("`", "`", "code")(text, start, end);

/** What a toolbar button does to the text and its selection; nothing, if it was called off. */
type Action = (text: string, start: number, end: number) => TextChange | undefined;

/**
 * A Markdown editor: a textarea with a formatting toolbar beside a live preview, rendered as the
 * Document will read. It only ever edits the Markdown, so what is saved is exactly what it shows.
 * Given `attach`, files dropped or pasted into it are attached and embedded at the cursor.
 */
export function MarkdownEditor(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** The Project whose Ticket keys a Ticket reference starts with, if any. */
  projectKey?: string | null;
  /** Attaches files to what is being edited, answering those that attached; without it, files dropped or pasted are left alone. */
  attach?: (files: File[]) => Promise<Attachment[]>;
  ref?: Ref<MarkdownEditorHandle>;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  /** Applies an edit through the browser's own text input, so it can be undone like typing. */
  const apply = (action: Action) => {
    const el = area.current;
    if (!el) return;
    const edit = action(el.value, el.selectionStart, el.selectionEnd);
    el.focus();
    if (!edit) return;
    el.setSelectionRange(edit.start, edit.end);
    if (!document.execCommand("insertText", false, edit.insert)) {
      el.setRangeText(edit.insert);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.setSelectionRange(edit.start + edit.select[0], edit.start + edit.select[1]);
  };

  /** Puts `text` in place of the selection, leaving the cursor after it. */
  const insert = (text: string) => apply((_, start, end) => ({ start, end, insert: text, select: [text.length, text.length] }));
  useImperativeHandle(props.ref, () => ({ insert }));

  /** Attaches `files` and embeds those that attached where the cursor then is, one per line, in the order they came. */
  const attachFiles = async (files: File[]) => {
    const attached = await props.attach!(files);
    if (attached.length > 0) insert(attached.map(attachmentMarkdown).join("\n"));
  };
  /** Whether a drag carries files this editor takes: it can attach them and isn't disabled. */
  const carriesFiles = (e: DragEvent) => props.attach !== undefined && !props.disabled && e.dataTransfer.types.includes("Files");
  /** Lets files be dropped here, so the browser doesn't open them instead. */
  const onDragOver = (e: DragEvent) => {
    if (carriesFiles(e)) e.preventDefault();
  };
  /** Attaches and embeds dropped files, claiming the drop so the page doesn't attach them again. */
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    void attachFiles([...e.dataTransfer.files]);
  };
  /**
   * Attaches and embeds pasted files, claiming the paste so the page doesn't attach them again. A paste that also
   * carries text, as a copy from a word processor or spreadsheet does, pastes only the text, as it always has.
   */
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (!props.attach || files.length === 0) return;
    if (e.clipboardData.types.includes("text/plain")) {
      // The text goes into the editor; keep the page from taking the files and the text with them.
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    void attachFiles(files);
  };

  /** Asks for a Ticket key, starting from the selection or this Project's prefix, and puts it in place of the selection. */
  const ticketReference: Action = (text, start, end) => {
    const key = prompt("Ticket key", text.slice(start, end) || (props.projectKey ? `${props.projectKey}-` : ""))?.trim();
    return key ? { start, end, insert: key, select: [key.length, key.length] } : undefined;
  };

  const tools: [string, string, Action][] = [
    ["Heading", "H", prefixLines("## ")],
    ["Bold", "B", wrap("**", "**", "bold text")],
    ["Italic", "I", wrap("_", "_", "italic text")],
    ["Link", "Link", link],
    ["List", "List", prefixLines("- ")],
    ["Code", "Code", code],
    ["Ticket reference", "Ticket", ticketReference],
  ];

  return (
    <div className="markdown-editor">
      <div className="markdown-editor-pane">
        <div className="field">
          <label htmlFor={id}>{props.label}</label>
          <div className="toolbar" role="toolbar" aria-label="Formatting">
            {tools.map(([name, text, action]) => (
              <Button key={name} type="button" variant="secondary" title={name} aria-label={name} disabled={props.disabled} onClick={() => apply(action)}>
                {text}
              </Button>
            ))}
          </div>
          <textarea
            id={id}
            ref={area}
            disabled={props.disabled}
            value={props.value}
            rows={18}
            onChange={(e) => props.onChange(e.target.value)}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onPaste={onPaste}
          />
        </div>
      </div>
      <section className="markdown-editor-pane" aria-label="Preview">
        <span className="pane-label muted">Preview</span>
        <div className="markdown">
          {props.value.trim() ? <CronkMarkdown>{props.value}</CronkMarkdown> : <p className="muted">Nothing to preview yet.</p>}
        </div>
      </section>
    </div>
  );
}
