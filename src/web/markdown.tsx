import Markdown from "react-markdown";
import { api } from "./api.js";
import { Link } from "./router.js";
import { useLoad } from "./ui.js";
import { NOT_LINKED, TICKET_REFERENCE } from "../shared/ticket-references.js";

/** The mdast nodes this file touches; react-markdown hands its plugins trees of these. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}


/**
 * A remark plugin that turns references to Tickets of known Projects into links
 * to those Tickets. Only keys of real Projects count, so text like `UTF-8`
 * stays plain. Code is never touched, as it isn't text in the tree.
 */
function linkTicketReferences(projectKeys: Set<string>) {
  const split = (text: string): MdNode[] => {
    const parts: MdNode[] = [];
    let last = 0;
    for (const match of text.matchAll(TICKET_REFERENCE)) {
      if (!projectKeys.has(match[1]!)) continue;
      if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
      parts.push({ type: "link", url: `/tickets/${match[0]}`, children: [{ type: "text", value: match[0] }] });
      last = match.index + match[0].length;
    }
    if (last === 0) return [{ type: "text", value: text }];
    if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
    return parts;
  };
  const visit = (node: MdNode) => {
    if (!node.children || NOT_LINKED.has(node.type)) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return split(child.value ?? "");
      visit(child);
      return [child];
    });
  };
  return () => visit;
}

/** Keys of every Project, archived ones included, loaded once per page load. */
let projectKeys: Promise<Set<string>> | undefined;
function loadProjectKeys(): Promise<Set<string>> {
  projectKeys ??= Promise.all([api.projects(false), api.projects(true)]).then(
    (lists) => new Set(lists.flat().map((p) => p.key)),
    (err) => {
      projectKeys = undefined;
      throw err;
    },
  );
  return projectKeys;
}

/** Forgets the known Project keys, so a Project created since shows up in links. */
export function forgetProjectKeys(): void {
  projectKeys = undefined;
}

/** Renders Cronk Markdown: CommonMark plus Ticket references as links. */
export function CronkMarkdown(props: { children: string }) {
  const [keys] = useLoad(loadProjectKeys, []);
  const known = keys.kind === "loaded" ? keys.value : new Set<string>();
  return (
    <Markdown
      remarkPlugins={[linkTicketReferences(known)]}
      components={{
        a: ({ href, children }) =>
          href?.startsWith("/") ? (
            <Link to={href} className="link">{children}</Link>
          ) : (
            <a href={href} className="link">{children}</a>
          ),
      }}
    >
      {props.children}
    </Markdown>
  );
}
