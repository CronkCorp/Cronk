import { describe, expect, it } from "vitest";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnection } from "./harness.js";
import { connectMcp, delegatedSetup, projectWithTickets, registerAgent, startInstalledCronk } from "./harness.js";

/** A tool's raw result: whether it is an error, and the text of each content item. */
async function rawResult(mcp: McpConnection, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; texts: string[] }> {
  const result = (await mcp.client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: result.isError ?? false, texts: result.content.map((c) => c.text) };
}

/**
 * Calls a tool and returns its result: the API's answer parsed from the text after the leading
 * Agent Session id, and whether it is an error.
 */
async function callTool(mcp: McpConnection, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any }> {
  const { isError, texts } = await rawResult(mcp, name, args);
  expect(texts).toHaveLength(2);
  expect(texts[0]).toBe(`Agent Session ${mcp.transport.sessionId}`);
  return { isError, body: isError ? texts[1] : JSON.parse(texts[1]!) };
}

describe("every MCP tool result", () => {
  it("starts with the calling Agent Session's id, ahead of the API's unchanged JSON", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "v1" })).body.document;
    const mcp = await connectMcp(cronk, claude.secret);
    const named = `Agent Session ${mcp.transport.sessionId}`;

    for (const [name, args, url] of [
      ["tickets", { action: "get", key: "CRONK-1" }, "/api/tickets/CRONK-1"],
      ["activities", { action: "list", key: "CRONK-1" }, "/api/tickets/CRONK-1/activities"],
      ["comments", { action: "list", key: "CRONK-1" }, "/api/tickets/CRONK-1/comments"],
      ["documents", { action: "get", id: doc.id }, `/api/documents/${doc.id}`],
      ["guidance", { action: "get" }, "/api/workspace/guidance"],
      ["search", { query: "plan" }, "/api/search?q=plan"],
    ] as const) {
      const { isError, texts } = await rawResult(mcp, name, args);
      expect({ name, isError, first: texts[0] }).toEqual({ name, isError: false, first: named });
      expect(JSON.parse(texts[1]!)).toEqual((await admin.get(url)).body);
    }
  });

  it("starts with the calling Agent Session's id when the call fails, however it fails", async () => {
    const { cronk, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret);
    const named = `Agent Session ${mcp.transport.sessionId}`;

    // The API refuses it.
    expect(await rawResult(mcp, "tickets", { action: "get", key: "CRONK-404" })).toEqual({ isError: true, texts: [named, "No such Ticket"] });
    // The Agent left out a parameter the action needs.
    expect(await rawResult(mcp, "tickets", { action: "get" })).toEqual({ isError: true, texts: [named, "The get action needs a key"] });
    // The tool itself throws: a lone surrogate can't be put in a URL.
    expect(await rawResult(mcp, "tickets", { action: "get", key: "\uD800" })).toEqual({ isError: true, texts: [named, "URI malformed"] });
  });

  it("names the Agent Session that made the call, so two Sessions each see their own", async () => {
    const { cronk, claude } = await delegatedSetup();
    const first = await connectMcp(cronk, claude.secret);
    const second = await connectMcp(cronk, claude.secret);

    expect((await rawResult(first, "guidance", { action: "get" })).texts[0]).toBe(`Agent Session ${first.transport.sessionId}`);
    expect((await rawResult(second, "guidance", { action: "get" })).texts[0]).toBe(`Agent Session ${second.transport.sessionId}`);
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
  });
});

