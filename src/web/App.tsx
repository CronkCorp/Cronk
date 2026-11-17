import { TranscriptPage } from "./transcripts.js";
import { Button, buttonClass } from "./components/button.js";
import { useEffect, useState } from "react";
import { AgentAccessSelect, AgentsPage } from "./agents.js";
import { DocumentPage, DocumentsPage } from "./documents.js";
import { ArtifactPage, ArtifactsPage, versionOf } from "./artifacts.js";
import { decisionFilterFrom, DecisionsPage } from "./decisions.js";
import { api, ApiError, workspaceExportUrl, type AgentAccess, type User, type Workspace } from "./api.js";
import { GuidanceSection } from "./guidance.js";
import { inboxAddressFrom, InboxPage } from "./inbox.js";
import { triageAddressFrom, TriagePage } from "./triage.js";
import { AcceptInvitationPage, ChangePasswordPage, ResetPasswordPage, UsersPage } from "./people.js";
import { SearchPage, searchFilterFrom } from "./search.js";
import { Sidebar } from "./frame.js";
import { routeOf } from "./routes.js";
import { Link, navigate, useLocation } from "./router.js";
import { AuthCard, Field, messageOf, Show, TextArea, useLoad, useSubmit } from "./ui.js";
import { formatBytes } from "./components/files.js";
import { filterFrom, ProjectPage, ProjectsPage, projectViewOf } from "./work.js";
import { TicketPage } from "./ticket.js";
import { TermPage, TermsPage } from "./terms.js";

type State =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "setup" }
  | { kind: "signIn" }
  | { kind: "signedIn"; user: User };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const { path } = useLocation();
  const invitation = /^\/invite\/([^/]+)$/.exec(path);
  const passwordReset = /^\/reset-password\/([^/]+)$/.exec(path);

  useEffect(() => {
    const start = async (): Promise<State> => {
      try {
        return { kind: "signedIn", user: await api.me() };
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) throw err;
        return { kind: (await api.setupRequired()) ? "setup" : "signIn" };
      }
    };
    start().then(setState, (err) => setState({ kind: "unavailable", message: messageOf(err) }));
  }, []);

  // An invitation link works whoever is signed in on this browser: accepting it signs in as the new User.
  if (invitation) {
    return (
      <AcceptInvitationPage
        token={decodeURIComponent(invitation[1]!)}
        onDone={(user) => {
          setState({ kind: "signedIn", user });
          navigate("/");
        }}
      />
    );
  }

  // Like an invitation, a reset link works whoever is signed in on this browser: using it signs in as its User.
  if (passwordReset) {
    return (
      <ResetPasswordPage
        token={decodeURIComponent(passwordReset[1]!)}
        onDone={(user) => {
          setState({ kind: "signedIn", user });
          navigate("/");
        }}
      />
    );
  }

  switch (state.kind) {
    case "loading":
      return null;
    case "unavailable":
      return (
        <AuthCard title="Cronk is unavailable" intro="It could not be reached. Try again in a moment.">
          <p className="error" role="alert">{state.message}</p>
          <Button onClick={() => location.reload()}>Try again</Button>
        </AuthCard>
      );
    case "setup":
      return <SetupPage onDone={(user) => setState({ kind: "signedIn", user })} />;
    case "signIn":
      return <SignInPage onDone={(user) => setState({ kind: "signedIn", user })} />;
    case "signedIn":
      return <Shell user={state.user} onSignedOut={() => setState({ kind: "signIn" })} />;
  }
}

function SetupPage(props: { onDone: (user: User) => void }) {
  const [workspaceName, setWorkspaceName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { submit, error, busy } = useSubmit(
    () => api.setup({ name, email, password, ...(workspaceName.trim() ? { workspaceName } : {}) }),
    props.onDone,
  );
  return (
    <AuthCard title="Set up Cronk" intro="Create the first account. It becomes the Admin of this Workspace.">
      <form onSubmit={submit}>
        <Field label="Workspace name" value={workspaceName} onChange={setWorkspaceName} required={false} />
        <Field label="Your name" value={name} onChange={setName} autoComplete="name" />
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" />
        {error && <p className="error" role="alert">{error}</p>}
        <Button type="submit" disabled={busy}>Create Admin account</Button>
      </form>
    </AuthCard>
  );
}

function SignInPage(props: { onDone: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { submit, error, busy } = useSubmit(() => api.signIn(email, password), props.onDone);
  return (
    <AuthCard title="Sign in">
      <form onSubmit={submit}>
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && <p className="error" role="alert">{error}</p>}
        <Button type="submit" disabled={busy}>Sign in</Button>
      </form>
    </AuthCard>
  );
}

/** The signed-in frame: the sidebar, and the page for the current address in the main column. */
function Shell(props: { user: User; onSignedOut: () => void }) {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    api.workspace().then(setWorkspace, (err) => setLoadError(messageOf(err)));
  }, []);

  const signOut = () => api.signOut().then(props.onSignedOut, (err) => setLoadError(messageOf(err)));

  return (
    <div className="shell">
      <Sidebar me={props.user} workspace={workspace} onSignOut={() => void signOut()} />
      <main className="main">
        <div className="content">
          {loadError && <p className="error" role="alert">{loadError}</p>}
          <Page me={props.user} workspace={workspace} onWorkspaceChange={setWorkspace} />
        </div>
      </main>
    </div>
  );
}

