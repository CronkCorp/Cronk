#!/usr/bin/env node
// @ts-check
/**
 * Cronk's reference Claude Code hook: converts a Claude Code chat to Markdown in Cronk's turn convention
 * and uploads it as a Transcript (ADR 0013). See "Upload Transcripts from Claude Code" in Cronk's README.
 *
 *   node cronk-transcript.mjs --print <chat.jsonl>   prints the chat as Markdown
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {{ type: string, text?: string, content?: string | Block[], name?: string, id?: string, tool_use_id?: string, input?: unknown, is_error?: boolean }} Block
 * @typedef {{ type?: string, isSidechain?: boolean, isMeta?: boolean, isCompactSummary?: boolean, agentId?: string, toolUseResult?: unknown, message?: { role?: string, content?: string | Block[] } }} Entry
 * @typedef {{ chat: string, toolUseId?: string }} Subagent a subagent's chat file, and the id of the tool call that launched it
 * @typedef {{ chats: Map<string, Entry[]>, agentByToolUse: Map<string, string>, placed: Set<string> }} SubagentPlacement
 *   the subagents' chats by agentId, the agentIds their meta files give the tool calls that launched them, and those already placed
 */

/**
 * Converts the lines of a Claude Code chat file to Markdown, with each subagent's chat in a `subagent <agentId>` block
 * where its parent learned it finished. The same lines always give the same text, and a chat or subagent that grows
 * only gains text at the end, so a re-upload continues the stored Transcript.
 * @param {string} jsonl the main chat
 * @param {Record<string, Subagent>} [subagents] the subagents' chat files, by agentId
 * @returns {string}
 */
function toMarkdown(jsonl, subagents = {}) {
  const entries = parseChat(jsonl);
  // Older Claude Code wrote subagents' chats into the main file as side-chain entries, each tagged with its agentId.
  /** @type {Map<string, Entry[]>} */
  const chats = new Map();
  for (const entry of entries) {
    if (!entry.isSidechain || typeof entry.agentId !== "string" || Object.hasOwn(subagents, entry.agentId)) continue;
    chats.set(entry.agentId, [...(chats.get(entry.agentId) ?? []), entry]);
  }
  /** @type {Map<string, string>} */
  const agentByToolUse = new Map();
  for (const [agentId, subagent] of Object.entries(subagents)) {
    chats.set(agentId, parseChat(subagent.chat));
    if (subagent.toolUseId) agentByToolUse.set(subagent.toolUseId, agentId);
  }
  const mainChat = entries.filter((entry) => !entry.isSidechain);
  return chatMarkdown(mainChat, { chats, agentByToolUse, placed: new Set() });
}

/**
 * One chat's entries as Markdown, with the chats of the subagents it learned finished, each placed once.
 * @param {Entry[]} entries @param {SubagentPlacement} subagents
 * @returns {string}
 */
function chatMarkdown(entries, subagents) {
  /** @type {string[]} */
  const parts = [];
  /** @type {string | undefined} */
  let currentRole;
  /** Appends `text` to the chat, in a new turn when it isn't `role`'s. @param {string} role @param {string} text */
  const append = (role, text) => {
    if (role !== currentRole) {
      parts.push(`## ${role}\n`);
      currentRole = role;
    }
    parts.push(text);
  };
  /** @type {Set<string>} The tool calls this chat made, which its subagents' completions must name. */
  const toolUses = new Set();
  /** Appends the chat of the subagent `agentId`, unless it's missing or already placed. @param {string} agentId */
  const placeSubagent = (agentId) => {
    const chat = subagents.chats.get(agentId);
    if (!chat || subagents.placed.has(agentId)) return;
    subagents.placed.add(agentId);
    append("Assistant", fenced(`subagent ${agentId}`, chatMarkdown(chat, subagents)));
  };
  for (const entry of entries) {
    // Left out: what Claude Code adds itself, such as the summary that continues a compacted chat.
    if (!entry.message || entry.isMeta || entry.isCompactSummary) continue;
    const blocks = typeof entry.message.content === "string" ? [{ type: "text", text: entry.message.content }] : (entry.message.content ?? []);
    const role = entry.type === "assistant" ? "Assistant" : entry.type === "user" ? "User" : undefined;
    if (!role) continue;
    for (const block of blocks) {
      if (block.type === "text") {
        const completed = role === "User" ? completedSubagent(block.text ?? "") : undefined;
        if (completed && toolUses.has(completed.toolUseId)) placeSubagent(completed.agentId);
        const text = role === "User" ? typedByUser(block.text ?? "") : block.text;
        if (text) append(role, text);
      } else if (block.type === "image") append(role, IMAGE);
      else if (block.type === "tool_use") {
        if (block.id) toolUses.add(block.id);
        append("Assistant", fenced(`tool-call ${block.name}`, trimmed(JSON.stringify(block.input ?? {}, null, 2))));
      }
      // A tool's result comes back in a user entry, but belongs to the Assistant's turn that called it.
      else if (block.type === "tool_result") {
        append("Assistant", fenced(block.is_error ? "tool-result error" : "tool-result", trimmed(resultText(block.content))));
        // A foreground subagent has finished when its result comes back; a background one has only launched.
        const result = /** @type {{ agentId?: unknown, status?: unknown } | undefined} */ (entry.toolUseResult);
        const agentId = typeof result?.agentId === "string" ? result.agentId : subagents.agentByToolUse.get(block.tool_use_id ?? "");
        if (agentId && result?.status !== "async_launched") placeSubagent(agentId);
      }
    }
  }
  return parts.map((part) => `${part.trimEnd()}\n`).join("\n");
}

