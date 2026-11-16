/** The app's addresses, parsed once for both the page and the sidebar (docs/ui.md § Layout and navigation). */

export type Route =
  | { page: "projects"; archived: boolean }
  | { page: "project"; key: string }
  | { page: "projectDocuments"; key: string }
  | { page: "ticket"; key: string }
  | { page: "documents" }
  | { page: "document"; id: string }
  | { page: "inbox" }
  | { page: "agents" }
  | { page: "search" }
  | { page: "guidance" }
  | { page: "users" }
  | { page: "settings" }
  | { page: "password" };

const FIXED: Record<string, Route> = {
  "/archived": { page: "projects", archived: true },
  "/documents": { page: "documents" },
  "/inbox": { page: "inbox" },
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
  [/^\/tickets\/([^/]+)$/, (key) => ({ page: "ticket", key })],
  [/^\/documents\/([^/]+)$/, (id) => ({ page: "document", id })],
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
