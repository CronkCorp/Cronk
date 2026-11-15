import { useEffect, type ReactNode } from "react";
import { Actor, userActor } from "./components/actor.js";
import { Button } from "./components/button.js";
import { Menu, type MenuItem } from "./components/overlays.js";
import { api, watchInbox, type Project, type User, type Workspace } from "./api.js";
import { Link, navigate, useLocation } from "./router.js";
import { SearchBox } from "./search.js";
import { useLoad } from "./ui.js";

// The app frame's sidebar: docs/ui.md § Layout and navigation.

/** Which sidebar item the page at `path` belongs to: a Ticket marks its Project, a Document marks Documents. */
export function currentItem(path: string): string | undefined {
  let first: string | undefined, second: string | undefined;
  try {
    [, first, second] = path.split("/").map(decodeURIComponent);
  } catch {
    return undefined; // a malformed address belongs to no item
  }
  // Keys are upper case, but the server also takes them in lower case.
  second = second?.toUpperCase();
  switch (first) {
    case "inbox":
    case "documents":
    case "agents":
    case "guidance":
    case "users":
    case "settings":
      return first;
    case "projects":
      return second ? `project:${second}` : undefined;
    case "tickets":
      return second?.includes("-") ? `project:${second.slice(0, second.lastIndexOf("-"))}` : undefined;
    default:
      return undefined;
  }
}

const ROLE_NAMES: Record<User["role"], string> = { admin: "Admin", member: "Member" };

/**
 * The sidebar: the Workspace, Search, the main links with their counts, the Projects, the Workspace group
 * and the signed-in User. Below 760px it becomes a strip, and everything below the main links moves into a menu.
 */
export function Sidebar(props: { me: User; workspace: Workspace | undefined; onSignOut: () => void }) {
  const { path } = useLocation();
  const current = currentItem(path);
  const admin = props.me.role === "admin";
  // Projects and Agent Sessions have no stream to the browser, so they load again on each navigation.
  const [projects] = useLoad(() => api.projects(), [path]);
  const [agents] = useLoad(() => api.agents(), [path]);
  const [inbox, reloadInbox] = useLoad(() => api.inbox(), []);
  useEffect(() => watchInbox({ ready: reloadInbox, on: { changed: reloadInbox } }), []);

  const waiting = inbox.kind === "loaded" ? inbox.value.length : 0;
  const liveSessions = agents.kind === "loaded" ? agents.value.reduce((n, a) => n + a.sessions.length, 0) : 0;
  const projectList: Project[] = projects.kind === "loaded" ? projects.value : [];
  const workspaceLinks = [
    { id: "guidance", to: "/guidance", label: "Guidance" },
    ...(admin
      ? [
          { id: "users", to: "/users", label: "Users" },
          { id: "settings", to: "/settings", label: "Settings" },
        ]
      : []),
  ];
  const phoneMenu: MenuItem[] = [
    ...projectList.map((p) => ({ group: "Projects", label: `${p.key} ${p.name}`, onSelect: () => navigate(`/projects/${encodeURIComponent(p.key)}`) })),
    ...workspaceLinks.map((l) => ({ group: "Workspace", label: l.label, onSelect: () => navigate(l.to) })),
    { group: `${props.me.name} · ${ROLE_NAMES[props.me.role]}`, label: "Sign out", onSelect: props.onSignOut },
  ];

  return (
    <nav className="sidebar" aria-label="Sidebar">
      <div className="sidebar-head">
        <Link to="/" className="workspace-name">
          <span className="workspace-mark" aria-hidden="true">{props.workspace?.name.trim().charAt(0).toUpperCase()}</span>
          <span data-testid="workspace-name">{props.workspace?.name}</span>
        </Link>
        <div className="sidebar-phone-menu">
          <Menu label="More" trigger={<Button variant="secondary">Menu</Button>} items={phoneMenu} />
        </div>
      </div>
      <SearchBox />
      <ul className="nav-list nav-main">
        <NavItem to="/inbox" current={current === "inbox"}>
          <span className="nav-text">Inbox</span>
          <NavCount count={waiting} className="nav-count" unit="waiting" />
        </NavItem>
        <NavItem to="/documents" current={current === "documents"}>
          <span className="nav-text">Documents</span>
        </NavItem>
        <NavItem to="/agents" current={current === "agents"}>
          <span className="nav-text">Agents</span>
          <NavCount count={liveSessions} className="nav-live" unit="live" dot />
        </NavItem>
      </ul>
      <div className="sidebar-more">
        {projectList.length > 0 && (
          <NavGroup label="Projects">
            {projectList.map((p) => (
              <NavItem key={p.id} to={`/projects/${encodeURIComponent(p.key)}`} current={current === `project:${p.key}`}>
                <span className="nav-key">{p.key}</span> <span className="nav-text">{p.name}</span>
              </NavItem>
            ))}
          </NavGroup>
        )}
        <NavGroup label="Workspace">
          {workspaceLinks.map((l) => (
            <NavItem key={l.id} to={l.to} current={current === l.id}>
              <span className="nav-text">{l.label}</span>
            </NavItem>
          ))}
        </NavGroup>
      </div>
      <div className="sidebar-user">
        <Menu
          label="Account"
          trigger={
            <Button variant="ghost" className="user-button">
              <Actor actor={userActor(props.me.name)} />
              <span className="muted">{ROLE_NAMES[props.me.role]}</span>
            </Button>
          }
          items={[{ label: "Sign out", onSelect: props.onSignOut }]}
        />
      </div>
    </nav>
  );
}

/** A count after a sidebar link's name, read out with its unit ("Inbox 2 waiting"); nothing when it is zero. */
function NavCount(props: { count: number; className: string; unit: string; dot?: boolean }) {
  if (props.count === 0) return null;
  return (
    <>
      {" "}
      <span className={props.className}>
        {props.dot && <span className="live-dot" aria-hidden="true" />}
        {props.count}
        <span className="visually-hidden"> {props.unit}</span>
      </span>
    </>
  );
}

function NavGroup(props: { label: string; children: ReactNode }) {
  const id = `nav-group-${props.label.toLowerCase()}`;
  return (
    <div className="nav-group">
      <div className="nav-label" id={id}>{props.label}</div>
      <ul className="nav-list" aria-labelledby={id}>{props.children}</ul>
    </div>
  );
}

/** One sidebar link; the current page's carries `aria-current="page"` and the active style. */
function NavItem(props: { to: string; current: boolean; children: ReactNode }) {
  return (
    <li>
      <Link to={props.to} className={`nav-item${props.current ? " active" : ""}`} {...(props.current ? { "aria-current": "page" as const } : {})}>
        {props.children}
      </Link>
    </li>
  );
}
