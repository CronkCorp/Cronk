import { createContext, useContext } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import Markdown, { type Components } from "react-markdown";
import { api } from "./api.js";
import { Link } from "./router.js";
import { useLoad } from "./ui.js";
import { alignCodeToSource, alignToSource, encodeBounds, type Container, type SourceBounds } from "./source-map.js";
import { replaceReferenceText, TICKET_REFERENCE, type MarkdownNode, type MarkdownPoint } from "../shared/ticket-references.js";
import { DECISION_REFERENCE, normalName, termPattern } from "../shared/knowledge-references.js";
import { ARTIFACT_ADDRESS, replaceArtifactEmbeds, type ArtifactAt } from "../shared/artifact-embeds.js";
import { ArtifactEmbed } from "./artifacts.js";

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

/** What rendered Markdown links: keys of known Projects, numbers of the Workspace's Decisions, and the Terms that apply where it lies. */
interface LinkTargets {
  projectKeys: Set<string>;
  workspaceDecisions: Set<number>;
  /** Term ids by name, as `normalName` gives it. */
  terms: Map<string, string>;
}

/** A reference found in a run of text, with where it links. */
interface Found {
  index: number;
  text: string;
  url: string;
}

/** Where a link to an Artifact's address goes: within Cronk when the address is this Cronk's, else the address as written. */
const artifactHref = (address: string) => {
  const url = URL.parse(address);
  return url && url.origin === location.origin ? `${url.pathname}${url.search}` : address;
};

/**
 * The references `text` makes, left to right without overlaps (the longer wins where two start
 * together): Artifacts' addresses, Ticket and Decision keys of known Projects, keys of the Workspace's
 * Decisions, and the names of Terms with their capitalisation, as whole words.
 */
function referencesIn(text: string, targets: LinkTargets, terms: RegExp | undefined): Found[] {
  const found: Found[] = [];
  for (const m of text.matchAll(ARTIFACT_ADDRESS)) found.push({ index: m.index, text: m[0], url: artifactHref(m[0]) });
  for (const m of text.matchAll(TICKET_REFERENCE)) {
    if (targets.projectKeys.has(m[1]!)) found.push({ index: m.index, text: m[0], url: `/tickets/${m[0]}` });
  }
  for (const m of text.matchAll(DECISION_REFERENCE)) {
    const known = m[1] === undefined ? targets.workspaceDecisions.has(Number(m[2])) : targets.projectKeys.has(m[1]);
    if (known) found.push({ index: m.index, text: m[0], url: `/decisions/${m[0]}` });
  }
  for (const m of terms ? text.matchAll(terms) : []) {
    const id = targets.terms.get(normalName(m[0]));
    if (id) found.push({ index: m.index, text: m[0], url: `/terms/${id}` });
  }
  found.sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  let end = 0;
  return found.filter((f) => {
    if (f.index < end) return false;
    end = f.index + f.text.length;
    return true;
  });
}

/**
 * A remark plugin that turns references in text into links: Ticket and Decision keys of known Projects
 * (so text like `UTF-8` stays plain), keys of the Workspace's Decisions, and the names of the Terms that
 * apply, written with their capitalisation. Code and existing links are never touched.
 */
function linkReferences(targets: LinkTargets, source: string) {
  const terms = termPattern([...targets.terms.keys()]);
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
    for (const match of referencesIn(text, targets, terms)) {
      if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index), ...positionWithin(node, last, match.index - last) });
      const at = positionWithin(node, match.index, match.text.length);
      parts.push({ type: "link", url: match.url, children: [{ type: "text", value: match.text, ...at }], ...at });
      last = match.index + match.text.length;
    }
    if (last === 0) return [node];
    if (last < text.length) parts.push({ type: "text", value: text.slice(last), ...positionWithin(node, last, text.length - last) });
    return parts;
  };
  return () => (tree: MdNode) => replaceReferenceText(tree, split);
}

/** The key an embed is listed by: its Artifact and the Version it names. */
const embedKey = (at: ArtifactAt) => `${at.artifactId}@${at.version ?? ""}`;

/**
 * A remark plugin that turns each line holding an Artifact's address alone into an embed of it, when the API listed
 * it among what the text embeds (`embeds`); any other such line stays a link.
 */
function embedArtifacts(embeds: ArtifactAt[]) {
  const listed = new Set(embeds.map(embedKey));
  return () => (tree: MdNode) =>
    replaceArtifactEmbeds(tree, (at) =>
      listed.has(embedKey(at))
        ? ({ type: "artifactEmbed", children: [], data: { hName: "artifact-embed", hProperties: { artifactId: at.artifactId, version: at.version ?? "" } } } as MdNode)
        : undefined,
    );
}

