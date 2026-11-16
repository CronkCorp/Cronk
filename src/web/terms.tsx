import { useState, type ReactNode } from "react";
import { Actor } from "./components/actor.js";
import { Banner } from "./components/banner.js";
import { Button, buttonClass } from "./components/button.js";
import { Chip, ProtectedMark } from "./components/tags.js";
import { ProtectionHistory } from "./components/protection.js";
import { ConfirmDialog, Menu } from "./components/overlays.js";
import { RelativeTime } from "./components/time.js";
import { api, glossaryUrl, type Term, type TermInput, type TermVersion } from "./api.js";
import { explainStale } from "./documents.js";
import { CronkMarkdown } from "./markdown.js";
import { Link, navigate } from "./router.js";
import { termsAddress } from "./routes.js";
import { Field, Show, TextArea, useAction, useCanWrite, useLoad } from "./ui.js";

// The Terms page and a Term's page: docs/ui.md § Terms.

/** Where a Term belongs, as its row, page and crumbs name it. */
const placeName = (projectKey: string | null | undefined) => projectKey ?? "Workspace";

/** The crumbs above a Terms heading: Terms, then the place. */
function Crumbs(props: { projectKey: string | null | undefined }) {
  return (
    <div className="muted crumbs">
      <Link to={termsAddress(props.projectKey)} className="link">Terms</Link> / {placeName(props.projectKey)}
    </div>
  );
}