describe("the MCP endpoint", () => {
  it("starts an Agent Session for an Agent token and welcomes it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");

    const mcp = await connectMcp(cronk, claude.secret);

    expect(mcp.client.getInstructions()).toContain("claude-laptop");
    expect(mcp.client.getInstructions()).toContain("Acme");
    expect(mcp.client.getInstructions()).toContain(
      "Claiming a Ticket gives you its parent, Sub-Tickets, related Tickets, Reports, Linked Documents and the Documents that mention it.",
    );
    const [agent] = (await admin.get("/api/agents")).body.agents;
    expect(agent.sessions).toEqual([expect.objectContaining({ id: mcp.transport.sessionId, startedAt: "2026-01-01T09:00:00.000Z" })]);
  });

  it("welcomes it with the Workspace's Guidance, then each Project's", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 0);
    await projectWithTickets(admin, "DOCS", 0);
    await admin.put("/api/workspace/guidance", { markdown: "Always write tests first.", baseVersion: 0 });
    await admin.put("/api/projects/CRONK/guidance", { markdown: "Use pnpm, never npm.", baseVersion: 0 });
    await admin.put("/api/projects/DOCS/guidance", { markdown: "Write in British English.", baseVersion: 0 });

    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop")).secret);

    const instructions = mcp.client.getInstructions()!;
    const at = (text: string) => instructions.indexOf(text);
    expect(at("Always write tests first.")).toBeGreaterThan(-1);
    expect(at("Use pnpm, never npm.")).toBeGreaterThan(at("Always write tests first."));
    expect(at("Write in British English.")).toBeGreaterThan(at("Use pnpm, never npm."));
  });

  it("ends the Agent Session when the client disconnects", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    const first = await connectMcp(cronk, claude.secret);
    const second = await connectMcp(cronk, claude.secret);

    await first.disconnect();

    const [agent] = (await admin.get("/api/agents")).body.agents;
    expect(agent.sessions.map((s: { id: string }) => s.id)).toEqual([second.transport.sessionId]);
  });

  it("ends the Agent Session once it stays silent past the silence threshold, and refuses it afterwards", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    const mcp = await connectMcp(cronk, claude.secret);
    const liveSessions = async () => (await admin.get("/api/agents")).body.agents[0].sessions.map((s: { id: string }) => s.id);

    cronk.clock.advance(4 * 60_000);
    await mcp.client.ping();
    cronk.clock.advance(4 * 60_000);
    // A heartbeat now, as a timer firing late would run, doesn't refresh it: connectMcp's client
    // isn't listening, so it holds no stream for the heartbeat to refresh the Session through.
    await cronk.heartbeat();
    expect(await liveSessions()).toEqual([mcp.transport.sessionId]);

    cronk.clock.advance(60_000);
    expect(await liveSessions()).toEqual([]);
    await expect(mcp.client.ping()).rejects.toMatchObject({ code: 404, message: expect.stringContaining("Agent Session has ended") });
  });

  it("keeps the Agent Session of a client listening for notifications alive while it stays idle past the silence threshold", async () => {
    const { cronk, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret, { listening: true });
    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });

    // 12 minutes pass, each four of them ending in the stream's heartbeat.
    for (let i = 0; i < 3; i++) {
      cronk.clock.advance(4 * 60_000);
      await cronk.heartbeat();
    }

    const logged = await callTool(mcp, "activities", { action: "log", key: "CRONK-1", kind: "progress", body: "Still here." });
    expect(logged).toMatchObject({ isError: false, body: { activity: { session: { id: mcp.transport.sessionId } } } });
  });

  it("ends the Agent Session of a client that stops listening without disconnecting, as on a crash, after the silence threshold", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    const mcp = await connectMcp(cronk, claude.secret, { listening: true });
    const liveSessions = async () => (await admin.get("/api/agents")).body.agents[0].sessions.map((s: { id: string }) => s.id);

    const sessionId = mcp.transport.sessionId;
    await mcp.client.close();
    await cronk.heartbeat();
    cronk.clock.advance(4 * 60_000);
    await cronk.heartbeat();
    expect(await liveSessions()).toEqual([sessionId]);
    cronk.clock.advance(60_000);
    expect(await liveSessions()).toEqual([]);
  });

  it("refuses unknown tokens, and a token as soon as it is revoked", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await expect(connectMcp(cronk, "not-a-token")).rejects.toMatchObject({ code: 401 });

    const claude = await registerAgent(admin, "claude-laptop");
    const mcp = await connectMcp(cronk, claude.secret);
    await admin.delete(`/api/agents/${claude.agentId}/tokens/${claude.tokenId}`);
    await expect(mcp.client.ping()).rejects.toMatchObject({ code: 401 });
    expect((await admin.get("/api/agents")).body.agents[0].sessions).toEqual([]);
  });

  it("ends an Agent Session it no longer holds, as after a restart, when its client comes back", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    const mcp = await connectMcp(cronk, claude.secret);
    await mcp.client.close();
    await cronk.restart();

    const res = await fetch(new URL("/mcp", await cronk.url()), {
      method: "POST",
      headers: {
        authorization: `Bearer ${claude.secret}`,
        "mcp-session-id": mcp.transport.sessionId!,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(404);
    expect((await admin.get("/api/agents")).body.agents[0].sessions).toEqual([]);
  });
});

describe("an MCP session", () => {
  it("answers only the token that opened it, and is left alone by others naming it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    const codex = await registerAgent(admin, "codex");
    const mcp = await connectMcp(cronk, claude.secret);
    const otherToken = (await admin.post(`/api/agents/${claude.agentId}/tokens`, { readOnly: true })).body.secret;

    for (const token of [codex.secret, otherToken]) {
      const res = await fetch(new URL("/mcp", await cronk.url()), {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, "mcp-session-id": mcp.transport.sessionId! },
      });
      expect(res.status).toBe(404);
    }

    await mcp.client.ping();
    const [agent] = (await admin.get("/api/agents")).body.agents;
    expect(agent.sessions.map((s: { id: string }) => s.id)).toEqual([mcp.transport.sessionId]);
  });
});

