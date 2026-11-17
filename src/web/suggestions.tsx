import { useState, type ReactNode } from "react";
import type { Conflict, RecordedActor, SuggestedContent, Suggestion, SuggestionMerge } from "./api.js";
import type { Fields, Mergeable, MergedField } from "./merge.js";
import { KindLabel } from "./components/tags.js";
import { diffLines, type DiffLine } from "./diff.js";
import { CronkMarkdown } from "./markdown.js";
import { Field, TextArea } from "./ui.js";

// Suggestions (ADR 0014; docs/ui.md § Inbox and Triage in Phase 2): an Agent's proposed new Version of an item, shown as its
// reasoning and a Diff against the Version it started from. Display only: the API decides what accepting it does.

/** An Agent's "why", in an `--agent-soft` box under a WHY label (docs/ui.md § Reasoning). */
export function Reasoning(props: { children: string; projectKey?: string | null }) {
  return (
    <div className="reasoning">
      <KindLabel kind="suggestion">Why</KindLabel>
      <CronkMarkdown projectKey={props.projectKey ?? undefined}>{props.children}</CronkMarkdown>
    </div>
  );
}

/** A Suggestion's content as lines to compare: the fields besides the main text first, each on its own labelled line. */
export function contentText(kind: Suggestion["item"]["kind"], c: SuggestedContent): string {
  const lines: string[] = [];
  const field = (label: string, value: unknown) => lines.push(`${label}: ${value ?? "none"}`);
  if (kind === "document") field("Title", c.title);
  if (kind === "decision") {
    field("Title", c.title);
    field("Group", c.group);
  }
  if (kind === "term") {
    field("Name", c.name);
    field("Group", c.group);
    field("Avoid", Array.isArray(c.avoid) && c.avoid.length ? c.avoid.join(", ") : "nothing");
  }
  const main = kind === "term" ? c.definition : kind === "guidance" ? c.markdown : c.body;
  return [...lines, ...(lines.length ? [""] : []), String(main ?? "")].join("\n");
}

/** How a Diff is shown: one column of changes, or the two Versions side by side. */
export type DiffView = "unified" | "split";

/** Where the Diff view each User last chose is kept in this browser. */
const viewKey = (userId: string) => `cronk:diff-view:${userId}`;

/** The Diff view `userId` last chose, remembered in this browser; unified until they choose. */
export function useDiffView(userId: string): [DiffView, (view: DiffView) => void] {
  const [view, setView] = useState<DiffView>(() => {
    try {
      return localStorage.getItem(viewKey(userId)) === "split" ? "split" : "unified";
    } catch {
      return "unified";
    }
  });
  const choose = (next: DiffView) => {
    setView(next);
    try {
      localStorage.setItem(viewKey(userId), next);
    } catch {
      // Not remembered, as in a private window; the choice still holds for this page.
    }
  };
  return [view, choose];
}

/** How many unchanged lines around a change stay visible; longer unchanged runs fold. */
const CONTEXT = 3;

/** `lines` with runs of unchanged lines away from any change folded into one row saying how many; a lone line stays. */
function folded(lines: DiffLine[]): (DiffLine | { kind: "fold"; count: number })[] {
  const changed = lines.map((l) => l.kind !== "same");
  const near = (i: number) => changed.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(Boolean);
  const rows: (DiffLine | { kind: "fold"; lines: DiffLine[] })[] = [];
  lines.forEach((line, i) => {
    if (line.kind !== "same" || near(i)) return rows.push(line);
    const last = rows.at(-1);
    if (last?.kind === "fold") last.lines.push(line);
    else rows.push({ kind: "fold", lines: [line] });
  });
  return rows.flatMap((row): (DiffLine | { kind: "fold"; count: number })[] =>
    row.kind !== "fold" ? [row] : row.lines.length === 1 ? row.lines : [{ kind: "fold", count: row.lines.length }],
  );
}

const MARK = { same: " ", added: "+", removed: "−" } as const;

