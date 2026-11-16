/**
 * How Markdown embeds Artifacts, shared by the web client, which shows the embeds, and the server, which answers
 * and records what a body embeds. An Artifact's address standing alone on a line of a paragraph, bare (as text, or
 * as an autolink `<…>` showing its own address), embeds the Artifact: the Version it names, or else the latest.
 * Anywhere else its address is a link. Plain data only, as it ends up in the web bundle.
 */
import type { MarkdownNode, MarkdownPoint } from "./ticket-references.js";

/**
 * An Artifact's address past its origin: `/artifacts/<id>`, with `?version=<n>` for a fixed Version. Any origin
 * counts, since an Artifact keeps its id when an export moves it to another Cronk.
 */
const ADDRESS_PATH = String.raw`\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?version=([1-9][0-9]{0,8}))?`;
const ORIGIN = String.raw`https?:\/\/[^\s/?#]+`;

/** An Artifact's address, `<origin>/artifacts/<id>` with `?version=<n>` for a fixed Version, as text in prose. */
export const ARTIFACT_ADDRESS = new RegExp(String.raw`\b${ORIGIN}${ADDRESS_PATH}(?![\w\-?&=/#])`, "gi");

/** An address alone, with its origin or as a path. */
const WHOLE_ADDRESS = new RegExp(String.raw`^(?:${ORIGIN})?${ADDRESS_PATH}$`, "i");

/** An Artifact embedded, or linked: its id, and the Version the address names, null for the latest. */
export interface ArtifactAt {
  artifactId: string;
  version: number | null;
}

/** The Artifact an address names, if it is an Artifact's address; a path alone (`/artifacts/<id>`) is one too. */
export function artifactAt(address: string): ArtifactAt | undefined {
  const m = WHOLE_ADDRESS.exec(address.trim());
  return m ? { artifactId: m[1]!.toLowerCase(), version: m[2] === undefined ? null : Number(m[2]) } : undefined;
}

/** The key an embed counts once by: its Artifact and the Version it names. */
export const embedKey = (at: ArtifactAt) => `${at.artifactId}@${at.version ?? ""}`;

/** The node a paragraph's line is made of, past white space at its ends, when that is all it holds. */
function soleNode(line: MarkdownNode[]): MarkdownNode | undefined {
  const content = line.filter((n) => !(n.type === "text" && (n.value ?? "").trim() === ""));
  return content.length === 1 ? content[0] : undefined;
}

/** An embed a line of a paragraph makes: the Artifact, and its address as written. */
interface EmbedLine {
  at: ArtifactAt;
  address: string;
}

/** What a line of a paragraph embeds: an Artifact's address alone, bare, as text or an autolink showing it. */
function embeddedBy(line: MarkdownNode[]): EmbedLine | undefined {
  const node = soleNode(line);
  const address = node?.type === "text" ? (node.value ?? "").trim() : node?.type === "link" ? ((node as { url?: string }).url ?? "") : "";
  if (node?.type === "link") {
    const shown = node.children?.length === 1 && node.children[0]!.type === "text" ? node.children[0]!.value : undefined;
    if (shown?.trim() !== address) return undefined;
  }
  const at = artifactAt(address);
  return at && { at, address };
}

/** A point in `source` at `offset`, with its line and column. */
function pointIn(source: string, offset: number): MarkdownPoint {
  const before = source.slice(0, offset);
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n"), offset };
}

/** A line of a paragraph: its nodes, and the break that started it (a soft line break, or a hard `break` node); none for the first. */
interface Line {
  nodes: MarkdownNode[];
  after?: MarkdownNode;
}

/**
 * A paragraph's children split into its lines, at the line breaks inside its text and its hard breaks. With the
 * `source` it was parsed from, each piece of a split text keeps where it sits there, when it is found as written.
 */
function linesOf(paragraph: MarkdownNode, source: string | undefined): Line[] {
  const lines: Line[] = [{ nodes: [] }];
  for (const child of paragraph.children ?? []) {
    if (child.type === "break") {
      lines.push({ nodes: [], after: child });
      continue;
    }
    if (child.type !== "text" || !(child.value ?? "").includes("\n")) {
      lines[lines.length - 1]!.nodes.push(child);
      continue;
    }
    let cursor = child.position?.start.offset;
    const end = child.position?.end.offset;
    child.value!.split("\n").forEach((value, k) => {
      if (k > 0) lines.push({ nodes: [], after: { type: "text", value: "\n" } });
      if (value === "") return;
      const piece: MarkdownNode = { type: "text", value };
      const at = source !== undefined && cursor !== undefined && end !== undefined ? source.indexOf(value, cursor) : -1;
      if (at >= 0 && at + value.length <= end!) {
        piece.position = { start: pointIn(source!, at), end: pointIn(source!, at + value.length) };
        cursor = at + value.length;
      }
      lines[lines.length - 1]!.nodes.push(piece);
    });
  }
  return lines;
}

/**
 * Replaces each paragraph under `node` that holds a line embedding an Artifact with paragraphs of its other lines
 * and, in place of each such line, the node `embed` makes for it (given the address as written); where `embed`
 * makes none, the line stays as it was. Code and HTML are left alone, being no paragraphs; paragraphs in lists and
 * quotes count. With the `source` the tree was parsed from, the text of split paragraphs keeps where it sits there.
 */
export function replaceArtifactEmbeds(
  node: MarkdownNode,
  embed: (at: ArtifactAt, address: string) => MarkdownNode | undefined,
  source?: string,
): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "paragraph") {
      replaceArtifactEmbeds(child, embed, source);
      return [child];
    }
    const lines = linesOf(child, source);
    const made = lines.map((line) => {
      const found = embeddedBy(line.nodes);
      return found && embed(found.at, found.address);
    });
    if (made.every((n) => n === undefined)) return [child];
    const out: MarkdownNode[] = [];
    let run: Line[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const children = run.flatMap((line, k) => (k === 0 || !line.after ? line.nodes : [line.after, ...line.nodes]));
      if (children.some((n) => n.type !== "text" || (n.value ?? "").trim() !== "")) out.push({ type: "paragraph", children });
      run = [];
    };
    lines.forEach((line, k) => {
      const node = made[k];
      if (node === undefined) return void run.push(line);
      flush();
      out.push(node);
    });
    flush();
    return out;
  });
}

/** The Artifacts a parsed Markdown tree embeds, in order, each once (an Artifact at the same Version counting once). */
export function artifactEmbedsIn(tree: MarkdownNode): ArtifactAt[] {
  const found = new Map<string, ArtifactAt>();
  replaceArtifactEmbeds(structuredClone(tree), (at) => {
    if (!found.has(embedKey(at))) found.set(embedKey(at), at);
    return { type: "text", value: "" };
  });
  return [...found.values()];
}