describe("the tickets tool", () => {
  it("lists a Project's Tickets and gets one, through the API's access rules", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 2);
    await projectWithTickets(admin, "SECRET", 1);
    await admin.patch("/api/projects/SECRET", { agentAccess: "none" });
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop")).secret);

    const listed = await callTool(mcp, "tickets", { action: "list", project: "CRONK" });
    expect(listed.body.tickets.map((t: { key: string }) => t.key)).toEqual(["CRONK-1", "CRONK-2"]);
    const got = await callTool(mcp, "tickets", { action: "get", key: "CRONK-2" });
    expect(got.body.ticket).toMatchObject({ key: "CRONK-2", title: "Ticket 2" });

    expect(await callTool(mcp, "tickets", { action: "get", key: "SECRET-1" })).toEqual({ isError: true, body: "No such Ticket" });
    expect(await callTool(mcp, "tickets", { action: "list", project: "SECRET" })).toEqual({ isError: true, body: "No such Project" });
    expect(await callTool(mcp, "tickets", { action: "get" })).toEqual({ isError: true, body: "The get action needs a key" });
  });

  it("offers a read-only token only the actions that read", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);

    expect(mcp.client.getInstructions()).toContain("read-only");
    const { tools } = await mcp.client.listTools();
    const tickets = tools.find((t) => t.name === "tickets");
    expect(tickets?.inputSchema.properties?.action).toMatchObject({ enum: ["list", "get"] });
    expect((await callTool(mcp, "tickets", { action: "get", key: "CRONK-1" })).body.ticket.key).toBe("CRONK-1");
  });

  it("filters the list as the API does", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 3);
    await admin.patch("/api/tickets/CRONK-2", { priority: "high", labels: ["ui"] });
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop")).secret);

    const listed = await callTool(mcp, "tickets", { action: "list", project: "CRONK", priority: ["high"], label: ["UI"] });
    expect(listed.body.tickets.map((t: { key: string }) => t.key)).toEqual(["CRONK-2"]);
  });

  it("filters the list by Delegate, so an Agent can find what is delegated to it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 3);
    const adaId = (await admin.get("/api/me")).body.user.id;
    const claude = await registerAgent(admin, "claude-laptop");
    await admin.patch("/api/tickets/CRONK-3", { assigneeId: adaId, delegateId: claude.agentId });
    const mcp = await connectMcp(cronk, claude.secret);

    const listed = await callTool(mcp, "tickets", { action: "list", project: "CRONK", delegate: [claude.agentId] });
    expect(listed.body.tickets.map((t: { key: string }) => t.key)).toEqual(["CRONK-3"]);
  });
});

describe("the guidance tool", () => {
  it("fetches the Workspace's Guidance, or a Project's, through the API's access rules", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 0);
    await projectWithTickets(admin, "SECRET", 0);
    await admin.patch("/api/projects/SECRET", { agentAccess: "none" });
    await admin.put("/api/workspace/guidance", { markdown: "Always write tests first.", baseVersion: 0 });
    await admin.put("/api/projects/CRONK/guidance", { markdown: "Use pnpm, never npm.", baseVersion: 0 });
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);

    expect((await callTool(mcp, "guidance", { action: "get" })).body).toEqual({ guidance: { markdown: "Always write tests first.", version: 1 } });
    expect((await callTool(mcp, "guidance", { action: "get", project: "cronk" })).body).toEqual({ guidance: { markdown: "Use pnpm, never npm.", version: 1 } });
    expect(await callTool(mcp, "guidance", { action: "get", project: "SECRET" })).toEqual({ isError: true, body: "No such Project" });
  });
});

describe("the decisions tool", () => {
  it("lists and gets Decisions of the Workspace or a Project through the API's access rules", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 0);
    await projectWithTickets(admin, "SECRET", 0);
    await admin.patch("/api/projects/SECRET", { agentAccess: "none" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Postgres", body: "We use Postgres.", group: "Storage" });
    await admin.post("/api/projects/CRONK/decisions", { title: "SQLite" });
    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    await admin.post("/api/workspace/decisions", { title: "Compose for installs" });
    await admin.post("/api/projects/SECRET/decisions", { title: "Hush" });
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);

    const listed = await callTool(mcp, "decisions", { action: "list", project: "CRONK", status: ["accepted"] });
    expect(listed.body.decisions.map((d: { key: string }) => d.key)).toEqual(["CRONK-D1"]);
    expect((await callTool(mcp, "decisions", { action: "list" })).body.decisions.map((d: { key: string }) => d.key)).toEqual(["D1"]);
    expect((await callTool(mcp, "decisions", { action: "list", project: "CRONK", group: ["storage"] })).body.decisions).toHaveLength(1);
    expect((await callTool(mcp, "decisions", { action: "get", key: "cronk-d1" })).body.decision).toMatchObject({
      key: "CRONK-D1",
      status: "accepted",
      body: "We use Postgres.",
    });
    expect(await callTool(mcp, "decisions", { action: "get", key: "SECRET-D1" })).toEqual({ isError: true, body: "No such Decision" });
    expect(await callTool(mcp, "decisions", { action: "get" })).toEqual({ isError: true, body: "The get action needs a key" });
  });
  it("proposes Decisions, from the Ticket the Agent holds the Claim on, and refines them only while proposed", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret);
    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });

    const proposed = await callTool(mcp, "decisions", { action: "propose", project: "CRONK", title: "Markdown for Decisions", body: "v1", group: "Storage" });
    expect(proposed.body.decision).toMatchObject({ key: "CRONK-D1", status: "proposed", group: "Storage", sourceTicket: { key: "CRONK-1" } });
    expect((await callTool(mcp, "decisions", { action: "propose", title: "Compose for installs" })).body.decision.key).toBe("D1");
    const refined = await callTool(mcp, "decisions", { action: "update", key: "CRONK-D1", baseVersion: 1, body: "v2" });
    expect(refined.body.decision).toMatchObject({ body: "v2", version: 2 });
    expect(await callTool(mcp, "decisions", { action: "update", key: "CRONK-D1", body: "v3" })).toEqual({ isError: true, body: "The update action needs a baseVersion" });

    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    const refused = await callTool(mcp, "decisions", { action: "update", key: "CRONK-D1", baseVersion: 3, body: "v3" });
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatch(/only while it is proposed/);
  });

  it("offers a read-only token only list and get", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);
    const { tools } = await mcp.client.listTools();
    const action = tools.find((t) => t.name === "decisions")!.inputSchema.properties!.action as { enum: string[] };
    expect(action.enum).toEqual(["list", "get"]);
  });

  it("welcomes the Agent with the reason a User rejected a Decision it proposed", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const first = await connectMcp(cronk, claude.secret);
    await callTool(first, "decisions", { action: "propose", title: "Compose for installs" });
    await first.disconnect();
    await admin.post("/api/decisions/D1/status", { status: "rejected", reason: "We ship a single binary.\nCompose is too much." });

    const instructions = (await connectMcp(cronk, claude.secret)).client.getInstructions()!;
    expect(instructions).toContain("- D1: Compose for installs: Ada rejected it, which you proposed, saying why:\n  > We ship a single binary.\n  > Compose is too much.");
  });
});

