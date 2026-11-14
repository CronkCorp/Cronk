/** A minimal client-side router over the History API; the server answers every page path with the app shell. */

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

const listeners = new Set<() => void>();

export function navigate(to: string): void {
  history.pushState(null, "", to);
  for (const listener of listeners) listener();
}

/** The current path and query string, re-rendering when they change. */
export function useLocation(): { path: string; search: URLSearchParams } {
  const read = () => ({ path: location.pathname, search: new URLSearchParams(location.search) });
  const [current, setCurrent] = useState(read);
  useEffect(() => {
    const update = () => setCurrent(read());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return current;
}

export function Link(props: { to: string; className?: string; children: ReactNode }) {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(props.to);
  };
  return (
    <a href={props.to} className={props.className} onClick={onClick}>
      {props.children}
    </a>
  );
}
