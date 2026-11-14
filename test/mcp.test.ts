import { describe, expect, it } from "vitest";
import { connectMcp, registerAgent, startInstalledCronk } from "./harness.js";

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
  });
});
