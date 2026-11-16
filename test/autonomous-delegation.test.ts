import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, registerAgent, type Client } from "./harness.js";

describe("Autonomous Delegation", () => {
  it("is off on a Ticket until a User turns it on, recorded as a Change", async () => {
    const { admin } = await delegatedSetup();
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.autonomous).toBe(false);

    const on = await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    expect(on.status).toBe(200);
    expect(on.body.ticket.autonomous).toBe(true);
    const off = await admin.patch("/api/tickets/CRONK-1", { autonomous: false });
    expect(off.body.ticket.autonomous).toBe(false);

    const { changes } = (await admin.get("/api/tickets/CRONK-1/changes")).body;
    expect(changes.slice(-2)).toMatchObject([
      { actor: { kind: "user", name: "Ada" }, change: "autonomous", from: false, to: true },
      { actor: { kind: "user", name: "Ada" }, change: "autonomous", from: true, to: false },
    ]);
  });

  it("is set only by Users, never by Agents, not even the Delegate holding the Claim", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const refused = await agent.patch("/api/tickets/CRONK-1", { autonomous: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Only a User/);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.autonomous).toBe(false);
  });
});

describe("Autonomous Delegation on Sub-Tickets", () => {
  it("is inherited by Sub-Tickets created later, including those the Agent splits off", async () => {
    const { admin, session } = await delegatedSetup();
    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const split = await agent.post("/api/tickets/CRONK-1/sub-tickets", { title: "First half" });
    expect(split.status).toBe(201);
    expect(split.body.ticket.autonomous).toBe(true);
    const byUser = await admin.post(`/api/tickets/${split.body.ticket.key}/sub-tickets`, { title: "A quarter" });
    expect(byUser.body.ticket.autonomous).toBe(true);
  });

  it("follows the parent when a User turns it on or off, all the way down", async () => {
    const { admin } = await delegatedSetup();
    const child = (await admin.post("/api/tickets/CRONK-1/sub-tickets", { title: "Child" })).body.ticket.key;
    const grandchild = (await admin.post(`/api/tickets/${child}/sub-tickets`, { title: "Grandchild" })).body.ticket.key;
    expect((await admin.get(`/api/tickets/${grandchild}`)).body.ticket.autonomous).toBe(false);

    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    expect((await admin.get(`/api/tickets/${child}`)).body.ticket.autonomous).toBe(true);
    expect((await admin.get(`/api/tickets/${grandchild}`)).body.ticket.autonomous).toBe(true);
    expect((await admin.get(`/api/tickets/${grandchild}/changes`)).body.changes.at(-1)).toMatchObject({
      actor: { kind: "user", name: "Ada" },
      change: "autonomous",
      from: false,
      to: true,
    });

    await admin.patch("/api/tickets/CRONK-1", { autonomous: false });
    expect((await admin.get(`/api/tickets/${grandchild}`)).body.ticket.autonomous).toBe(false);
  });
});

describe("A Project's Autonomous Delegation default", () => {
  it("is off until a User turns it on, and only Users change it", async () => {
    const { admin, session } = await delegatedSetup();
    expect((await admin.get("/api/projects/CRONK")).body.project.autonomousByDefault).toBe(false);

    const on = await admin.patch("/api/projects/CRONK", { autonomousByDefault: true });
    expect(on.status).toBe(200);
    expect(on.body.project.autonomousByDefault).toBe(true);
    expect((await admin.get("/api/projects/CRONK")).body.project.autonomousByDefault).toBe(true);

    const agent = await session();
    const refused = await agent.patch("/api/projects/CRONK", { autonomousByDefault: false });
    expect(refused.status).toBe(403);
    expect((await admin.get("/api/projects/CRONK")).body.project.autonomousByDefault).toBe(true);
  });

  it("pre-fills Autonomous Delegation when a User delegates a Ticket, unless the User says otherwise", async () => {
    const { admin, claude } = await delegatedSetup(3);
    await admin.patch("/api/projects/CRONK", { autonomousByDefault: true });
    // Already delegated: changing the default doesn't touch existing Delegations.
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.autonomous).toBe(false);

    for (const key of ["CRONK-1", "CRONK-2", "CRONK-3"]) await admin.patch(`/api/tickets/${key}`, { delegateId: null });
    expect((await admin.patch("/api/tickets/CRONK-1", { delegateId: claude.agentId })).body.ticket.autonomous).toBe(true);
    expect((await admin.patch("/api/tickets/CRONK-2", { delegateId: claude.agentId, autonomous: false })).body.ticket.autonomous).toBe(false);

    await admin.patch("/api/projects/CRONK", { autonomousByDefault: false });
    await admin.patch("/api/tickets/CRONK-3", { autonomous: true });
    expect((await admin.patch("/api/tickets/CRONK-3", { delegateId: claude.agentId })).body.ticket.autonomous).toBe(false);
  });
});

