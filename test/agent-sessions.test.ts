import { describe, expect, it } from "vitest";
import { joinAs, projectWithTickets, registerAgent, startInstalledCronk, startSession } from "./harness.js";

describe("Agent Sessions", () => {
  it("are started only by Agents, and shown with their Agent to its Owner and to Admins", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.post("/api/agent-sessions")).status).toBe(403);
    const claude = await registerAgent(bob, "claude-laptop");

    const started = await cronk.client(claude.secret).post("/api/agent-sessions");
    expect(started.status).toBe(201);
    expect(started.body.welcome).toMatchObject({ workspace: { name: "Acme" }, agent: { name: "claude-laptop", owner: { name: "bob" } }, readOnly: false });

    const expected = [{ id: started.body.session.id, startedAt: "2026-01-01T09:00:00.000Z", lastSeenAt: "2026-01-01T09:00:00.000Z", endsIfSilentAt: "2026-01-01T09:05:00.000Z", claims: [] }];
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

  it("are listed with their live Claims, leaving out Tickets in Projects the caller can't read", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await projectWithTickets(admin, "CRONK", 1);
    await projectWithTickets(admin, "SECRET", 1);
    const claude = await registerAgent(bob, "claude-laptop");
    const bobId = (await bob.get("/api/me")).body.user.id;
    for (const key of ["CRONK-1", "SECRET-1"]) await admin.patch(`/api/tickets/${key}`, { assigneeId: bobId, delegateId: claude.agentId });
    const busy = await startSession(cronk, claude.secret);
    const idle = await startSession(cronk, claude.secret);
    for (const key of ["CRONK-1", "SECRET-1"]) expect((await busy.post(`/api/tickets/${key}/claim`)).status).toBe(200);
    await admin.patch("/api/projects/SECRET", { visibility: "private" });

    const claimsOf = (agents: { sessions: { id: string; claims: unknown[] }[] }[]) => Object.fromEntries(agents[0]!.sessions.map((s) => [s.id, s.claims]));
    expect(claimsOf((await bob.get("/api/agents")).body.agents)).toEqual({
      [busy.sessionId]: [{ ticketKey: "CRONK-1", title: "Ticket 1" }],
      [idle.sessionId]: [],
    });
    expect(claimsOf((await admin.get("/api/agents?all=true")).body.agents)).toEqual({
      [busy.sessionId]: [
        { ticketKey: "CRONK-1", title: "Ticket 1" },
        { ticketKey: "SECRET-1", title: "Ticket 1" },
      ],
      [idle.sessionId]: [],
    });

    await busy.delete("/api/tickets/CRONK-1/claim");
    expect(claimsOf((await bob.get("/api/agents")).body.agents)[busy.sessionId]).toEqual([]);
  });

  it("are listed with when the Agent's last one ended, by disconnecting or falling silent", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    const lastEnded = async () => (await admin.get("/api/agents")).body.agents[0].lastSessionEndedAt;
    expect(await lastEnded()).toBeNull();

    const first = await startSession(cronk, claude.secret);
    cronk.clock.advance(60_000);
    await first.delete("/api/agent-sessions/current");
    expect(await lastEnded()).toBe("2026-01-01T09:01:00.000Z");

    await startSession(cronk, claude.secret);
    expect(await lastEnded()).toBe("2026-01-01T09:01:00.000Z");
    cronk.clock.advance(10 * 60_000);
    expect(await lastEnded()).toBe("2026-01-01T09:06:00.000Z");
  });
});

describe("Agents", () => {
  it("are listed with how many unfinished Tickets they are Delegate on that the caller can read", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    await projectWithTickets(admin, "CRONK", 3);
    await projectWithTickets(admin, "SECRET", 1);
    const claude = await registerAgent(bob, "claude-laptop");
    for (const key of ["CRONK-1", "CRONK-2", "CRONK-3", "SECRET-1"]) await admin.patch(`/api/tickets/${key}`, { assigneeId: bobId, delegateId: claude.agentId });
    const completed = (await admin.get("/api/projects/CRONK")).body.statuses.find((s: { category: string }) => s.category === "completed").id;
    await admin.patch("/api/tickets/CRONK-3", { statusId: completed });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });

    expect((await bob.get("/api/agents")).body.agents[0].delegateTicketCount).toBe(2);
    expect((await admin.get("/api/agents?all=true")).body.agents[0].delegateTicketCount).toBe(3);
  });
});
