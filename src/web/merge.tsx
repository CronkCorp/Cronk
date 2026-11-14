import { useState, type ReactNode } from "react";
import type { Conflict, MergedSection } from "./api.js";
import { diffLines } from "./diff.js";
import { TextArea } from "./ui.js";

/**
 * Settling a save refused because someone saved since: what changed between two Versions, and the
 * choice for each part both edits changed. Documents and Guidance share it, as they share the merge.
 */

/** One conflicting part: base, mine and theirs side by side, and the text to keep, which starts as mine. */
function ConflictChoice(props: { label: string; conflict: Conflict; value: string; onChange: (v: string) => void; rows: number }) {
  const c = props.conflict;
  const side = (name: string, text: string | null) => (
    <div className="side">
      <span className="muted">{name}</span>
      <pre className="theirs">{text ?? "(removed)"}</pre>
    </div>
  );
  return (
    <section className="merge-conflict" aria-label={props.label}>
      <h3>{props.label}</h3>
      <div className="sides">
        {side("Before", c.base)}
        {side("Mine", c.mine)}
        {side("Theirs", c.theirs)}
      </div>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => props.onChange(c.mine ?? "")}>Use mine</button>
        <button type="button" className="secondary" onClick={() => props.onChange(c.theirs ?? "")}>Use theirs</button>
        <button type="button" className="secondary" onClick={() => props.onChange(c.both)}>Use both</button>
      </div>
      <TextArea label={`Keep for ${props.label}`} value={props.value} onChange={props.onChange} rows={props.rows} />
    </section>
  );
}

/** What `ResolveMerge` settles: a merge's sections, and for a Document its title. */
interface Mergeable {
  title?: string | null;
  titleConflict?: Conflict | null;
  sections: MergedSection[];
}

/** Lets the User settle each conflict of a merge, then hands back the merged title (empty without one) and body. */
export function ResolveMerge(props: { merge: Mergeable; onResolved: (r: { title: string; body: string }) => void; onCancel: () => void }) {
  const m = props.merge;
  const [title, setTitle] = useState(m.title ?? m.titleConflict?.mine ?? "");
  const [kept, setKept] = useState<string[]>(m.sections.map((s) => s.text ?? s.conflict?.mine ?? ""));
  const keep = (i: number, text: string) => setKept(kept.map((k, at) => (at === i ? text : k)));
  const sectionName = (s: MergedSection) => s.heading ?? (m.sections.length === 1 ? "The whole body" : "Before the first heading");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onResolved({ title, body: kept.join("") });
      }}
    >
      {m.titleConflict && <ConflictChoice label="Title" conflict={m.titleConflict} value={title} onChange={setTitle} rows={1} />}
      {m.sections.map((s, i) =>
        s.conflict ? <ConflictChoice key={i} label={sectionName(s)} conflict={s.conflict} value={kept[i]!} onChange={(v) => keep(i, v)} rows={8} /> : null,
      )}
      <div className="actions">
        <button type="submit">Use these and keep editing</button>
        <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** How many unchanged lines around a change stay visible; longer unchanged runs fold. */
const CONTEXT = 3;

/** What changed from one Version (or edit) to another, line by line. */
export function VersionDiff(props: { before: { title: string; body: string }; after: { title: string; body: string }; label: string }) {
  const lines = diffLines(props.before.body, props.after.body);
  const changed = lines.map((l) => l.kind !== "same");
  const near = (i: number) => changed.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(Boolean);
  const rows: ReactNode[] = [];
  let folded = 0;
  const flush = (key: string) => {
    if (folded > 0) rows.push(<li key={key} className="diff-fold muted">{folded} unchanged {folded === 1 ? "line" : "lines"}</li>);
    folded = 0;
  };
  lines.forEach((line, i) => {
    if (line.kind === "same" && !near(i)) {
      folded++;
      return;
    }
    flush(`fold-${i}`);
    const mark = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
    rows.push(<li key={i} className={`diff-${line.kind}`}>{`${mark} ${line.text}`}</li>);
  });
  flush("fold-end");
  return (
    <div className="diff">
      {props.before.title !== props.after.title && (
        <p>Title: <del>{props.before.title}</del> → <ins>{props.after.title}</ins></p>
      )}
      {changed.some(Boolean) ? (
        <ol className="diff-lines" aria-label={props.label}>{rows}</ol>
      ) : (
        <p className="muted">The bodies are the same.</p>
      )}
    </div>
  );
}