/** The id of the CRONK Status in `category`. */
async function statusIn(admin: Client, category: string): Promise<string> {
  return ((await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[]).find((s) => s.category === category)!.id;
}

describe("An Agent's completion under Autonomous Delegation", () => {
  it("needs a Report written during its Claim, then is recorded Unverified and ends the Claim", async () => {
    const { admin, session } = await delegatedSetup();
    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    const done = await statusIn(admin, "completed");
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const refused = await agent.patch("/api/tickets/CRONK-1", { statusId: done });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Write a Report on CRONK-1/);

    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed the cache." });
    const completed = await agent.patch("/api/tickets/CRONK-1", { statusId: done });
    expect(completed.status).toBe(200);
    expect(completed.body.ticket).toMatchObject({ status: { category: "completed" }, verification: "unverified" });
    const detail = (await admin.get("/api/tickets/CRONK-1")).body;
    expect(detail.ticket.verification).toBe("unverified");
    expect(detail.claim).toBeNull();
    expect((await admin.get("/api/tickets/CRONK-1/changes")).body.changes.slice(-2)).toMatchObject([
      { actor: { kind: "agent", session: { id: agent.sessionId } }, change: "status", to: { category: "completed" } },
      { actor: { kind: "agent", session: { id: agent.sessionId } }, change: "verification", from: null, to: "unverified" },
    ]);
  });

  it("is refused once a User turns Autonomous Delegation off, and for every Agent without it", async () => {
    const { admin, session } = await delegatedSetup();
    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    const done = await statusIn(admin, "completed");
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed the cache." });

    await admin.patch("/api/tickets/CRONK-1", { autonomous: false });
    const refused = await agent.patch("/api/tickets/CRONK-1", { statusId: done });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Autonomous Delegation/);
    expect((await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "canceled") })).status).toBe(403);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.status.category).toBe("backlog");
  });

  it("can't cancel or shelve work: completing is all Autonomous Delegation adds", async () => {
    const { admin, session } = await delegatedSetup();
    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed the cache." });

    expect((await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "canceled") })).status).toBe(403);
    expect((await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "started") })).status).toBe(200);
    expect((await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "backlog") })).status).toBe(403);
  });

  it("isn't how a User's completion is recorded: theirs needs no Verification", async () => {
    const { admin } = await delegatedSetup();
    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.verification).toBeNull();
    const completed = await admin.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "completed") });
    expect(completed.body.ticket.verification).toBeNull();
  });
});

describe("An Unverified completion", () => {
  it("counts as finished for blocking: the Tickets it blocked become Ready for their Delegate", async () => {
    const { admin, session } = await delegatedSetup(2);
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    const agent = await session();
    expect((await agent.post("/api/tickets/CRONK-2/claim")).status).toBe(409);

    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed the cache." });
    const events = await agent.events("/api/agent-sessions/current/events");
    expect((await events.next())?.event).toBe("ready");
    await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "completed") });

    expect(await events.next()).toMatchObject({ event: "ticketReady", data: { ticket: { key: "CRONK-2" } } });
    expect((await agent.post("/api/tickets/CRONK-2/claim")).status).toBe(200);
  });
});

/** Has the Agent of `session` complete CRONK-`n` under Autonomous Delegation, with a Report. */
async function completeAutonomously(admin: Client, agent: Client, key = "CRONK-1") {
  await admin.patch(`/api/tickets/${key}`, { autonomous: true });
  await agent.post(`/api/tickets/${key}/claim`);
  const report = (await agent.post(`/api/tickets/${key}/reports`, { title: `Done with ${key}`, body: "Fixed the cache." })).body.report;
  const moved = await agent.patch(`/api/tickets/${key}`, { statusId: await statusIn(admin, "completed") });
  if (moved.status !== 200) throw new Error(`Completing ${key} failed: ${JSON.stringify(moved.body)}`);
  return report;
}

