/** The app's addresses, parsed once for both the page and the sidebar (docs/ui.md § Layout and navigation). */

export type Route =
  | { page: "projects"; archived: boolean }
  | { page: "project"; key: string }
  | { page: "projectDocuments"; key: string }
  | { page: "artifacts" }
  | { page: "projectArtifacts"; key: string }
  | { page: "artifact"; id: string }
  | { page: "ticket"; key: string }
  | { page: "documents" }
  | { page: "document"; id: string }
  | { page: "decisions" }
  | { page: "decision"; key: string }
  | { page: "inbox" }
  | { page: "triage" }
  | { page: "terms" }
  | { page: "term"; id: string }
  | { page: "agents" }
  | { page: "search" }
  | { page: "guidance" }
  | { page: "users" }
  | { page: "settings" }
  | { page: "password" };

const FIXED: Record<string, Route> = {
  "/archived": { page: "projects", archived: true },
  "/documents": { page: "documents" },
  "/artifacts": { page: "artifacts" },
  "/decisions": { page: "decisions" },
  "/inbox": { page: "inbox" },
  "/triage": { page: "triage" },
  "/terms": { page: "terms" },
  "/agents": { page: "agents" },
  "/search": { page: "search" },
  "/guidance": { page: "guidance" },
  "/users": { page: "users" },
  "/settings": { page: "settings" },
  "/password": { page: "password" },
};

const PATTERNS: [RegExp, (param: string) => Route][] = [
  [/^\/projects\/([^/]+)$/, (key) => ({ page: "project", key })],
  [/^\/projects\/([^/]+)\/documents$/, (key) => ({ page: "projectDocuments", key })],
  [/^\/projects\/([^/]+)\/artifacts$/, (key) => ({ page: "projectArtifacts", key })],
  [/^\/artifacts\/([^/]+)$/, (id) => ({ page: "artifact", id })],
  [/^\/tickets\/([^/]+)$/, (key) => ({ page: "ticket", key })],
  [/^\/documents\/([^/]+)$/, (id) => ({ page: "document", id })],
  [/^\/decisions\/([^/]+)$/, (key) => ({ page: "decision", key })],
  [/^\/terms\/([^/]+)$/, (id) => ({ page: "term", id })],
];

/** The page at `path`; any other address, or a malformed one, is the Projects page. */
export function routeOf(path: string): Route {
  const fixed = FIXED[path];
  if (fixed) return fixed;
  for (const [pattern, route] of PATTERNS) {
    const match = pattern.exec(path);
    if (!match) continue;
    try {
      return route(decodeURIComponent(match[1]!));
    } catch {
      break; // a malformed escape
    }
  }
  return { page: "projects", archived: false };
}

/** The Project a Ticket key belongs to: everything before its last "-", as Project keys hold none. */
export const projectKeyOfTicket = (ticketKey: string) => ticketKey.slice(0, Math.max(0, ticketKey.lastIndexOf("-")));

/** The Terms page of a place: a Project's, or the Workspace's without a Project key. */
export const termsAddress = (projectKey: string | null | undefined) => (projectKey ? `/terms?project=${encodeURIComponent(projectKey)}` : "/terms");

/** The Project a page belongs to, if any, so the Terms and Decisions pages can start on it: a Project's own pages, or a Ticket's. */
export function projectKeyOf(route: Route): string | undefined {
  if (route.page === "project" || route.page === "projectDocuments" || route.page === "projectArtifacts") return route.key.toUpperCase();
  if (route.page === "ticket") return projectKeyOfTicket(route.key).toUpperCase();
  return undefined;
}
