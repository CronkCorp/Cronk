import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";

export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs a change against the API, tracking whether it is busy and showing its error message if it is refused. */
export function useAction<A extends unknown[], T>(action: (...args: A) => Promise<T>, onDone: (result: T) => void) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (...args: A) => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await action(...args));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy };
}

/** Runs a form submission, showing the API's error message if it is refused. */
export function useSubmit<T>(action: () => Promise<T>, onDone: (result: T) => void) {
  const { run, error, busy } = useAction(action, onDone);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    return run();
  };
  return { submit, error, busy };
}

export type Loaded<T> = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; value: T };

/** Loads data when `deps` change; `reload` fetches it again. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): [Loaded<T>, () => void, (value: T) => void] {
  const [state, setState] = useState<Loaded<T>>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);
  // The deps the shown value was loaded for.
  const loadedFor = useRef<unknown[]>(undefined);
  useEffect(() => {
    let current = true;
    const sameDeps = loadedFor.current !== undefined && loadedFor.current.length === deps.length && loadedFor.current.every((d, i) => Object.is(d, deps[i]));
    load().then(
      (value) => {
        if (!current) return;
        loadedFor.current = deps;
        setState({ kind: "loaded", value });
      },
      // A failed reload of the same thing keeps what was loaded, so a live view doesn't swap its list for an error on a blip;
      // the next reload tries again.
      (err) => current && setState((was) => (sameDeps && was.kind === "loaded" ? was : { kind: "failed", message: messageOf(err) })),
    );
    return () => {
      current = false;
    };
  }, [...deps, generation]);
  return [state, () => setGeneration((g) => g + 1), (value) => setState({ kind: "loaded", value })];
}

/** Shows a load's error, nothing while loading, or its content. */
export function Show<T>(props: { state: Loaded<T>; children: (value: T) => ReactNode }) {
  if (props.state.kind === "loading") return null;
  if (props.state.kind === "failed") return <p className="error" role="alert">{props.state.message}</p>;
  return <>{props.children(props.state.value)}</>;
}

export function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        disabled={props.disabled}
        type={props.type ?? "text"}
        value={props.value}
        required={props.required ?? true}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

export function TextArea(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <textarea
        ref={props.inputRef}
        disabled={props.disabled}
        value={props.value}
        rows={props.rows ?? 6}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

/** The centred card the signed-out pages (setup, sign-in, invitations) are shown in. */
export function AuthCard(props: { title: string; intro?: string; children: ReactNode }) {
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
