import { Chip, ProtectedMark } from "./components/tags.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SEARCH_KINDS } from "../shared/values.js";
import { api, type SearchKind, type SearchResult } from "./api.js";
import { Link, navigate } from "./router.js";
import { transcriptAddress } from "./transcripts.js";
import { Show, useLoad } from "./ui.js";
import { FilterSelect } from "./work.js";

/** Where a Document opens. */
const documentPath = (r: SearchResult) => `/documents/${r.documentId}`;

/** For each kind of result: its name, where it opens, and the key shown beside its title (if it has one). */
const KINDS: Record<SearchKind, { name: string; path: (r: SearchResult) => string; key: (r: SearchResult) => string | null }> = {
  ticket: { name: "Ticket", path: (r) => `/tickets/${r.ticketKey}`, key: (r) => r.ticketKey },
  document: { name: "Document", path: documentPath, key: () => null },
  // A Report opens as its Document, under its Ticket's key.
  report: { name: "Report", path: documentPath, key: (r) => r.ticketKey },
  // A Comment opens what it is on: its Artifact, its Document or its Ticket.
  comment: {
    name: "Comment",
    path: (r) => (r.artifactId ? `/artifacts/${r.artifactId}` : r.documentId ? documentPath(r) : `/tickets/${r.ticketKey}`),
    key: (r) => r.ticketKey,
  },
  term: { name: "Term", path: (r) => `/terms/${r.termId}`, key: () => null },
  decision: { name: "Decision", path: (r) => `/decisions/${r.decisionKey}`, key: (r) => r.decisionKey },
  // A Transcript opens at the turn that matches best.
  transcript: { name: "Transcript", path: (r) => transcriptAddress(r.transcriptId!, r.turn), key: () => null },
};

/** What the search page searches for: the query, and optionally one kind and one Project key. */
export interface SearchFilter {
  q: string;
  kind?: SearchKind | undefined;
  project?: string | undefined;
}

/** Where the search page for `filter` lives. */
const searchPath = (filter: SearchFilter) => `/search?${new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][])}`;

/** The search page's filter, read from its address. */
export const searchFilterFrom = (search: URLSearchParams): SearchFilter => {
  const kind = search.get("kind");
  return {
    q: search.get("q") ?? "",
    kind: SEARCH_KINDS.find((k) => k === kind),
    project: search.get("project") ?? undefined,
  };
};

/** Whether a key press lands in something the User types into, where `/` must stay a character. */
const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** The search box in the sidebar, which `/` focuses; searching opens the search page. */
export function SearchBox() {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || typingIn(e.target)) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) navigate(searchPath({ q: q.trim() }));
  };
  return (
    <form role="search" className="search-box" onSubmit={submit}>
      <input ref={input} type="search" aria-label="Search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      <kbd className="search-key" aria-hidden="true">/</kbd>
    </form>
  );
}

/** What the search for `filter` found, best match first, with controls to narrow it to a kind and a Project. */
export function SearchPage(props: { filter: SearchFilter }) {
  const { q, kind, project } = props.filter;
  const [results] = useLoad(() => (q.trim() ? api.search(q, { kind, project }) : Promise.resolve([])), [q, kind, project]);
  const [projects] = useLoad(() => api.projects(), []);
  const set = (field: "kind" | "project") => (value: string) => navigate(searchPath({ ...props.filter, [field]: value || undefined }));
  return (
    <section>
      <div className="page-head">
        <h1>Search results for “{q}”</h1>
      </div>
      <div className="filters" role="group" aria-label="Filters">
        <FilterSelect name="Kind" value={kind} onChange={set("kind")} options={SEARCH_KINDS.map((k) => [k, KINDS[k].name])} />
        <FilterSelect
          name="Project"
          value={project}
          onChange={set("project")}
          options={(projects.kind === "loaded" ? projects.value : []).map((p): [string, string] => [p.key, p.name])}
        />
      </div>
      <Show state={results}>
        {(found) =>
          found.length === 0 ? (
            <p className="muted">Nothing found.</p>
          ) : (
            <ul className="rows" aria-label="Search results">
              {found.map((r, i) => {
                const { name, path, key } = KINDS[r.kind];
                const shownKey = key(r);
                return (
                  <li key={i} className="row">
                    <Link to={path(r)} className="row-link search-result">
                      <div className="search-result-head">
                        <Chip>{name}</Chip>
                        {shownKey && <span className="key">{shownKey}</span>}
                        <span className="grow">
                          {r.kind === "comment" ? `On ${r.title}` : r.title}
                          {r.protected && <> <ProtectedMark compact /></>}
                        </span>
                        <span className="muted">{r.kind === "transcript" ? `Turn ${r.turn}` : (r.projectKey ?? "Workspace")}</span>
                      </div>
                      <p className="muted search-excerpt">{r.excerpt}</p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Show>
    </section>
  );
}
