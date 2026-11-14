import { useEffect, useState, type FormEvent, type ReactNode } from "react";

export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs a form submission, showing the API's error message if it is refused. */
export function useSubmit<T>(action: () => Promise<T>, onDone: (result: T) => void) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onDone(await action());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

export type Loaded<T> = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; value: T };

/** Loads data when `deps` change; `reload` fetches it again. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): [Loaded<T>, () => void, (value: T) => void] {
  const [state, setState] = useState<Loaded<T>>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let current = true;
    load().then(
      (value) => current && setState({ kind: "loaded", value }),
      (err) => current && setState({ kind: "failed", message: messageOf(err) }),
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
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
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

export function TextArea(props: { label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <textarea
        value={props.value}
        rows={props.rows ?? 6}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}
