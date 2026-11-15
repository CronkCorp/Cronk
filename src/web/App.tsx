import { Actor } from "./components/actor.js";
import { Button, buttonClass } from "./components/button.js";
import { useEffect, useState } from "react";
import { AgentAccessSelect, AgentsPage } from "./agents.js";
import { DocumentPage, DocumentsPage } from "./documents.js";
import { api, ApiError, workspaceExportUrl, type AgentAccess, type User, type Workspace } from "./api.js";
import { GuidanceSection } from "./guidance.js";
import { inboxFilterFrom, InboxPage } from "./inbox.js";
import { AcceptInvitationPage, UsersPage } from "./people.js";
import { SearchBox, SearchPage, searchFilterFrom } from "./search.js";
import { Link, navigate, useLocation } from "./router.js";
import { AuthCard, Field, messageOf, useSubmit } from "./ui.js";
import { filterFrom, ProjectPage, ProjectsPage, TicketPage, type ProjectView } from "./work.js";

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

function Shell(props: { user: User; onSignedOut: () => void }) {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [loadError, setLoadError] = useState<string>();
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    api.workspace().then(setWorkspace, (err) => setLoadError(messageOf(err)));
  }, []);

  const signOut = () => api.signOut().then(props.onSignedOut, (err) => setLoadError(messageOf(err)));

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="workspace-name">
          <span data-testid="workspace-name">{workspace?.name}</span>
        </Link>
        <div className="topbar-right">
          <SearchBox />
          <Link to="/inbox" className="link">Inbox</Link>
          <Link to="/documents" className="link">Documents</Link>
          <Link to="/guidance" className="link">Guidance</Link>
          <Link to="/agents" className="link">Agents</Link>
          {props.user.role === "admin" && (
            <>
              <Link to="/users" className="link">Users</Link>
              <Button variant="ghost" onClick={() => setRenaming(true)}>Workspace settings</Button>
            </>
          )}
          <Actor actor={{ kind: "user", name: props.user.name }} />
          <Button variant="ghost" onClick={signOut}>Sign out</Button>
        </div>
      </header>
      <main className="content">
        {loadError && <p className="error" role="alert">{loadError}</p>}
        {renaming && workspace !== undefined ? (
          <WorkspaceSettings
            current={workspace}
            onDone={(updated) => {
              setWorkspace(updated);
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <Page me={props.user} />
        )}
      </main>
    </div>
  );
}

/** The page for the current address. */
function Page(props: { me: User }) {
  const { path, search } = useLocation();
  if (path === "/users" && props.me.role === "admin") return <UsersPage me={props.me} />;
  if (path === "/agents") return <AgentsPage me={props.me} />;
  if (path === "/search") return <SearchPage filter={searchFilterFrom(search)} />;
  if (path === "/inbox") return <InboxPage filter={inboxFilterFrom(search)} />;
  if (path === "/documents") return <DocumentsPage />;
  const projectDocuments = /^\/projects\/([^/]+)\/documents$/.exec(path);
  if (projectDocuments) return <DocumentsPage projectKey={decodeURIComponent(projectDocuments[1]!)} />;
  const documentMatch = /^\/documents\/([^/]+)$/.exec(path);
  if (documentMatch) return <DocumentPage id={decodeURIComponent(documentMatch[1]!)} edit={search.get("edit") === "1"} />;
  if (path === "/guidance") return <WorkspaceGuidancePage me={props.me} />;
  const project = /^\/projects\/([^/]+)$/.exec(path);
  if (project) {
    return (
      <ProjectPage
        projectKey={decodeURIComponent(project[1]!)}
        view={projectView(search.get("view"))}
        filter={filterFrom(search)}
        me={props.me}
      />
    );
  }
  const ticket = /^\/tickets\/([^/]+)$/.exec(path);
  if (ticket) return <TicketPage ticketKey={decodeURIComponent(ticket[1]!)} />;
  return <ProjectsPage archived={path === "/archived"} />;
}

function WorkspaceSettings(props: { current: Workspace; onDone: (workspace: Workspace) => void; onCancel: () => void }) {
  const [name, setName] = useState(props.current.name);
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(props.current.agentAccess);
  const [silenceMinutes, setSilenceMinutes] = useState(String(props.current.silenceThresholdSeconds / 60));
  const { submit, error, busy } = useSubmit(
    () => api.updateWorkspace({ name, agentAccess, silenceThresholdSeconds: Math.round(Number(silenceMinutes) * 60) }),
    props.onDone,
  );
  return (
    <section className="panel">
      <h2>Workspace settings</h2>
      <form onSubmit={submit}>
        <Field label="Workspace name" value={name} onChange={setName} />
        <AgentAccessSelect value={agentAccess} onChange={setAgentAccess} />
        <p className="muted hint">The most Agents may do in the Workspace outside any Project, such as creating Projects.</p>
        <Field label="Silence threshold (minutes)" type="number" value={silenceMinutes} onChange={setSilenceMinutes} />
        <p className="muted hint">How long an Agent Session may stay silent before it ends and its Claims lapse, from 1 minute to 1 day.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <Button type="submit" disabled={busy}>Save</Button>
          <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
        </div>
      </form>
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

function projectView(view: string | null): ProjectView {
  return view === "board" || view === "statuses" || view === "reports" || view === "guidance" ? view : "list";
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
