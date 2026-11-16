import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, projectWithTickets, registerAgent, startInstalledCronk, startSession } from "./harness.js";

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

  it("answer only the token that started them: another token of the same Agent is told the Session has ended", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const claude = await registerAgent(admin, "claude-laptop");
    const a = await startSession(cronk, claude.secret);
    const b = (await admin.post(`/api/agents/${claude.agentId}/tokens`, {})).body.secret;
    const bInA = cronk.client(b, { "cronk-agent-session": a.sessionId });

    cronk.clock.advance(60_000);
    const refused = await bInA.get("/api/agent-sessions/current");
    expect(refused).toEqual({ status: 410, body: { error: "This Agent Session has ended; start a new one" } });
    expect((await bInA.post("/api/projects/CRONK/tickets", { title: "From B" })).status).toBe(410);
    expect((await admin.get("/api/projects/CRONK/tickets")).body.tickets).toHaveLength(1);
    expect((await admin.get("/api/agents")).body.agents[0].sessions[0]).toMatchObject({ id: a.sessionId, lastSeenAt: "2026-01-01T09:00:00.000Z" });
    expect((await a.get("/api/agent-sessions/current")).status).toBe(200);
  });

  it("are needed for every write an Agent makes, and a refused write says how to start one", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const bare = cronk.client((await registerAgent(admin, "claude-laptop")).secret);

    const refused = await bare.post("/api/projects/CRONK/tickets", { title: "Outside a Session" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Agent Session/);
    expect(refused.body.error).toContain("POST /api/agent-sessions");
    expect(refused.body.error).toContain("Cronk-Agent-Session");
    expect((await bare.patch("/api/tickets/CRONK-1", { title: "Renamed" })).status).toBe(403);
    expect((await bare.post("/api/tickets/CRONK-1/comments", { body: "Hello" })).status).toBe(403);
    expect((await bare.post("/api/workspace/documents", { title: "Notes", body: "x" })).status).toBe(403);
    expect((await admin.get("/api/projects/CRONK/tickets")).body.tickets).toEqual([expect.objectContaining({ title: expect.not.stringMatching(/Renamed/) })]);
    expect((await admin.get("/api/tickets/CRONK-1/comments")).body.comments).toEqual([]);
  });

  it("aren't what a read-only token is told to start: its writes are refused as read-only", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const reader = cronk.client((await registerAgent(admin, "claude-laptop", { readOnly: true })).secret);

    const refused = await reader.post("/api/projects/CRONK/tickets", { title: "Outside a Session" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/read-only/);
    expect(refused.body.error).not.toMatch(/Agent Session/);
  });

  it("aren't needed to read with a bare token", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const bare = cronk.client((await registerAgent(admin, "claude-laptop")).secret);

    expect((await bare.get("/api/projects")).status).toBe(200);
    expect((await bare.get("/api/tickets/CRONK-1")).status).toBe(200);
    expect((await bare.get("/api/projects/CRONK/tickets")).body.tickets).toHaveLength(1);
    expect((await bare.get("/api/me")).status).toBe(200);
  });

  it("can be started, used and ended by a script with one call each", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const secret = (await registerAgent(admin, "nightly-script")).secret;

    const started = await cronk.client(secret).post("/api/agent-sessions");
    expect(started.status).toBe(201);
    const script = cronk.client(secret, { "cronk-agent-session": started.body.session.id });
    const created = await script.post("/api/projects/CRONK/tickets", { title: "Nightly report" });
    expect(created.status).toBe(201);
    const history = (await admin.get(`/api/tickets/${created.body.ticket.key}/history`)).body.changes;
    expect(history[0].actor).toMatchObject({ kind: "agent", name: "nightly-script", session: { id: started.body.session.id } });

    expect((await script.delete("/api/agent-sessions/current")).status).toBe(204);
    expect((await script.post("/api/projects/CRONK/tickets", { title: "After the end" })).status).toBe(410);
    expect((await cronk.client(secret).get("/api/tickets/CRONK-1")).status).toBe(200);
  });

  it("can't be acted in by a read-only token of the same Agent", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    const full = await startSession(cronk, claude.secret);
    const reader = (await admin.post(`/api/agents/${claude.agentId}/tokens`, { readOnly: true })).body.secret;

    expect((await cronk.client(reader, { "cronk-agent-session": full.sessionId }).get("/api/projects")).status).toBe(410);
    expect((await cronk.client(reader).get("/api/projects")).status).toBe(200);
  });

  it("can't be ended or followed by another token of the same Agent", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    const a = await startSession(cronk, claude.secret);
    const b = (await admin.post(`/api/agents/${claude.agentId}/tokens`, {})).body.secret;
    const bInA = cronk.client(b, { "cronk-agent-session": a.sessionId });

    expect((await bInA.delete("/api/agent-sessions/current")).status).toBe(410);
    expect((await bInA.events("/api/agent-sessions/current/events")).status).toBe(410);
    expect((await a.get("/api/agent-sessions/current")).status).toBe(200);
  });

  it("end with their Claims when the token that started them is revoked, while the Agent's other tokens keep working", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const a = await session();
    expect((await a.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    const bSecret = (await admin.post(`/api/agents/${claude.agentId}/tokens`, {})).body.secret;
    const b = cronk.client(bSecret);

    expect((await admin.delete(`/api/agents/${claude.agentId}/tokens/${claude.tokenId}`)).status).toBe(204);
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
    expect((await admin.get("/api/agents")).body.agents[0].sessions).toEqual([]);
    expect((await a.get("/api/agent-sessions/current")).status).toBe(401);
    expect((await cronk.client(bSecret, { "cronk-agent-session": a.sessionId }).get("/api/agent-sessions/current")).status).toBe(410);
    expect((await b.get("/api/tickets/CRONK-1")).status).toBe(200);
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
