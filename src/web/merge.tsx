import { Button } from "./components/button.js";
import { Chip } from "./components/tags.js";
import { Banner } from "./components/banner.js";
import { Actor, type ActorLike } from "./components/actor.js";
import { useState, type FormEvent, type ReactNode } from "react";
import { staleVersionOf, type Conflict, type MergedSection } from "./api.js";
import { diffLines } from "./diff.js";
import { TextArea, messageOf } from "./ui.js";

/**
 * Settling a save refused because someone saved since: what changed between two Versions, and the
 * choice for each part both edits changed. Documents and Guidance share it, as they share the merge.
 */

/** One side of a stale save, as `StaleSaveNotice` shows it: a Version's number and text, and a Document's title. */
export interface SavedText {
  number: number;
  title?: string;
  body: string;
}

/**
 * Where settling a refused save stands: a conflict to settle, a clean merge, a conflict the User
 * settled, or a conflict the User left unsettled to go back to their draft.
 */
export type MergeStage = "conflict" | "merged" | "resolved" | "behind";

/** What the banner advises at each stage; `choices` counts the parts that need a choice, and `clean` whether others merged cleanly. */
function stageAdvice(stage: MergeStage, choices: number, clean: boolean): string {
  switch (stage) {
    case "conflict": {
      const need = `${choices} ${choices === 1 ? "section needs" : "sections need"} your choice`;
      return `${need}${clean ? "; the rest merged cleanly" : ""}. Choose or combine below, then save.`;
    }
    case "merged":
      return "Their changes touched other sections and are merged into yours below; check them and save again.";
    case "resolved":
      return "Your choices are merged into your draft below; check it and save again.";
    case "behind":
      return "Your draft is still behind theirs; save again to merge them.";
  }
}

/**
 * The information banner telling the User their save was refused because `by` saved `theirs` since
 * `base`, and what to do next. Outside a conflict, their changes follow, folded; while one is
 * settled, `ResolveMerge` shows them instead.
 */
export function StaleSaveNotice(props: { by: ActorLike; base: SavedText; theirs: SavedText; stage: MergeStage; choices: number; clean: boolean }) {
  const { base, theirs } = props;
  return (
    <>
      <Banner tone="info" role="alert">
        <p>
          <strong>
            <Actor actor={props.by} /> saved Version {theirs.number} while you were editing, so your save was not made.
          </strong>{" "}
          {stageAdvice(props.stage, props.choices, props.clean)}
        </p>
      </Banner>
      {props.stage !== "conflict" && (
        <details className="folded-diff">
          <summary>Their changes (Version {base.number} to {theirs.number})</summary>
          <VersionDiff before={base} after={theirs} label={`Their changes, Version ${base.number} to ${theirs.number}`} />
        </details>
      )}
    </>
  );
}

/** Drops the User's draft for the Version someone saved meanwhile; it sits in the editor's action row. */
export function DiscardMine(props: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button type="button" variant="secondary" onClick={props.onClick} disabled={props.disabled}>
      Discard mine and edit theirs
    </Button>
  );
}

/** A draft as settling a stale save sees it: its text, and for a Document its title. */
export interface Draft {
  title?: string;
  text: string;
}

/** A merge of a refused draft, adapted from a Document's or Guidance's to one shape. */
export interface StaleMerge {
  /** The Version editing started from. */
  base: SavedText;
  /** The Version someone else saved meanwhile, which the merge is onto. */
  theirs: SavedText;
  /** Who saved their Version. */
  by: ActorLike;
  /** The merge, for `ResolveMerge` to settle. */
  merge: Mergeable;
  /** The merged draft, or null when the merge left conflicts for the User to settle. */
  merged: Draft | null;
}

/** Someone else's save that refused this one, and how settling it stands. */
interface OtherEdit extends Pick<StaleMerge, "base" | "theirs" | "by"> {
  /** Whether the merge left conflicts for the User to settle. */
  conflicted: boolean;
  /** The User left the conflict unsettled and went back to their draft. */
  wentBack?: boolean;
}

