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