describe("the terms tool", () => {
  it("lists the Terms that apply in a Project or the Workspace, and gets one by name or id", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 0);
    const ticket = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." })).body.term;
    await admin.post("/api/workspace/terms", { name: "Customer", definition: "A paying organization." });
    await admin.post("/api/projects/CRONK/terms", { name: "Customer", definition: "A billing account." });
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);

    expect((await callTool(mcp, "terms", { action: "list" })).body).toEqual((await admin.get("/api/workspace/terms")).body);
    expect((await callTool(mcp, "terms", { action: "list", project: "cronk" })).body).toEqual((await admin.get("/api/projects/CRONK/terms")).body);
    expect((await callTool(mcp, "terms", { action: "get", name: "customer", project: "CRONK" })).body.term.definition).toBe("A billing account.");
    expect((await callTool(mcp, "terms", { action: "get", name: "customer" })).body.term.definition).toBe("A paying organization.");
    expect((await callTool(mcp, "terms", { action: "get", id: ticket.id })).body).toEqual((await admin.get(`/api/terms/${ticket.id}`)).body);
    expect(await callTool(mcp, "terms", { action: "get", name: "Board", project: "CRONK" })).toEqual({ isError: true, body: "No Term named Board applies in CRONK" });
    expect(await callTool(mcp, "terms", { action: "get" })).toEqual({ isError: true, body: "The get action needs a name or an id" });
  });

  it("is named in the welcome: the Workspace's Term names, then each Project's own", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 0);
    await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." });
    await admin.post("/api/workspace/terms", { name: "Customer", definition: "A paying organization." });
    await admin.post("/api/projects/CRONK/terms", { name: "customer", definition: "A billing account." });
    await admin.post("/api/projects/CRONK/terms", { name: "Board", definition: "Columns." });
    const claude = await registerAgent(admin, "claude-laptop");

    const started = await cronk.client(claude.secret).post("/api/agent-sessions");
    expect(started.body.welcome.workspace.terms).toEqual(["Customer", "Ticket"]);
    expect(started.body.welcome.projects[0].terms).toEqual(["Board", "customer"]);

    const instructions = (await connectMcp(cronk, claude.secret)).client.getInstructions()!;
    expect(instructions).toContain("## Terms");
    expect(instructions).toContain("- Workspace: Customer, Ticket");
    expect(instructions).toContain("- CRONK: Board, customer (replaces the Workspace's)");
    expect(instructions).toContain("`terms` tool");
  });
});

describe("a tool that saves text", () => {
  it("follows the API's answer with a hint naming each word a Term says to avoid and the Term to use", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work.", avoid: ["issue", "work item"] });
    const mcp = await connectMcp(cronk, claude.secret);
    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });

    const { isError, texts } = await rawResult(mcp, "documents", {
      action: "write_report",
      key: "CRONK-1",
      title: "Fixed the issue",
      body: "This work item is done.\n\n`issue` in code\n\n> an issue quoted",
    });
    expect(isError).toBe(false);
    expect(texts).toHaveLength(3);
    expect(JSON.parse(texts[1]!).avoidedWords).toHaveLength(2);
    expect(texts[2]).toBe(
      "Saved, but it uses words a Term says to avoid:\n" +
        '- "issue" (title, line 1, column 11): use Ticket\n' +
        '- "work item" (body, line 1, column 6): use Ticket',
    );

    const clean = await callTool(mcp, "activities", { action: "log", key: "CRONK-1", kind: "progress", body: "All good." });
    expect(clean.body.avoidedWords).toEqual([]);
  });
});

