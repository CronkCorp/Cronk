import { describe, expect, it } from "vitest";
import type { McpConnection } from "./harness.js";
import { connectMcp, projectWithTickets, registerAgent, startInstalledCronk } from "./harness.js";

/** Calls a tool and returns its result: the API's answer parsed from the text, and whether it is an error. */
async function callTool(mcp: McpConnection, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any }> {
  const result = (await mcp.client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = result.content[0]!.text;
  return { isError: result.isError ?? false, body: result.isError ? text : JSON.parse(text) };
}

describe("the MCP endpoint", () => {
  it("starts an Agent Session for an Agent token and welcomes it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");

    const mcp = await connectMcp(cronk, claude.secret);

    expect(mcp.client.getInstructions()).toContain("claude-laptop");
    expect(mcp.client.getInstructions()).toContain("Acme");
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
    expect(await liveSessions()).toEqual([mcp.transport.sessionId]);

    cronk.clock.advance(60_000);
    expect(await liveSessions()).toEqual([]);
    await expect(mcp.client.ping()).rejects.toMatchObject({ code: 404, message: expect.stringContaining("Agent Session has ended") });
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
});

describe("the activities tool", () => {
  it("logs Activities and asks questions on the Ticket the Agent Session holds, and lists them", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const claude = await registerAgent(admin, "claude-laptop");
    const adaId = (await admin.get("/api/users")).body.users[0].id;
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: adaId, delegateId: claude.agentId });
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

  it("offers a read-only token only get and tree", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const mcp = await connectMcp(cronk, (await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);

    const { tools } = await mcp.client.listTools();
    expect(tools.find((t) => t.name === "documents")?.inputSchema.properties?.action).toMatchObject({ enum: ["get", "tree"] });
  });
});