/** The Workspace / Project scope switch: one segment for the Workspace, then one per Project. */
function ScopeSwitch(props: { projectKey: string | undefined }) {
  const [projects] = useLoad(() => api.projects(), []);
  const keys = projects.kind === "loaded" ? projects.value.map((p) => p.key) : [];
  const scopes: [string | undefined, string][] = [[undefined, "Workspace"], ...keys.map((k): [string, string] => [k, k])];
  return (
    <nav className="segmented" aria-label="Scope">
      {scopes.map(([key, label]) => {
        const active = key === props.projectKey;
        return (
          <Link key={label} to={termsAddress(key)} className={active ? "segment active" : "segment"} {...(active ? { "aria-current": "page" as const } : {})}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Whether a Term's name or one of its words to avoid holds `filter`, ignoring case. */
const matches = (term: Term, filter: string) => {
  const wanted = filter.trim().toLowerCase();
  return wanted === "" || [term.name, ...term.avoid].some((w) => w.toLowerCase().includes(wanted));
};

/** Terms by group as a glossary lists them: those without a group first, then each group by name. */
function byGroup(terms: Term[]): [string | null, Term[]][] {
  const groups = [...new Set(terms.map((t) => t.group))].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.toLowerCase().localeCompare(b.toLowerCase())));
  return groups.map((g) => [g, terms.filter((t) => t.group === g)]);
}

/**
 * The Terms that apply in a Project, or the Workspace's, read like a glossary: grouped, filterable by
 * name and words to avoid, each with its definition and the words to avoid.
 */
export function TermsPage(props: { projectKey?: string | undefined }) {
  const projectKey = props.projectKey?.toUpperCase();
  const [terms] = useLoad(() => api.terms(projectKey), [projectKey]);
  const canWrite = useCanWrite(projectKey);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  return (
    <section className="terms-page">
      <div className="page-head">
        <div>
          <Crumbs projectKey={projectKey} />
          <h1>Terms</h1>
        </div>
        <div className="actions">
          <ScopeSwitch projectKey={projectKey} />
          <a className={buttonClass("secondary")} href={glossaryUrl(projectKey)} download="GLOSSARY.md">Export GLOSSARY.md</a>
          {canWrite && !creating && <Button onClick={() => setCreating(true)}>New Term</Button>}
        </div>
      </div>
      {creating && <NewTerm projectKey={projectKey} onCancel={() => setCreating(false)} />}
      <Show state={terms}>
        {(all) => {
          if (all.length === 0) {
            return (
              <div className="empty">
                <h2>No Terms yet</h2>
                <p className="muted">Create one with New Term: a name, its definition and the words to avoid for it.</p>
              </div>
            );
          }
          const shown = all.filter((t) => matches(t, filter));
          const own = all.filter((t) => t.projectKey !== null).length;
          return (
            <>
              <div className="terms-filter">
                <input
                  className="filter-input"
                  type="search"
                  aria-label="Filter Terms and words to avoid"
                  placeholder="Filter Terms and words to avoid"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <span className="muted small">
                  {all.length} {all.length === 1 ? "Term" : "Terms"}
                  {projectKey && ` · ${own} from this Project, ${all.length - own} from the Workspace`}
                </span>
              </div>
              {shown.length === 0 && <p className="muted">No Term's name or words to avoid hold “{filter.trim()}”.</p>}
              {byGroup(shown).map(([group, members]) => (
                <section key={group ?? ""} className="term-group" aria-label={group ?? "Without a group"}>
                  {group !== null && <h2>{group}</h2>}
                  <ul className="rows terms">
                    {members.map((t) => (
                      <TermRow key={t.id} term={t} />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          );
        }}
      </Show>
    </section>
  );
}

/** "Overrides the Workspace Term", or "Replaced in CRONK", as a pill after a Term's name. */
function OverridePill(props: { term: Term }) {
  const { overrides, overriddenBy } = props.term;
  if (overrides) return <Chip tone="info">Overrides the Workspace Term</Chip>;
  if (overriddenBy.length > 0) return <Chip tone="info">{`Replaced in ${overriddenBy.map((o) => o.projectKey).join(", ")}`}</Chip>;
  return null;
}

/** The words to avoid, struck through. */
function Avoid(props: { words: string[] }) {
  if (props.words.length === 0) return null;
  return (
    <p className="avoid muted small">
      Avoid:{" "}
      {props.words.map((w, i) => (
        <span key={w}>
          {i > 0 && ", "}
          <s>{w}</s>
        </span>
      ))}
    </p>
  );
}

/** One Term as the glossary lists it: name, override, place and Version, then its definition and the words to avoid. */
function TermRow(props: { term: Term }) {
  const t = props.term;
  return (
    <li className="term">
      <div className="term-head">
        <Link to={`/terms/${t.id}`} className="term-name">{t.name}</Link>
        {t.protected && <ProtectedMark />}
        <OverridePill term={t} />
        <span className="muted small">{placeName(t.projectKey)}</span>
        <span className="grow" />
        <span className="muted small">Version {t.version}</span>
      </div>
      <div className="markdown term-definition">
        <CronkMarkdown>{t.definition}</CronkMarkdown>
      </div>
      <Avoid words={t.avoid} />
      {t.overrides && (
        <p className="muted small">
          In the Workspace, {t.overrides.name} means “{firstLine(t.overrides.definition)}” <Link to={`/terms/${t.overrides.id}`} className="link">See it</Link>
        </p>
      )}
    </li>
  );
}

/** The first line of a definition, for quoting it in passing. */
const firstLine = (markdown: string) => markdown.trim().split("\n")[0]!;

/** Words to avoid as typed: separated by commas. */
const wordsFrom = (text: string) => text.split(",").map((w) => w.trim()).filter((w) => w !== "");

/** The fields of a Term to create or edit, handed to `onSubmit`; `submitLabel` names the button. */
function TermForm(props: { initial?: TermInput; submitLabel: string; busy: boolean; error: string | undefined; onSubmit: (input: TermInput) => void; onCancel: () => void }) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [definition, setDefinition] = useState(props.initial?.definition ?? "");
  const [avoid, setAvoid] = useState(props.initial?.avoid.join(", ") ?? "");
  const [group, setGroup] = useState(props.initial?.group ?? "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit({ name, definition, avoid: wordsFrom(avoid), group: group.trim() || null });
      }}
    >
      <Field label="Name" value={name} onChange={setName} />
      <TextArea label="Definition" value={definition} onChange={setDefinition} rows={4} />
      <Field label="Words to avoid, separated by commas" value={avoid} onChange={setAvoid} required={false} />
      <Field label="Group" value={group} onChange={setGroup} required={false} />
      {props.error && <p className="error" role="alert">{props.error}</p>}
      <div className="actions">
        <Button type="submit" disabled={props.busy}>{props.submitLabel}</Button>
        <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function NewTerm(props: { projectKey: string | undefined; onCancel: () => void }) {
  const create = useAction((input: TermInput) => api.createTerm(props.projectKey, input), (term) => navigate(`/terms/${term.id}`));
  return (
    <section className="panel wide">
      <h2>New {props.projectKey ? `${props.projectKey} ` : "Workspace "}Term</h2>
      {props.projectKey && <p className="muted hint">Within {props.projectKey}, it replaces any Workspace Term of the same name.</p>}
      <TermForm submitLabel="Create Term" busy={create.busy} error={create.error} onSubmit={(input) => void create.run(input)} onCancel={props.onCancel} />
    </section>
  );
}

/** One Term at its current Version: its override, definition, words to avoid and group, then its History; edited in place. */
export function TermPage(props: { id: string; edit: boolean }) {
  const [term, reload, setTerm] = useLoad(() => api.term(props.id), [props.id]);
  return <Show state={term}>{(t) => <TermView key={t.id} term={t} startEditing={props.edit} onChanged={setTerm} onReload={reload} />}</Show>;
}

function TermView(props: { term: Term; startEditing: boolean; onChanged: (t: Term) => void; onReload: () => void }) {
  const t = props.term;
  const canWrite = useCanWrite(t.projectKey);
  const [editing, setEditing] = useState(props.startEditing);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const save = useAction(
    (input: TermInput) =>
      api.saveTerm(t.id, t.version, input).catch(explainStale(props.onReload, "saving")),
    (saved) => {
      setEditing(false);
      props.onChanged(saved);
    },
  );
  const remove = useAction(
    () => api.deleteTerm(t.id, t.version),
    () => navigate(termsAddress(t.projectKey)),
  );
  const protect = useAction((value: boolean) => api.protectTerm(t.id, value), props.onChanged);
  return (
    <section className="term-page">
      <div className="page-head">
        <div>
          <Crumbs projectKey={t.projectKey} />
          <h1>
            {t.name} {t.protected && <ProtectedMark />}
          </h1>
        </div>
        {canWrite && !editing && (
          <div className="actions">
            <Menu
              label="More"
              trigger={<Button variant="secondary" aria-label="More">…</Button>}
              items={[
                { label: t.protected ? "Unprotect" : "Protect", onSelect: () => void protect.run(!t.protected), disabled: protect.busy },
                { label: "Delete", danger: true, onSelect: () => setConfirmingDelete(true) },
              ]}
            />
            <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
          </div>
        )}
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title={`Delete ${t.name}?`}
          description="This deletes the Term and all its Versions."
          confirmLabel="Delete"
          busy={remove.busy}
          onConfirm={() => void remove.run()}
        />
      </div>
      {remove.error && <p className="error" role="alert">{remove.error}</p>}
      {protect.error && <p className="error" role="alert">{protect.error}</p>}
      <OverrideBanner term={t} />
      {editing ? (
        <section className="panel wide">
          <h2>Edit {t.name}</h2>
          <TermForm
            initial={t}
            submitLabel={`Save as Version ${t.version + 1}`}
            busy={save.busy}
            error={save.error}
            onSubmit={(input) => void save.run(input)}
            onCancel={() => setEditing(false)}
          />
        </section>
      ) : (
        <section className="panel wide term-detail">
          <div className="markdown term-definition">
            <CronkMarkdown>{t.definition}</CronkMarkdown>
          </div>
          <Avoid words={t.avoid} />
          <p className="muted small">
            {t.group && <>Group: {t.group} · </>}
            {placeName(t.projectKey)} · Version {t.version}, <RelativeTime at={t.updatedAt} />
          </p>
        </section>
      )}
      <History term={t} />
    </section>
  );
}

/** The `--info` banner of a Term that overrides the Workspace's, or is replaced in Projects, linking the other Term. */
function OverrideBanner(props: { term: Term }) {
  const { overrides, overriddenBy, projectKey } = props.term;
  if (overrides) {
    return (
      <Banner tone="info" role="status">
        <p>
          Overrides the Workspace Term <strong>{overrides.name}</strong> (“{firstLine(overrides.definition)}”) within {projectKey}.{" "}
          <Link to={`/terms/${overrides.id}`} className="link">Open the Workspace Term</Link>
        </p>
      </Banner>
    );
  }
  if (overriddenBy.length === 0) return null;
  return (
    <Banner tone="info" role="status">
      <p>
        Replaced by a Project's own Term within{" "}
        {overriddenBy.map((o, i) => (
          <span key={o.id}>
            {i > 0 && ", "}
            <Link to={`/terms/${o.id}`} className="link">{o.projectKey}</Link>
          </span>
        ))}
        .
      </p>
    </Banner>
  );
}

/** A Term's Versions, newest first, each with who saved it and what it said. */
function History(props: { term: Term }) {
  const [versions] = useLoad(() => api.termVersions(props.term.id), [props.term.id, props.term.version]);
  return (
    <section className="panel wide">
      <h2>History</h2>
      <Show state={versions}>
        {(list) => (
          <ol className="history versions" aria-label="Versions">
            {list.map((v) => (
              <li key={v.number} className="term-version">
                <div>
                  <strong>Version {v.number}</strong> <RelativeTime at={v.at} /> <Actor actor={v.actor} />
                </div>
                <VersionFields version={v} />
              </li>
            ))}
          </ol>
        )}
      </Show>
      <ProtectionHistory load={() => api.termProtection(props.term.id)} reloadOn={[props.term.id, props.term.protected]} />
    </section>
  );
}

function VersionFields(props: { version: TermVersion }): ReactNode {
  const v = props.version;
  return (
    <div className="muted small">
      <strong>{v.name}</strong>
      {v.group && <> · {v.group}</>}: {firstLine(v.definition)}
      {v.avoid.length > 0 && <> · Avoid: {v.avoid.join(", ")}</>}
    </div>
  );
}
