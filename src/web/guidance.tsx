import { useState, type FormEvent } from "react";
import { api, ApiError, type Guidance, type GuidanceMerge } from "./api.js";
import { CronkMarkdown } from "./markdown.js";
import { ResolveMerge, VersionDiff } from "./merge.js";
import { messageOf, Show, TextArea, useLoad } from "./ui.js";

/**
 * Guidance for Agents, the Workspace's or (with `projectKey`) a Project's: its current Markdown,
 * an editor for those allowed to write it, and its Versions. A save someone else beat is
 * refused by the API; the editor then merges their Version into the draft section by section.
 */
export function GuidanceSection(props: { projectKey?: string; canEdit: boolean; intro: string }) {
  const [guidance, , setGuidance] = useLoad(() => api.guidance(props.projectKey), [props.projectKey]);
  const [versions, reloadVersions] = useLoad(() => api.guidanceVersions(props.projectKey), [props.projectKey]);
  const [editing, setEditing] = useState(false);

  return (
    <Show state={guidance}>
      {(current) => (
        <section className="guidance">
          <p className="muted">{props.intro}</p>
          {editing ? (
            <GuidanceEditor
              projectKey={props.projectKey}
              current={current}
              onCurrentChanged={(theirs) => {
                setGuidance(theirs);
                reloadVersions();
              }}
              onDone={(saved) => {
                setGuidance(saved);
                setEditing(false);
                reloadVersions();
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <div className="markdown" data-testid="guidance">
                {current.markdown.trim() ? <CronkMarkdown>{current.markdown}</CronkMarkdown> : <p className="muted">No Guidance yet.</p>}
              </div>
              {props.canEdit && (
                <div className="actions">
                  <button onClick={() => setEditing(true)}>Edit Guidance</button>
                </div>
              )}
            </>
          )}
          <h2>Versions</h2>
          <Show state={versions}>
            {(list) =>
              list.length === 0 ? (
                <p className="muted">Not written yet.</p>
              ) : (
                <ol className="history" aria-label="Versions">
                  {[...list].reverse().map((v) => (
                    <li key={v.version}>
                      <span className="muted">Version {v.version}, {new Date(v.at).toLocaleString()}</span> <strong>{v.actor.name}</strong>
                    </li>
                  ))}
                </ol>
              )
            }
          </Show>
        </section>
      )}
    </Show>
  );
}

/** Someone else's save that refused this one: the Guidance this edit started from, and the Version they saved. */
interface OtherEdit {
  base: Guidance;
  theirs: Guidance;
  /** Who saved their Version. */
  by: string;
}

/**
 * Edits Guidance. The save names the Version editing started from; if someone saved since, it is
 * refused, and the editor shows their edit and merges it into this one section by section, as the
 * Document editor does. Sections both changed differently wait for the User to choose or combine.
 */
function GuidanceEditor(props: {
  projectKey: string | undefined;
  current: Guidance;
  onCurrentChanged: (guidance: Guidance) => void;
  onDone: (guidance: Guidance) => void;
  onCancel: () => void;
}) {
  const [markdown, setMarkdown] = useState(props.current.markdown);
  const [base, setBase] = useState(props.current.version);
  const [other, setOther] = useState<OtherEdit>();
  const [resolving, setResolving] = useState<GuidanceMerge>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      props.onDone(await api.saveGuidance(props.projectKey, { markdown, baseVersion: base }));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409 && err.body.current)) {
        setError(messageOf(err));
        return;
      }
      try {
        const [merge, versions] = await Promise.all([
          api.mergeGuidance(props.projectKey, { markdown, baseVersion: base }),
          api.guidanceVersions(props.projectKey),
        ]);
        const started = versions.find((v) => v.version === base) ?? { markdown: "", version: 0 };
        const by = versions.find((v) => v.version === merge.onto.version)?.actor.name ?? "Someone";
        setOther({ base: { markdown: started.markdown, version: started.version }, theirs: merge.onto, by });
        props.onCurrentChanged(merge.onto);
        if (merge.conflicts === 0) {
          setMarkdown(merge.markdown!);
          setBase(merge.onto.version);
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
  const takeTheirs = (theirs: Guidance) => {
    setMarkdown(theirs.markdown);
    setBase(theirs.version);
    setResolving(undefined);
    setOther(undefined);
  };

  return (
    <section className="panel wide">
      {other && (
        <div className={resolving ? "conflict" : "merged"} role="alert">
          <p>
            <strong>{other.by}</strong> saved Version {other.theirs.version} while you were editing, so your save was not made.{" "}
            {resolving
              ? "You both changed the same part; choose or combine below, then save."
              : "Their changes touched other sections and are merged into yours below; check them and save again."}
          </p>
          <details open={!!resolving}>
            <summary>Their changes (Version {other.base.version} to {other.theirs.version})</summary>
            <VersionDiff
              before={{ title: "", body: other.base.markdown }}
              after={{ title: "", body: other.theirs.markdown }}
              label={`Their changes, Version ${other.base.version} to ${other.theirs.version}`}
            />
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
            setMarkdown(resolved.body);
            setBase(resolving.onto.version);
            setResolving(undefined);
          }}
          onCancel={props.onCancel}
        />
      ) : (
        <form onSubmit={save}>
          <TextArea label="Guidance (Markdown)" value={markdown} onChange={setMarkdown} rows={14} />
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
