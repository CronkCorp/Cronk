import { describe, expect, it } from "vitest";
import { agentOf, delegatedSetup, joinAs, startInstalledCronk, type Client } from "./harness.js";

/** The Inbox of `client`, as `kind key` lines, in order: a Decision's key, or a Ticket's. */
const inboxLines = async (client: Client) =>
  ((await client.get("/api/inbox")).body.items as { kind: string; decision?: { key: string }; ticket: { key: string } | null }[]).map(
    (i) => `${i.kind} ${i.decision?.key ?? i.ticket?.key}`,
  );

describe("an Agent proposing a Decision", () => {
  it("records it as proposed, by the Agent in its Agent Session", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await agentOf(cronk, admin, "claude-laptop");

    const proposed = await claude.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions", body: "We keep them as Markdown." });

    expect(proposed.status).toBe(201);
    expect(proposed.body.decision).toMatchObject({
      key: "CRONK-D1",
      status: "proposed",
      proposedBy: { kind: "agent", name: "claude-laptop", session: { id: claude.sessionId } },
    });
    expect((await claude.post("/api/workspace/decisions", { title: "Compose for installs" })).body.decision).toMatchObject({ key: "D1", status: "proposed" });
  });
});

describe("an Agent refining a proposed Decision", () => {
  it("saves new Versions while it is proposed, and is refused once a User has changed its status", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await claude.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions", body: "v1" });

    const refined = await claude.patch("/api/decisions/CRONK-D1", { baseVersion: 1, body: "v2" });
    expect(refined.status).toBe(200);
    expect(refined.body.decision).toMatchObject({ body: "v2", version: 2, status: "proposed" });
    expect((await admin.get("/api/decisions/CRONK-D1/versions/2")).body.version.actor).toMatchObject({ kind: "agent", name: "claude-laptop" });

    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    const refused = await claude.patch("/api/decisions/CRONK-D1", { baseVersion: 3, body: "v3" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/proposed/);
    expect((await admin.get("/api/decisions/CRONK-D1")).body.decision).toMatchObject({ body: "v2", version: 3, status: "accepted" });
  });
});

describe("rejecting a Decision", () => {
  it("needs a reason, which the Decision and its Version keep", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await claude.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions" });

    for (const reason of [undefined, "   "]) {
      const refused = await admin.post("/api/decisions/CRONK-D1/status", { status: "rejected", ...(reason === undefined ? {} : { reason }) });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/reason/);
    }
    const rejected = await admin.post("/api/decisions/CRONK-D1/status", { status: "rejected", reason: "  We already store them in Postgres.  " });

    expect(rejected.status).toBe(200);
    expect(rejected.body.decision).toMatchObject({ status: "rejected", version: 2, statusReason: "We already store them in Postgres." });
    expect((await admin.get("/api/decisions/CRONK-D1/versions/2")).body.version).toMatchObject({ status: "rejected", statusReason: "We already store them in Postgres." });
    // Taken up again, it no longer carries the reason it was rejected for; its history does.
    expect((await admin.post("/api/decisions/CRONK-D1/status", { status: "proposed" })).body.decision.statusReason).toBeNull();
    expect((await admin.get("/api/decisions/CRONK-D1/versions/1")).body.version.statusReason).toBeNull();
  });
});

