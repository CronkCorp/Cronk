import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, startSession } from "./harness.js";

describe("Claiming a Ticket", () => {
  it("gives the Agent Session the Ticket's Claim, shown on the Ticket", async () => {
    const { admin, session } = await delegatedSetup();
    const first = await session();
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.status.category).toBe("backlog");

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
    expect(refused.body.error).toBe("CRONK-1 is Claimed by another Agent Session");
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
    const undelegated = await inSession.post("/api/tickets/CRONK-2/claim");
    expect(undelegated.status).toBe(409);
    expect(undelegated.body.error).toBe("CRONK-2 isn't delegated to claude-laptop");

    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[];
    for (const category of ["completed", "canceled"]) {
      await admin.patch("/api/tickets/CRONK-1", { statusId: statuses.find((s) => s.category === category)!.id });
      const finished = await inSession.post("/api/tickets/CRONK-1/claim");
      expect(finished.status).toBe(409);
      expect(finished.body.error).toMatch(/^CRONK-1 is (Done|Canceled), so there is nothing left to work on$/);
    }

    expect((await cronk.client(claude.secret).post("/api/tickets/CRONK-1/claim")).status).toBe(400);
    expect((await admin.post("/api/tickets/CRONK-1/claim")).status).toBe(400);
  });

  it("is refused, saying why, for a Ticket that isn't Ready: In Review, blocked by unfinished Tickets, or in an archived Project", async () => {
    const { admin, session } = await delegatedSetup(5);
    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[];
    const inCategory = (category: string) => statuses.find((s) => s.category === category)!.id;
    await admin.patch("/api/tickets/CRONK-1", { statusId: inCategory("in_review") });
    await admin.post("/api/tickets/CRONK-2/relations", { kind: "blocked_by", ticketKey: "CRONK-3" });
    await admin.post("/api/tickets/CRONK-2/relations", { kind: "blocked_by", ticketKey: "CRONK-4" });
    await admin.post("/api/tickets/CRONK-2/relations", { kind: "blocked_by", ticketKey: "CRONK-5" });
    await admin.patch("/api/tickets/CRONK-5", { statusId: inCategory("completed") });
    const agent = await session();

    const inReview = await agent.post("/api/tickets/CRONK-1/claim");
    expect(inReview.status).toBe(409);
    expect(inReview.body.error).toBe("CRONK-1 is In Review, waiting until a User Sends it back");
    const blocked = await agent.post("/api/tickets/CRONK-2/claim");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("CRONK-2 is blocked by CRONK-3 and CRONK-4, which aren't finished");

    await admin.patch("/api/projects/CRONK", { archived: true });
    const archived = await agent.post("/api/tickets/CRONK-3/claim");
    expect(archived.status).toBe(409);
    expect(archived.body.error).toBe("CRONK-3 is in the archived Project CRONK");
    await admin.patch("/api/projects/CRONK", { archived: false });

    await admin.post("/api/tickets/CRONK-1/send-back", { comment: "Needs tests" });
    expect((await agent.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    // Claiming again from the Agent Session holding the Claim keeps it.
    const again = await agent.post("/api/tickets/CRONK-1/claim");
    expect(again.status).toBe(200);
    expect(again.body.claim.session.id).toBe(agent.sessionId);
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
    // Last heard at 09:04, so it lapses the five-minute silence threshold later.
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toMatchObject({
      lastSeenAt: "2026-01-01T09:04:00.000Z",
      endsIfSilentAt: "2026-01-01T09:09:00.000Z",
    });
    const second = await session();
    expect((await second.post("/api/tickets/CRONK-1/claim")).status).toBe(409);

    cronk.clock.advance(60_000);
    const lapsed = (await admin.get("/api/tickets/CRONK-1")).body;
    expect(lapsed.claim).toBeNull();
    expect(lapsed.ticket.delegate).toEqual({ id: claude.agentId, name: "claude-laptop" });
    expect((await second.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
  });

  it("is kept alive while its Agent Session's events stream is open, and lapses after the silence threshold once it closes", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const first = await session();
    await first.post("/api/tickets/CRONK-1/claim");
    const stream = await first.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");

    // 12 minutes pass, each four of them ending in the stream's heartbeat.
    for (let i = 0; i < 3; i++) {
      cronk.clock.advance(4 * 60_000);
      await cronk.heartbeat();
    }
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toMatchObject({ endsIfSilentAt: "2026-01-01T09:17:00.000Z" });

    stream.close();
    cronk.clock.advance(4 * 60_000);
    await cronk.heartbeat();
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toMatchObject({ endsIfSilentAt: "2026-01-01T09:17:00.000Z" });
    cronk.clock.advance(60_000);
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
    expect((await first.get("/api/agent-sessions/current")).status).toBe(410);
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

  it("ends when a User moves its Ticket into review, completes or cancels it, so the Agent Session can't keep working on it", async () => {
    const { admin, session } = await delegatedSetup(3);
    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[];
    const inCategory = (category: string) => statuses.find((s) => s.category === category)!.id;
    const agent = await session();

    for (const [key, category] of [["CRONK-1", "in_review"], ["CRONK-2", "completed"], ["CRONK-3", "canceled"]] as const) {
      await agent.post(`/api/tickets/${key}/claim`);
      await admin.patch(`/api/tickets/${key}`, { statusId: inCategory(category) });

      expect((await admin.get(`/api/tickets/${key}`)).body.claim).toBeNull();
      expect((await agent.patch(`/api/tickets/${key}`, { statusId: inCategory("started") })).status).toBe(409);
      expect((await agent.post(`/api/tickets/${key}/activities`, { kind: "progress", body: "Still going" })).status).toBe(409);
    }
  });

  it("ends when removing its Status moves the Ticket into a Completed Status", async () => {
    const { admin, session } = await delegatedSetup();
    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[];
    const inCategory = (category: string) => statuses.find((s) => s.category === category)!.id;
    const extra = (await admin.post("/api/projects/CRONK/statuses", { name: "Doing", category: "started" })).body.status;
    await admin.patch("/api/tickets/CRONK-1", { statusId: extra.id });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    expect((await admin.delete(`/api/projects/CRONK/statuses/${extra.id}?moveTo=${inCategory("completed")}`)).status).toBe(204);
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
    expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "progress", body: "Still going" })).status).toBe(409);
  });

  it("has its silence threshold set only by Admins", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.patch("/api/workspace", { silenceThresholdSeconds: 120 })).status).toBe(403);
    expect((await cronk.client(claude.secret).patch("/api/workspace", { silenceThresholdSeconds: 120 })).status).toBe(403);
    expect((await admin.get("/api/workspace")).body.silenceThresholdSeconds).toBe(300);
  });
});

