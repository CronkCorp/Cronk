import { useState } from "react";
import { api, type Guidance } from "./api.js";
import { CronkMarkdown } from "./markdown.js";
import { ResolveMerge, StaleSaveNotice, useStaleSave, type SavedText } from "./merge.js";
import { Show, TextArea, useLoad } from "./ui.js";

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
  const { draft, setDraft, save, busy, error, notice, resolve } = useStaleSave({
    draft: { text: props.current.markdown },
    baseVersion: props.current.version,
    save: (d, baseVersion) => api.saveGuidance(props.projectKey, { markdown: d.text, baseVersion }),
    merge: async (d, baseVersion) => {
      const merge = await api.mergeGuidance(props.projectKey, { markdown: d.text, baseVersion });
      // Listed after the merge, so the Version it merged onto is among them.
      const versions = await api.guidanceVersions(props.projectKey);
      const at = (version: number): SavedText => ({ number: version, body: versions.find((v) => v.version === version)?.markdown ?? "" });
      // Someone saved since: the page shows their Version as current while this edit is merged onto it.
      props.onCurrentChanged(merge.onto);
      return {
        base: at(baseVersion),
        theirs: { number: merge.onto.version, body: merge.onto.markdown },
        by: versions.find((v) => v.version === merge.onto.version)?.actor ?? { kind: "user", name: "Someone" },
        merge,
        merged: merge.conflicts === 0 ? { text: merge.markdown! } : null,
      };
    },
    onSaved: props.onDone,
  });

  return (
    <section className="panel wide">
      {notice && <StaleSaveNotice {...notice} />}
      {resolve ? (
        <ResolveMerge {...resolve} />
      ) : (
        <form onSubmit={save}>
          {/* Read-only while saving: the merge sends the draft as it was when Save was pressed. */}
          <TextArea label="Guidance (Markdown)" value={draft.text} onChange={(text) => setDraft({ text })} rows={14} disabled={busy} />
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