describe("The Inbox's Unverified group", () => {
  it("holds the Assignee's Unverified completions with their Reports, until a User Accepts them", async () => {
    const { admin, claude, session } = await delegatedSetup(2);
    const agent = await session();
    const report = await completeAutonomously(admin, agent);
    // A User's own completion needs no Verification, so it never reaches the Inbox.
    await admin.patch("/api/tickets/CRONK-2", { statusId: await statusIn(admin, "completed") });

    const { items } = (await admin.get("/api/inbox")).body;
    expect(items).toMatchObject([
      { kind: "unverified", at: "2026-01-01T09:00:00.000Z", ticket: { key: "CRONK-1", verification: "unverified" }, reports: [{ id: report.id, title: "Done with CRONK-1" }] },
    ]);
    expect((await admin.get("/api/inbox?kind=review")).body.items).toEqual([]);
    expect((await admin.get(`/api/inbox?kind=unverified&agent=${claude.agentId}`)).body.items).toHaveLength(1);

    const accepted = await admin.post("/api/tickets/CRONK-1/accept");
    expect(accepted.status).toBe(200);
    expect(accepted.body.ticket).toMatchObject({ status: { category: "completed" }, verification: "verified" });
    expect((await admin.get("/api/tickets/CRONK-1/changes")).body.changes.at(-1)).toMatchObject({
      actor: { kind: "user", name: "Ada" },
      change: "verification",
      from: "unverified",
      to: "verified",
    });
    expect((await admin.get("/api/inbox")).body.items).toEqual([]);
  });

  it("tells the Assignee's open Inbox when a completion arrives and when it is Accepted", async () => {
    const { admin, session } = await delegatedSetup();
    const inbox = await admin.events("/api/inbox/events");
    expect((await inbox.next())?.event).toBe("ready");
    const agent = await session();
    await completeAutonomously(admin, agent);
    expect((await inbox.next())?.event).toBe("changed");
    await admin.post("/api/tickets/CRONK-1/accept");
    expect((await inbox.next())?.event).toBe("changed");
  });
});

describe("Accept", () => {
  it("is only for an Unverified completion, and only for Users with Write", async () => {
    const { cronk, admin, session } = await delegatedSetup(2);
    expect((await admin.post("/api/tickets/CRONK-2/accept")).status).toBe(409);
    const agent = await session();
    await completeAutonomously(admin, agent);

    const byAgent = await agent.post("/api/tickets/CRONK-1/accept");
    expect(byAgent.status).toBe(403);
    const reader = await joinAs(cronk, admin, "rita@example.com");
    const ritaId = (await reader.get("/api/me")).body.user.id;
    await admin.put(`/api/projects/CRONK/members/${ritaId}`, { access: "read" });
    expect((await reader.post("/api/tickets/CRONK-1/accept")).status).toBe(403);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.verification).toBe("unverified");

    expect((await admin.post("/api/tickets/CRONK-1/accept")).status).toBe(200);
    const again = await admin.post("/api/tickets/CRONK-1/accept");
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/isn't an Unverified completion/);
  });

  it("is ended by moving the Ticket out of Completed, which ends its Verification", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await completeAutonomously(admin, agent);
    const moved = await admin.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "started") });
    expect(moved.body.ticket.verification).toBeNull();
    expect((await admin.get("/api/inbox")).body.items).toEqual([]);
  });
});

describe("A question under Autonomous Delegation", () => {
  it("never blocks: asked as blocking, it is recorded as non-blocking and lands in the Owner's Inbox", async () => {
    const { admin, session } = await delegatedSetup(2);
    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const asked = await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Which cache?", blocking: true });
    expect(asked.status).toBe(201);
    expect(asked.body.activity).toMatchObject({ kind: "question", blocking: false });
    expect((await admin.get("/api/inbox")).body.items).toMatchObject([
      { kind: "question", ticket: { key: "CRONK-1" }, question: { body: "Which cache?", blocking: false } },
    ]);

    // Without Autonomous Delegation the Agent may still wait on its answer.
    await agent.post("/api/tickets/CRONK-2/claim");
    const waiting = await agent.post("/api/tickets/CRONK-2/activities", { kind: "question", body: "Which queue?", blocking: true });
    expect(waiting.body.activity.blocking).toBe(true);
  });
});

