import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type User } from "./api.js";

type State = { kind: "loading" } | { kind: "setup" } | { kind: "signIn" } | { kind: "signedIn"; user: User };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    api
      .me()
      .then((user) => setState({ kind: "signedIn", user }))
      .catch(async (err) => {
        if (!(err instanceof ApiError) || err.status !== 401) throw err;
        setState({ kind: (await api.setupRequired()) ? "setup" : "signIn" });
      });
  }, []);

  switch (state.kind) {
    case "loading":
      return null;
    case "setup":
      return <SetupPage onDone={(user) => setState({ kind: "signedIn", user })} />;
    case "signIn":
      return <SignInPage onDone={(user) => setState({ kind: "signedIn", user })} />;
    case "signedIn":
      return <Shell user={state.user} onSignedOut={() => setState({ kind: "signIn" })} />;
  }
}

/** Runs a form submission, showing the API's error message if it is refused. */
function useSubmit<T>(action: () => Promise<T>, onDone: (result: T) => void) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onDone(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

function AuthCard(props: { title: string; intro?: string; children: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">Cronk</div>
        <h1>{props.title}</h1>
        {props.intro && <p className="muted">{props.intro}</p>}
        {props.children}
      </div>
    </main>
  );
}

function Field(props: { label: string; type?: string; value: string; onChange: (v: string) => void; autoComplete?: string; required?: boolean }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        required={props.required ?? true}
        autoComplete={props.autoComplete}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
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
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    void api.workspace().then((w) => setWorkspaceName(w.name));
  }, []);

  const signOut = async () => {
    await api.signOut();
    props.onSignedOut();
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="workspace-name" data-testid="workspace-name">{workspaceName}</div>
        <div className="topbar-right">
          {props.user.role === "admin" && (
            <button className="link" onClick={() => setRenaming(true)}>Workspace settings</button>
          )}
          <span className="muted">{props.user.name}</span>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="content">
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
          <div className="empty">
            <h2>No Projects yet</h2>
            <p className="muted">Projects, Tickets and Documents will appear here.</p>
          </div>
        )}
      </main>
    </div>
  );
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