/** Whether every run of text a hast node shows was parsed from between `start` and `end` in the source. */
const textWithin = (node: HastNode, start: number, end: number): boolean => {
  if (node.type !== "text") return (node.children ?? []).every((child) => textWithin(child, start, end));
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  return from !== undefined && to !== undefined && start <= from && to <= end;
};

/** The hast nodes `markSourceAndHighlights` touches. */
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
function codeBounds(value: string, code: HastNode, ancestors: HastNode[], source: string): SourceBounds | undefined {
  const span = spanOf(code);
  if (!span) return undefined;
  const containers: Container[] = [];
  for (const ancestor of ancestors) {
    const kind = ancestor.tagName === "blockquote" ? "blockquote" : ancestor.tagName === "li" ? "listItem" : undefined;
    if (!kind) continue;
    const start = spanOf(ancestor)?.start;
    if (start === undefined) return undefined;
    containers.push({ kind, start });
  }
  return alignCodeToSource(value, source, span, containers) ?? verbatimBounds(value, span, source);
}

/** Where code that shows its Markdown as it is sits, when its text is found exactly once inside its stretch, as inside backticks. */
function verbatimBounds(value: string, span: { start: number; end: number }, source: string): SourceBounds | undefined {
  const stretch = source.slice(span.start, span.end);
  const found = stretch.indexOf(value);
  if (found < 0 || stretch.indexOf(value, found + 1) >= 0) return undefined;
  const offsets = Array.from({ length: value.length + 1 }, (_, k) => span.start + found + k);
  return { starts: offsets, ends: offsets };
}

/** A passage to highlight in rendered Markdown, such as a Comment's anchor, named by `id`. */
export interface Highlight {
  id: string;
  passage: string;
}

/** The ids of the passages a highlight `mark` belongs to, as `CronkMarkdown` names them. */
export const highlightIds = (mark: Element): string[] => (mark.getAttribute("data-highlights") ?? "").split(" ").filter(Boolean);

/**
 * A run of rendered text as `markSourceAndHighlights` found it: where in the source each of its characters
 * sits, with the span it was wrapped in, or `unmapped` when that is not known for certain (with the
 * stretch it was parsed from, when known).
 */
type Run =
  /** `bare` marks whitespace between inline elements, which gets no source span of its own. */
  | { kind: "mapped"; value: string; bounds: SourceBounds; wrapper: HastNode; bare: boolean }
  | { kind: "unmapped"; from?: number; to?: number };

/**
 * Which characters of each run show the Markdown from `from` to `to`: those whose own Markdown lies
 * inside it. Nothing when no character does, or when a run of text that can't be tied to the source
 * may show part of it, so a passage is never highlighted on a guess.
 */
function place(runs: Run[], from: number, to: number): Map<Run, [number, number]> | undefined {
  const covered = new Map<Run, [number, number]>();
  let firstAt = -1;
  let lastAt = -1;
  const unknown: number[] = [];
  runs.forEach((run, at) => {
    if (run.kind === "unmapped") {
      if (run.from === undefined || run.to === undefined) unknown.push(at);
      else if (run.from < to && from < run.to) unknown.push(-1);
      return;
    }
    const { starts, ends } = run.bounds;
    let start = -1;
    let end = -1;
    for (let k = 0; k < run.value.length; k++) {
      if (starts[k]! >= from && ends[k + 1]! <= to) {
        if (start < 0) start = k;
        end = k + 1;
      }
    }
    if (start < 0) return;
    covered.set(run, [start, end]);
    if (firstAt < 0) firstAt = at;
    lastAt = at;
  });
  if (covered.size === 0 || unknown.some((at) => at < 0 || (firstAt < at && at < lastAt))) return undefined;
  // Text of unknown origin right next to the highlight may hold the rest of the passage, unless what is highlighted reaches its ends.
  const first = runs[firstAt] as Extract<Run, { kind: "mapped" }>;
  const last = runs[lastAt] as Extract<Run, { kind: "mapped" }>;
  const reachesStart = first.bounds.starts[covered.get(first)![0]] === from;
  const reachesEnd = last.bounds.ends[covered.get(last)![1]] === to;
  if ((!reachesStart && unknown.includes(firstAt - 1)) || (!reachesEnd && unknown.includes(lastAt + 1))) return undefined;
  return covered;
}

/** The part of `bounds` from character `a` up to `b`, as `alignToSource` would give it for that text alone. */
function sliceBounds(bounds: SourceBounds, a: number, b: number): SourceBounds {
  return { starts: [...bounds.starts.slice(a, b), bounds.ends[b]!], ends: [bounds.starts[a]!, ...bounds.ends.slice(a + 1, b + 1)] };
}

/** A piece of a run of text, wrapped in a span naming where it sits in the source unless `bare`. */
function pieceSpan(value: string, bounds: SourceBounds, bare: boolean): HastNode {
  const text: HastNode = { type: "text", value };
  return bare ? text : sourceSpan(text, bounds.ends[0]!, bounds);
}