describe("Asking for the next Ready Ticket", () => {
  it("Claims the highest-Priority Ready Ticket, oldest first among equals", async () => {
    const { cronk, admin, adaId, claude, session } = await delegatedSetup();
    for (const title of ["Second", "Third", "Fourth"]) {
      cronk.clock.advance(60_000);
      await admin.post("/api/projects/CRONK/tickets", { title });
    }
    for (const key of ["CRONK-2", "CRONK-3", "CRONK-4"]) await admin.patch(`/api/tickets/${key}`, { assigneeId: adaId, delegateId: claude.agentId });
    await admin.patch("/api/tickets/CRONK-3", { priority: "high" });
    await admin.patch("/api/tickets/CRONK-4", { priority: "high" });
    await admin.patch("/api/tickets/CRONK-1", { priority: "low" });
    const agent = await session();

    const keys = [];
    for (let i = 0; i < 4; i++) {
      const next = await agent.post("/api/agent-sessions/current/next");
      expect(next.status).toBe(200);
      expect(next.body.next.claim.session.id).toBe(agent.sessionId);
      keys.push(next.body.next.ticket.key);
    }
    expect(keys).toEqual(["CRONK-3", "CRONK-4", "CRONK-1", "CRONK-2"]);
    expect((await agent.post("/api/agent-sessions/current/next")).body.next).toBeNull();
  });

  it("leaves out Tickets not delegated to the Agent, Completed or Canceled, blocked by unfinished Tickets, or Claimed", async () => {
    const { admin, session } = await delegatedSetup(6);
    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[];
    const inCategory = (category: string) => statuses.find((s) => s.category === category)!.id;
    await admin.patch("/api/tickets/CRONK-1", { delegateId: null });
    await admin.patch("/api/tickets/CRONK-2", { statusId: inCategory("completed") });
    await admin.patch("/api/tickets/CRONK-3", { statusId: inCategory("canceled") });
    await admin.post("/api/tickets/CRONK-4/relations", { kind: "blocked_by", ticketKey: "CRONK-1" });
    await admin.post("/api/tickets/CRONK-5/relations", { kind: "blocked_by", ticketKey: "CRONK-2" });
    await admin.post("/api/tickets/CRONK-5/relations", { kind: "blocked_by", ticketKey: "CRONK-3" });
    const other = await session();
    await other.post("/api/tickets/CRONK-6/claim");
    const agent = await session();

    expect((await agent.post("/api/agent-sessions/current/next")).body.next.ticket.key).toBe("CRONK-5");
    expect((await agent.post("/api/agent-sessions/current/next")).body.next).toBeNull();
    await admin.patch("/api/tickets/CRONK-1", { statusId: inCategory("completed") });
    expect((await agent.post("/api/agent-sessions/current/next")).body.next.ticket.key).toBe("CRONK-4");
  });

  it("leaves out Tickets In Review, which wait on a User, until they are Sent back", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup(2);
    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[];
    const inCategory = (category: string) => statuses.find((s) => s.category === category)!.id;
    await admin.patch("/api/tickets/CRONK-1", { statusId: inCategory("in_review") });
    await admin.patch("/api/tickets/CRONK-2", { statusId: inCategory("in_review") });

    const welcomed = await cronk.client(claude.secret).post("/api/agent-sessions");
    expect(welcomed.body.welcome.readyTickets).toEqual([]);
    const agent = await session();
    expect((await agent.post("/api/agent-sessions/current/next")).body.next).toBeNull();

    expect((await admin.post("/api/tickets/CRONK-2/send-back", { comment: "Needs tests" })).status).toBe(200);
    expect((await agent.post("/api/agent-sessions/current/next")).body.next.ticket.key).toBe("CRONK-2");
  });

  it("never gives two concurrent Agent Sessions the same Ticket", async () => {
    const { session } = await delegatedSetup(5);
    const sessions = await Promise.all(Array.from({ length: 8 }, () => session()));

    const answers = await Promise.all(sessions.map((s) => s.post("/api/agent-sessions/current/next")));

    expect(answers.every((a) => a.status === 200)).toBe(true);
    const claimed = answers.filter((a) => a.body.next).map((a) => a.body.next.ticket.key);
    expect(claimed.sort()).toEqual(["CRONK-1", "CRONK-2", "CRONK-3", "CRONK-4", "CRONK-5"]);
  });

  it("is only for an Agent Session", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    expect((await cronk.client(claude.secret).post("/api/agent-sessions/current/next")).status).toBe(400);
    expect((await admin.post("/api/agent-sessions/current/next")).status).toBe(400);
  });
});