/** One column of the Diff: the rows shown, each marked as kept, added or removed. */
function DiffRows(props: { lines: DiffLine[]; label: string; marks?: boolean }) {
  return (
    <ol className="suggestion-diff-lines" aria-label={props.label}>
      {folded(props.lines).map((row, i) =>
        row.kind === "fold" ? (
          <li key={i} className="diff-fold muted">{`${row.count} unchanged ${row.count === 1 ? "line" : "lines"}`}</li>
        ) : (
          <li key={i} className={`diff-${row.kind}`}>
            {props.marks !== false && <span className="diff-mark" aria-hidden="true">{MARK[row.kind]}</span>}
            <span className="diff-text">{row.text || " "}</span>
          </li>
        ),
      )}
    </ol>
  );
}

/**
 * What a Suggestion changes, line by line, against its base Version (docs/ui.md § Diff): unified, or the base and the
 * suggestion side by side, as the User last chose. Below 700px it is always unified.
 */
export function Diff(props: { before: string; after: string; beforeLabel: string; afterLabel: string; view: DiffView; onViewChange: (view: DiffView) => void }) {
  const lines = diffLines(props.before, props.after);
  const unified = (
    <div className="suggestion-diff unified">
      <p className="suggestion-diff-head">{`${props.beforeLabel} → ${props.afterLabel}`}</p>
      <DiffRows lines={lines} label="Changes" />
    </div>
  );
  return (
    <div className={`diff-view ${props.view}`}>
      <div className="segmented diff-switch" role="group" aria-label="Diff view">
        {(["unified", "split"] as const).map((view) => (
          <button key={view} type="button" className={`segment${props.view === view ? " active" : ""}`} aria-pressed={props.view === view} onClick={() => props.onViewChange(view)}>
            {view === "unified" ? "Unified" : "Side by side"}
          </button>
        ))}
      </div>
      {props.view === "unified" ? (
        unified
      ) : (
        <>
          <div className="suggestion-diff-split">
            <div className="suggestion-diff-side">
              <p className="suggestion-diff-head">{props.beforeLabel}</p>
              <DiffRows lines={lines.filter((l) => l.kind !== "added")} label={props.beforeLabel} marks={false} />
            </div>
            <div className="suggestion-diff-side">
              <p className="suggestion-diff-head">{props.afterLabel}</p>
              <DiffRows lines={lines.filter((l) => l.kind !== "removed")} label={props.afterLabel} marks={false} />
            </div>
          </div>
          {/* Too narrow for two columns: the unified Diff stands in. */}
          <div className="suggestion-diff-narrow">{unified}</div>
        </>
      )}
    </div>
  );
}

/** The fields a User edits a Suggestion's content in, before accepting it, by its item's kind. */
export function ContentEditor(props: { kind: Suggestion["item"]["kind"]; value: SuggestedContent; onChange: (value: SuggestedContent) => void; disabled?: boolean }) {
  const { value, disabled } = props;
  const set = (field: string) => (v: string) => props.onChange({ ...value, [field]: v });
  const text = (field: string) => (typeof value[field] === "string" ? (value[field] as string) : "");
  const fields: ReactNode[] = [];
  if (props.kind === "document" || props.kind === "decision") fields.push(<Field key="title" label="Title" value={text("title")} onChange={set("title")} disabled={disabled} />);
  if (props.kind === "term") {
    fields.push(<Field key="name" label="Name" value={text("name")} onChange={set("name")} disabled={disabled} />);
    fields.push(
      <Field
        key="avoid"
        label="Avoid (comma-separated)"
        required={false}
        value={Array.isArray(value.avoid) ? value.avoid.join(", ") : ""}
        onChange={(v) => props.onChange({ ...value, avoid: v.split(",").map((w) => w.trim()).filter(Boolean) })}
        disabled={disabled}
      />,
    );
  }
  if (props.kind === "term" || props.kind === "decision") {
    fields.push(<Field key="group" label="Group" required={false} value={text("group")} onChange={(v) => props.onChange({ ...value, group: v.trim() ? v : null })} disabled={disabled} />);
  }
  const main = props.kind === "term" ? ["definition", "Definition (Markdown)"] : props.kind === "guidance" ? ["markdown", "Guidance (Markdown)"] : ["body", "Body (Markdown)"];
  fields.push(<TextArea key="main" label={main[1]!} value={text(main[0]!)} onChange={set(main[0]!)} rows={12} disabled={disabled} />);
  return <div className="suggestion-editor">{fields}</div>;
}