/**
 * The draft of an editor whose save names the Version editing started from, and what to do when
 * that save is refused because someone saved since: show their edit, and merge it into the draft
 * section by section, leaving sections both changed differently for the User to choose or combine.
 * Documents and Guidance share it; each passes its own save and merge calls, adapted to a `Draft`.
 * The merge call runs once per refused save and may also tell the page what the Version now is.
 * Hands back the draft, the save handler, and the props for `StaleSaveNotice`, `ResolveMerge` and
 * `DiscardMine` while there is a refused save to settle.
 */
export function useStaleSave<D extends Draft, T>(options: {
  draft: D;
  baseVersion: number;
  save: (draft: D, baseVersion: number) => Promise<T>;
  merge: (draft: D, baseVersion: number) => Promise<StaleMerge>;
  onSaved: (saved: T) => void;
}) {
  const [draft, setDraft] = useState<D>(options.draft);
  const [base, setBase] = useState(options.baseVersion);
  const [other, setOther] = useState<OtherEdit>();
  const [resolving, setResolving] = useState<{ merge: Mergeable; onto: number }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  /** Replaces the draft's text, and its title when it has one. */
  const replaceDraft = (text: string, title: string | undefined) =>
    setDraft((d) => ({ ...d, text, ...(d.title !== undefined && title !== undefined && { title }) }));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      options.onSaved(await options.save(draft, base));
    } catch (err) {
      if (!staleVersionOf(err)) {
        setError(messageOf(err));
        return;
      }
      try {
        const m = await options.merge(draft, base);
        const { base: started, theirs, by } = m;
        setOther({ base: started, theirs, by, conflicted: m.merged === null });
        if (m.merged) {
          replaceDraft(m.merged.text, m.merged.title);
          setBase(m.theirs.number);
        } else {
          setResolving({ merge: m.merge, onto: m.theirs.number });
        }
      } catch (mergeErr) {
        setError(messageOf(mergeErr));
      }
    } finally {
      setBusy(false);
    }
  };

  const takeTheirs = (theirs: SavedText) => {
    replaceDraft(theirs.body, theirs.title);
    setBase(theirs.number);
    setResolving(undefined);
    setOther(undefined);
  };

  // The draft is still based on the Version editing started from, so its next save is refused and merges again.
  const backToDraft = () => {
    setResolving(undefined);
    setOther((o) => o && { ...o, wentBack: true });
  };

  const notice: Parameters<typeof StaleSaveNotice>[0] | undefined = other && {
    by: other.by,
    base: other.base,
    theirs: other.theirs,
    stage: resolving ? "conflict" : other.wentBack ? "behind" : other.conflicted ? "resolved" : "merged",
    choices: resolving ? conflictCount(resolving.merge) : 0,
    clean: resolving ? resolving.merge.sections.some((s) => !s.conflict) : true,
  };
  /** Drops the draft for their Version, while someone else's save is in the way; not while saving. */
  const discardMine = other && { onClick: () => takeTheirs(other.theirs), disabled: busy };
  const onDiscardMine = discardMine?.onClick;
  const resolve: Parameters<typeof ResolveMerge>[0] | undefined = resolving &&
    other && {
      merge: resolving.merge,
      mine: draft.text,
      theirsLabel: `${other.by.name}, Version ${other.theirs.number}`,
      onResolved: (resolved) => {
        replaceDraft(resolved.body, resolved.title);
        setBase(resolving.onto);
        setResolving(undefined);
      },
      onBack: backToDraft,
      onDiscardMine: onDiscardMine!,
    };

  return { draft, setDraft, save, busy, error, notice, resolve, discardMine };
}

/**
 * One conflicting part as a panel: the User's side and theirs next to each other, buttons to take
 * either or both, and the text to keep, which starts as the User's own.
 */