describe("The Claim holder", () => {
  it("can move the Ticket into Unstarted, Started and In Review Statuses but never Completed, Canceled or Backlog", async () => {
    const { admin, session } = await delegatedSetup();
    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[];
    const inCategory = (category: string) => statuses.find((s) => s.category === category)!.id;
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "Done." });

    for (const category of ["started", "unstarted", "in_review"]) {
      const moved = await agent.patch("/api/tickets/CRONK-1", { statusId: inCategory(category) });
      expect(moved.status).toBe(200);
      expect(moved.body.ticket.status.category).toBe(category);
    }
    for (const category of ["completed", "canceled", "backlog"]) {
      const refused = await agent.patch("/api/tickets/CRONK-1", { statusId: inCategory(category) });
      expect(refused.status).toBe(403);
    }
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.status.category).toBe("in_review");
    expect((await admin.patch("/api/tickets/CRONK-1", { statusId: inCategory("completed") })).status).toBe(200);
  });

  it("is the only Agent Session that can move the Ticket", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const started = (await admin.get("/api/projects/CRONK")).body.statuses.find((s: { category: string }) => s.category === "started").id;
    const holder = await session();
    const other = await session();

    expect((await holder.patch("/api/tickets/CRONK-1", { statusId: started })).status).toBe(409);
    await holder.post("/api/tickets/CRONK-1/claim");
    expect((await other.patch("/api/tickets/CRONK-1", { statusId: started })).status).toBe(409);
    expect((await cronk.client(claude.secret).patch("/api/tickets/CRONK-1", { statusId: started })).status).toBe(403);
    expect((await holder.patch("/api/tickets/CRONK-1", { statusId: started })).status).toBe(200);
  });
});

