/**
 * How Markdown refers to Tickets, shared by the web client, which links the references,
 * and the server, which records the Documents that make them. Plain data only, as it ends
 * up in the web bundle.
 */

/** A Ticket key such as `CRONK-12`, as it appears in prose. */
export const TICKET_REFERENCE = /\b([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,8})\b/g;

/** Markdown nodes whose text must stay as written, so references in them are never links: existing links and their kin. */
const NOT_LINKED = new Set(["link", "linkReference", "definition"]);

/** A Markdown (mdast) node, as far as finding Ticket references needs it. */
export interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  /** Where the node sits in the Markdown it was parsed from, when the parser recorded it. */
  position?: { start: MarkdownPoint; end: MarkdownPoint };
}

/** A place in Markdown source, as the parser records it. */
export interface MarkdownPoint {
  line: number;
  column: number;
  offset?: number;
}

/**
 * Replaces each text node under `node` whose Ticket keys count as references with the nodes
 * `replace` makes of its text (the node is passed too, for its position). Code isn't text in the tree, and text inside links is left alone.
 */
export function replaceReferenceText(node: MarkdownNode, replace: (text: string, node: MarkdownNode) => MarkdownNode[]): void {
  if (!node.children || NOT_LINKED.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text") return replace(child.value ?? "", child);
    replaceReferenceText(child, replace);
    return [child];
  });
}
