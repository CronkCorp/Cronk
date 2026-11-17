import { Button } from "./components/button.js";
import { Chip } from "./components/tags.js";
import { Banner } from "./components/banner.js";
import { Actor, type ActorLike } from "./components/actor.js";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { staleVersionOf, type Conflict, type MergedSection } from "./api.js";
import { diffLines } from "./diff.js";
import { Show, TextArea, messageOf, useLoad } from "./ui.js";

/**
 * Settling a save refused because someone saved since: what changed between two Versions, and the
 * choice for each part both edits changed. Documents, Decisions and Guidance share it, as they share the merge.
 * Before a save, Documents and Decisions also share watching for a newer Version and the banner warning of it.
 */

/**
 * Fields beyond the title and text that merge whole, such as a Decision's group, by the label the
 * editor shows them under, each as the text the User edits.
 */
export type Fields = Record<string, string>;

/** One side of a stale save, as `StaleSaveNotice` shows it: a Version's number and text, a Document's title, and a Decision's other fields. */
export interface SavedText {
  number: number;
  title?: string;
  body: string;
  fields?: Fields;
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

/** A draft as settling a stale save sees it: its text, for a Document or Decision its title, and for a Decision its other fields. */
export interface Draft {
  title?: string;
  text: string;
  fields?: Fields;
}

/** A merge of a refused draft, adapted from a Document's, Decision's or Guidance's to one shape. */
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
 * Documents, Decisions and Guidance share it; each passes its own save and merge calls, adapted to a `Draft`.
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

  /** Replaces the draft's text, and its title and other fields when it has them. */
  const replaceDraft = (text: string, title: string | undefined, fields: Fields | undefined) =>
    setDraft((d) => ({
      ...d,
      text,
      ...(d.title !== undefined && title !== undefined && { title }),
      ...(d.fields !== undefined && fields !== undefined && { fields: { ...d.fields, ...fields } }),
    }));

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
          replaceDraft(m.merged.text, m.merged.title, m.merged.fields);
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
    replaceDraft(theirs.body, theirs.title, theirs.fields);
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
        replaceDraft(resolved.body, resolved.title, resolved.fields);
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
function ConflictChoice(props: {
  label: string;
  theirsLabel: string;
  conflict: Conflict;
  value: string;
  onChange: (v: string) => void;
  rows: number;
  /** Whether to offer keeping both sides; true unless said otherwise. */
  combinable?: boolean;
  /** What the User's side is called; "Yours" unless said otherwise. */
  mineLabel?: string;
}) {
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
        {side(props.mineLabel ?? "Yours", c.mine)}
        {side(props.theirsLabel, c.theirs)}
      </div>
      <div className="actions merge-choices">
        <Button type="button" variant="secondary" onClick={() => props.onChange(c.mine ?? "")}>Use mine</Button>
        <Button type="button" variant="secondary" onClick={() => props.onChange(c.theirs ?? "")}>Use theirs</Button>
        {props.combinable !== false && <Button type="button" variant="secondary" onClick={() => props.onChange(c.both)}>Use both</Button>}
        <span className="muted">or edit below</span>
      </div>
      <TextArea label={`Keep for ${props.label}`} value={props.value} onChange={props.onChange} rows={props.rows} />
    </section>
  );
}

/** A field of a merge that merges whole, such as a Decision's group: its merged text, or the conflict a User must settle. */
export interface MergedField {
  /** The label the editor shows it under, which names it in the draft's `fields`. */
  label: string;
  /** The merged text; null when it conflicts. */
  text: string | null;
  /** Set when both sides changed it differently. */
  conflict: Conflict | null;
  /** Whether keeping both sides makes sense, as it does for a list; false offers only one side or the other. */
  combinable: boolean;
}

/** What `ResolveMerge` settles: a merge's sections, for a Document or Decision its title, and for a Decision its other fields. */
export interface Mergeable {
  title?: string | null;
  titleConflict?: Conflict | null;
  fields?: MergedField[];
  sections: MergedSection[];
}

/** How many parts of a merge, its title and other fields included, need the User's choice. */
export function conflictCount(m: Mergeable): number {
  return (m.titleConflict ? 1 : 0) + (m.fields ?? []).filter((f) => f.conflict).length + m.sections.filter((s) => s.conflict).length;
}

/**
 * Lets the User settle each conflict of a merge, then hands back the merged title (empty without one), other fields and body.
 * What merged cleanly shows as a folded diff from `mine`, the User's draft; `theirsLabel` names the other side.
 * `onBack` leaves without settling, back to the User's own draft; `onDiscardMine`, when given, takes their Version instead.
 * The labels of the submit and back buttons, and a note beside them, can be named for other uses, such as accepting a Suggestion.
 */