describe("Sub-Tickets", () => {
  it("can be created by the Claim holder, inheriting the parent's Assignee and Delegate", async () => {
    const { admin, adaId, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const created = await agent.post("/api/tickets/CRONK-1/sub-tickets", { title: "Write the migration", description: "First step" });
    expect(created.status).toBe(201);
    expect(created.body.ticket).toMatchObject({
      key: "CRONK-2",
      title: "Write the migration",
      description: "First step",
      parent: { key: "CRONK-1" },
      assignee: { id: adaId, name: "Ada" },
      delegate: { id: claude.agentId, name: "claude-laptop" },
    });
    expect((await admin.get("/api/tickets/CRONK-1")).body.subTickets.map((t: { key: string }) => t.key)).toEqual(["CRONK-2"]);
  });

  it("are refused to Agent Sessions not holding the parent's Claim, but open to Users with Write", async () => {
    const { admin, session } = await delegatedSetup();
    const holder = await session();
    const other = await session();

    expect((await holder.post("/api/tickets/CRONK-1/sub-tickets", { title: "Too early" })).status).toBe(409);
    await holder.post("/api/tickets/CRONK-1/claim");
    expect((await other.post("/api/tickets/CRONK-1/sub-tickets", { title: "Not mine" })).status).toBe(409);
    expect((await admin.post("/api/tickets/CRONK-1/sub-tickets", { title: "Split by Ada" })).status).toBe(201);
    expect((await admin.get("/api/tickets/CRONK-1")).body.subTickets.map((t: { title: string }) => t.title)).toEqual(["Split by Ada"]);
  });
});

describe("The welcome", () => {
  it("lists the Agent's Ready Tickets in the order next offers them", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup(3);
    await admin.patch("/api/tickets/CRONK-3", { priority: "urgent" });
    await (await session()).post("/api/tickets/CRONK-1/claim");

    const started = await cronk.client(claude.secret).post("/api/agent-sessions");
    expect(started.body.welcome.readyTickets).toEqual([
      { key: "CRONK-3", title: "Ticket 3", priority: "urgent", status: expect.objectContaining({ category: "backlog" }) },
      { key: "CRONK-2", title: "Ticket 2", priority: "none", status: expect.objectContaining({ category: "backlog" }) },
    ]);
  });
});

