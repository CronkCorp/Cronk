import Markdown, { type Components } from "react-markdown";
import { api } from "./api.js";
import { Link } from "./router.js";
import { useLoad } from "./ui.js";
import { alignCodeToSource, alignToSource, encodeBounds, type Container, type SourceBounds } from "./source-map.js";
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
 * A remark plugin that turns references to Tickets of known Projects into links
 * to those Tickets. Only keys of real Projects count, so text like `UTF-8`
 * stays plain. Code is never touched, as it isn't text in the tree.
 */
function linkTicketReferences(projectKeys: Set<string>, source: string) {
  /**
   * Where `length` characters from `from` in a text node's value sit in the source, if the node's position
   * is known and its value can be tied to the source character by character.
   */
  const positionWithin = (node: MarkdownNode, from: number, length: number): Pick<MarkdownNode, "position"> => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return {};
    const bounds = alignToSource(node.value ?? "", source, start, end);
    if (!bounds) return {};
    return { position: { start: pointIn(source, bounds.starts[from]!), end: pointIn(source, bounds.ends[from + length]!) } };
  };
  const split = (text: string, node: MarkdownNode): MdNode[] => {
    const parts: MdNode[] = [];
    let last = 0;
    for (const match of text.matchAll(TICKET_REFERENCE)) {
      if (!projectKeys.has(match[1]!)) continue;
      if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index), ...positionWithin(node, last, match.index - last) });
      const at = positionWithin(node, match.index, match[0].length);
      parts.push({ type: "link", url: `/tickets/${match[0]}`, children: [{ type: "text", value: match[0], ...at }], ...at });
      last = match.index + match[0].length;
    }
    if (last === 0) return [node];
    if (last < text.length) parts.push({ type: "text", value: text.slice(last), ...positionWithin(node, last, text.length - last) });
    return parts;
  };
  return () => (tree: MdNode) => replaceReferenceText(tree, split);
}

/** Whether every run of text a hast node shows was parsed from between `start` and `end` in the source. */
const textWithin = (node: HastNode, start: number, end: number): boolean => {
  if (node.type !== "text") return (node.children ?? []).every((child) => textWithin(child, start, end));
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  return from !== undefined && to !== undefined && start <= from && to <= end;
};

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

/** Where a hast node's Markdown starts and ends in the source, if it is known. */
function spanOf(node: HastNode | undefined): { start: number; end: number } | undefined {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  return start === undefined || end === undefined ? undefined : { start, end };
}

/** `node` wrapped in a span naming where its Markdown starts, and how its characters sit from there when `bounds` says. */
function sourceSpan(node: HastNode, start: number, bounds?: SourceBounds): HastNode {
  const map = bounds && encodeBounds(bounds, start);
  return { type: "element", tagName: "span", properties: { dataSourceStart: start, ...(map && { dataSourceMap: map }) }, children: [node] };
}

/**
 * Where the text of a code block (`code` in `pre`) sits in the source, if that is known for certain: each
 * line is tied to the source past the prefix every blockquote and list item around it puts before it, or,
 * failing that, the text is found exactly once inside the block's stretch.
 */
function markCode(node: HastNode, code: HastNode, ancestors: HastNode[], source: string): HastNode {
  const value = node.value ?? "";
  const span = spanOf(code);
  if (!value.trim() || !span) return node;
  const containers: Container[] = [];
  for (const ancestor of ancestors) {
    const kind = ancestor.tagName === "blockquote" ? "blockquote" : ancestor.tagName === "li" ? "listItem" : undefined;
    if (!kind) continue;
    const start = spanOf(ancestor)?.start;
    if (start === undefined) return node;
    containers.push({ kind, start });
  }
  const bounds = alignCodeToSource(value, source, span, containers);
  return bounds ? sourceSpan(node, bounds.ends[0]!, bounds) : markVerbatim(node, span, source);
}

/** Marks code that shows its Markdown as it is where its text is found exactly once inside its stretch, as inside backticks. */
function markVerbatim(node: HastNode, span: { start: number; end: number }, source: string): HastNode {
  const value = node.value ?? "";
  const stretch = source.slice(span.start, span.end);
  const found = stretch.indexOf(value);
  if (found < 0 || stretch.indexOf(value, found + 1) >= 0) return node;
  return sourceSpan(node, span.start + found);
}

/**
 * A rehype plugin that wraps each run of text in a span naming where the text sits in the Markdown
 * source (`data-source-start`), when that is known for certain: each of its characters can be tied to
 * the stretch it was parsed from, skipping what Markdown dropped (`data-source-map`, as `encodeBounds`
 * writes it), or, for code, the text is found exactly once inside that stretch, as inside its
 * backticks. A code block's lines are tied past the prefixes of the blockquotes and list items around
 * it. Inline elements name where their markup starts and ends (`data-markup-start`, `data-markup-end`), when
 * every run of their text was parsed from inside it; a code block's fences are left out of it.
 */
function markSourceOffsets(source: string) {
  const mark = (node: HastNode, ancestors: HastNode[]): HastNode => {
    const parent = ancestors[ancestors.length - 1];
    if (node.type !== "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const inline = node.tagName && INLINE_MARKUP.has(node.tagName) && !(node.tagName === "code" && parent?.tagName === "pre");
      if (inline && start !== undefined && end !== undefined && textWithin(node, start, end)) {
        node.properties = { ...node.properties, dataMarkupStart: start, dataMarkupEnd: end };
      }
      node.children = node.children?.map((child) => mark(child, [...ancestors, node]));
      return node;
    }
    // A code block's text carries no place of its own; its `code` element does.
    if (parent?.tagName === "code" && ancestors[ancestors.length - 2]?.tagName === "pre") return markCode(node, parent, ancestors, source);
    const value = node.value ?? "";
    const span = spanOf(node);
    if (!value.trim() || !span) return node;
    const bounds = alignToSource(value, source, span.start, span.end);
    if (bounds) return sourceSpan(node, span.start, bounds);
    // Inline code shows its Markdown as it is, inside backticks the run's stretch includes.
    return parent?.tagName === "code" ? markVerbatim(node, span, source) : node;
  };
  return () => (tree: HastNode) => {
    mark(tree, []);
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
