import Markdown, { type Components } from "react-markdown";
import { api } from "./api.js";
import { Link } from "./router.js";
import { useLoad } from "./ui.js";
import { alignToSource, encodeBounds } from "./source-map.js";
import { replaceReferenceText, TICKET_REFERENCE, type MarkdownNode, type MarkdownPoint } from "../shared/ticket-references.js";

/** The mdast nodes this file touches; react-markdown hands its plugins trees of these. */
interface MdNode extends MarkdownNode {
  url?: string;
  children?: MdNode[];
}

/** A point in `source` at `offset`, with its line and column: without them the rest of the pipeline drops the position. */
function pointIn(source: string, offset: number): MarkdownPoint {
  const before = source.slice(0, offset);
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n"), offset };
}

/**
 * Where `length` characters from `from` in a text node's value sit in `source`, if the node's position
 * is known and its value can be tied to the source character by character.
 */
function positionWithin(node: MarkdownNode, source: string, from: number, length: number): Pick<MarkdownNode, "position"> {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return {};
  const bounds = alignToSource(node.value ?? "", source, start, end);
  if (!bounds) return {};
  return { position: { start: pointIn(source, bounds.starts[from]!), end: pointIn(source, bounds.ends[from + length]!) } };
}

/**
 * A remark plugin that turns references to Tickets of known Projects into links
 * to those Tickets. Only keys of real Projects count, so text like `UTF-8`
 * stays plain. Code is never touched, as it isn't text in the tree.
 */
function linkTicketReferences(projectKeys: Set<string>, source: string) {
  const split = (text: string, node: MarkdownNode): MdNode[] => {
    const parts: MdNode[] = [];
    let last = 0;
    for (const match of text.matchAll(TICKET_REFERENCE)) {
      if (!projectKeys.has(match[1]!)) continue;
      if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index), ...positionWithin(node, source, last, match.index - last) });
      const at = positionWithin(node, source, match.index, match[0].length);
      parts.push({ type: "link", url: `/tickets/${match[0]}`, children: [{ type: "text", value: match[0], ...at }], ...at });
      last = match.index + match[0].length;
    }
    if (last === 0) return [node];
    if (last < text.length) parts.push({ type: "text", value: text.slice(last), ...positionWithin(node, source, last, text.length - last) });
    return parts;
  };
  return () => (tree: MdNode) => replaceReferenceText(tree, split);
}

/** The text a hast node shows. */
const textOf = (node: HastNode): string => node.value ?? (node.children ?? []).map(textOf).join("");

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
 * source (`data-source-start`), when that is known for certain: the text is found exactly once in the
 * stretch it was parsed from, as code is inside its backticks, or each of its characters can be tied to
 * that stretch, skipping what Markdown dropped (`data-source-map`, as `encodeBounds` writes it). Inline
 * elements name where their markup starts and ends (`data-markup-start`, `data-markup-end`), when
 * the Markdown there holds their text as shown; a code block's fences are left out of it.
 */
function markSourceOffsets(source: string) {
  const mark = (node: HastNode, parent?: HastNode): HastNode => {
    if (node.type !== "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const inline = node.tagName && INLINE_MARKUP.has(node.tagName) && !(node.tagName === "code" && parent?.tagName === "pre");
      if (inline && start !== undefined && end !== undefined && source.slice(start, end).includes(textOf(node))) {
        node.properties = { ...node.properties, dataMarkupStart: start, dataMarkupEnd: end };
      }
      node.children = node.children?.map((child) => mark(child, node));
      return node;
    }
    const value = node.value ?? "";
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (!value.trim() || start === undefined || end === undefined) return node;
    const stretch = source.slice(start, end);
    const at = stretch.indexOf(value);
    if (at >= 0 && stretch.indexOf(value, at + 1) < 0) {
      return { type: "element", tagName: "span", properties: { dataSourceStart: start + at }, children: [node] };
    }
    const bounds = alignToSource(value, source, start, end);
    if (!bounds) return node;
    return { type: "element", tagName: "span", properties: { dataSourceStart: start, dataSourceMap: encodeBounds(bounds, start) }, children: [node] };
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
 * How rendered Markdown shows its elements. Defined once, not per render: a new component each render
 * would remount every link, and a selection ending inside one would lose its end.
 */
const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href?.startsWith("/") ? (
      <Link to={href} className="link">{children}</Link>
    ) : (
      <a href={href} className="link">{children}</a>
    ),
};

/**
 * Renders Cronk Markdown: CommonMark plus Ticket references as links. With `sourceOffsets`, each run of
 * text says where it sits in the Markdown, so a selection can be read back as the Markdown it shows.
 */
export function CronkMarkdown(props: { children: string; sourceOffsets?: boolean }) {
  const [keys] = useLoad(loadProjectKeys, []);
  const known = keys.kind === "loaded" ? keys.value : new Set<string>();
  return (
    <Markdown
      remarkPlugins={[linkTicketReferences(known, props.children)]}
      rehypePlugins={props.sourceOffsets ? [markSourceOffsets(props.children)] : []}
      components={COMPONENTS}
    >
      {props.children}
    </Markdown>
  );
}
