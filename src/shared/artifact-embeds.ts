/**
 * How Markdown embeds Artifacts, shared by the web client, which shows the embeds, and the server, which answers
 * and records what a body embeds. An Artifact's address standing alone on a line of a paragraph, bare (as text, or
 * as an autolink `<…>` showing its own address), embeds the Artifact: the Version it names, or else the latest.
 * Anywhere else its address is a link. Plain data only, as it ends up in the web bundle.
 */
import type { MarkdownNode } from "./ticket-references.js";

/** An Artifact's address, `<origin>/artifacts/<id>` with `?version=<n>` for a fixed Version, as text in prose. */
export const ARTIFACT_ADDRESS =
  /\bhttps?:\/\/[^\s/?#]+\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?version=([1-9][0-9]{0,8}))?(?![\w\-?&=/#])/gi;

/** An Artifact embedded, or linked: its id, and the Version the address names, null for the latest. */
export interface ArtifactAt {
  artifactId: string;
  version: number | null;
}

/** The Artifact an address names, if it is an Artifact's address; a path alone (`/artifacts/<id>`) is one too. */
export function artifactAt(address: string): ArtifactAt | undefined {
  const m = /^(?:https?:\/\/[^\s/?#]+)?\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?version=([1-9][0-9]{0,8}))?$/i.exec(address.trim());
  return m ? { artifactId: m[1]!.toLowerCase(), version: m[2] === undefined ? null : Number(m[2]) } : undefined;
}

/** The node a paragraph's line is made of, past white space at its ends, when that is all it holds. */
function soleNode(line: MarkdownNode[]): MarkdownNode | undefined {
  const content = line.filter((n) => !(n.type === "text" && (n.value ?? "").trim() === ""));
  return content.length === 1 ? content[0] : undefined;
}

/** The Artifact a line of a paragraph embeds: its address alone, bare, as text or an autolink showing it. */
function embeddedBy(line: MarkdownNode[]): ArtifactAt | undefined {
  const node = soleNode(line);
  if (node?.type === "text") return artifactAt(node.value ?? "");
  if (node?.type !== "link") return undefined;
  const url = (node as { url?: string }).url ?? "";
  const shown = node.children?.length === 1 && node.children[0]!.type === "text" ? node.children[0]!.value : undefined;
  return shown !== undefined && shown.trim() === url ? artifactAt(url) : undefined;
}

/** A paragraph's children split into its lines, at the line breaks inside its text; each line's nodes keep their positions where whole. */
function linesOf(paragraph: MarkdownNode): MarkdownNode[][] {
  const lines: MarkdownNode[][] = [[]];
  for (const child of paragraph.children ?? []) {
    if (child.type === "break") {
      lines.push([]);
      continue;
    }
    if (child.type !== "text" || !(child.value ?? "").includes("\n")) {
      lines[lines.length - 1]!.push(child);
      continue;
    }
    const parts = child.value!.split("\n");
    parts.forEach((value, k) => {
      if (k > 0) lines.push([]);
      if (value !== "") lines[lines.length - 1]!.push({ type: "text", value });
    });
  }
  return lines;
}

/**
 * Replaces each paragraph under `node` that holds a line embedding an Artifact with paragraphs of its other lines
 * and, in place of each such line, the node `embed` makes for it. Code, quotes and HTML are left alone, being
 * no paragraphs; paragraphs in lists and quotes count.
 */
export function replaceArtifactEmbeds(node: MarkdownNode, embed: (at: ArtifactAt) => MarkdownNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "paragraph") {
      replaceArtifactEmbeds(child, embed);
      return [child];
    }
    const lines = linesOf(child);
    const found = lines.map(embeddedBy);
    if (found.every((at) => at === undefined)) return [child];
    const out: MarkdownNode[] = [];
    let run: MarkdownNode[][] = [];
    const flush = () => {
      if (run.length === 0) return;
      const children = run.flatMap((line, k) => (k === 0 ? line : [{ type: "text", value: "\n" }, ...line]));
      if (children.some((n) => n.type !== "text" || (n.value ?? "").trim() !== "")) out.push({ type: "paragraph", children });
      run = [];
    };
    lines.forEach((line, k) => {
      const at = found[k];
      if (at === undefined) return void run.push(line);
      flush();
      out.push(embed(at));
    });
    flush();
    return out;
  });
}

/** The Artifacts a parsed Markdown tree embeds, in order, each once (an Artifact at the same Version counting once). */
export function artifactEmbedsIn(tree: MarkdownNode): ArtifactAt[] {
  const found = new Map<string, ArtifactAt>();
  replaceArtifactEmbeds(structuredClone(tree), (at) => {
    found.set(`${at.artifactId}@${at.version ?? ""}`, at);
    return { type: "text", value: "" };
  });
  return [...found.values()];
}