describe("working a delegated Ticket over MCP", () => {
  /** Ada's Project CRONK with `count` Tickets assigned to her and delegated to her Agent claude-laptop, which connects over MCP. */
  async function delegatedOverMcp(count: number) {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", count);
    const claude = await registerAgent(admin, "claude-laptop");
    const adaId = (await admin.get("/api/users")).body.users[0].id;
    for (let i = 1; i <= count; i++) await admin.patch(`/api/tickets/CRONK-${i}`, { assigneeId: adaId, delegateId: claude.agentId });
    return { cronk, admin, mcp: await connectMcp(cronk, claude.secret) };
  }

  it("welcomes the Agent with its Ready Tickets", async () => {
    const { mcp } = await delegatedOverMcp(2);
    expect(mcp.client.getInstructions()).toMatch(/Ready Tickets[\s\S]*CRONK-1: Ticket 1[\s\S]*CRONK-2: Ticket 2/);
  });

  it("welcomes the Agent saying which Ready Tickets are autonomous, and completes one with a Report", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 2);
    const claude = await registerAgent(admin, "claude-laptop");
    await admin.patch("/api/tickets/CRONK-1", { delegateId: claude.agentId, autonomous: true });
    await admin.patch("/api/tickets/CRONK-2", { delegateId: claude.agentId });
    const mcp = await connectMcp(cronk, claude.secret);

    const instructions = mcp.client.getInstructions()!;
    expect(instructions).toMatch(/Autonomous Delegation/);
    expect(instructions).toContain("- CRONK-1: Ticket 1 (Backlog, autonomous: complete it yourself with a Report)");
    expect(instructions).toContain("- CRONK-2: Ticket 2 (Backlog)\n");

    expect((await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" })).body.ticket.autonomous).toBe(true);
    await callTool(mcp, "documents", { action: "write_report", key: "CRONK-1", title: "Done", body: "Fixed the cache." });
    const done = await callTool(mcp, "tickets", { action: "move", key: "CRONK-1", to: "Done" });
    expect(done).toMatchObject({ isError: false, body: { ticket: { status: { category: "completed" }, verification: "unverified" } } });
  });

  it("Claims the next Ready Ticket, moves it, splits it and releases it", async () => {
    const { admin, mcp } = await delegatedOverMcp(1);

    const next = await callTool(mcp, "tickets", { action: "next" });
    expect(next.body.next).toMatchObject({ ticket: { key: "CRONK-1" }, claim: { session: { id: mcp.transport.sessionId } } });
    expect((await callTool(mcp, "tickets", { action: "next" })).body).toEqual({ next: null });

    const moved = await callTool(mcp, "tickets", { action: "move", key: "CRONK-1", to: "in progress" });
    expect(moved.body.ticket.status).toMatchObject({ name: "In Progress", category: "started" });
    expect(await callTool(mcp, "tickets", { action: "move", key: "CRONK-1", to: "Nope" })).toEqual({
      isError: true,
      body: expect.stringContaining("CRONK has no Status named Nope"),
    });
    expect((await callTool(mcp, "tickets", { action: "move", key: "CRONK-1", to: "Done" })).isError).toBe(true);

    const split = await callTool(mcp, "tickets", { action: "create_sub_ticket", key: "CRONK-1", title: "A smaller step" });
    expect(split.body.ticket).toMatchObject({ key: "CRONK-2", parent: { key: "CRONK-1" }, delegate: { name: "claude-laptop" } });

    expect((await callTool(mcp, "tickets", { action: "release", key: "CRONK-1" })).isError).toBe(false);
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
    expect((await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" })).body.claim.session.id).toBe(mcp.transport.sessionId);
  });

  it("edits each field of a Ticket only while holding its Claim, saying why when it doesn't", async () => {
    const { admin, mcp } = await delegatedOverMcp(2);
    const edits = [{ title: "Renamed" }, { description: "New description" }, { priority: "high" }, { labels: ["bug"] }, { parent: "CRONK-2" }];

    for (const edit of edits) {
      expect(await callTool(mcp, "tickets", { action: "edit", key: "CRONK-1", ...edit })).toEqual({
        isError: true,
        body: "Claim CRONK-1 in your Agent Session before editing it: it isn't Claimed",
      });
    }
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket).toMatchObject({ title: "Ticket 1", description: "", priority: "none", labels: [], parent: null });

    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });
    for (const edit of edits) expect((await callTool(mcp, "tickets", { action: "edit", key: "CRONK-1", ...edit })).isError).toBe(false);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket).toMatchObject({
      title: "Renamed",
      description: "New description",
      priority: "high",
      labels: ["bug"],
      parent: { key: "CRONK-2" },
    });
    const unparented = await callTool(mcp, "tickets", { action: "edit", key: "CRONK-1", parent: "none" });
    expect(unparented.body.ticket.parent).toBeNull();
  });

  it("relates and unrelates a Ticket only while holding its Claim, saying why when it doesn't", async () => {
    const { admin, mcp } = await delegatedOverMcp(2);
    const relation = { key: "CRONK-1", relation: "relates_to", other: "CRONK-2" };

    expect(await callTool(mcp, "tickets", { action: "relate", ...relation })).toEqual({
      isError: true,
      body: "Claim CRONK-1 in your Agent Session before changing its Relations: it isn't Claimed",
    });
    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });
    const related = await callTool(mcp, "tickets", { action: "relate", ...relation });
    expect(related.body.relations.relatesTo).toMatchObject([{ key: "CRONK-2" }]);

    await callTool(mcp, "tickets", { action: "release", key: "CRONK-1" });
    expect(await callTool(mcp, "tickets", { action: "unrelate", ...relation })).toEqual({
      isError: true,
      body: "Claim CRONK-1 in your Agent Session before changing its Relations: it isn't Claimed",
    });
    expect((await admin.get("/api/tickets/CRONK-1")).body.relations.relatesTo).toMatchObject([{ key: "CRONK-2" }]);
    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });
    expect((await callTool(mcp, "tickets", { action: "unrelate", ...relation })).body.relations.relatesTo).toEqual([]);
  });
});