describe("Claims and access", () => {
  it("are refused to read-only tokens and where the Project's Agent Access is Read, and such Tickets aren't offered", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup(1);
    const readOnly = (await admin.post(`/api/agents/${claude.agentId}/tokens`, { readOnly: true })).body.secret;
    const lookup = await startSession(cronk, readOnly);
    expect((await lookup.post("/api/tickets/CRONK-1/claim")).status).toBe(403);
    expect((await lookup.post("/api/agent-sessions/current/next")).body.next).toBeNull();

    await admin.patch("/api/projects/CRONK", { agentAccess: "read" });
    const agent = await session();
    expect((await agent.post("/api/tickets/CRONK-1/claim")).status).toBe(403);
    expect((await agent.post("/api/agent-sessions/current/next")).body.next).toBeNull();
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.readyTickets).toEqual([]);
  });

  it("end when the Ticket's Delegate changes", async () => {
    const { admin, session } = await delegatedSetup();
    await (await session()).post("/api/tickets/CRONK-1/claim");
    await admin.patch("/api/tickets/CRONK-1", { delegateId: null });
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
  });

  it("end with their Agent Session", async () => {
    const { admin, session } = await delegatedSetup();
    const first = await session();
    await first.post("/api/tickets/CRONK-1/claim");
    await first.delete("/api/agent-sessions/current");
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
    expect((await (await session()).post("/api/tickets/CRONK-1/claim")).status).toBe(200);
  });

  it("are never held by two Agent Sessions at once, whether they claim or ask for next", async () => {
    const { admin, session } = await delegatedSetup(1);
    const sessions = await Promise.all(Array.from({ length: 8 }, () => session()));

    const answers = await Promise.all(
      sessions.map((s, i) => (i % 2 ? s.post("/api/tickets/CRONK-1/claim") : s.post("/api/agent-sessions/current/next"))),
    );

    const winners = answers.filter((a) => (a.body.next ?? a.body)?.claim);
    expect(winners).toHaveLength(1);
    const holder = (winners[0]!.body.next ?? winners[0]!.body).claim.session.id;
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim.session.id).toBe(holder);
  });
});

describe("Context on claim", () => {
  it("gives the Claimed Ticket with its parent, Sub-Tickets, related Tickets, Reports and the Documents that mention it", async () => {
    const { cronk, admin, session } = await delegatedSetup(2);
    await admin.post("/api/tickets/CRONK-1/sub-tickets", { title: "Wire the cache", description: "Put the cache in front of search." });
    await admin.post("/api/tickets/CRONK-3/sub-tickets", { title: "Measure hits" });
    await admin.post("/api/tickets/CRONK-3/relations", { kind: "relates_to", ticketKey: "CRONK-2" });
    await admin.patch("/api/tickets/CRONK-3", { priority: "urgent" });

    const earlier = await session();
    await earlier.post("/api/tickets/CRONK-3/claim");
    const report = (await earlier.post("/api/tickets/CRONK-3/reports", { title: "First pass", body: "Halfway." })).body.report.id;
    await earlier.delete("/api/tickets/CRONK-3/claim");

    const design = (await admin.post("/api/projects/CRONK/documents", { title: "Design", body: "The cache (CRONK-3) sits in front." })).body.document.id;
    cronk.clock.advance(1_000);
    const runbook = (await admin.post("/api/workspace/documents", { title: "Runbook", body: "After CRONK-3 ships, warm the cache." })).body.document.id;
    await admin.post("/api/projects/CRONK/documents", { title: "Elsewhere", body: "CRONK-30, ACRONK-3 and cronk 3 are other things." });
    await admin.post("/api/projects", { name: "Hidden", key: "HIDDEN" });
    await admin.post("/api/projects/HIDDEN/documents", { title: "Hidden notes", body: "About CRONK-3." });
    await admin.patch("/api/projects/HIDDEN", { agentAccess: "none" });

    const agent = await session();
    const claimed = (await agent.post("/api/tickets/CRONK-3/claim")).body;
    expect(claimed.ticket).toMatchObject({ key: "CRONK-3", description: "Put the cache in front of search.", parent: { key: "CRONK-1", title: "Ticket 1" } });
    expect(claimed.subTickets.map((t: { key: string }) => t.key)).toEqual(["CRONK-4"]);
    expect(claimed.relations.relatesTo.map((t: { key: string }) => t.key)).toEqual(["CRONK-2"]);
    const documents = [
      { id: report, title: "First pass", projectKey: "CRONK", ticketKey: "CRONK-3", version: 1 },
      { id: runbook, title: "Runbook", projectKey: null, ticketKey: null, version: 1 },
      { id: design, title: "Design", projectKey: "CRONK", ticketKey: null, version: 1 },
    ];
    expect(claimed.documents).toEqual(documents.map((d) => expect.objectContaining(d)));

    await agent.delete("/api/tickets/CRONK-3/claim");
    const next = (await agent.post("/api/agent-sessions/current/next")).body.next;
    expect(next.ticket.key).toBe("CRONK-3");
    expect(next.documents).toEqual(documents.map((d) => expect.objectContaining(d)));
  });
});
