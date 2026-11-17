import { describe, expect, it } from "vitest";
import { agentOf, delegatedSetup, joinAs, memberPassword, registerAgent, startInstalledCronk, startSession, type Client, type Response } from "./harness.js";

/** The waiting items at `path` as `client` sees them, as `kind key` lines, in order: a Decision's key, or a Ticket's. */
const waitingLines = async (client: Client, path: string) =>
  ((await client.get(path)).body.items as { kind: string; decision?: { key: string }; ticket: { key: string } | null }[]).map(
    (i) => `${i.kind} ${i.decision?.key ?? i.ticket?.key}`,
  );

/** The Inbox of `client`, as `kind key` lines. */
const inboxLines = (client: Client) => waitingLines(client, "/api/inbox");

/** The Triage of `client`, as `kind key` lines. */
const triageLines = (client: Client, query = "") => waitingLines(client, `/api/triage${query}`);

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

  /** Starts a release of CRONK-1's Claim that waits on the Ticket, then `propose`, which waits behind it; answers both once let through. */
  async function proposeBehindRelease(propose: (agent: Client) => Promise<Response>) {
    const { cronk, session } = await delegatedSetup(1);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const ticketId = (await agent.get("/api/tickets/CRONK-1")).body.ticket.id;

    const held = await cronk.holdRow("tickets", ticketId);
    const release = agent.delete("/api/tickets/CRONK-1/claim");
    await held.waiters(1);
    const proposing = propose(agent);
    expect(await Promise.race([proposing.then(() => "proposed"), held.waiters(2).then(() => "waited")])).toBe("waited");
    await held.release();
    return { released: await release, proposed: await proposing };
  }

  it("waits for a release of its source Claim committed first, and is refused naming the Ticket", async () => {
    const { released, proposed } = await proposeBehindRelease((agent) => agent.post("/api/projects/CRONK/decisions", { title: "Raced", ticket: "CRONK-1" }));
    expect(released.status).toBe(204);
    expect(proposed.status).toBe(409);
    expect(proposed.body.error).toMatch(/Claim CRONK-1 in your Agent Session before naming it as the Ticket a Decision came from/);
  });

  it("waits for a release of its source Claim committed first, and records no source naming none", async () => {
    const { released, proposed } = await proposeBehindRelease((agent) => agent.post("/api/projects/CRONK/decisions", { title: "Raced" }));
    expect(released.status).toBe(204);
    expect(proposed.status).toBe(201);
    expect(proposed.body.decision.sourceTicket).toBeNull();
  });

  it("holds a release of its source Claim until it commits, so the Claim it records was live", async () => {
    const { cronk, session } = await delegatedSetup(1);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    // Recording the Decision's first Version waits, after the Decision has found its source Claim.
    const held = await cronk.holdTable("decision_versions");
    const proposing = agent.post("/api/projects/CRONK/decisions", { title: "First", ticket: "CRONK-1" });
    await held.waiters(1);
    const release = agent.delete("/api/tickets/CRONK-1/claim");
    expect(await Promise.race([release.then(() => "released"), held.waiters(2).then(() => "waited")])).toBe("waited");
    await held.release();

    const proposed = await proposing;
    expect(proposed.status).toBe(201);
    expect(proposed.body.decision.sourceTicket).toMatchObject({ key: "CRONK-1" });
    expect((await release).status).toBe(204);
  });

  it("locks its Project before its source Ticket, as filing a Discovered Ticket from the same Claim does", async () => {
    const { cronk, admin, session } = await delegatedSetup(1);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const projectId = (await admin.get("/api/projects/CRONK")).body.project.id;

    // The Discovered Ticket waits on the Project first, then the Decision does.
    const held = await cronk.holdRow("projects", projectId);
    const filing = agent.post("/api/projects/CRONK/tickets", { title: "Found", ticket: "CRONK-1" });
    await held.waiters(1);
    const proposing = agent.post("/api/projects/CRONK/decisions", { title: "Meanwhile", ticket: "CRONK-1" });
    await held.waiters(2);
    await held.release();

    // Neither is aborted as a deadlock.
    expect((await filing).status).toBe(201);
    expect((await proposing).status).toBe(201);
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
        artifact: null,
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

/**
 * Ada, the Admin, with the private Project CRONK; Carol, who owns carol-bot; Dave, Assignee of CRONK-1, from which carol-bot proposed
 * CRONK-D1 while it held the Claim; Wendy, with Write in CRONK; Rita, with Read there; and Bob, who can't see CRONK.
 */
async function decisionFromDavesTicket() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  await admin.post("/api/projects/CRONK/tickets", { title: "Fix the cache" });
  const join = async (name: string) => {
    const client = await joinAs(cronk, admin, `${name}@example.com`);
    return { client, id: (await client.get("/api/me")).body.user.id as string };
  };
  const [carol, dave, wendy, rita, bob] = [await join("carol"), await join("dave"), await join("wendy"), await join("rita"), await join("bob")];
  for (const id of [carol.id, dave.id, wendy.id]) await admin.put(`/api/projects/CRONK/members/${id}`, { access: "write" });
  await admin.put(`/api/projects/CRONK/members/${rita.id}`, { access: "read" });
  await admin.patch("/api/projects/CRONK", { visibility: "private" });
  const carolBot = await registerAgent(carol.client, "carol-bot");
  await admin.patch("/api/tickets/CRONK-1", { assigneeId: carol.id, delegateId: carolBot.agentId });
  const agent = await startSession(cronk, carolBot.secret);
  await agent.post("/api/tickets/CRONK-1/claim");
  const proposed = await agent.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions" });
  if (proposed.status !== 201) throw new Error(`Proposing failed: ${JSON.stringify(proposed.body)}`);
  await admin.patch("/api/tickets/CRONK-1", { assigneeId: dave.id });
  const setActive = async (id: string, active: boolean) => {
    const res = await admin.patch(`/api/users/${id}`, { active });
    if (res.status !== 200) throw new Error(`Setting active failed: ${JSON.stringify(res.body)}`);
  };
  /** Deactivating ends a User's sign-ins: a client signed in again as `name`. */
  const signIn = async (name: string) => {
    const client = cronk.client();
    const res = await client.post("/api/sign-in", { email: `${name}@example.com`, password: memberPassword });
    if (res.status !== 200) throw new Error(`Signing in failed: ${JSON.stringify(res.body)}`);
    return client;
  };
  return { cronk, admin, carol: carol.client, carolId: carol.id, dave: dave.client, daveId: dave.id, wendy: wendy.client, rita: rita.client, bob: bob.client, setActive, signIn };
}

describe("a proposed Decision whose reviewer is deactivated", () => {
  it("goes to the proposing Agent's Owner while the source Ticket's Assignee is deactivated, and back once they return", async () => {
    const { carol, dave, daveId, setActive, signIn } = await decisionFromDavesTicket();
    expect(await inboxLines(dave)).toEqual(["decision CRONK-D1"]);
    expect(await inboxLines(carol)).toEqual([]);

    await setActive(daveId, false);
    expect(await inboxLines(carol)).toEqual(["decision CRONK-D1"]);

    await setActive(daveId, true);
    expect(await inboxLines(await signIn("dave"))).toEqual(["decision CRONK-D1"]);
    expect(await inboxLines(carol)).toEqual([]);
  });

  it("goes to Triage, for the Users who may accept it, while its Owner is deactivated too", async () => {
    const { admin, carolId, daveId, wendy, rita, bob, setActive, signIn } = await decisionFromDavesTicket();
    await setActive(daveId, false);
    await setActive(carolId, false);

    expect(await triageLines(wendy)).toEqual(["decision CRONK-D1"]);
    expect(await triageLines(wendy, "?kind=decision")).toEqual(["decision CRONK-D1"]);
    expect(await triageLines(wendy, "?kind=suggestion")).toEqual([]);
    expect(await triageLines(admin, "?project=CRONK")).toEqual(["decision CRONK-D1"]);
    // Accepting or rejecting a Decision takes Write in its Project, as acting on any Triage item does.
    expect(await triageLines(rita)).toEqual([]);
    expect(await triageLines(bob)).toEqual([]);
    expect((await wendy.get("/api/triage")).body.items).toMatchObject([
      { kind: "decision", decision: { key: "CRONK-D1", status: "proposed", proposedBy: { name: "carol-bot" } }, ticket: { key: "CRONK-1" } },
    ]);

    await setActive(daveId, true);
    expect(await triageLines(wendy)).toEqual([]);
    expect(await inboxLines(await signIn("dave"))).toEqual(["decision CRONK-D1"]);
  });

  it("tells the Owner's open Inbox views when the Assignee leaves or returns, and nobody else's", async () => {
    const { carol, daveId, bob, setActive } = await decisionFromDavesTicket();
    const owners = await carol.events("/api/inbox/events");
    const others = await bob.events("/api/inbox/events");
    expect((await owners.next())?.event).toBe("ready");
    expect((await others.next())?.event).toBe("ready");

    await setActive(daveId, false);
    expect((await owners.next())?.event).toBe("changed");
    await setActive(daveId, true);
    expect((await owners.next())?.event).toBe("changed");
    await expect(others.next(500)).rejects.toThrow("No server-sent event came in time");
  });

  it("tells the Owner's open Inbox view, as the reviewer, when a User accepts or rejects it", async () => {
    const { admin, carol, daveId, setActive } = await decisionFromDavesTicket();
    await setActive(daveId, false);
    const owners = await carol.events("/api/inbox/events");
    expect((await owners.next())?.event).toBe("ready");

    await admin.post("/api/decisions/CRONK-D1/status", { status: "rejected", reason: "We keep them in Postgres." });
    expect((await owners.next())?.event).toBe("changed");
    expect(await inboxLines(carol)).toEqual([]);
    await admin.post("/api/decisions/CRONK-D1/status", { status: "proposed" });
    expect((await owners.next())?.event).toBe("changed");
    expect(await inboxLines(carol)).toEqual(["decision CRONK-D1"]);
    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    expect((await owners.next())?.event).toBe("changed");
    expect(await inboxLines(carol)).toEqual([]);
  });
});