describe("the activities tool", () => {
  it("logs Activities and asks questions on the Ticket the Agent Session holds, and lists them", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret);

    expect(await callTool(mcp, "activities", { action: "log", key: "CRONK-1", kind: "plan", body: "First" })).toEqual({
      isError: true,
      body: expect.stringContaining("Claim CRONK-1"),
    });
    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });
    const logged = await callTool(mcp, "activities", { action: "log", key: "CRONK-1", kind: "plan", body: "First" });
    expect(logged.body.activity).toMatchObject({ kind: "plan", body: "First", blocking: false, session: { id: mcp.transport.sessionId } });
    await callTool(mcp, "activities", { action: "ask", key: "CRONK-1", body: "Postgres or SQLite?", blocking: true });
    await callTool(mcp, "activities", { action: "ask", key: "CRONK-1", body: "Any naming preference?" });

    const listed = await callTool(mcp, "activities", { action: "list", key: "CRONK-1" });
    expect(listed.body.activities.map((a: { kind: string; blocking: boolean }) => [a.kind, a.blocking])).toEqual([
      ["plan", false],
      ["question", true],
      ["question", false],
    ]);
    expect((await admin.get("/api/tickets/CRONK-1/activities")).body).toEqual(listed.body);
  });

  it("offers a read-only token only the list", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);
    const { tools } = await mcp.client.listTools();
    expect(tools.find((t) => t.name === "activities")?.inputSchema.properties?.action).toMatchObject({ enum: ["list"] });
  });
});

describe("the documents tool", () => {
  it("creates, lists, gets and updates Documents through the API", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await registerAgent(admin, "claude-laptop");
    const mcp = await connectMcp(cronk, claude.secret);

    const guide = (await callTool(mcp, "documents", { action: "create", project: "CRONK", title: "Guide", body: "# Guide" })).body.document;
    expect(guide).toMatchObject({ projectKey: "CRONK", title: "Guide", body: "# Guide", version: 1 });
    await callTool(mcp, "documents", { action: "create", project: "CRONK", title: "Setup", parentId: guide.id });
    await callTool(mcp, "documents", { action: "create", title: "Handbook" });

    const tree = await callTool(mcp, "documents", { action: "tree", project: "CRONK" });
    expect(tree.body.documents.map((d: { title: string; depth: number }) => [d.title, d.depth])).toEqual([["Guide", 0], ["Setup", 1]]);
    const workspace = await callTool(mcp, "documents", { action: "tree" });
    expect(workspace.body.documents.map((d: { title: string }) => d.title)).toEqual(["Handbook"]);

    const updated = await callTool(mcp, "documents", { action: "update", id: guide.id, baseVersion: 1, body: "# Guide\n\nMore." });
    expect(updated.body.document.version).toBe(2);
    expect((await callTool(mcp, "documents", { action: "get", id: guide.id })).body.document.body).toBe("# Guide\n\nMore.");

    const versions = (await admin.get(`/api/documents/${guide.id}/versions`)).body.versions;
    expect(versions[0].actor).toMatchObject({ kind: "agent", name: "claude-laptop", session: { id: mcp.transport.sessionId } });
  });

  it("answers a stale update with the current Version, so the Agent can merge and retry", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { id } = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "v1" })).body.document;
    await admin.patch(`/api/documents/${id}`, { baseVersion: 1, body: "theirs" });
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop")).secret);

    const stale = await callTool(mcp, "documents", { action: "update", id, baseVersion: 1, body: "mine" });
    expect(stale.isError).toBe(true);
    expect(stale.body).toContain("Version 2");
    expect(stale.body).toContain('"body":"theirs"');
    expect(await callTool(mcp, "documents", { action: "update", id, body: "mine" })).toEqual({
      isError: true,
      body: "The update action needs a baseVersion",
    });
  });

  it("replaces one section of a Document by its heading, and names the headings when there is no such section", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { id } = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "## Setup\n\nOld.\n\n## Usage\n\nRun it.\n" })).body.document;
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop")).secret);

    const replaced = await callTool(mcp, "documents", { action: "replace_section", id, baseVersion: 1, heading: "Setup", body: "New." });
    expect(replaced.body.document).toMatchObject({ version: 2, body: "## Setup\n\nNew.\n\n## Usage\n\nRun it.\n" });

    const missing = await callTool(mcp, "documents", { action: "replace_section", id, baseVersion: 2, heading: "Install", body: "x" });
    expect(missing.isError).toBe(true);
    expect(missing.body).toContain("no section headed “Install”");
    expect(missing.body).toContain('"headings":["## Setup","## Usage"]');
  });

  it("writes a Report on the Ticket the Agent Session holds, which an Agent's move to In Review needs", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret);
    const report = { action: "write_report", key: "CRONK-1", title: "Findings", body: "It was the cache." };

    expect(await callTool(mcp, "documents", report)).toEqual({ isError: true, body: expect.stringContaining("Claim CRONK-1") });
    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });
    expect(await callTool(mcp, "tickets", { action: "move", key: "CRONK-1", to: "In Review" })).toEqual({
      isError: true,
      body: expect.stringContaining("Write a Report on CRONK-1"),
    });

    const written = await callTool(mcp, "documents", report);
    expect(written.body.report).toMatchObject({ ticketKey: "CRONK-1", title: "Findings", body: "It was the cache.", version: 1 });
    expect((await callTool(mcp, "tickets", { action: "move", key: "CRONK-1", to: "In Review" })).body.ticket.status.category).toBe("in_review");
    expect((await admin.get("/api/tickets/CRONK-1/reports")).body.reports).toMatchObject([{ id: written.body.report.id, session: { id: mcp.transport.sessionId } }]);
    expect(await callTool(mcp, "documents", { action: "write_report", key: "CRONK-1", title: "No body" })).toEqual({
      isError: true,
      body: "The write_report action needs a body",
    });
  });

  it("refuses to update a Report without the Claim on its Ticket, naming the Claim", async () => {
    const { cronk, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret);
    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });
    const { id } = (await callTool(mcp, "documents", { action: "write_report", key: "CRONK-1", title: "Findings", body: "Done." })).body.report;
    await callTool(mcp, "tickets", { action: "release", key: "CRONK-1" });

    expect(await callTool(mcp, "documents", { action: "update", id, baseVersion: 1, body: "Rewritten." })).toEqual({
      isError: true,
      body: expect.stringContaining("Claim CRONK-1"),
    });
  });

  it("offers a read-only token only get and tree", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);

    const { tools } = await mcp.client.listTools();
    expect(tools.find((t) => t.name === "documents")?.inputSchema.properties?.action).toMatchObject({ enum: ["get", "tree"] });
  });
});

