import { Chip, ProtectedMark } from "./components/tags.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SEARCH_KINDS } from "../shared/values.js";
import { api, type SearchKind, type SearchResult } from "./api.js";
import { Link, navigate } from "./router.js";
import { Show, useLoad } from "./ui.js";
import { FilterSelect } from "./work.js";

const KIND_NAMES: Record<SearchKind, string> = { ticket: "Ticket", document: "Document", report: "Report", comment: "Comment", term: "Term", decision: "Decision" };

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

/** Where a search result opens: its Decision, its Term, its Document or its Ticket. */
const resultPath = (r: SearchResult) =>
  r.decisionKey
    ? `/decisions/${r.decisionKey}`
    : r.termId
      ? `/terms/${r.termId}`
      : r.documentId
        ? `/documents/${r.documentId}`
        : `/tickets/${r.ticketKey}`;

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
        <FilterSelect name="Kind" value={kind} onChange={set("kind")} options={SEARCH_KINDS.map((k) => [k, KIND_NAMES[k]])} />
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
              {found.map((r, i) => (
                <li key={i} className="row">
                  <Link to={resultPath(r)} className="row-link search-result">
                    <div className="search-result-head">
                      <Chip>{KIND_NAMES[r.kind]}</Chip>
                      {(r.ticketKey ?? r.decisionKey) && <span className="key">{r.ticketKey ?? r.decisionKey}</span>}
                      <span className="grow">
                        {r.kind === "comment" ? `On ${r.title}` : r.title}
                        {r.protected && <> <ProtectedMark compact /></>}
                      </span>
                      <span className="muted">{r.projectKey ?? "Workspace"}</span>
                    </div>
                    <p className="muted search-excerpt">{r.excerpt}</p>
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