/** The page for the current address. */
function Page(props: { me: User; workspace: Workspace | undefined; onWorkspaceChange: (workspace: Workspace) => void }) {
  const { path, search } = useLocation();
  const admin = props.me.role === "admin";
  const route = routeOf(path);
  switch (route.page) {
    case "users":
      if (admin) return <UsersPage me={props.me} />;
      break;
    case "settings":
      if (!admin) break;
      return props.workspace === undefined ? null : (
        <WorkspaceSettings current={props.workspace} onDone={props.onWorkspaceChange} onCancel={() => navigate("/")} />
      );
    case "password":
      return <ChangePasswordPage me={props.me} />;
    case "agents":
      return <AgentsPage me={props.me} />;
    case "search":
      return <SearchPage filter={searchFilterFrom(search)} />;
    case "inbox":
      return <InboxPage address={inboxAddressFrom(search)} me={props.me} />;
    case "triage":
      return <TriagePage address={triageAddressFrom(search)} me={props.me} />;
    case "documents":
      return <DocumentsPage />;
    case "projectDocuments":
      return <DocumentsPage projectKey={route.key} />;
    case "artifacts":
      return <ArtifactsPage workspace={props.workspace} />;
    case "projectArtifacts":
      return <ArtifactsPage projectKey={route.key} workspace={props.workspace} />;
    case "artifact":
      return <ArtifactPage id={route.id} version={versionOf(search.get("version"))} workspace={props.workspace} />;
    case "document":
      return <DocumentPage id={route.id} edit={search.get("edit") === "1"} />;
    case "decisions":
      return <DecisionsPage projectKey={search.get("project") ?? undefined} filter={decisionFilterFrom(search)} />;
    case "decision":
      return <DecisionsPage filter={decisionFilterFrom(search)} selected={route.key} />;
    case "guidance":
      return <WorkspaceGuidancePage me={props.me} />;
    case "terms":
      return <TermsPage projectKey={search.get("project") ?? undefined} />;
    case "term":
      return <TermPage id={route.id} edit={search.get("edit") === "1"} />;
    case "transcript":
      return <TranscriptPage id={route.id} />;
    case "project":
      // Keyed by Project, so state kept while on the page, such as opened board columns, starts afresh in another.
      return <ProjectPage key={route.key} projectKey={route.key} {...projectViewOf(search.get("view"))} filter={filterFrom(search)} me={props.me} />;
    case "ticket":
      return <TicketPage ticketKey={route.key} />;
    case "projects":
      return <ProjectsPage archived={route.archived} />;
  }
  return <ProjectsPage archived={false} />;
}