describe("the comments tool", () => {
  it("posts and lists Comments on Tickets and Documents, replying to a Comment and anchoring to a passage", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Design", body: "Use a cache." })).body.document;
    const asked = (await admin.post("/api/tickets/CRONK-1/comments", { body: "Ready?" })).body.comment;
    const mcp = await connectMcp(cronk, claude.secret);

    const reply = await callTool(mcp, "comments", { action: "post", key: "CRONK-1", body: "Yes.", replyToCommentId: asked.id });
    expect(reply.body.comment).toMatchObject({ ticketKey: "CRONK-1", replyToCommentId: asked.id, actor: { kind: "agent", session: { id: mcp.transport.sessionId } } });
    const anchored = await callTool(mcp, "comments", { action: "post", documentId: doc.id, body: "Which cache?", passage: "a cache" });
    expect(anchored.body.comment.anchor).toEqual({ passage: "a cache", version: 1, inCurrentVersion: true });

    expect((await callTool(mcp, "comments", { action: "list", key: "CRONK-1" })).body).toEqual((await admin.get("/api/tickets/CRONK-1/comments")).body);
    expect((await callTool(mcp, "comments", { action: "list", documentId: doc.id })).body.comments).toHaveLength(1);
    expect(await callTool(mcp, "comments", { action: "list" })).toEqual({ isError: true, body: "The list action needs a key or a documentId" });
  });

  it("offers a read-only token only the list", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);
    const { tools } = await mcp.client.listTools();
    expect(tools.find((t) => t.name === "comments")?.inputSchema.properties?.action).toMatchObject({ enum: ["list"] });
  });
});

describe("the search tool", () => {
  it("searches what the Agent may read, with the API's filters, also with a read-only token", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 0);
    await projectWithTickets(admin, "SECRET", 0);
    await admin.post("/api/projects/CRONK/tickets", { title: "Rotate the keys" });
    await admin.post("/api/projects/CRONK/documents", { title: "Key rotation", body: "Rotate them monthly." });
    await admin.post("/api/projects/SECRET/tickets", { title: "Rotate the secret keys" });
    await admin.patch("/api/projects/SECRET", { agentAccess: "none" });
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);

    const all = await callTool(mcp, "search", { query: "rotate" });
    expect(all.body).toEqual((await admin.get("/api/search?q=rotate&project=CRONK")).body);
    expect(all.body.results).toHaveLength(2);
    const tickets = await callTool(mcp, "search", { query: "rotate", kind: ["ticket"], project: ["CRONK"], limit: 5 });
    expect(tickets.body.results.map((r: { ticketKey: string }) => r.ticketKey)).toEqual(["CRONK-1"]);
    expect(await callTool(mcp, "search", { query: "rotate", project: ["SECRET"] })).toEqual({ isError: true, body: "No such Project" });
  });
});