/**
 * Highlights each passage at the first place its Markdown appears in `source`, as the API finds it,
 * when the rendered text there can be tied to it for certain: the runs showing it are split, and
 * each piece inside it is wrapped in a `mark` naming the passages it belongs to (`data-highlights`).
 * The first piece of each passage can take focus.
 */
function highlightPassages(runs: Run[], source: string, highlights: Highlight[]) {
  const ids = new Map<Run, Set<string>[]>();
  for (const h of highlights) {
    const from = h.passage ? source.indexOf(h.passage) : -1;
    if (from < 0) continue;
    const placed = place(runs, from, from + h.passage.length);
    for (const [run, [start, end]] of placed ?? []) {
      if (run.kind !== "mapped") continue;
      const perChar = ids.get(run) ?? Array.from({ length: run.value.length }, () => new Set<string>());
      ids.set(run, perChar);
      for (let k = start; k < end; k++) perChar[k]!.add(h.id);
    }
  }
  const focusable = new Set<string>();
  for (const run of runs) {
    const perChar = run.kind === "mapped" ? ids.get(run) : undefined;
    if (run.kind !== "mapped" || !perChar) continue;
    const pieces: HastNode[] = [];
    for (let a = 0; a < run.value.length; ) {
      const key = [...perChar[a]!].join(" ");
      let b = a + 1;
      while (b < run.value.length && [...perChar[b]!].join(" ") === key) b++;
      const piece = pieceSpan(run.value.slice(a, b), sliceBounds(run.bounds, a, b), run.bare);
      if (!key) pieces.push(piece);
      else {
        const first = [...perChar[a]!].some((id) => !focusable.has(id));
        perChar[a]!.forEach((id) => focusable.add(id));
        pieces.push({ type: "element", tagName: "mark", properties: { className: ["highlight"], dataHighlights: key, ...(first && { tabIndex: 0 }) }, children: [piece] });
      }
      a = b;
    }
    run.wrapper.type = "element";
    run.wrapper.tagName = "span";
    run.wrapper.properties = {};
    run.wrapper.children = pieces;
    delete run.wrapper.value;
  }
}

/**
 * A rehype plugin that wraps each run of text in a span naming where the text sits in the Markdown
 * source (`data-source-start`), when that is known for certain: each of its characters can be tied to
 * the stretch it was parsed from, skipping what Markdown dropped (`data-source-map`, as `encodeBounds`
 * writes it), or, for code, the text is found exactly once inside that stretch, as inside its
 * backticks. A code block's lines are tied past the prefixes of the blockquotes and list items around
 * it. Inline elements name where their markup starts and ends (`data-markup-start`, `data-markup-end`), when
 * every run of their text was parsed from inside it; a code block's fences are left out of it.
 * Then it highlights `highlights` (see `highlightPassages`).
 */