describe("Verification", () => {
  it("can't be reset by an Agent sending a Ticket's current Completed Status again", async () => {
    const { admin, session } = await delegatedSetup(2);
    const agent = await session();
    await completeAutonomously(admin, agent);
    await admin.post("/api/tickets/CRONK-1/accept");
    const done = await statusIn(admin, "completed");
    await admin.patch("/api/tickets/CRONK-2", { statusId: done });

    for (const key of ["CRONK-1", "CRONK-2"]) await agent.patch(`/api/tickets/${key}`, { statusId: done });
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.verification).toBe("verified");
    expect((await admin.get("/api/tickets/CRONK-2")).body.ticket.verification).toBeNull();
  });
});

describe("A Ticket moved under another", () => {
  it("takes on its new parent's Autonomous Delegation, with its own Sub-Tickets", async () => {
    const { admin } = await delegatedSetup(2);
    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    const child = (await admin.post("/api/tickets/CRONK-2/sub-tickets", { title: "Child" })).body.ticket.key;

    const moved = await admin.patch("/api/tickets/CRONK-2", { parentKey: "CRONK-1" });
    expect(moved.body.ticket.autonomous).toBe(true);
    expect((await admin.get(`/api/tickets/${child}`)).body.ticket.autonomous).toBe(true);
    // Moved out again, it keeps what it had until a User changes it.
    expect((await admin.patch("/api/tickets/CRONK-2", { parentKey: null })).body.ticket.autonomous).toBe(true);
  });
});

describe("Reopen", () => {
  it("needs a reason, then sends the Unverified completion back to the same Delegate in a Started Status, Ready again", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await completeAutonomously(admin, agent);

    expect((await admin.post("/api/tickets/CRONK-1/reopen", { comment: " ", dependents: {} })).status).toBe(400);
    const events = await agent.events("/api/agent-sessions/current/events");
    expect((await events.next())?.event).toBe("ready");

    const reopened = await admin.post("/api/tickets/CRONK-1/reopen", { comment: "The cache isn't cleared on moves.", dependents: {} });
    expect(reopened.status).toBe(200);
    expect(reopened.body.ticket).toMatchObject({ status: { category: "started" }, verification: null, delegate: { id: claude.agentId } });
    expect(reopened.body.comment).toMatchObject({ body: "The cache isn't cleared on moves." });
    expect((await admin.get("/api/tickets/CRONK-1/changes")).body.changes.slice(-2)).toMatchObject([
      { actor: { kind: "user", name: "Ada" }, change: "status", to: { category: "started" }, reopened: true },
      { actor: { kind: "user", name: "Ada" }, change: "verification", from: "unverified", to: null },
    ]);
    expect((await admin.get("/api/inbox")).body.items).toEqual([]);
    // The Delegate is told: the Ticket is Ready for it again, and the reason waits for it.
    const told = [await events.next(), await events.next()].map((e) => e?.event).sort();
    expect(told).toEqual(["ticketReady", "waiting"]);
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toMatchObject([
      { reason: "comment", comment: { body: "The cache isn't cleared on moves." }, ticket: { key: "CRONK-1" } },
    ]);
  });

  it("is only for an Unverified completion, and only for Users with Write", async () => {
    const { cronk, admin, session } = await delegatedSetup(2);
    const reason = { comment: "Not right.", dependents: {} };
    expect((await admin.post("/api/tickets/CRONK-2/reopen", reason)).status).toBe(409);
    const agent = await session();
    await completeAutonomously(admin, agent);

    expect((await agent.post("/api/tickets/CRONK-1/reopen", reason)).status).toBe(403);
    const reader = await joinAs(cronk, admin, "rita@example.com");
    const ritaId = (await reader.get("/api/me")).body.user.id;
    await admin.put(`/api/projects/CRONK/members/${ritaId}`, { access: "read" });
    expect((await reader.post("/api/tickets/CRONK-1/reopen", reason)).status).toBe(403);

    await admin.post("/api/tickets/CRONK-1/accept");
    const verified = await admin.post("/api/tickets/CRONK-1/reopen", reason);
    expect(verified.status).toBe(409);
    expect(verified.body.error).toMatch(/isn't an Unverified completion/);
  });
});