/**
 * The background subagent whose completion a user entry's `text` notifies, if it's such a notification.
 * @param {string} text
 * @returns {{ agentId: string, toolUseId: string } | undefined}
 */
function completedSubagent(text) {
  if (!text.startsWith("<task-notification>")) return undefined;
  const agentId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
  return agentId && toolUseId ? { agentId, toolUseId } : undefined;
}

/**
 * Converts the chat file at `path` to Markdown, with its subagents' chats from the `subagents/` folder Claude Code keeps
 * beside it, at `<session id>/subagents/agent-<agentId>.jsonl`.
 * @param {string} path
 */
function convertChat(path) {
  return toMarkdown(readFileSync(path, "utf8"), readSubagents(join(path.replace(/\.jsonl$/, ""), "subagents")));
}

/**
 * The subagents' chat files in `dir`, by agentId. A missing or unreadable folder or file leaves those subagents out.
 * @param {string} dir
 * @returns {Record<string, Subagent>}
 */
function readSubagents(dir) {
  /** @type {Record<string, Subagent>} */
  const subagents = {};
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return subagents;
  }
  for (const name of names.sort()) {
    const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1];
    if (!agentId) continue;
    try {
      subagents[agentId] = { chat: readFileSync(join(dir, name), "utf8") };
    } catch {
      continue;
    }
    try {
      const toolUseId = JSON.parse(readFileSync(join(dir, `agent-${agentId}.meta.json`), "utf8")).toolUseId;
      if (typeof toolUseId === "string") subagents[agentId].toolUseId = toolUseId;
    } catch {
      // No meta file: its launching tool call is known only from the chat.
    }
  }
  return subagents;
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

/**
 * What the User typed, from a user entry's `text`: a slash or shell command as typed, and nothing for what Claude Code
 * itself adds as the User, such as a command's output or a background task's notification.
 * @param {string} text
 * @returns {string | undefined}
 */
function typedByUser(text) {
  const command = /^<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) return [command[1], /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]].filter(Boolean).join(" ");
  const shell = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(text);
  if (shell) return `! ${shell[1]?.trim()}`;
  if (/^<(local-command-stdout|bash-stdout|bash-stderr|task-notification)>/.test(text)) return undefined;
  return text;
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

/** The entries of a chat file's lines, leaving out those that aren't entries. @param {string} jsonl @returns {Entry[]} */
function parseChat(jsonl) {
  return jsonl.split("\n").flatMap((line) => parseEntry(line) ?? []);
}

/** @param {string} line @returns {Entry | undefined} */
function parseEntry(line) {
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
  const markdown = convertChat(event.transcript_path);
  if (markdown === "") return undefined;
  const response = await fetch(`${url.replace(/\/+$/, "")}/api/transcripts/by-chat/${encodeURIComponent(event.session_id)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown; charset=utf-8" },
    body: markdown,
    // An unreachable Cronk mustn't hold Claude Code up for long.
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
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

/** How long an upload may take before the hook gives up on it. */
const UPLOAD_TIMEOUT_MS = 20_000;

/** @returns {Promise<string>} */
async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const [mode, file] = process.argv.slice(2);
if (mode === "--print") {
  if (file) process.stdout.write(convertChat(file));
  else {
    process.stderr.write("Usage: node cronk-transcript.mjs --print <chat.jsonl>, or run it as a Claude Code hook\n");
    process.exitCode = 1;
  }
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
