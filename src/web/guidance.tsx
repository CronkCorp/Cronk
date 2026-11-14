import { useState, type FormEvent } from "react";
import { api, ApiError, type Guidance } from "./api.js";
import { CronkMarkdown } from "./markdown.js";
import { messageOf, Show, TextArea, useLoad } from "./ui.js";

/**
 * Guidance for Agents, the Workspace's or (with `projectKey`) a Project's: its current Markdown,
 * an editor for those allowed to write it, and its Versions. A save someone else beat is
 * refused by the API; the editor then shows their Version and keeps the draft to merge.
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

function GuidanceEditor(props: {
  projectKey: string | undefined;
  current: Guidance;
  onCurrentChanged: (guidance: Guidance) => void;
  onDone: (guidance: Guidance) => void;
  onCancel: () => void;
}) {
  const [markdown, setMarkdown] = useState(props.current.markdown);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Set when someone saved while this draft was open: their Version, which the next save is based on.
  const [theirs, setTheirs] = useState<Guidance>();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      props.onDone(await api.saveGuidance(props.projectKey, { markdown, baseVersion: props.current.version }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body.current) {
        const current = err.body.current as Guidance;
        setTheirs(current);
        props.onCurrentChanged(current);
      } else {
        setError(messageOf(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="panel wide">
      {theirs && (
        <div className="conflict" role="alert">
          <p>Someone saved Version {theirs.version} while you were editing. Merge their changes into your draft below, then save again.</p>
          <pre className="their-version">{theirs.markdown}</pre>
        </div>
      )}
      <TextArea label="Guidance (Markdown)" value={markdown} onChange={setMarkdown} rows={14} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={busy}>Save</button>
        <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}