describe("a proposed Decision in the Inbox", () => {
  it("goes to the Agent's Owner when proposed outside any Claim, until a User accepts it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await admin.post("/api/projects/CRONK/decisions", { title: "A User's own proposal" });
    cronk.clock.advance(60_000);
    await claude.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions", body: "We keep them as Markdown." });
    cronk.clock.advance(60_000);
    await claude.post("/api/workspace/decisions", { title: "Compose for installs" });

    const inbox = (await admin.get("/api/inbox")).body.items;
    expect(inbox).toMatchObject([
      {
        kind: "decision",
        at: "2026-01-01T09:01:00.000Z",
        decision: { key: "CRONK-D2", title: "Markdown for Decisions", body: "We keep them as Markdown.", status: "proposed", proposedBy: { name: "claude-laptop" }, sourceTicket: null },
        ticket: null,
      },
      { kind: "decision", decision: { key: "D1" }, ticket: null },
    ]);
    expect(await inboxLines(bob)).toEqual([]);
    expect((await admin.get("/api/inbox?kind=review")).body.items).toEqual([]);
    expect((await admin.get("/api/inbox?kind=decision")).body.items).toHaveLength(2);
    expect((await admin.get("/api/inbox?project=CRONK")).body.items.map((i: { decision: { key: string } }) => i.decision.key)).toEqual(["CRONK-D2"]);

    await bob.post("/api/decisions/CRONK-D2/status", { status: "accepted" });
    expect(await inboxLines(admin)).toEqual(["decision D1"]);
  });

  it("goes to the Assignee of the Ticket the Agent held the Claim on, even once reassigned, until a User rejects it", async () => {
    const { cronk, admin, session } = await delegatedSetup(2);
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const proposed = await agent.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions" });

    expect(proposed.body.decision.sourceTicket).toEqual({ key: "CRONK-1", title: "Ticket 1" });
    expect((await admin.get("/api/inbox")).body.items).toMatchObject([
      { kind: "decision", decision: { key: "CRONK-D1" }, ticket: { key: "CRONK-1", title: "Ticket 1", status: { name: expect.any(String) } } },
    ]);
    // The Ticket's new Assignee reviews it now, not the Agent's Owner.
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: bobId });
    expect(await inboxLines(admin)).toEqual([]);
    expect(await inboxLines(bob)).toEqual(["decision CRONK-D1"]);

    await admin.post("/api/decisions/CRONK-D1/status", { status: "rejected", reason: "We keep them in Postgres." });
    expect(await inboxLines(bob)).toEqual([]);
  });

  it("names a source Ticket only if the Agent Session holds its Claim, and asks which when it holds several", async () => {
    const { admin, session } = await delegatedSetup(2);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-2/claim");

    // Holding two Claims, the Agent names the one the Decision came from.
    const named = await agent.post("/api/projects/CRONK/decisions", { title: "From the second", ticket: "cronk-2" });
    expect(named.body.decision.sourceTicket).toMatchObject({ key: "CRONK-2" });
    const unnamed = await agent.post("/api/projects/CRONK/decisions", { title: "From either" });
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.error).toMatch(/CRONK-1, CRONK-2/);
    await admin.post("/api/projects/CRONK/tickets", { title: "Not claimed" });
    const refused = await agent.post("/api/projects/CRONK/decisions", { title: "From elsewhere", ticket: "CRONK-3" });
    expect(refused.status).toBe(409);
    expect((await admin.post("/api/projects/CRONK/decisions", { title: "A User's", ticket: "CRONK-1" })).status).toBe(400);
  });

  it("names a source Ticket only where everyone who reads the Decision can read the Ticket", async () => {
    const { admin, session } = await delegatedSetup(1);
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    await admin.post("/api/projects", { name: "Site", key: "SITE" });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    // A Decision of another Project, or of the Workspace while the Ticket's Project is private, comes from no Ticket.
    expect((await agent.post("/api/projects/SITE/decisions", { title: "Elsewhere" })).body.decision.sourceTicket).toBeNull();
    expect((await agent.post("/api/workspace/decisions", { title: "Everywhere" })).body.decision.sourceTicket).toBeNull();
    const named = await agent.post("/api/workspace/decisions", { title: "Named", ticket: "CRONK-1" });
    expect(named.status).toBe(400);
    expect(named.body.error).toMatch(/private/);
    expect((await agent.post("/api/projects/CRONK/decisions", { title: "Here" })).body.decision.sourceTicket).toMatchObject({ key: "CRONK-1" });
    await admin.patch("/api/projects/CRONK", { visibility: "open" });
    expect((await agent.post("/api/workspace/decisions", { title: "Open now" })).body.decision.sourceTicket).toMatchObject({ key: "CRONK-1" });
  });
});

