import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { connectMcp, delegatedSetup } from "./harness.js";

/** The reference Claude Code hook, run as a script just as Claude Code runs it. */
const HOOK = fileURLToPath(new URL("../hooks/claude-code/cronk-transcript.mjs", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/claude-code/${name}`, import.meta.url));

/** Runs the hook as Claude Code does when a chat stops, with `event` on stdin and `env` added to the environment. */
function runHook(event: object, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

/** Converts the Claude Code chat file `jsonl` with the hook's `--print` mode, returning what it prints. */
async function convert(jsonl: string): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [HOOK, "--print", jsonl]);
  return stdout;
}

describe("The reference Claude Code Transcript hook", () => {
  it("converts a chat's text to User and Assistant turns, leaving out reasoning, side chats and Claude Code's own entries", async () => {
    expect(await convert(fixture("text-only.jsonl"))).toBe(await readFile(fixture("text-only.md"), "utf8"));
  });

  it("puts tool calls and their results in the Assistant's turn as fenced blocks, fenced past any backticks they hold", async () => {
    expect(await convert(fixture("tools.jsonl"))).toBe(await readFile(fixture("tools.md"), "utf8"));
  });

  it("trims long tool calls and results to their start, where a Cronk result names its Agent Session, and their end", async () => {
    expect(await convert(fixture("long-output.jsonl"))).toBe(await readFile(fixture("long-output.md"), "utf8"));
  });

  it("shows slash and shell commands as the User typed them, leaving out what Claude Code adds: their output, notifications and summaries", async () => {
    expect(await convert(fixture("claude-code-entries.jsonl"))).toBe(await readFile(fixture("claude-code-entries.md"), "utf8"));
  });

  it("puts each subagent's chat in the Assistant's turn where its parent learns it finished, once, nested ones inside their parent's", async () => {
    // Foreground (at its result), background (at its completion notification), nested, and an older side chain in the
    // main file; one claimed subagent's file is missing and one file no chat claims.
    expect(await convert(fixture("subagents.jsonl"))).toBe(await readFile(fixture("subagents.md"), "utf8"));
  });

  it("says how to use it when asked to print without a chat file", async () => {
    const ran = await promisify(execFile)(process.execPath, [HOOK, "--print"]).catch((err) => err);
    expect(ran).toMatchObject({ code: 1, stderr: expect.stringMatching(/--print <chat.jsonl>/) });
  });

  it("converts the same chat to the same text every run, and a chat that grows to text that continues it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cronk-hook-"));
    for (const name of ["text-only.jsonl", "tools.jsonl", "long-output.jsonl", "claude-code-entries.jsonl"]) {
      const whole = await convert(fixture(name));
      expect(await convert(fixture(name)), name).toBe(whole);
      // Claude Code appends to the chat file as the chat goes on, so each earlier upload saw only its first lines.
      const lines = (await readFile(fixture(name), "utf8")).split("\n");
      for (let n = 1; n < lines.length; n++) {
        const partial = join(dir, `${n}-${name}`);
        await writeFile(partial, lines.slice(0, n).join("\n"));
        expect(whole.startsWith(await convert(partial)), `${name}, first ${n} lines`).toBe(true);
      }
    }
  });

  it("uploads the chat as the Agent's Transcript, keyed by Claude Code's session id, when the chat stops", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    // The Agent claims its Ticket and logs its plan through Cronk's MCP server, as Claude Code would call it.
    const mcp = await connectMcp(cronk, claude.secret);
    const call = async (name: string, args: object) => ((await mcp.client.callTool({ name, arguments: { ...args } })) as { content: unknown[] }).content;
    await call("tickets", { action: "claim", key: "CRONK-1" });
    const logged = await call("activities", { action: "log", key: "CRONK-1", kind: "plan", body: "Fix the sign-in form." });
    const dir = await mkdtemp(join(tmpdir(), "cronk-hook-"));
    const chat = join(dir, "chat.jsonl");
    const entries = [
      { type: "user", message: { role: "user", content: "Pick up CRONK-1." } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__cronk__activities", input: { action: "log", key: "CRONK-1", kind: "plan" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: logged }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Planned CRONK-1." }] } },
    ];
    await writeFile(chat, entries.map((entry) => JSON.stringify(entry) + "\n").join(""));

    const ran = await runHook(
      { session_id: "claude-chat-1", transcript_path: chat, hook_event_name: "Stop", stop_hook_active: false },
      { CRONK_URL: await cronk.url(), CRONK_TOKEN: claude.secret },
    );
    expect(ran, ran.stderr).toMatchObject({ code: 0 });

    const listed = (await admin.get("/api/transcripts")).body.transcripts;
    expect(listed).toHaveLength(1);
    const transcript = (await admin.get(`/api/transcripts/${listed[0].id}`)).body.transcript;
    expect(transcript).toMatchObject({ chatId: "claude-chat-1", markdown: await convert(chat), tickets: [{ key: "CRONK-1" }] });
    expect(transcript.markdown).toContain("## User\n\nPick up CRONK-1.\n");
  });

  it("stays quiet about a chat that changed nothing yet, and reports what keeps any other upload out without blocking Claude", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const event = { session_id: "claude-chat-1", transcript_path: fixture("text-only.jsonl"), hook_event_name: "Stop" };
    const url = await cronk.url();

    expect(await runHook(event, { CRONK_URL: url, CRONK_TOKEN: claude.secret })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect((await admin.get("/api/transcripts")).body.transcripts).toEqual([]);

    // Exit code 1 shows Claude Code's user the problem; 2 would stop Claude from stopping.
    const unset = await runHook(event, { CRONK_URL: "", CRONK_TOKEN: "" });
    expect(unset).toMatchObject({ code: 1, stderr: expect.stringMatching(/Set CRONK_URL and CRONK_TOKEN/) });
    const badToken = await runHook(event, { CRONK_URL: url, CRONK_TOKEN: "not-a-token" });
    expect(badToken).toMatchObject({ code: 1, stderr: expect.stringMatching(/Cronk didn't take the Transcript \(401\)/) });
  });
});
