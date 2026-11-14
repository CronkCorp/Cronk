import { describe, expect, it } from "vitest";
import { type Client, type Cronk, joinAs, projectWithTickets, registerAgent, startInstalledCronk } from "./harness.js";

/**
 * Ada, the Admin, with the Project CRONK holding `tickets` Tickets, all assigned to her and
 * delegated to her Agent claude-laptop. `session()` starts a new Agent Session of that Agent.
 */
async function delegatedSetup(tickets = 1) {
  const { cronk, admin } = await startInstalledCronk();
  await projectWithTickets(admin, "CRONK", tickets);
  const claude = await registerAgent(admin, "claude-laptop");
  const adaId = (await admin.get("/api/users")).body.users[0].id;
  for (let i = 1; i <= tickets; i++) await admin.patch(`/api/tickets/CRONK-${i}`, { assigneeId: adaId, delegateId: claude.agentId });
  return { cronk, admin, claude, adaId, session: () => startSession(cronk, claude.secret) };
}

/** Starts an Agent Session with `secret` and returns a client calling within it, with the Session's id. */
async function startSession(cronk: Cronk, secret: string): Promise<Client & { sessionId: string }> {
  const started = await cronk.client(secret).post("/api/agent-sessions");
  if (started.status !== 201) throw new Error(`Starting a Session failed: ${JSON.stringify(started.body)}`);
  const sessionId: string = started.body.session.id;
  return Object.assign(cronk.client(secret, { "cronk-agent-session": sessionId }), { sessionId });
}

describe("Claiming a Ticket", () => {
  it("gives the Agent Session the Ticket's Claim, shown on the Ticket", async () => {
    const { admin, session } = await delegatedSetup();
    const first = await session();

    const claimed = await first.post("/api/tickets/CRONK-1/claim");
    expect(claimed.status).toBe(200);
    expect(claimed.body.ticket.key).toBe("CRONK-1");
    const claim = {
      agent: { name: "claude-laptop" },
      session: { id: first.sessionId },
      claimedAt: "2026-01-01T09:00:00.000Z",
      endsIfSilentAt: "2026-01-01T09:05:00.000Z",
    };
    expect(claimed.body.claim).toMatchObject(claim);
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toMatchObject(claim);
  });

  it("is refused while another Agent Session holds a live Claim, until it is released", async () => {
    const { admin, session } = await delegatedSetup();
    const first = await session();
    const second = await session();
    await first.post("/api/tickets/CRONK-1/claim");

    const refused = await second.post("/api/tickets/CRONK-1/claim");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Claimed/);
    expect((await first.post("/api/tickets/CRONK-1/claim")).status).toBe(200);

    expect((await second.delete("/api/tickets/CRONK-1/claim")).status).toBe(409);
    expect((await first.delete("/api/tickets/CRONK-1/claim")).status).toBe(204);
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
    expect((await second.post("/api/tickets/CRONK-1/claim")).body.claim.session.id).toBe(second.sessionId);
  });

  it("is refused for Tickets not delegated to the Agent, Completed or Canceled, and outside an Agent Session", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup(2);
    const inSession = await session();
    await admin.patch("/api/tickets/CRONK-2", { delegateId: null });
    expect((await inSession.post("/api/tickets/CRONK-2/claim")).status).toBe(409);

    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[];
    for (const category of ["completed", "canceled"]) {
      await admin.patch("/api/tickets/CRONK-1", { statusId: statuses.find((s) => s.category === category)!.id });
      expect((await inSession.post("/api/tickets/CRONK-1/claim")).status).toBe(409);
    }

    expect((await cronk.client(claude.secret).post("/api/tickets/CRONK-1/claim")).status).toBe(400);
    expect((await admin.post("/api/tickets/CRONK-1/claim")).status).toBe(400);
  });
});

describe("A Claim", () => {
  it("is kept alive by any call from its Agent Session, and lapses after the silence threshold, keeping the Delegate", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const first = await session();
    await first.post("/api/tickets/CRONK-1/claim");

    cronk.clock.advance(4 * 60_000);
    await first.get("/api/projects");
    cronk.clock.advance(4 * 60_000);
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toMatchObject({ endsIfSilentAt: "2026-01-01T09:09:00.000Z" });
    const second = await session();
    expect((await second.post("/api/tickets/CRONK-1/claim")).status).toBe(409);

    cronk.clock.advance(60_000);
    const lapsed = (await admin.get("/api/tickets/CRONK-1")).body;
    expect(lapsed.claim).toBeNull();
    expect(lapsed.ticket.delegate).toEqual({ id: claude.agentId, name: "claude-laptop" });
    expect((await second.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
  });

  it("lapses after the silence threshold the Admin sets for the Workspace", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    expect((await admin.get("/api/workspace")).body.silenceThresholdSeconds).toBe(300);
    const set = await admin.patch("/api/workspace", { silenceThresholdSeconds: 120 });
    expect(set.status).toBe(200);
    expect(set.body.silenceThresholdSeconds).toBe(120);
    expect((await admin.patch("/api/workspace", { silenceThresholdSeconds: 0 })).status).toBe(400);

    const first = await session();
    await first.post("/api/tickets/CRONK-1/claim");
    cronk.clock.advance(2 * 60_000);
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
  });

  it("has its silence threshold set only by Admins", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.patch("/api/workspace", { silenceThresholdSeconds: 120 })).status).toBe(403);
    expect((await cronk.client(claude.secret).patch("/api/workspace", { silenceThresholdSeconds: 120 })).status).toBe(403);
    expect((await admin.get("/api/workspace")).body.silenceThresholdSeconds).toBe(300);
  });
});
