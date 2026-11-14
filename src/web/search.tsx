import { useState, type FormEvent } from "react";
import { api, type SearchKind, type SearchResult } from "./api.js";
import { Link, navigate } from "./router.js";
import { Show, useLoad } from "./ui.js";

const KIND_NAMES: Record<SearchKind, string> = { ticket: "Ticket", document: "Document", report: "Report", comment: "Comment" };

/** Where the search page for `q` lives. */
const searchPath = (q: string) => `/search?${new URLSearchParams({ q })}`;

/** The search box in the top bar; searching opens the search page. */
export function SearchBox() {
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) navigate(searchPath(q.trim()));
  };
  return (
    <form role="search" className="search-box" onSubmit={submit}>
      <input type="search" aria-label="Search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

/** Where a search result opens: its Ticket or its Document. */
const resultPath = (r: SearchResult) => (r.documentId ? `/documents/${r.documentId}` : `/tickets/${r.ticketKey}`);

/** What the search for `q` found, best match first. */
export function SearchPage(props: { q: string }) {
  const [results] = useLoad(() => (props.q.trim() ? api.search(props.q) : Promise.resolve([])), [props.q]);
  return (
    <section>
      <div className="page-head">
        <h1>Search results for “{props.q}”</h1>
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