/** The Admin's Workspace settings, at `/settings`. Saving keeps the page open and tells the frame the new name. */
function WorkspaceSettings(props: { current: Workspace; onDone: (workspace: Workspace) => void; onCancel: () => void }) {
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState(props.current.name);
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(props.current.agentAccess);
  const [silenceMinutes, setSilenceMinutes] = useState(String(props.current.silenceThresholdSeconds / 60));
  const [attachmentMegabytes, setAttachmentMegabytes] = useState(String(props.current.attachmentMaxBytes / MB));
  const [artifactMegabytes, setArtifactMegabytes] = useState(String(props.current.artifactMaxBytes / MB));
  const [artifactFiles, setArtifactFiles] = useState(String(props.current.artifactMaxFiles));
  const [allowedOrigins, setAllowedOrigins] = useState(props.current.artifactAllowedOrigins.join("\n"));
  const [extraOrigins, setExtraOrigins] = useState(props.current.artifactExtraOriginsAllowed);
  const [storage] = useLoad(api.storage, []);
  const { submit, error, busy } = useSubmit(
    () => {
      setSaved(false);
      return api.updateWorkspace({
        name,
        agentAccess,
        silenceThresholdSeconds: Math.round(Number(silenceMinutes) * 60),
        attachmentMaxBytes: Math.round(Number(attachmentMegabytes) * MB),
        artifactMaxBytes: Math.round(Number(artifactMegabytes) * MB),
        artifactMaxFiles: Math.round(Number(artifactFiles)),
        artifactAllowedOrigins: allowedOrigins.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
        artifactExtraOriginsAllowed: extraOrigins,
      });
    },
    (workspace) => {
      setSaved(true);
      props.onDone(workspace);
    },
  );
  return (
    <section className="panel">
      <h1>Workspace settings</h1>
      <form onSubmit={submit}>
        <Field label="Workspace name" value={name} onChange={setName} />
        <AgentAccessSelect value={agentAccess} onChange={setAgentAccess} />
        <p className="muted hint">The most Agents may do in the Workspace outside any Project, such as creating Projects.</p>
        <Field label="Silence threshold (minutes)" type="number" value={silenceMinutes} onChange={setSilenceMinutes} />
        <p className="muted hint">How long an Agent Session may stay silent before it ends and its Claims lapse, from 1 minute to 1 day.</p>
        <Field label="Attachment size limit (MB)" type="number" value={attachmentMegabytes} onChange={setAttachmentMegabytes} />
        <p className="muted hint">The largest file anyone may attach, from 1 MB to 10 GB.</p>
        <Field label="Artifact size limit (MB)" type="number" value={artifactMegabytes} onChange={setArtifactMegabytes} />
        <p className="muted hint">The most one Version of an Artifact may hold, all its files together, from 1 MB to 500 MB.</p>
        <Field label="Artifact file limit" type="number" value={artifactFiles} onChange={setArtifactFiles} />
        <p className="muted hint">The most files one Version of an Artifact may hold, from 1 to 10,000.</p>
        <TextArea label="Artifact allow-list" rows={5} value={allowedOrigins} onChange={setAllowedOrigins} placeholder="https://cdn.jsdelivr.net" />
        <p className="muted hint">
          The origins every Artifact may load scripts, styles and fonts from, one per line, such as https://cdn.jsdelivr.net. Network requests stay blocked.
        </p>
        <label className="field inline">
          <span>Extra origins</span>
          <select value={extraOrigins ? "allowed" : "off"} onChange={(e) => setExtraOrigins(e.target.value === "allowed")}>
            <option value="allowed">Publishes may declare them</option>
            <option value="off">Off</option>
          </select>
        </label>
        <p className="muted hint">
          A publish may declare origins beyond the allow-list for its Version, each with a reason, shown on the Artifact. Turned off, such publishes are
          refused and Versions are served without the extras they declared.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <Button type="submit" disabled={busy}>Save</Button>
          <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
          {saved && <span className="muted" role="status">Saved.</span>}
        </div>
      </form>
      <h2>Storage used</h2>
      <Show state={storage}>
        {(s) => (
          <p className="muted hint" data-testid="storage-used">
            Attachments: {formatBytes(s.attachments.bytes)} in {s.attachments.files} {s.attachments.files === 1 ? "file" : "files"}. Artifacts:{" "}
            {formatBytes(s.artifacts.bytes)} in {s.artifacts.files} {s.artifacts.files === 1 ? "file" : "files"}, every Version counted. There is no quota.
          </p>
        )}
      </Show>
      <h2>Export and import</h2>
      <p className="muted hint">
        Everything in the Workspace as Markdown files with frontmatter, in a .tar.gz archive. Import one into a fresh installation to move Cronk.
      </p>
      <div className="actions">
        <a className={buttonClass("secondary")} href={workspaceExportUrl} download>Download export</a>
        <ImportExport />
      </div>
    </section>
  );
}

const MB = 1024 * 1024;

/** Picks an export archive and imports it. */
function ImportExport() {
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    setStatus("Importing…");
    try {
      const imported = await api.importExport(file);
      setStatus(`Imported ${imported.projects.length === 1 ? "Project" : "Projects"} ${imported.projects.join(", ") || "none"}.`);
    } catch (err) {
      setStatus(undefined);
      setError(messageOf(err));
    }
  };
  return (
    <>
      <label className={buttonClass("secondary")}>
        Import export…
        <input type="file" accept=".gz,.tgz,.tar" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      </label>
      {status && <span className="muted">{status}</span>}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

function WorkspaceGuidancePage(props: { me: User }) {
  return (
    <section>
      <div className="page-head">
        <h1>Workspace Guidance</h1>
      </div>
      <GuidanceSection
        canEdit={props.me.role === "admin"}
        intro="Standing instructions for every Agent, in every Project. Each Agent Session gets them when it connects, followed by the Guidance of the Projects it can see. Only Admins can change them."
      />
    </section>
  );
}
