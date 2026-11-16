import { useState } from "react";
import { api, ApiError, type Artifact, type ArtifactVersion, type EmbeddedIn } from "./api.js";
import { Actor } from "./components/actor.js";
import { Button, buttonClass } from "./components/button.js";
import { formatBytes } from "./components/files.js";
import { Dialog, Menu, Popover } from "./components/overlays.js";
import { ProtectionHistory } from "./components/protection.js";
import { Chip, ProtectedMark } from "./components/tags.js";
import { ProjectCrumbs } from "./components/crumbs.js";
import { CopyLink } from "./components/copy-link.js";
import { RelativeTime } from "./components/time.js";
import { packFolder } from "./folder-archive.js";
import { Link, navigate } from "./router.js";
import { Field, Show, useAction, useCanWrite, useLoad } from "./ui.js";

/** Artifacts: the list of a Project's or the Workspace's, and an Artifact's own page (docs/ui.md § Artifact). */

/** The address of an Artifacts list: a Project's, or the Workspace's without a Project key. */
const listAddress = (projectKey: string | null | undefined) => (projectKey ? `/projects/${projectKey}/artifacts` : "/artifacts");

/** The Version a `?version=` parameter names, if it names one. */
export const versionOf = (param: string | null): number | undefined => (param && /^[1-9][0-9]{0,8}$/.test(param) ? Number(param) : undefined);

/** The `sandbox` an Artifact's frame gets: its scripts run, but in an origin of their own, away from Cronk's. */
const FRAME_SANDBOX = "allow-scripts allow-modals allow-downloads";

/** What an embed shows of an Artifact: the Version it names, or else its latest. */
interface Embedded {
  title: string;
  number: number;
  latest: boolean;
  frameUrl: string;
  /** Its page in Cronk, at that Version when the embed names one. */
  page: string;
}

/** Loads what an embed of Artifact `id` shows: Version `version`, or else the latest. */
async function loadEmbedded(id: string, version: number | null): Promise<Embedded> {
  if (version === null) {
    const a = await api.artifact(id);
    return { title: a.title, number: a.version, latest: true, frameUrl: a.frameUrl ?? "", page: `/artifacts/${id}` };
  }
  const v = await api.artifactVersion(id, version);
  return { title: v.title, number: v.number, latest: false, frameUrl: v.frameUrl ?? "", page: `/artifacts/${id}?version=${v.number}` };
}

/**
 * An Artifact embedded in a Document, Report or Comment (docs/ui.md § Artifact): a bordered block with a bar (kind label,
 * title, Version chip, Open full size) above the sandboxed frame. One the reader can't open shows as its address, a link.
 */
export function ArtifactEmbed(props: { artifactId: string; version: number | null; address: string }) {
  const [state] = useLoad(() => loadEmbedded(props.artifactId, props.version), [props.artifactId, props.version]);
  if (state.kind === "failed") {
    return (
      <p>
        <a href={props.address} className="link">{props.address}</a>
      </p>
    );
  }
  const shown = state.kind === "loaded" ? state.value : undefined;
  return (
    <figure className="artifact-embed">
      <div className="artifact-embed-bar">
        <span className="kind-label">Artifact</span>
        {shown ? (
          <Link to={shown.page} className="artifact-embed-title link">{shown.title}</Link>
        ) : (
          <span className="artifact-embed-title muted">Loading…</span>
        )}
        {shown && <Chip>{`Version ${shown.number}${shown.latest ? " · latest" : ""}`}</Chip>}
        <span className="grow" />
        {shown && (
          <a className={buttonClass("secondary")} href={shown.frameUrl} target="_blank" rel="noopener noreferrer">Open full size</a>
        )}
      </div>
      {shown && (
        <iframe key={shown.frameUrl} className="artifact-embed-frame" title={`${shown.title}, Version ${shown.number}`} src={shown.frameUrl} sandbox={FRAME_SANDBOX} />
      )}
    </figure>
  );
}

