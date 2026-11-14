import { useEffect, useState } from "react";
import { api, ApiError, type User } from "./api.js";
import { AcceptInvitationPage, UsersPage } from "./people.js";
import { Link, navigate, useLocation } from "./router.js";
import { AuthCard, Field, messageOf, useSubmit } from "./ui.js";
import { ProjectPage, ProjectsPage, TicketPage, type ProjectView } from "./work.js";

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
          <button onClick={() => location.reload()}>Try again</button>
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
        <button type="submit" disabled={busy}>Create Admin account</button>
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
        <button type="submit" disabled={busy}>Sign in</button>
      </form>
    </AuthCard>
  );
}

function Shell(props: { user: User; onSignedOut: () => void }) {
  const [workspaceName, setWorkspaceName] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    api.workspace().then(
      (w) => setWorkspaceName(w.name),
      (err) => setLoadError(messageOf(err)),
    );
  }, []);

  const signOut = () => api.signOut().then(props.onSignedOut, (err) => setLoadError(messageOf(err)));

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="workspace-name">
          <span data-testid="workspace-name">{workspaceName}</span>
        </Link>
        <div className="topbar-right">
          {props.user.role === "admin" && (
            <>
              <Link to="/users" className="link">Users</Link>
              <button className="link" onClick={() => setRenaming(true)}>Workspace settings</button>
            </>
          )}
          <span className="muted">{props.user.name}</span>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="content">
        {loadError && <p className="error" role="alert">{loadError}</p>}
        {renaming && workspaceName !== undefined ? (
          <RenameWorkspace
            current={workspaceName}
            onDone={(name) => {
              setWorkspaceName(name);
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
  const project = /^\/projects\/([^/]+)$/.exec(path);
  if (project) return <ProjectPage projectKey={decodeURIComponent(project[1]!)} view={projectView(search.get("view"))} me={props.me} />;
  const ticket = /^\/tickets\/([^/]+)$/.exec(path);
  if (ticket) return <TicketPage ticketKey={decodeURIComponent(ticket[1]!)} />;
  return <ProjectsPage archived={path === "/archived"} />;
}

function RenameWorkspace(props: { current: string; onDone: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(props.current);
  const { submit, error, busy } = useSubmit(() => api.renameWorkspace(name), (w) => props.onDone(w.name));
  return (
    <section className="panel">
      <h2>Workspace settings</h2>
      <form onSubmit={submit}>
        <Field label="Workspace name" value={name} onChange={setName} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="submit" disabled={busy}>Save</button>
          <button type="button" className="secondary" onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

function projectView(view: string | null): ProjectView {
  return view === "board" || view === "statuses" ? view : "list";
}
