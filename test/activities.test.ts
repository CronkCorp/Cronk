import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, startSession } from "./harness.js";

describe("Activities", () => {
  it("are logged by the Claim holder and listed on the Ticket, oldest first, with their kind, body, time and Agent Session", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const logged = await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "1. Read the code\n2. Write a test" });
    expect(logged.status).toBe(201);
    cronk.clock.advance(60_000);
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Which **database**?", blocking: true });

    const listed = await admin.get("/api/tickets/CRONK-1/activities");
    expect(listed.status).toBe(200);
    const by = { agent: { id: claude.agentId, name: "claude-laptop", owner: { name: "Ada" } }, session: { id: agent.sessionId } };
    expect(listed.body.activities).toMatchObject([
      { kind: "plan", body: "1. Read the code\n2. Write a test", blocking: false, at: "2026-01-01T09:00:00.000Z", ...by },
      { kind: "question", body: "Which **database**?", blocking: true, at: "2026-01-01T09:01:00.000Z", ...by },
    ]);
    expect(listed.body.activities[0]).toEqual(logged.body.activity);
  });
});

describe("Writing an Activity", () => {
  it("is refused to anyone but the Agent Session holding the Ticket's Claim", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const holder = await session();
    const other = await session();
    const plan = { kind: "plan", body: "Do the thing" };

    expect((await holder.post("/api/tickets/CRONK-1/activities", plan)).status).toBe(409);
    await holder.post("/api/tickets/CRONK-1/claim");
    const refused = await other.post("/api/tickets/CRONK-1/activities", plan);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Claim CRONK-1/);
    expect((await cronk.client(claude.secret).post("/api/tickets/CRONK-1/activities", plan)).status).toBe(400);
    expect((await admin.post("/api/tickets/CRONK-1/activities", plan)).status).toBe(400);

    await holder.delete("/api/tickets/CRONK-1/claim");
    expect((await holder.post("/api/tickets/CRONK-1/activities", plan)).status).toBe(409);
    expect((await admin.get("/api/tickets/CRONK-1/activities")).body.activities).toEqual([]);
  });

  it("lets only a question be blocking", async () => {
    const { session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "finding", body: "Found it", blocking: true })).status).toBe(400);
    expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "chat", body: "Hi" })).status).toBe(400);
    expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "error", body: " " })).status).toBe(400);
    expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "error", body: "It broke" })).body.activity.blocking).toBe(false);
  });
});

describe("An Activity", () => {
  it("keeps the Claim alive past the silence threshold", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    for (let i = 0; i < 3; i++) {
      cronk.clock.advance(4 * 60_000);
      expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "progress", body: `Step ${i}` })).status).toBe(201);
    }
    cronk.clock.advance(4 * 60_000);
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toMatchObject({
      session: { id: agent.sessionId },
      claimedAt: "2026-01-01T09:00:00.000Z",
      endsIfSilentAt: "2026-01-01T09:17:00.000Z",
    });
    expect((await (await session()).post("/api/tickets/CRONK-1/claim")).status).toBe(409);
  });

  it("is refused to read-only tokens, and listed only to those who can see the Ticket", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Plan" });
    const readOnly = (await admin.post(`/api/agents/${claude.agentId}/tokens`, { readOnly: true })).body.secret;
    const lookup = await startSession(cronk, readOnly);
    expect((await lookup.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Plan" })).status).toBe(403);
    expect((await lookup.get("/api/tickets/CRONK-1/activities")).body.activities).toHaveLength(1);

    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.get("/api/tickets/CRONK-1/activities")).status).toBe(200);
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    expect((await bob.get("/api/tickets/CRONK-1/activities")).status).toBe(404);
  });
});
