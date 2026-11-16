#!/usr/bin/env node
// @ts-check
/**
 * Cronk's reference Claude Code hook: converts a Claude Code chat to Markdown in Cronk's turn convention
 * and uploads it as a Transcript (ADR 0013). See "Upload Transcripts from Claude Code" in Cronk's README.
 *
 *   node cronk-transcript.mjs --print <chat.jsonl>   prints the chat as Markdown
 */
import { readFileSync } from "node:fs";

/**
 * @typedef {{ type: string, text?: string, content?: string | Block[], name?: string, input?: unknown, is_error?: boolean }} Block
 * @typedef {{ type?: string, isSidechain?: boolean, isMeta?: boolean, message?: { role?: string, content?: string | Block[] } }} Entry
 */

/**
 * Converts the lines of a Claude Code chat file to Markdown. The same lines always give the same text,
 * and a chat that grows only gains text at the end, so a re-upload continues the stored Transcript.
 * @param {string} jsonl
 * @returns {string}
 */
function toMarkdown(jsonl) {
  /** @type {string[]} */
  const parts = [];
  /** @type {string | undefined} */
  let turn;
  /** @param {string} role @param {string} text */
  const add = (role, text) => {
    if (role !== turn) {
      parts.push(`## ${role}\n`);
      turn = role;
    }
    parts.push(text);
  };
  for (const line of jsonl.split("\n")) {
    const entry = parse(line);
    if (!entry?.message || entry.isSidechain || entry.isMeta) continue;
    const blocks = typeof entry.message.content === "string" ? [{ type: "text", text: entry.message.content }] : (entry.message.content ?? []);
    const role = entry.type === "assistant" ? "Assistant" : entry.type === "user" ? "User" : undefined;
    if (!role) continue;
    for (const block of blocks) {
      if (block.type === "text" && block.text) add(role, block.text);
      else if (block.type === "image") add(role, IMAGE);
      else if (block.type === "tool_use") add("Assistant", fenced(`tool-call ${block.name}`, trimmed(JSON.stringify(block.input ?? {}, null, 2))));
      // A tool's result comes back in a user entry, but belongs to the Assistant's turn that called it.
      else if (block.type === "tool_result") add("Assistant", fenced(block.is_error ? "tool-result error" : "tool-result", trimmed(resultText(block.content))));
    }
  }
  return parts.map((part) => `${part.trimEnd()}\n`).join("\n");
}

/** Tool calls and results longer than this many characters are trimmed to their first `KEEP_START` and last `KEEP_END`. */
const TRIM_OVER = 4000;
const KEEP_START = 3000;
const KEEP_END = 1000;

/**
 * `text`, trimmed when long to its start, where each Cronk tool result names its Agent Session, and its end.
 * @param {string} text
 */
function trimmed(text) {
  if (text.length <= TRIM_OVER) return text;
  // Never split a character made of two UTF-16 units.
  const start = text.slice(0, KEEP_START).replace(/[\uD800-\uDBFF]$/, "");
  const end = text.slice(-KEEP_END).replace(/^[\uDC00-\uDFFF]/, "");
  const marker = `[… ${text.length - start.length - end.length} characters trimmed …]`;
  return `${start}${start.endsWith("\n") ? "" : "\n"}${marker}${end.startsWith("\n") ? "" : "\n"}${end}`;
}

/** What stands in for an image, which a Transcript doesn't carry. */
const IMAGE = "[image]";

/** @param {Block["content"]} content @returns {string} */
function resultText(content) {
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => (block.type === "image" ? IMAGE : (block.text ?? ""))).join("\n");
}

/**
 * `text` as a fenced code block with the info string `info`, its fence longer than any run of backticks in the text.
 * @param {string} info @param {string} text
 */
function fenced(info, text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

/** @param {string} line @returns {Entry | undefined} */
function parse(line) {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === "object" ? entry : undefined;
  } catch {
    // A line Claude Code is still writing, or not JSON at all.
    return undefined;
  }
}

/**
 * Uploads the chat a Claude Code hook event names as the Agent's Transcript of it. Cronk refuses a chat in which
 * none of the Agent's Agent Sessions changed anything yet, which is expected, so that isn't reported.
 * @param {{ session_id?: unknown, transcript_path?: unknown }} event
 * @returns {Promise<string | undefined>} what went wrong, if anything did
 */
async function upload(event) {
  const url = process.env.CRONK_URL;
  const token = process.env.CRONK_TOKEN;
  if (!url || !token) return "Set CRONK_URL and CRONK_TOKEN to upload Transcripts to Cronk";
  if (typeof event.session_id !== "string" || typeof event.transcript_path !== "string") return "The hook event names no chat";
  const markdown = toMarkdown(readFileSync(event.transcript_path, "utf8"));
  if (markdown === "") return undefined;
  const response = await fetch(`${url.replace(/\/+$/, "")}/api/transcripts/by-chat/${encodeURIComponent(event.session_id)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown; charset=utf-8" },
    body: markdown,
  });
  if (response.ok || response.status === 422) return undefined;
  const body = await response.text();
  /** @type {unknown} */
  let error = body;
  try {
    error = JSON.parse(body).error ?? body;
  } catch {
    // Not Cronk's JSON, such as a proxy's error page: report it as it came.
  }
  return `Cronk didn't take the Transcript (${response.status}): ${error}`;
}

/** @returns {Promise<string>} */
async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const [mode, file] = process.argv.slice(2);
if (mode === "--print" && file) {
  process.stdout.write(toMarkdown(readFileSync(file, "utf8")));
} else {
  // A hook: Claude Code passes the event as JSON on stdin. A failure is reported but never blocks Claude (exit code 1, not 2).
  try {
    const problem = await upload(JSON.parse(await readStdin()));
    if (problem) {
      process.stderr.write(`${problem}\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`Uploading the Transcript to Cronk failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
