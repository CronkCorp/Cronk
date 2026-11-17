import { useEffect, useState } from "react";
import { api, ApiError, watchArtifact, type Artifact, type ArtifactVersion, type Attachment, type EmbeddedIn, type ExtraOrigin, type Workspace } from "./api.js";
import { AttachmentViewer, PageAttachments } from "./attachments.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { ArtifactCommentsDrawer } from "./timeline.js";
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
import { EXTRA_ORIGIN_USES } from "../shared/values.js";

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
export function ArtifactsPage(props: { projectKey?: string; workspace: Workspace | undefined }) {
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
        publish={(title, archive, extras) => api.publishArtifact(props.projectKey, title, archive, extras)}
        onPublished={(a) => navigate(`/artifacts/${a.id}`)}
        extrasAllowed={props.workspace?.artifactExtraOriginsAllowed === true}
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
export function ArtifactPage(props: { id: string; version?: number | undefined; workspace: Workspace | undefined }) {
  const [artifact, reload, setArtifact] = useLoad(() => api.artifact(props.id), [props.id]);
  const [pinned] = useLoad(
    () => (props.version === undefined ? Promise.resolve(undefined) : api.artifactVersion(props.id, props.version)),
    [props.id, props.version],
  );
  return (
    <Show state={artifact}>
      {(a) => (
        <Show state={pinned}>
          {(version) => <ArtifactView artifact={a} version={version} workspace={props.workspace} onChanged={setArtifact} reload={reload} />}
        </Show>
      )}
    </Show>
  );
}

function ArtifactView(props: {
  artifact: Artifact;
  version: ArtifactVersion | undefined;
  workspace: Workspace | undefined;
  onChanged: (a: Artifact) => void;
  reload: () => void;
}) {
  const a = props.artifact;
  const shown = props.version ?? a.versions?.find((v) => v.number === a.version);
  const number = shown?.number ?? a.version;
  const frameUrl = props.version?.frameUrl ?? a.frameUrl ?? "";
  const extras = shown?.extraOrigins ?? a.extraOrigins;
  const extrasApply = props.workspace?.artifactExtraOriginsAllowed ?? true;
  const canWrite = useCanWrite(a.projectKey);
  const [publishing, setPublishing] = useState(false);
  const protect = useAction((value: boolean) => api.protectArtifact(a.id, value), (changed) => props.onChanged({ ...a, protected: changed.protected }));
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [comments, reloadComments] = useLoad(() => api.artifactComments(a.id), [a.id]);
  const [attachments, reloadAttachments] = useLoad(() => api.artifactAttachments(a.id), [a.id]);
  const [opened, setOpened] = useState<Attachment>();
  const [live, onLive] = useLiveState();
  useEffect(
    () =>
      watchArtifact(a.id, {
        onLive,
        // On (re)connecting, catch up on what was posted meanwhile.
        ready: () => {
          reloadComments();
          reloadAttachments();
        },
        on: { comment: () => reloadComments(), attachments: () => reloadAttachments() },
      }),
    [a.id],
  );
  const loadedComments = comments.kind === "loaded" ? comments.value : [];
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
          {extras.length > 0 && <ExtraOrigins extras={extras} apply={extrasApply} />}
          <span className="grow" />
          <CopyLink url={shown?.url ?? a.versionUrl} label={`Copy link to Version ${number}`} />
          <a className={buttonClass("secondary")} href={frameUrl} target="_blank" rel="noopener noreferrer">Open full size</a>
          <Button variant="secondary" aria-pressed={drawerOpen} aria-controls="artifact-comments" onClick={() => setDrawerOpen((o) => !o)}>
            Comments {loadedComments.length}
          </Button>
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
        <div className="artifact-body">
          <iframe key={frameUrl} className="artifact-frame" title={`${a.title}, Version ${number}`} src={frameUrl} sandbox={FRAME_SANDBOX} />
          {drawerOpen && (
            <PageAttachments.Provider value={{ attachments: attachments.kind === "loaded" ? attachments.value : [], onOpen: setOpened }}>
              <div id="artifact-comments" className="artifact-drawer-slot">
                <Show state={comments}>
                  {(all) => (
                    <ArtifactCommentsDrawer
                      artifactId={a.id}
                      version={number}
                      publisher={shown?.actor}
                      comments={all}
                      canWrite={canWrite}
                      onPosted={() => reloadComments()}
                      live={<LiveIndicator state={live} />}
                    />
                  )}
                </Show>
              </div>
            </PageAttachments.Provider>
          )}
        </div>
      </div>
      <AttachmentViewer
        attachment={opened}
        canWrite={canWrite}
        onClose={() => setOpened(undefined)}
        onDeleted={() => {
          setOpened(undefined);
          reloadAttachments();
        }}
      />
      <p className="muted hint artifact-note">
        {frameUrl.startsWith(location.origin) ? "Served from Cronk's own hostname" : "Served from the Artifact hostname"} in a sandboxed frame.{" "}
        {servingNote(props.workspace?.artifactAllowedOrigins, extrasApply ? extras : [])}
      </p>
      <PublishDialog
        open={publishing}
        onOpenChange={setPublishing}
        title={`Publish Version ${a.version + 1} of ${a.title}`}
        publish={(_title, archive, extras) => api.publishArtifactVersion(a.id, a.version, archive, extras)}
        onPublished={() => {
          navigate(`/artifacts/${a.id}`);
          props.reload();
        }}
        extrasAllowed={props.workspace?.artifactExtraOriginsAllowed === true}
        untitled
      />
      <ProtectionHistory load={() => api.artifactProtection(a.id)} reloadOn={[a.id, a.protected]} />
    </section>
  );
}

