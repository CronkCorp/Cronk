import Markdown from "react-markdown";
import { api } from "./api.js";
import { Link } from "./router.js";
import { useLoad } from "./ui.js";
import { replaceReferenceText, TICKET_REFERENCE, type MarkdownNode, type MarkdownPoint } from "../shared/ticket-references.js";

/** The mdast nodes this file touches; react-markdown hands its plugins trees of these. */
interface MdNode extends MarkdownNode {
  url?: string;
  children?: MdNode[];
}

/**
 * Where `length` characters from `from` in a text node's value sit in the source, if the node's
 * position is known, counting as if the value were the source text it was parsed from.
 */
function positionWithin(node: MarkdownNode, from: number, length: number): Pick<MarkdownNode, "position"> {
  const start = node.position?.start;
  if (start?.offset === undefined) return {};
  const value = node.value ?? "";
  const pointAt = (at: number): MarkdownPoint => {
    const before = value.slice(0, at);
    const lineStart = before.lastIndexOf("\n");
    const lines = before.split("\n").length - 1;
    return { line: start.line + lines, column: lineStart < 0 ? start.column + at : at - lineStart, offset: start.offset! + at };
  };
  return { position: { start: pointAt(from), end: pointAt(from + length) } };
}


/**
 * A remark plugin that turns references to Tickets of known Projects into links
 * to those Tickets. Only keys of real Projects count, so text like `UTF-8`
 * stays plain. Code is never touched, as it isn't text in the tree.
 */
function linkTicketReferences(projectKeys: Set<string>) {
  const split = (text: string, node: MarkdownNode): MdNode[] => {
    const parts: MdNode[] = [];
    let last = 0;
    for (const match of text.matchAll(TICKET_REFERENCE)) {
      if (!projectKeys.has(match[1]!)) continue;
      if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index), ...positionWithin(node, last, match.index - last) });
      const reference = { type: "text", value: match[0], ...positionWithin(node, match.index, match[0].length) };
      parts.push({ type: "link", url: `/tickets/${match[0]}`, children: [reference], ...positionWithin(node, match.index, match[0].length) });
      last = match.index + match[0].length;
    }
    if (last === 0) return [node];
    if (last < text.length) parts.push({ type: "text", value: text.slice(last), ...positionWithin(node, last, text.length - last) });
    return parts;
  };
  return () => (tree: MdNode) => replaceReferenceText(tree, split);
}

/** The hast nodes `markSourceOffsets` touches. */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Inline elements whose Markdown wraps their text in markup, such as `**` around bold. */
const INLINE_MARKUP = new Set(["strong", "em", "del", "code", "a"]);

/**
 * A rehype plugin that wraps each run of text in a span naming where the text sits in the Markdown
 * source (`data-source-start`), when that is known for certain: the text is either the whole stretch
 * it was parsed from, or found exactly once inside it, as code is inside its backticks. Inline
 * elements name where their markup starts and ends (`data-markup-start`, `data-markup-end`).
 */
function markSourceOffsets(source: string) {
  const mark = (node: HastNode): HastNode => {
    if (node.type !== "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (node.tagName && INLINE_MARKUP.has(node.tagName) && start !== undefined && end !== undefined) {
        node.properties = { ...node.properties, dataMarkupStart: start, dataMarkupEnd: end };
      }
      node.children = node.children?.map(mark);
      return node;
    }
    const value = node.value ?? "";
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (!value.trim() || start === undefined || end === undefined) return node;
    const stretch = source.slice(start, end);
    const at = stretch.indexOf(value);
    if (at < 0 || stretch.indexOf(value, at + 1) >= 0) return node;
    return { type: "element", tagName: "span", properties: { dataSourceStart: start + at }, children: [node] };
  };
  return () => (tree: HastNode) => {
    mark(tree);
  };
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

/**
 * Renders Cronk Markdown: CommonMark plus Ticket references as links. With `sourceOffsets`, each run of
 * text says where it sits in the Markdown, so a selection can be read back as the Markdown it shows.
 */
export function CronkMarkdown(props: { children: string; sourceOffsets?: boolean }) {
  const [keys] = useLoad(loadProjectKeys, []);
  const known = keys.kind === "loaded" ? keys.value : new Set<string>();
  return (
    <Markdown
      remarkPlugins={[linkTicketReferences(known)]}
      rehypePlugins={props.sourceOffsets ? [markSourceOffsets(props.children)] : []}
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