describe("a proposed Decision's reviewer", () => {
  it("hears on their open Inbox when one arrives, is refined, and is accepted", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await agentOf(cronk, admin, "claude-laptop");
    const inbox = await admin.events("/api/inbox/events");
    expect((await inbox.next())?.event).toBe("ready");

    await claude.post("/api/workspace/decisions", { title: "Compose for installs" });
    expect((await inbox.next())?.event).toBe("changed");
    await claude.patch("/api/decisions/D1", { baseVersion: 1, body: "Use Compose." });
    expect((await inbox.next())?.event).toBe("changed");
    await admin.post("/api/decisions/D1/status", { status: "accepted" });
    expect((await inbox.next())?.event).toBe("changed");
  });

  it("hears when one leaves their Inbox because an accepted Decision superseded it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await claude.post("/api/workspace/decisions", { title: "Compose for installs" });
    const grace = await joinAs(cronk, admin, "grace@example.com");
    await grace.post("/api/workspace/decisions", { title: "A single binary", supersedes: ["D1"] });
    const inbox = await admin.events("/api/inbox/events");
    expect((await inbox.next())?.event).toBe("ready");

    await grace.post("/api/decisions/D2/status", { status: "accepted" });

    expect((await inbox.next())?.event).toBe("changed");
    expect(await inboxLines(admin)).toEqual([]);
  });
});

describe("rejecting an Agent's proposed Decision", () => {
  it("tells the Agent why, as Waiting Work in the welcome of its next Agent Session", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions" });
    await admin.post("/api/projects/CRONK/decisions", { title: "A User's own" });
    cronk.clock.advance(60_000);

    await admin.post("/api/decisions/CRONK-D1/status", { status: "rejected", reason: "We keep them in Postgres." });
    await admin.post("/api/decisions/CRONK-D2/status", { status: "rejected", reason: "Nobody to tell." });

    const welcomed = await cronk.client(claude.secret).post("/api/agent-sessions");
    expect(welcomed.body.welcome.waitingWork).toEqual([
      {
        reason: "rejected",
        comment: null,
        decision: {
          key: "CRONK-D1",
          title: "Markdown for Decisions",
          reason: "We keep them in Postgres.",
          rejectedBy: { kind: "user", id: expect.any(String), name: "Ada" },
          at: "2026-01-01T09:01:00.000Z",
        },
        ticket: { key: "CRONK-1", title: "Ticket 1" },
        document: null,
      },
    ]);
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toEqual([]);
  });

  it("pushes the reason to the Agent's live Agent Sessions", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await claude.post("/api/workspace/decisions", { title: "Compose for installs" });
    const stream = await claude.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.post("/api/decisions/D1/status", { status: "rejected", reason: "We ship a binary." });

    expect(await stream.next()).toMatchObject({
      event: "waiting",
      data: { waiting: { reason: "rejected", comment: null, decision: { key: "D1", reason: "We ship a binary." }, ticket: null, document: null } },
    });
  });
});

describe("a Report", () => {
  it("lists the Decisions its Agent Session proposed during the Claim it was written in", async () => {
    const { admin, session } = await delegatedSetup(2);
    const agent = await session();
    await agent.post("/api/projects/CRONK/decisions", { title: "Before any Claim" });
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions" });
    await agent.post("/api/workspace/decisions", { title: "Compose for installs" });
    await agent.post("/api/tickets/CRONK-1/reports", { title: "What I did", body: "Proposed two Decisions." });
    await agent.post("/api/tickets/CRONK-2/claim");
    await agent.post("/api/projects/CRONK/decisions", { title: "From the other Ticket", ticket: "CRONK-2" });
    await admin.post("/api/decisions/CRONK-D2/status", { status: "accepted" });

    const [report] = (await admin.get("/api/tickets/CRONK-1/reports")).body.reports;
    expect(report.decisions).toEqual([
      { key: "CRONK-D2", title: "Markdown for Decisions", status: "accepted" },
      { key: "D1", title: "Compose for installs", status: "proposed" },
    ]);
    expect((await admin.get("/api/projects/CRONK/reports")).body.reports[0].decisions).toHaveLength(2);
  });
});