/** What a page may load, as the note under the frame says it: the Workspace's allow-list and the Version's extras in force. */
function servingNote(allowed: string[] | undefined, extras: Artifact["extraOrigins"]): string {
  const hosts = (origins: string[]) => origins.map((o) => o.replace(/^https:\/\//, "")).join(", ");
  const from = allowed === undefined ? "the Workspace's allow-list" : allowed.length === 0 ? "nowhere else" : hosts(allowed);
  const requests = extras.filter((e) => e.uses.includes("connect")).map((e) => e.origin);
  return (
    `It loads scripts, styles and fonts only from itself and ${from}` +
    `${extras.length > 0 ? ", and whatever else only from the extra origins this Version declared, for what each was declared for" : ""}. ` +
    (requests.length > 0 ? `Network requests go only to ${hosts(requests)}.` : "Network requests are blocked.")
  );
}

/** The extra origins the shown Version declared, as a `--warn` pill that opens each with what it loads and why. */
function ExtraOrigins(props: { extras: Artifact["extraOrigins"]; apply: boolean }) {
  const count = props.extras.length;
  return (
    <Popover
      label="Extra origins"
      trigger={
        <button type="button" className="chip warn extra-origins-chip">
          {count} extra {count === 1 ? "origin" : "origins"}
          {props.apply ? "" : " · off"} ▾
        </button>
      }
    >
      <div className="extra-origins">
        <div className="menu-label">Extra origins this Version declared</div>
        {!props.apply && (
          <p className="muted extra-origins-off">Not applied: this Workspace doesn't allow extra origins, so the Version is served without them.</p>
        )}
        <ul className="extra-origin-list" aria-label="Extra origins">
          {props.extras.map((e) => (
            <li key={e.origin} className="extra-origin">
              <span className="extra-origin-name">{e.origin}</span>
              <span className="muted">for {e.uses.map((u) => USE_LABELS[u]).join(", ")}</span>
              <span>{e.reason}</span>
            </li>
          ))}
        </ul>
      </div>
    </Popover>
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

/** Where a place embedding an Artifact is read: a Document or Report, or the Ticket, Document or Artifact a Comment is on. */
const embeddedInPage = (e: EmbeddedIn) =>
  e.kind !== "comment"
    ? `/documents/${e.id}`
    : e.ticketKey
      ? `/tickets/${e.ticketKey}`
      : e.artifactId
        ? `/artifacts/${e.artifactId}`
        : `/documents/${e.documentId}`;

/** Each kind of place's label, with the class its kind label takes. */
const EMBED_KINDS: Record<EmbeddedIn["kind"], { label: string; className: string }> = {
  document: { label: "Document", className: "kind-label" },
  report: { label: "Report", className: "kind-label report" },
  comment: { label: "Comment", className: "kind-label comment" },
};

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
                    <span className={EMBED_KINDS[e.kind].className}>{EMBED_KINDS[e.kind].label}</span>
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

/** What each use of an extra origin is called for people; `connect` opens network requests. */
const USE_LABELS: Record<ExtraOrigin["uses"][number], string> = {
  scripts: "scripts",
  styles: "styles",
  fonts: "fonts",
  images: "images",
  media: "media",
  connect: "network requests",
};

/** An extra origin as the dialog edits it, keyed so rows keep their fields when one above is removed. */
interface ExtraOriginRow extends ExtraOrigin {
  key: number;
}

/**
 * Picks a folder holding index.html and publishes it, as a new Artifact titled in the dialog, or as a new Version (`untitled`).
 * Where the Workspace allows them (`extrasAllowed`), the publish may declare extra origins; they always start empty, never
 * carried over from an earlier Version, and the API alone judges them.
 */
function PublishDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  publish: (title: string, archive: Blob, extraOrigins: ExtraOrigin[]) => Promise<Artifact>;
  onPublished: (artifact: Artifact) => void;
  extrasAllowed: boolean;
  untitled?: boolean;
}) {
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [extras, setExtras] = useState<ExtraOriginRow[]>([]);
  const [nextKey, setNextKey] = useState(0);
  const [staleError, setStaleError] = useState<unknown>();
  const { run, error, busy } = useAction(
    async () => {
      setStaleError(undefined);
      const archive = await packFolder(files);
      if (!archive) throw new Error("Pick a folder holding index.html first");
      const declared = props.extrasAllowed ? extras.map(({ origin, uses, reason }) => ({ origin, uses, reason })) : [];
      return props.publish(title.trim(), archive, declared).catch((err: unknown) => {
        setStaleError(err);
        throw err;
      });
    },
    (artifact) => {
      props.onOpenChange(false);
      setFiles([]);
      setTitle("");
      setExtras([]);
      props.onPublished(artifact);
    },
  );
  const change = (key: number, changes: Partial<ExtraOrigin>) => setExtras((rows) => rows.map((r) => (r.key === key ? { ...r, ...changes } : r)));
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
        {props.extrasAllowed && (
          <div className="publish-extras">
            <h3 className="publish-extras-title">Extra origins</h3>
            <p className="muted publish-extras-hint">Other sites this Version loads from beyond the Workspace's allow-list, each with what it loads and why.</p>
            <ul className="publish-extra-list" aria-label="Extra origins">
              {extras.map((row) => (
                <li key={row.key} className="publish-extra">
                  <Field label="Origin" value={row.origin} placeholder="https://cdn.example.com" onChange={(origin) => change(row.key, { origin })} required={false} />
                  <div className="publish-extra-uses" role="group" aria-label="Loads">
                    {EXTRA_ORIGIN_USES.map((use) => (
                      <label key={use} className="use-toggle">
                        <input
                          type="checkbox"
                          checked={row.uses.includes(use)}
                          onChange={(e) =>
                            change(row.key, { uses: e.target.checked ? EXTRA_ORIGIN_USES.filter((u) => u === use || row.uses.includes(u)) : row.uses.filter((u) => u !== use) })
                          }
                        />
                        {USE_LABELS[use]}
                      </label>
                    ))}
                  </div>
                  <Field label="Reason" value={row.reason} onChange={(reason) => change(row.key, { reason })} required={false} />
                  <div className="actions">
                    <Button type="button" variant="secondary" onClick={() => setExtras((rows) => rows.filter((r) => r.key !== row.key))}>Remove</Button>
                  </div>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setExtras((rows) => [...rows, { key: nextKey, origin: "", uses: [], reason: "" }]);
                setNextKey((k) => k + 1);
              }}
            >
              Add origin
            </Button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {stale ? "Someone published a newer Version meanwhile. Reload the Artifact, then publish again." : error}
          </p>
        )}
        <div className="actions dialog-actions">
          <Button type="button" variant="secondary" onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={busy || files.length === 0 || (!props.untitled && title.trim() === "")}>Publish</Button>
        </div>
      </form>
    </Dialog>
  );
}