function markSourceAndHighlights(source: string, highlights: Highlight[]) {
  const runs: Run[] = [];
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
    const value = node.value ?? "";
    // A code block's text carries no place of its own; its `code` element does.
    const codeBlock = parent?.tagName === "code" && ancestors[ancestors.length - 2]?.tagName === "pre";
    const span = spanOf(codeBlock ? parent : node);
    if (!span) {
      // Whitespace the renderer puts between blocks is no text of the Document's own.
      if (value.trim()) runs.push({ kind: "unmapped" });
      return node;
    }
    if (!value.trim()) {
      // Whitespace between inline elements is left as it is, but a highlight may run through it.
      const bounds = codeBlock ? undefined : alignToSource(value, source, span.start, span.end);
      if (!bounds) return node;
      const wrapper: HastNode = { type: "text", value };
      runs.push({ kind: "mapped", value, bounds, wrapper, bare: true });
      return wrapper;
    }
    const bounds = codeBlock
      ? codeBounds(value, parent, ancestors, source)
      : // Inline code shows its Markdown as it is, inside backticks the run's stretch includes.
        (alignToSource(value, source, span.start, span.end) ?? (parent?.tagName === "code" ? verbatimBounds(value, span, source) : undefined));
    if (!bounds) {
      runs.push({ kind: "unmapped", from: span.start, to: span.end });
      return node;
    }
    const wrapper = sourceSpan(node, bounds.ends[0]!, bounds);
    runs.push({ kind: "mapped", value, bounds, wrapper, bare: false });
    return wrapper;
  };
  return () => (tree: HastNode) => {
    runs.length = 0;
    mark(tree, []);
    if (highlights.length > 0) highlightPassages(runs, source, highlights);
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

/** Numbers of the Workspace's Decisions, loaded once per page load; none if the reader can't read the Workspace. */
let workspaceDecisions: Promise<Set<number>> | undefined;
function loadWorkspaceDecisions(): Promise<Set<number>> {
  workspaceDecisions ??= api.decisions().then(
    (list) => new Set(list.map((d) => d.number)),
    () => new Set(),
  );
  return workspaceDecisions;
}

/** The Terms that apply in each place (`""` for the Workspace) by name, loaded once per page load; none if the reader can't read them. */
const placeTerms = new Map<string, Promise<Map<string, string>>>();
function loadTerms(projectKey: string | null): Promise<Map<string, string>> {
  const place = projectKey ?? "";
  let terms = placeTerms.get(place);
  if (!terms) {
    terms = api.terms(projectKey ?? undefined).then(
      (list) => new Map(list.map((t) => [normalName(t.name), t.id])),
      () => new Map(),
    );
    placeTerms.set(place, terms);
  }
  return terms;
}

/** Forgets the known Project keys, so a Project created since shows up in links. */
export function forgetProjectKeys(): void {
  projectKeys = undefined;
}

/** Forgets the known Decisions and Terms, so ones created or renamed since show up in links. */
export function forgetLinkedKnowledge(): void {
  workspaceDecisions = undefined;
  placeTerms.clear();
}

/**
 * Where rendered Markdown lies: in a Project (its key) or the Workspace (null), which decides the Terms
 * whose names it links. Without one, no Terms are linked.
 */
export const MarkdownPlace = createContext<string | null | undefined>(undefined);

async function loadLinkTargets(projectKey: string | null | undefined): Promise<LinkTargets> {
  const [keys, decisions, terms] = await Promise.all([
    loadProjectKeys(),
    loadWorkspaceDecisions(),
    projectKey === undefined ? new Map<string, string>() : loadTerms(projectKey),
  ]);
  return { projectKeys: keys, workspaceDecisions: decisions, terms };
}

const NO_TARGETS: LinkTargets = { projectKeys: new Set(), workspaceDecisions: new Set(), terms: new Map() };

/**
 * How rendered Markdown shows its elements. Defined once, not per render: a new component each render
 * would remount every link, and a selection ending inside one would lose its end.
 */
const COMPONENTS = {
  a: ({ href, children }) =>
    href?.startsWith("/") ? (
      <Link to={href} className="link">{children}</Link>
    ) : (
      <a href={href} className="link">{children}</a>
    ),
  "artifact-embed": ({ node }: { node?: { properties?: Record<string, unknown> } }) => {
    const id = String(node?.properties?.artifactId ?? "");
    const version = node?.properties?.version ? Number(node.properties.version) : null;
    return <ArtifactEmbed artifactId={id} version={version} address={`${location.origin}/artifacts/${id}${version === null ? "" : `?version=${version}`}`} />;
  },
} as Components;

/**
 * Renders Cronk Markdown: CommonMark plus Artifacts' addresses, Ticket and Decision keys and Term names as links, the Terms
 * being those that apply in `projectKey` (null for the Workspace), or else where `MarkdownPlace` says it
 * lies. With `sourceOffsets`, each run of text says where it sits in the Markdown, so a selection can be
 * read back as the Markdown it shows, and `highlights` are marked where their passages first appear. The
 * Artifacts of `embeds` show in place where their address stands alone on a line.
 */
export function CronkMarkdown(props: {
  children: string;
  projectKey?: string | null;
  sourceOffsets?: boolean;
  highlights?: Highlight[];
  /** The Artifacts the API answers the text embeds; their addresses alone on a line show them in place. */
  embeds?: ArtifactAt[];
}) {
  const place = useContext(MarkdownPlace);
  const projectKey = props.projectKey !== undefined ? props.projectKey : place;
  const [targets] = useLoad(() => loadLinkTargets(projectKey), [projectKey]);
  return (
    <Markdown
      remarkPlugins={[embedArtifacts(props.embeds ?? []), linkReferences(targets.kind === "loaded" ? targets.value : NO_TARGETS, props.children)]}
      rehypePlugins={props.sourceOffsets ? [markSourceAndHighlights(props.children, props.highlights ?? [])] : []}
      components={COMPONENTS}
    >
      {props.children}
    </Markdown>
  );
}

const BLOCKS = new Set(["paragraph", "heading", "listItem", "code", "blockquote", "tableCell", "break", "thematicBreak"]);

/** Markdown's words without its marks, each block run into the next, as a list's snippet of a body shows it. */
export function plainText(markdown: string): string {
  const parts: string[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "html") return;
    if ("value" in node) parts.push(node.value);
    else if ("children" in node) for (const child of node.children) walk(child);
    if (BLOCKS.has(node.type)) parts.push(" ");
  };
  walk(fromMarkdown(markdown));
  return parts.join("").replace(/\s+/g, " ").trim();
}