describe("work waiting for an Agent over MCP", () => {
  it("is listed in the welcome of its next Agent Session", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Please also update the docs." });

    const mcp = await connectMcp(cronk, claude.secret);

    expect(mcp.client.getInstructions()).toMatch(/Work waiting for you[\s\S]*CRONK-1: Ticket 1[\s\S]*Ada[\s\S]*Please also update the docs\./);
  });

  it("is pushed to a connected Agent Session as a notification", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret, { listening: true });
    const notified = new Promise<unknown>((resolve) => mcp.client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => resolve(n.params)));

    const posted = (await admin.post("/api/tickets/CRONK-1/comments", { body: "Please also update the docs." })).body.comment;

    expect(await notified).toMatchObject({
      level: "notice",
      logger: "cronk",
      data: { waiting: { reason: "comment", comment: posted, ticket: { key: "CRONK-1" } } },
    });
  });

  it("is pushed again after its stream ends without the Agent losing access, as on a database blip", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret, { listening: true });
    let notified = false;
    mcp.client.setNotificationHandler(LoggingMessageNotificationSchema, () => void (notified = true));

    // The stream's access check, before it pushes this Comment's waiting work, fails, which ends the stream.
    await cronk.interruptQueriesOn("agent_tokens", () => admin.post("/api/tickets/CRONK-1/comments", { body: "Lost." }));
    expect(notified).toBe(false);

    // Work keeps starting to wait for it until a notice gets through, or a few seconds pass.
    const deadline = Date.now() + 5_000;
    while (!notified && Date.now() < deadline) {
      await admin.post("/api/tickets/CRONK-1/comments", { body: "Still there?" });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(notified).toBe(true);
  });

  it("that started waiting while its stream was down is pushed once the stream is back, once", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret, { listening: true });
    const bodies: string[] = [];
    let notified!: () => void;
    const lost = new Promise<void>((resolve) => (notified = resolve));
    mcp.client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      const body = (n.params as { data: { waiting: { comment: { body: string } } } }).data.waiting.comment.body;
      bodies.push(body);
      if (body === "Lost.") notified();
    });

    // The stream's access check, before it pushes this Comment's waiting work, fails, which ends the stream.
    await cronk.interruptQueriesOn("agent_tokens", () => admin.post("/api/tickets/CRONK-1/comments", { body: "Lost." }));
    await lost;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(bodies).toEqual(["Lost."]);
  });

  it("stops being pushed once the token is revoked, before the client's next request", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret, { listening: true });
    const notifications: { data: { waiting: { comment: { body: string } } } }[] = [];
    let notified!: () => void;
    const first = new Promise<void>((resolve) => (notified = resolve));
    mcp.client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      notifications.push(n.params as (typeof notifications)[number]);
      notified();
    });
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Before." });
    await first;

    await admin.delete(`/api/agents/${claude.agentId}/tokens/${claude.tokenId}`);
    await admin.post("/api/tickets/CRONK-1/comments", { body: "After." });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(notifications.map((n) => n.data.waiting.comment.body)).toEqual(["Before."]);
  });
});

describe("a Ticket becoming Ready over MCP", () => {
  it("is pushed to a connected Agent Session as a notice", async () => {
    const { cronk, admin, claude } = await delegatedSetup(2);
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    const mcp = await connectMcp(cronk, claude.secret, { listening: true });
    const notified = new Promise<unknown>((resolve) => mcp.client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => resolve(n.params)));

    await admin.delete("/api/tickets/CRONK-1/relations/blocks/CRONK-2");

    expect(await notified).toMatchObject({
      level: "notice",
      logger: "cronk",
      data: { message: expect.stringMatching(/CRONK-2: Ticket 2[\s\S]*`claim`/), ticketReady: { key: "CRONK-2", title: "Ticket 2" } },
    });
  });
});

describe("the attachments tool", () => {
  it("attaches text or base64 files to a Ticket the Agent holds the Claim on, and lists them", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret);

    expect((await callTool(mcp, "attachments", { action: "attach", key: "CRONK-1", name: "log.txt", content: "boom" })).isError).toBe(true);
    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });

    const log = await callTool(mcp, "attachments", { action: "attach", key: "CRONK-1", name: "sign-in-flood.log", content: "429 x 50\n" });
    expect(log.isError).toBe(false);
    expect(log.body.attachment).toMatchObject({ name: "sign-in-flood.log", contentType: "text/plain", size: 9, actor: { kind: "agent", session: { id: mcp.transport.sessionId } } });

    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const image = await callTool(mcp, "attachments", { action: "attach", key: "CRONK-1", name: "proxy-ip.png", contentBase64: png.toString("base64"), contentType: "image/png" });
    expect(image.body.attachment).toMatchObject({ contentType: "image/png", size: 8 });
    expect((await admin.download(`/api/attachments/${image.body.attachment.id}/file`)).body.equals(png)).toBe(true);

    expect(await callTool(mcp, "attachments", { action: "attach", key: "CRONK-1", name: "x", content: "a", contentBase64: "YQ==" })).toEqual({
      isError: true,
      body: "The attach action needs either content or contentBase64, not both",
    });
    const listed = await callTool(mcp, "attachments", { action: "list", key: "CRONK-1" });
    expect(listed.body).toEqual((await admin.get("/api/tickets/CRONK-1/attachments")).body);
  });

  it("takes files of several MB, not only what fits a small JSON request", async () => {
    const { cronk, claude } = await delegatedSetup();
    const mcp = await connectMcp(cronk, claude.secret);
    await callTool(mcp, "tickets", { action: "claim", key: "CRONK-1" });

    const recording = Buffer.alloc(3 * 1024 * 1024, 7);
    const attached = await callTool(mcp, "attachments", { action: "attach", key: "CRONK-1", name: "repro.mp4", contentBase64: recording.toString("base64"), contentType: "video/mp4" });
    expect(attached.body.attachment).toMatchObject({ name: "repro.mp4", size: recording.length });
  });

  it("offers a read-only token only list", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);
    const { tools } = await mcp.client.listTools();
    expect(tools.find((t) => t.name === "attachments")?.inputSchema.properties?.action).toMatchObject({ enum: ["list"] });
  });
});