/**
 * Ada's CRONK-1, completed by claude-laptop on its own, blocking CRONK-2 to CRONK-5 (of `tickets`), which continued on it:
 * CRONK-2 and CRONK-3 Started under the Agent's Claims, CRONK-4 and CRONK-5 completed by it, Unverified.
 */
async function continuedSetup(tickets = 5) {
  const setup = await delegatedSetup(tickets);
  const { admin, session } = setup;
  for (let i = 2; i <= tickets; i++) await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: `CRONK-${i}` });
  const agent = await session();
  await completeAutonomously(admin, agent);
  const started = await statusIn(admin, "started");
  for (const key of ["CRONK-2", "CRONK-3"]) {
    await agent.post(`/api/tickets/${key}/claim`);
    await agent.patch(`/api/tickets/${key}`, { statusId: started });
  }
  for (const key of ["CRONK-4", "CRONK-5"]) await completeAutonomously(admin, agent, key);
  return { ...setup, agent };
}

describe("Reopen with dependents that continued", () => {
  it("needs a fitting choice for each one, and none for the others", async () => {
    const { admin } = await continuedSetup(6);
    const reopen = (dependents: Record<string, string>) => admin.post("/api/tickets/CRONK-1/reopen", { comment: "Not right.", dependents });
    const all = { "CRONK-2": "keep", "CRONK-3": "pause", "CRONK-4": "keep", "CRONK-5": "reopen" };

    const missing = await reopen({ "CRONK-2": "keep", "CRONK-3": "pause", "CRONK-4": "keep" });
    expect(missing.status).toBe(409);
    expect(missing.body.error).toMatch(/CRONK-5/);
    expect((await reopen({ ...all, "CRONK-2": "reopen" })).status).toBe(400);
    expect((await reopen({ ...all, "CRONK-4": "pause" })).status).toBe(400);
    // CRONK-6 is in Backlog: it hasn't continued, so it takes no choice.
    expect((await reopen({ ...all, "cronk-6": "keep" })).status).toBe(400);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.verification).toBe("unverified");

    expect((await reopen({ ...all, "cronk-2": "keep" } as Record<string, string>)).status).toBe(400);
    expect((await reopen(all)).status).toBe(200);
  });

  it("tells the watchers of a dependent it blocks again, even one kept as it is", async () => {
    const { admin } = await continuedSetup(6);
    const stream = await admin.events("/api/tickets/CRONK-6/events");
    expect((await stream.next())?.event).toBe("ready");
    await admin.post("/api/tickets/CRONK-1/reopen", {
      comment: "Not right.",
      dependents: { "CRONK-2": "keep", "CRONK-3": "keep", "CRONK-4": "keep", "CRONK-5": "keep" },
    });
    // Its Delegate's note arrives as a Comment too.
    const events = [await stream.next(), await stream.next()].map((e) => e?.event).sort();
    expect(events).toEqual(["changed", "comment"]);
  });

  it("blocks them again: a dependent not yet taken up is no longer Ready", async () => {
    const { admin, session } = await continuedSetup(6);
    const agent = await session();
    await admin.post("/api/tickets/CRONK-1/reopen", {
      comment: "Not right.",
      dependents: { "CRONK-2": "keep", "CRONK-3": "keep", "CRONK-4": "keep", "CRONK-5": "keep" },
    });
    const refused = await agent.post("/api/tickets/CRONK-6/claim");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/blocked by CRONK-1/);
  });
});