/** The Artifacts of a Project, or of the Workspace without `projectKey`, with Publish for those who may write there. */
export function ArtifactsPage(props: { projectKey?: string }) {
  const [artifacts] = useLoad(() => api.artifacts(props.projectKey), [props.projectKey]);
  const canWrite = useCanWrite(props.projectKey);
  const [publishing, setPublishing] = useState(false);
  return (
    <section>
      <div className="page-head">
        <div>
          {props.projectKey && <ProjectCrumbs projectKey={props.projectKey} />}
          <h1>{props.projectKey ? "Artifacts" : "Workspace Artifacts"}</h1>
        </div>
        {canWrite && (
          <div className="actions">
            <Button onClick={() => setPublishing(true)}>Publish Artifact</Button>
          </div>
        )}
      </div>
      <PublishDialog
        open={publishing}
        onOpenChange={setPublishing}
        title="Publish an Artifact"
        publish={(title, archive) => api.publishArtifact(props.projectKey, title, archive)}
        onPublished={(a) => navigate(`/artifacts/${a.id}`)}
      />
      <Show state={artifacts}>
        {(list) =>
          list.length === 0 ? (
            <div className="empty">
              <h2>No Artifacts yet</h2>
              <p className="muted">Agents publish what they build to be seen, such as dashboards and reports, as they work, and so can you.</p>
            </div>
          ) : (
            <ul className="rows" aria-label="Artifacts">
              {list.map((a) => (
                <li key={a.id}>
                  <Link to={`/artifacts/${a.id}`} className="row">
                    <span className="grow">
                      {a.title} {a.protected && <ProtectedMark compact />}
                    </span>
                    <Chip>{`Version ${a.version}`}</Chip>
                    {a.sourceTicket && <span className="key">{a.sourceTicket.key}</span>}
                    <Actor actor={a.publishedBy} />
                    <RelativeTime at={a.updatedAt} className="muted" />
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </Show>
    </section>
  );
}

/**
 * An Artifact's page: a thin bar over the Artifact in a sandboxed frame, full bleed. `version` shows that Version
 * instead of the latest.
 */
export function ArtifactPage(props: { id: string; version?: number | undefined }) {
  const [artifact, reload, setArtifact] = useLoad(() => api.artifact(props.id), [props.id]);
  const [pinned] = useLoad(
    () => (props.version === undefined ? Promise.resolve(undefined) : api.artifactVersion(props.id, props.version)),
    [props.id, props.version],
  );
  return (
    <Show state={artifact}>
      {(a) => (
        <Show state={pinned}>
          {(version) => <ArtifactView artifact={a} version={version} onChanged={setArtifact} reload={reload} />}
        </Show>
      )}
    </Show>
  );
}

function ArtifactView(props: { artifact: Artifact; version: ArtifactVersion | undefined; onChanged: (a: Artifact) => void; reload: () => void }) {
  const a = props.artifact;
  const shown = props.version ?? a.versions?.find((v) => v.number === a.version);
  const number = shown?.number ?? a.version;
  const frameUrl = props.version?.frameUrl ?? a.frameUrl ?? "";
  const canWrite = useCanWrite(a.projectKey);
  const [publishing, setPublishing] = useState(false);
  const protect = useAction((value: boolean) => api.protectArtifact(a.id, value), (changed) => props.onChanged({ ...a, protected: changed.protected }));
  return (
    <section className="artifact-page">
      {a.projectKey ? (
        <ProjectCrumbs projectKey={a.projectKey}>
          {" / "}
          <Link to={listAddress(a.projectKey)} className="link">Artifacts</Link>
        </ProjectCrumbs>
      ) : (
        <div className="muted">
          <Link to="/artifacts" className="link">Workspace Artifacts</Link>
        </div>
      )}
      <div className="artifact-shell">
        <div className="artifact-bar">
          <h1 className="artifact-title">{shown?.title ?? a.title}</h1>
          {a.protected && <ProtectedMark />}
          <VersionMenu artifact={a} shown={number} />
          {(shown?.sourceTicket || shown?.actor) && (
            <span className="artifact-source muted">
              {shown.sourceTicket && (
                <>
                  from <Link to={`/tickets/${shown.sourceTicket.key}`} className="key link" title={shown.sourceTicket.title}>{shown.sourceTicket.key}</Link>{" "}
                </>
              )}
              by <Actor actor={shown.actor} />
            </span>
          )}
          <span className="grow" />
          <CopyLink url={shown?.url ?? a.versionUrl} label={`Copy link to Version ${number}`} />
          <a className={buttonClass("secondary")} href={frameUrl} target="_blank" rel="noopener noreferrer">Open full size</a>
          {canWrite && (
            <Menu
              label="More actions"
              trigger={<Button variant="secondary" aria-label="More actions">…</Button>}
              items={[
                { label: "Publish new Version…", onSelect: () => setPublishing(true) },
                { label: a.protected ? "Unprotect" : "Protect", onSelect: () => void protect.run(!a.protected) },
              ]}
            />
          )}
        </div>
        {protect.error && <p className="error" role="alert">{protect.error}</p>}
        <iframe key={frameUrl} className="artifact-frame" title={`${a.title}, Version ${number}`} src={frameUrl} sandbox={FRAME_SANDBOX} />
      </div>
      <p className="muted hint artifact-note">
        {frameUrl.startsWith(location.origin) ? "Served from Cronk's own hostname" : "Served from the Artifact hostname"} in a sandboxed frame. It loads
        scripts only from itself and a few CDNs, and network requests are blocked.
      </p>
      <PublishDialog
        open={publishing}
        onOpenChange={setPublishing}
        title={`Publish Version ${a.version + 1} of ${a.title}`}
        publish={(_title, archive) => api.publishArtifactVersion(a.id, a.version, archive)}
        onPublished={() => {
          navigate(`/artifacts/${a.id}`);
          props.reload();
        }}
        untitled
      />
      <ProtectionHistory load={() => api.artifactProtection(a.id)} reloadOn={[a.id, a.protected]} />
    </section>
  );
}

/** The Version menu: which Version is shown, every Version to switch to, and where the Artifact is embedded. */
function VersionMenu(props: { artifact: Artifact; shown: number }) {
  const a = props.artifact;
  const versions = a.versions ?? [];
  const latest = props.shown === a.version;
  return (
    <Popover
      label="Versions"
      trigger={
        <button type="button" className="version-chip">
          Version {props.shown}
          {latest ? " · latest" : ""} ▾
        </button>
      }
    >
      <div className="version-menu">
        <div className="menu-label">Versions</div>
        <ul className="version-list" aria-label="Versions">
          {versions.map((v) => (
            <li key={v.number} className={v.number === props.shown ? "current" : undefined}>
              <Link to={v.number === a.version ? `/artifacts/${a.id}` : `/artifacts/${a.id}?version=${v.number}`} className="version-row">
                <span className="version-number">Version {v.number}{v.number === a.version ? " · latest" : ""}</span>
                <span className="muted">
                  <RelativeTime at={v.at} /> · {v.fileCount} {v.fileCount === 1 ? "file" : "files"}, {formatBytes(v.size)}
                </span>
                <Actor actor={v.actor} />
              </Link>
            </li>
          ))}
        </ul>
        <CopyLink url={a.url} label="Copy link to latest" />
        <div className="menu-label">Embedded in</div>
        <EmbeddedInList artifactId={a.id} version={a.version} />
      </div>
    </Popover>
  );
}

/** Where a place embedding an Artifact is read: a Document or Report, or the Ticket or Document a Comment is on. */
const embeddedInPage = (e: EmbeddedIn) =>
  e.kind !== "comment" ? `/documents/${e.id}` : e.ticketKey ? `/tickets/${e.ticketKey}` : `/documents/${e.documentId}`;

const EMBED_KIND_LABELS: Record<EmbeddedIn["kind"], string> = { document: "Document", report: "Report", comment: "Comment" };

/** The Documents, Reports and Comments embedding an Artifact, each with the Version it shows; loaded again on each publish. */
function EmbeddedInList(props: { artifactId: string; version: number }) {
  const [places] = useLoad(() => api.artifactEmbeddedIn(props.artifactId), [props.artifactId, props.version]);
  return (
    <Show state={places}>
      {(list) =>
        list.length === 0 ? (
          <p className="muted version-empty">Not embedded anywhere yet.</p>
        ) : (
          <ul className="version-list" aria-label="Embedded in">
            {list.map((e) => (
              <li key={`${e.kind}:${e.id}:${e.version ?? ""}`}>
                <Link to={embeddedInPage(e)} className="version-row">
                  <span className="embedded-in-head">
                    <span className={`kind-label${e.kind === "report" ? " report" : e.kind === "comment" ? " comment" : ""}`}>{EMBED_KIND_LABELS[e.kind]}</span>
                    {e.ticketKey && <span className="key">{e.ticketKey}</span>}
                  </span>
                  <span>{e.title}</span>
                  <span className="muted">
                    {e.version === null ? "Latest Version" : `Version ${e.version}`} · <RelativeTime at={e.at} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )
      }
    </Show>
  );
}

/** Picks a folder holding index.html and publishes it, as a new Artifact titled in the dialog, or as a new Version (`untitled`). */
function PublishDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  publish: (title: string, archive: Blob) => Promise<Artifact>;
  onPublished: (artifact: Artifact) => void;
  untitled?: boolean;
}) {
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [staleError, setStaleError] = useState<unknown>();
  const { run, error, busy } = useAction(
    async () => {
      setStaleError(undefined);
      const archive = await packFolder(files);
      if (!archive) throw new Error("Pick a folder holding index.html first");
      return props.publish(title.trim(), archive).catch((err: unknown) => {
        setStaleError(err);
        throw err;
      });
    },
    (artifact) => {
      props.onOpenChange(false);
      setFiles([]);
      setTitle("");
      props.onPublished(artifact);
    },
  );
  const folderName = files[0]?.webkitRelativePath.split("/")[0];
  const stale = staleError instanceof ApiError && staleError.status === 409 && typeof staleError.body.version === "number";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} title={props.title} description="The whole folder becomes the Version; it must hold index.html at its top.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {!props.untitled && <Field label="Title" value={title} onChange={setTitle} />}
        <div className="actions">
          <label className={buttonClass("secondary")}>
            Choose folder…
            <input
              ref={(input) => {
                if (input) input.webkitdirectory = true;
              }}
              type="file"
              hidden
              onChange={(e) => setFiles([...(e.target.files ?? [])])}
            />
          </label>
          <span className="muted">{folderName ? `${folderName}: ${files.length} ${files.length === 1 ? "file" : "files"}` : "No folder chosen"}</span>
        </div>
        {error && (
          <p className="error" role="alert">
            {stale ? "Someone published a newer Version meanwhile. Reload the Artifact, then publish again." : error}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="secondary" onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={busy || files.length === 0 || (!props.untitled && title.trim() === "")}>Publish</Button>
        </div>
      </form>
    </Dialog>
  );
}