export function ResolveMerge(props: {
  merge: Mergeable;
  mine: string;
  /** What the User's side is called; "Yours" unless said otherwise. */
  mineLabel?: string;
  theirsLabel: string;
  onResolved: (r: { title: string; body: string; fields: Fields }) => void;
  onBack: () => void;
  onDiscardMine?: () => void;
  submitLabel?: string;
  backLabel?: string;
  note?: string;
  busy?: boolean;
}) {
  const m = props.merge;
  const [title, setTitle] = useState(m.title ?? m.titleConflict?.mine ?? "");
  const [fields, setFields] = useState<Fields>(Object.fromEntries((m.fields ?? []).map((f) => [f.label, f.text ?? f.conflict?.mine ?? ""])));
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
        props.onResolved({ title, body: kept.join(""), fields });
      }}
    >
      {m.titleConflict && (
        <ConflictChoice label="Title" mineLabel={props.mineLabel} theirsLabel={props.theirsLabel} conflict={m.titleConflict} value={title} onChange={setTitle} rows={1} />
      )}
      {(m.fields ?? []).map((f) =>
        f.conflict ? (
          <ConflictChoice
            key={f.label}
            label={f.label}
            mineLabel={props.mineLabel}
            theirsLabel={props.theirsLabel}
            conflict={f.conflict}
            combinable={f.combinable}
            value={fields[f.label]!}
            onChange={(v) => setFields((all) => ({ ...all, [f.label]: v }))}
            rows={1}
          />
        ) : null,
      )}
      {m.sections.map((s, i) =>
        s.conflict ? (
          <ConflictChoice key={i} label={sectionName(s)} mineLabel={props.mineLabel} theirsLabel={props.theirsLabel} conflict={s.conflict} value={kept[i]!} onChange={(v) => keep(i, v)} rows={8} />
        ) : null,
      )}
      {cleanlyMerged !== props.mine && (
        <details className="folded-diff" aria-label="Merged cleanly">
          <summary>Merged cleanly: their changes to other sections</summary>
          <VersionDiff before={{ body: props.mine }} after={{ body: cleanlyMerged }} label="Changes merged cleanly into yours" />
        </details>
      )}
      <div className="actions">
        <Button type="submit" disabled={props.busy}>{props.submitLabel ?? "Use these and keep editing"}</Button>
        <Button type="button" variant="secondary" onClick={props.onBack}>{props.backLabel ?? "Back to my draft"}</Button>
        {props.onDiscardMine && <DiscardMine onClick={props.onDiscardMine} />}
        {props.note && <span className="muted small">{props.note}</span>}
      </div>
    </form>
  );
}

/** How many unchanged lines around a change stay visible; longer unchanged runs fold. */
const CONTEXT = 3;

/** What changed from one Version (or edit) to another, line by line. */
export function VersionDiff(props: { before: { title?: string; body: string; fields?: Fields }; after: { title?: string; body: string; fields?: Fields }; label: string }) {
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
      {Object.entries(props.after.fields ?? {}).map(([label, after]) => {
        const before = props.before.fields?.[label] ?? "";
        return before === after ? null : (
          <p key={label}>{label}: <del>{before || "(none)"}</del> → <ins>{after || "(none)"}</ins></p>
        );
      })}
      {changed.some(Boolean) ? (
        <ol className="diff-lines" aria-label={props.label}>{rows}</ol>
      ) : (
        <p className="muted">The bodies are the same.</p>
      )}
    </div>
  );
}

/**
 * Watches for a newer Version than the one shown, as a Document's or Decision's live stream tells it. Feed the
 * stream's `version` events to `saw`, and call `catchUp` when the stream (re)connects to fetch the
 * `current` one for what was saved meanwhile. `newer` is that Version while it is ahead of
 * `version`; it is reloaded at once unless the page is `editing`, so a read-only page
 * follows along and an edit keeps its draft.
 */
export function useNewerVersion(options: { version: number; editing: boolean; onReload: () => void; current: () => Promise<{ version: number }> }): {
  newer: number | undefined;
  saw: (version: number) => void;
  catchUp: () => void;
} {
  const [latest, setLatest] = useState(options.version);
  const current = useRef(options.current);
  current.current = options.current;
  const saw = useCallback((version: number) => setLatest((v) => Math.max(v, version)), []);
  const catchUp = useCallback(() => void current.current().then((record) => saw(record.version), () => {}), [saw]);
  // Someone else's Version is shown at once, unless it would pull the page out from under an edit.
  const newer = latest > options.version ? latest : undefined;
  useEffect(() => {
    if (newer !== undefined && !options.editing) options.onReload();
  }, [newer, options.editing]);
  return { newer, saw, catchUp };
}

/**
 * Warns, while a Document or Decision is being edited, that someone saved a newer `version` meanwhile: who, and
 * what they changed since the Version the edit `started` from. Saving then merges it in. `of` names
 * it, `load` fetches one of its Versions, and `show` gives a Version as the diff shows it.
 */
export function SavedMeanwhile<V extends { number: number; actor: ActorLike }>(props: {
  of: string;
  started: number;
  version: number;
  load: (version: number) => Promise<V>;
  show: (v: V) => { title?: string; body: string; fields?: Fields };
}) {
  const { of, started, version } = props;
  const [versions] = useLoad(() => Promise.all([props.load(started), props.load(version)]), [of, started, version]);
  return (
    <Banner tone="warn" role="status">
      <Show state={versions}>
        {([base, theirs]) => (
          <>
            <p>
              <strong>
                <Actor actor={theirs.actor} /> saved Version {theirs.number} while you were editing Version {base.number}.
              </strong>{" "}
              Saving merges their changes into yours.
            </p>
            <details>
              <summary>See what they changed</summary>
              <VersionDiff before={props.show(base)} after={props.show(theirs)} label={`Their changes, Version ${base.number} to ${theirs.number}`} />
            </details>
          </>
        )}
      </Show>
    </Banner>
  );
}
