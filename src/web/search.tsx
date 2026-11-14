import { useState, type FormEvent } from "react";
import { SEARCH_KINDS } from "../shared/values.js";
import { api, type SearchKind, type SearchResult } from "./api.js";
import { Link, navigate } from "./router.js";
import { Show, useLoad } from "./ui.js";
import { FilterSelect } from "./work.js";

const KIND_NAMES: Record<SearchKind, string> = { ticket: "Ticket", document: "Document", report: "Report", comment: "Comment" };

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

/** The search box in the top bar; searching opens the search page. */
export function SearchBox() {
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) navigate(searchPath({ q: q.trim() }));
  };
  return (
    <form role="search" className="search-box" onSubmit={submit}>
      <input type="search" aria-label="Search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

/** Where a search result opens: its Ticket or its Document. */
const resultPath = (r: SearchResult) => (r.documentId ? `/documents/${r.documentId}` : `/tickets/${r.ticketKey}`);

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
                      <span className="badge">{KIND_NAMES[r.kind]}</span>
                      {r.ticketKey && <span className="key">{r.ticketKey}</span>}
                      <span className="grow">{r.kind === "comment" ? `On ${r.title}` : r.title}</span>
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
