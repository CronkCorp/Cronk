import { useEffect, useState, type RefObject } from "react";

/** Where a run of rendered text starts in the Markdown source, as `CronkMarkdown` with `sourceOffsets` marks it. */
function sourceStartOf(text: Text): number | undefined {
  const start = text.parentElement?.dataset.sourceStart;
  return start === undefined ? undefined : Number(start);
}

/** The first or last run of text with something in it inside `element`. */
function edgeText(element: Element, edge: "first" | "last"): Text | undefined {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let found: Text | undefined;
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    found = walker.currentNode as Text;
    if (edge === "first") break;
  }
  return found;
}

/**
 * Widens a selection's end that sits at the very edge of `text` to take in the markup around it, as
 * `**` around bold, as far out as `text` stays at that edge of each element the markup belongs to.
 */
function widen(text: Text, root: HTMLElement, edge: "first" | "last", at: number): number {
  for (let el = text.parentElement; el && el !== root && root.contains(el); el = el.parentElement) {
    const bound = edge === "first" ? el.dataset.markupStart : el.dataset.markupEnd;
    if (bound === undefined) continue;
    if (edgeText(el, edge) !== text) break;
    at = Number(bound);
  }
  return at;
}

/**
 * The passage of `source` a selection in its rendered form reads from: the Markdown between the
 * selection's ends, markup included, so the API finds it exactly. When an end's place in the
 * Markdown is unknown, the selected text itself, if the Markdown holds it as it is.
 */
export function passageOf(range: Range, root: HTMLElement, source: string): string | undefined {
  if (range.collapsed || !root.contains(range.commonAncestorContainer)) return undefined;
  const texts: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    // Whitespace between blocks, such as between list items, is no text of the Document's own.
    if (walker.currentNode.textContent?.trim() && range.intersectsNode(walker.currentNode)) texts.push(walker.currentNode as Text);
  }
  const first = texts[0];
  const last = texts[texts.length - 1];
  if (first && last) {
    const from = sourceStartOf(first);
    const to = sourceStartOf(last);
    if (from !== undefined && to !== undefined) {
      const startOffset = first === range.startContainer ? range.startOffset : 0;
      const endOffset = last === range.endContainer ? range.endOffset : last.length;
      const start = startOffset === 0 ? widen(first, root, "first", from) : from + startOffset;
      const end = endOffset === last.length ? widen(last, root, "last", to + endOffset) : to + endOffset;
      const passage = source.slice(start, end).trim();
      if (passage) return passage;
    }
  }
  const selected = range.toString().trim();
  return selected && source.includes(selected) ? selected : undefined;
}

/** A passage selected in a rendered Document, and where the selection ends, relative to the rendered root. */
export interface SelectedPassage {
  passage: string;
  top: number;
  left: number;
}

/** The passage of `source` currently selected inside `root`, kept up to date as the selection changes. */
export function useSelectedPassage(root: RefObject<HTMLElement | null>, source: string): SelectedPassage | undefined {
  const [selected, setSelected] = useState<SelectedPassage>();
  useEffect(() => {
    const update = () => {
      const selection = getSelection();
      const el = root.current;
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
      const passage = el && range ? passageOf(range, el, source) : undefined;
      if (!el || !range || !passage) return setSelected(undefined);
      const at = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      setSelected({ passage, top: at.bottom - box.top + 4, left: Math.max(0, at.left - box.left) });
    };
    // A resize moves the selection, so the button that follows it is placed again.
    document.addEventListener("selectionchange", update);
    window.addEventListener("resize", update);
    update();
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("resize", update);
    };
  }, [root, source]);
  return selected;
}