describe("Reopen's choice for each dependent", () => {
  const dependents = { "CRONK-2": "keep", "CRONK-3": "pause", "CRONK-4": "keep", "CRONK-5": "reopen" };

  it("keeps a Started one going under its Claim, or pauses it: Claim released, back in Unstarted", async () => {
    const { admin, agent } = await continuedSetup();
    expect((await admin.post("/api/tickets/CRONK-1/reopen", { comment: "Not right.", dependents })).status).toBe(200);

    const kept = (await admin.get("/api/tickets/CRONK-2")).body;
    expect(kept.ticket.status.category).toBe("started");
    expect(kept.claim).toMatchObject({ session: { id: agent.sessionId } });
    const paused = (await admin.get("/api/tickets/CRONK-3")).body;
    expect(paused.ticket.status.category).toBe("unstarted");
    expect(paused.claim).toBeNull();
    expect((await admin.get("/api/tickets/CRONK-3/changes")).body.changes.at(-1)).toMatchObject({
      actor: { kind: "user", name: "Ada" },
      change: "status",
      from: { category: "started" },
      to: { category: "unstarted" },
    });
    // Paused behind the Reopened Ticket, it waits until that is finished again.
    const claimed = await agent.post("/api/tickets/CRONK-3/claim");
    expect(claimed.status).toBe(409);
    expect(claimed.body.error).toMatch(/blocked by CRONK-1/);
  });

  it("keeps an Unverified one as it is, or Reopens it too, back to its Delegate", async () => {
    const { admin, claude } = await continuedSetup();
    await admin.post("/api/tickets/CRONK-1/reopen", { comment: "Not right.", dependents });

    expect((await admin.get("/api/tickets/CRONK-4")).body.ticket).toMatchObject({ status: { category: "completed" }, verification: "unverified" });
    expect((await admin.get("/api/tickets/CRONK-5")).body.ticket).toMatchObject({
      status: { category: "started" },
      verification: null,
      delegate: { id: claude.agentId },
    });
    expect((await admin.get("/api/tickets/CRONK-5/changes")).body.changes.at(-2)).toMatchObject({ change: "status", reopened: true });
    expect((await admin.get("/api/inbox")).body.items).toMatchObject([{ kind: "unverified", ticket: { key: "CRONK-4" } }]);
  });

  it("tells every dependent's Agent about it as Waiting Work, with the reason and what it means there", async () => {
    const { cronk, admin, adaId, claude } = await continuedSetup(7);
    // CRONK-6 hasn't started; CRONK-7, with no Delegate, has no Agent to tell.
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-7" });
    await admin.patch("/api/tickets/CRONK-7", { delegateId: null });
    // CRONK-5's own dependent belonged to another Agent, which learns of it too.
    const codex = await registerAgent(admin, "codex");
    const next = (await admin.post("/api/projects/CRONK/tickets", { title: "After 5" })).body.ticket.key;
    await admin.patch(`/api/tickets/${next}`, { assigneeId: adaId, delegateId: codex.agentId });
    await admin.post("/api/tickets/CRONK-5/relations", { kind: "blocks", ticketKey: next });
    await cronk.client(codex.secret).post("/api/agent-sessions");

    await admin.post("/api/tickets/CRONK-1/reopen", { comment: "Moves don't clear the cache.", dependents });

    const waiting = (await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork as WaitingItem[];
    const byTicket = Object.fromEntries(waiting.map((w) => [w.ticket.key, w.comment.body]));
    expect(Object.keys(byTicket).sort()).toEqual(["CRONK-1", "CRONK-2", "CRONK-3", "CRONK-4", "CRONK-5", "CRONK-6"]);
    expect(byTicket["CRONK-1"]).toBe("Moves don't clear the cache.");
    expect(byTicket["CRONK-2"]).toBe("CRONK-1 was Reopened, and this Ticket builds on it. You may keep going; check whether your work is affected.\n\n> Moves don't clear the cache.");
    expect(byTicket["CRONK-3"]).toMatch(/^CRONK-1 was Reopened, and this Ticket builds on it\. It is paused: its Claim is released and it is back in Todo/);
    expect(byTicket["CRONK-4"]).toMatch(/Check whether the work here is affected\./);
    expect(byTicket["CRONK-5"]).toMatch(/It is Reopened along with it\./);
    expect(byTicket["CRONK-6"]).toMatch(/^CRONK-1 was Reopened/);
    const codexWaiting = (await cronk.client(codex.secret).post("/api/agent-sessions")).body.welcome.waitingWork as WaitingItem[];
    expect(codexWaiting.map((w) => [w.ticket.key, w.comment.body])).toEqual([[next, expect.stringMatching(/^CRONK-5 was Reopened, and this Ticket builds on it/)]]);
  });
});

interface WaitingItem {
  ticket: { key: string };
  comment: { body: string };
}