function ConflictChoice(props: { label: string; theirsLabel: string; conflict: Conflict; value: string; onChange: (v: string) => void; rows: number }) {
  const c = props.conflict;
  const side = (name: string, text: string | null) => (
    <section className="merge-side" aria-label={name}>
      <span className="merge-side-name">{name}</span>
      <pre>{text ?? "(removed)"}</pre>
    </section>
  );
  return (
    <section className="merge-conflict" aria-label={props.label}>
      <div className="merge-conflict-head">
        <h3>{props.label}</h3>
        <Chip tone="danger">Both changed</Chip>
      </div>
      <div className="merge-sides">
        {side("Yours", c.mine)}
        {side(props.theirsLabel, c.theirs)}
      </div>
      <div className="actions merge-choices">
        <Button type="button" variant="secondary" onClick={() => props.onChange(c.mine ?? "")}>Use mine</Button>
        <Button type="button" variant="secondary" onClick={() => props.onChange(c.theirs ?? "")}>Use theirs</Button>
        <Button type="button" variant="secondary" onClick={() => props.onChange(c.both)}>Use both</Button>
        <span className="muted">or edit below</span>
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

/** How many parts of a merge, its title included, need the User's choice. */
function conflictCount(m: Mergeable): number {
  return (m.titleConflict ? 1 : 0) + m.sections.filter((s) => s.conflict).length;
}

/**
 * Lets the User settle each conflict of a merge, then hands back the merged title (empty without one) and body.
 * What merged cleanly shows as a folded diff from `mine`, the User's draft; `theirsLabel` names the other side.
 * `onBack` leaves without settling, back to the User's own draft; `onDiscardMine` takes their Version instead.
 */
export function ResolveMerge(props: {
  merge: Mergeable;
  mine: string;
  theirsLabel: string;
  onResolved: (r: { title: string; body: string }) => void;
  onBack: () => void;
  onDiscardMine: () => void;
}) {
  const m = props.merge;
  const [title, setTitle] = useState(m.title ?? m.titleConflict?.mine ?? "");
  const initial = m.sections.map((s) => s.text ?? s.conflict?.mine ?? "");
  const [kept, setKept] = useState<string[]>(initial);
  const keep = (i: number, text: string) => setKept(kept.map((k, at) => (at === i ? text : k)));
  const sectionName = (s: MergedSection) => s.heading ?? (m.sections.length === 1 ? "The whole text" : "Before the first heading");
  // Mine with every clean section merged in: what merging cleanly changed in the User's draft.
  const cleanlyMerged = initial.join("");
  return (
    <form
      className="resolve-merge"
      onSubmit={(event) => {
        event.preventDefault();
        props.onResolved({ title, body: kept.join("") });
      }}
    >
      {m.titleConflict && (
        <ConflictChoice label="Title" theirsLabel={props.theirsLabel} conflict={m.titleConflict} value={title} onChange={setTitle} rows={1} />
      )}
      {m.sections.map((s, i) =>
        s.conflict ? (
          <ConflictChoice key={i} label={sectionName(s)} theirsLabel={props.theirsLabel} conflict={s.conflict} value={kept[i]!} onChange={(v) => keep(i, v)} rows={8} />
        ) : null,
      )}
      {cleanlyMerged !== props.mine && (
        <details className="folded-diff" aria-label="Merged cleanly">
          <summary>Merged cleanly: their changes to other sections</summary>
          <VersionDiff before={{ body: props.mine }} after={{ body: cleanlyMerged }} label="Changes merged cleanly into yours" />
        </details>
      )}
      <div className="actions">
        <Button type="submit">Use these and keep editing</Button>
        <Button type="button" variant="secondary" onClick={props.onBack}>Back to my draft</Button>
        <DiscardMine onClick={props.onDiscardMine} />
      </div>
    </form>
  );
}

/** How many unchanged lines around a change stay visible; longer unchanged runs fold. */
const CONTEXT = 3;

/** What changed from one Version (or edit) to another, line by line. */
export function VersionDiff(props: { before: { title?: string; body: string }; after: { title?: string; body: string }; label: string }) {
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