/** Who a Version made by accepting a Suggestion is credited to, as the note beside the actions says it. */
export function creditNote(version: number, proposedBy: RecordedActor, edited: boolean): string {
  return edited ? `Version ${version} will be credited to you, linked to this Suggestion.` : `Version ${version} will be credited to ${proposedBy.name}, accepted by you.`;
}

type Kind = Suggestion["item"]["kind"];

/** The field of each kind's content holding its Markdown, which merges by sections. */
const MAIN_FIELD: Record<Kind, string> = { document: "body", decision: "body", term: "definition", guidance: "markdown" };

/** The fields besides the title and Markdown that merge whole, by the label the merge shows them under. */
const OTHER_FIELDS: Record<string, { label: string; combinable: boolean }> = {
  name: { label: "Name", combinable: false },
  avoid: { label: "Avoid (comma-separated)", combinable: true },
  group: { label: "Group", combinable: false },
};

/** A field's value as the text the User edits: a list of words comma-separated, no group as nothing. */
const asText = (v: unknown) => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "");

/** A whole field's conflict as `ResolveMerge` shows one; keeping both of a list keeps every word once. */
function wholeConflict(c: { base: unknown; mine: unknown; theirs: unknown }): Conflict {
  const both = Array.isArray(c.mine) && Array.isArray(c.theirs) ? [...new Set([...c.mine, ...c.theirs])].join(", ") : `${asText(c.mine)} ${asText(c.theirs)}`;
  return { base: asText(c.base), mine: asText(c.mine), theirs: asText(c.theirs), both };
}

/** The merge of an outdated Suggestion, adapted to what `ResolveMerge` settles: the Suggestion is "mine", the current Version "theirs". */
export function suggestionMergeable(kind: Kind, merge: SuggestionMerge): Mergeable {
  const field = (name: string) => merge.fields.find((f) => f.field === name);
  const title = field("title");
  const fields: MergedField[] = merge.fields
    .filter((f) => OTHER_FIELDS[f.field])
    .map((f) => ({ label: OTHER_FIELDS[f.field]!.label, combinable: OTHER_FIELDS[f.field]!.combinable, text: f.conflict ? null : asText(f.value), conflict: f.conflict && wholeConflict(f.conflict) }));
  return {
    ...(title && { title: title.conflict ? null : asText(title.value), titleConflict: title.conflict && wholeConflict(title.conflict) }),
    fields,
    sections: field(MAIN_FIELD[kind])!.sections ?? [],
  };
}

/** The Suggestion's Markdown, the side of a merge the clean sections are compared to. */
export const mainText = (kind: Kind, content: SuggestedContent) => asText(content[MAIN_FIELD[kind]]);

/** The content a User settled a merge to, in the shape the kind's Suggestion holds, from what `ResolveMerge` hands back. */
export function settledContent(kind: Kind, settled: { title: string; body: string; fields: Fields }): SuggestedContent {
  const content: SuggestedContent = { [MAIN_FIELD[kind]]: settled.body };
  if (kind === "document" || kind === "decision") content.title = settled.title;
  for (const [name, { label }] of Object.entries(OTHER_FIELDS)) {
    const text = settled.fields[label];
    if (text === undefined) continue;
    content[name] = name === "avoid" ? text.split(",").map((w) => w.trim()).filter(Boolean) : name === "group" ? text.trim() || null : text;
  }
  return content;
}
