import { describe, expect, it } from "vitest";
import { alignCodeToSource, type Container } from "../src/web/source-map.js";

/**
 * The Markdown a selection of `code`'s rendered text from character `from` up to character `to` reads
 * from, if the code block, at `code` in `source` inside `containers`, can be tied to it for certain.
 */
function anchor(source: string, value: string, code: { start: number; end: number }, containers: Container[], from: number, to: number) {
  const bounds = alignCodeToSource(value, source, code, containers);
  return bounds && source.slice(bounds.starts[from], bounds.ends[to]);
}

/** Where `text` starts in `source`, failing the test if it isn't there. */
function at(source: string, text: string): number {
  const found = source.indexOf(text);
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}

describe("aligning a code block with its Markdown", () => {
  it("skips a blockquote's marker on every line of fenced code, the first included", () => {
    const source = "> ```\n> one\n> two\n> ```\n";
    const value = "one\ntwo\n";
    const code = { start: at(source, "```"), end: source.lastIndexOf("```") + 3 };
    expect(anchor(source, value, code, [{ kind: "blockquote", start: 0 }], 1, 6)).toBe("ne\n> tw");
  });

  it("skips a list item's content indentation and keeps the code's own leading spaces", () => {
    const source = "- item\n\n  ```\n    nested\n  done\n  ```\n";
    const value = "  nested\ndone\n";
    const code = { start: at(source, "```"), end: source.lastIndexOf("```") + 3 };
    expect(anchor(source, value, code, [{ kind: "listItem", start: 0 }], 0, 13)).toBe("  nested\n  done");
    expect(anchor(source, value, code, [{ kind: "listItem", start: 0 }], 1, 8)).toBe(" nested");
  });

  it("takes an indented code block's four-space indent off each line, past the list item's", () => {
    const source = "1. item\n\n       one\n        two\n";
    const value = "one\n two\n";
    const code = { start: at(source, "    one"), end: source.length - 1 };
    expect(anchor(source, value, code, [{ kind: "listItem", start: 0 }], 1, 8)).toBe("ne\n        two");
  });

  it("skips nested prefixes in order: a list item inside a blockquote, blank code lines included", () => {
    const source = "> Quoted.\n>\n> - item\n>\n>   ```js\n>   one\n>\n>     two\n>   ```\n";
    const value = "one\n\n  two\n";
    const code = { start: at(source, "```"), end: source.lastIndexOf("```") + 3 };
    const containers: Container[] = [{ kind: "blockquote", start: 0 }, { kind: "listItem", start: at(source, "- item") }];
    expect(anchor(source, value, code, containers, 0, 10)).toBe("one\n>\n>     two");
  });

  it("takes up to as many spaces off each line as the fence is indented", () => {
    const source = "  ```\n   one\n two\n  ```\n";
    const code = { start: at(source, "```"), end: source.lastIndexOf("```") + 3 };
    expect(anchor(source, " one\ntwo\n", code, [], 0, 8)).toBe(" one\n two");
  });

  it("reads a fence on a list item's first line", () => {
    const source = "- ```\n  one\n  two\n  ```\n";
    const code = { start: at(source, "```"), end: source.lastIndexOf("```") + 3 };
    expect(anchor(source, "one\ntwo\n", code, [{ kind: "listItem", start: 0 }], 0, 7)).toBe("one\n  two");
  });

  it("ties nothing when a line doesn't carry its prefix as expected", () => {
    // A tab's width depends on its column.
    const tabbed = "- item\n\n  ```\n\tone\n  ```\n";
    const tabbedCode = { start: at(tabbed, "```"), end: tabbed.lastIndexOf("```") + 3 };
    expect(alignCodeToSource("  one\n", tabbed, tabbedCode, [{ kind: "listItem", start: 0 }])).toBeUndefined();
    const tabMarker = "-\titem\n\n  ```\n  one\n  ```\n";
    const tabMarkerCode = { start: at(tabMarker, "```"), end: tabMarker.lastIndexOf("```") + 3 };
    expect(alignCodeToSource("one\n", tabMarker, tabMarkerCode, [{ kind: "listItem", start: 0 }])).toBeUndefined();
    // A container that isn't where it is said to be.
    const unquoted = "```\none\n```\n";
    const unquotedCode = { start: 0, end: unquoted.lastIndexOf("```") + 3 };
    expect(alignCodeToSource("one\n", unquoted, unquotedCode, [{ kind: "blockquote", start: 0 }])).toBeUndefined();
  });
});
