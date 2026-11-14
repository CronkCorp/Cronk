import { describe, expect, it } from "vitest";
import { joinAs, registerAgent, startInstalledCronk } from "./harness.js";

describe("Agent Sessions", () => {
  it("are started only by Agents, and shown with their Agent to its Owner and to Admins", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.post("/api/agent-sessions")).status).toBe(403);
    const claude = await registerAgent(bob, "claude-laptop");

    const started = await cronk.client(claude.secret).post("/api/agent-sessions");
    expect(started.status).toBe(201);
    expect(started.body.welcome).toMatchObject({ workspace: { name: "Acme" }, agent: { name: "claude-laptop", owner: { name: "bob" } }, readOnly: false });

    const expected = [{ id: started.body.session.id, startedAt: "2026-01-01T09:00:00.000Z", lastSeenAt: "2026-01-01T09:00:00.000Z", endsIfSilentAt: "2026-01-01T09:05:00.000Z" }];
    expect((await bob.get("/api/agents")).body.agents[0].sessions).toEqual(expected);
    expect((await admin.get("/api/agents?all=true")).body.agents[0].sessions).toEqual(expected);
  });

  it("are refreshed by every call made in them", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    const session = (await cronk.client(claude.secret).post("/api/agent-sessions")).body.session;
    const inSession = cronk.client(claude.secret, { "cronk-agent-session": session.id });

    cronk.clock.advance(4 * 60_000);
    expect((await inSession.get("/api/projects")).status).toBe(200);
    cronk.clock.advance(4 * 60_000);
    expect((await inSession.get("/api/agent-sessions/current")).body.session).toMatchObject({ lastSeenAt: "2026-01-01T09:08:00.000Z", endsIfSilentAt: "2026-01-01T09:13:00.000Z" });

    cronk.clock.advance(5 * 60_000);
    expect((await inSession.get("/api/agent-sessions/current")).status).toBe(410);
  });
});
