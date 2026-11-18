import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, projectWithTickets, registerAgent, startInstalledCronk, startSession, statusIn, tarGz } from "./harness.js";

describe("Discovered Tickets", () => {
  it("files a Ticket an Agent creates while working on another as a Discovered Ticket: in Backlog, undelegated, with its source", async () => {
    const { admin, adaId, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const filed = await agent.post("/api/projects/CRONK/tickets", { title: "Migration leaves orphans", description: "Found while caching." });

    expect(filed.status).toBe(201);
    expect(filed.body.ticket).toMatchObject({
      key: "CRONK-2",
      status: { category: "backlog" },
      delegate: null,
      assignee: { id: adaId },
      discovered: {
        agent: { name: "claude-laptop" },
        session: { id: agent.sessionId },
        sourceTicket: { key: "CRONK-1", title: "Ticket 1" },
      },
    });
    expect((await admin.get("/api/tickets/CRONK-2")).body.ticket.discovered).toEqual(filed.body.ticket.discovered);
    // Cronk routed it; the Agent, which may not assign, didn't.
    const { changes } = (await admin.get("/api/tickets/CRONK-2/changes")).body;
    expect(changes.map((c: any) => `${c.change} by ${c.actor.kind}`)).toEqual(["created by agent", "assignee by system"]);
  });

  it("files a Ticket an Agent creates holding no Claim as a Discovered Ticket without a source, for the Agent's Owner", async () => {
    const { admin, adaId, session } = await delegatedSetup();
    const agent = await session();

    const filed = await agent.post("/api/projects/CRONK/tickets", { title: "Docs are stale" });

    expect(filed.status).toBe(201);
    expect(filed.body.ticket).toMatchObject({ status: { category: "backlog" }, delegate: null, assignee: { id: adaId } });
    expect(filed.body.ticket.discovered).toMatchObject({ agent: { name: "claude-laptop" }, sourceTicket: null });
    // A User's Ticket and an Agent's Sub-Ticket of its own Claimed Ticket aren't Discovered.
    expect((await admin.post("/api/projects/CRONK/tickets", { title: "Mine" })).body.ticket.discovered).toBeNull();
    await agent.post("/api/tickets/CRONK-1/claim");
    expect((await agent.post("/api/tickets/CRONK-1/sub-tickets", { title: "Part" })).body.ticket.discovered).toBeNull();
  });

});

describe("A Discovered Ticket's source", () => {
  it("is the Ticket the Agent names, of any Project, whose Claim it holds", async () => {
    const { admin, adaId, claude, session } = await delegatedSetup(2);
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    await admin.post("/api/projects/OPS/tickets", { title: "Deploy" });
    await admin.patch("/api/tickets/OPS-1", { assigneeId: adaId, delegateId: claude.agentId });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-2/claim");
    await agent.post("/api/tickets/OPS-1/claim");

    // Holding two Claims in CRONK, it names which one the Ticket came from.
    expect((await agent.post("/api/projects/CRONK/tickets", { title: "Found" })).status).toBe(400);
    const named = await agent.post("/api/projects/CRONK/tickets", { title: "Found", ticket: "cronk-2" });
    expect(named.body.ticket.discovered.sourceTicket).toEqual({ key: "CRONK-2", title: "Ticket 2" });
    // Its Claim on OPS-1 is one it holds too, so it can name it from another Project.
    const across = await agent.post("/api/projects/CRONK/tickets", { title: "Found", ticket: "OPS-1" });
    expect(across.body.ticket.discovered.sourceTicket).toEqual({ key: "OPS-1", title: "Deploy" });
    await agent.delete("/api/tickets/CRONK-1/claim");
    expect((await agent.post("/api/projects/CRONK/tickets", { title: "Found", ticket: "CRONK-1" })).status).toBe(409);
    // A User names no source.
    expect((await admin.post("/api/projects/CRONK/tickets", { title: "Mine", ticket: "CRONK-2" })).status).toBe(400);
  });

  it("is the one Claim still held once a release committed first has ended the other", async () => {
    const { cronk, session } = await delegatedSetup(2);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-2/claim");
    const ticketId = (await agent.get("/api/tickets/CRONK-1")).body.ticket.id;

    // The release of CRONK-1 waits on it first, then filing waits behind it rather than counting both Claims.
    const held = await cronk.holdRow("tickets", ticketId);
    const release = agent.delete("/api/tickets/CRONK-1/claim");
    await held.waiters(1);
    const filing = agent.post("/api/projects/CRONK/tickets", { title: "Found" });
    expect(await Promise.race([filing.then(() => "filed"), held.waiters(2).then(() => "waited")])).toBe("waited");
    await held.release();

    expect((await release).status).toBe(204);
    const filed = await filing;
    expect(filed.status).toBe(201);
    expect(filed.body.ticket.discovered.sourceTicket).toEqual({ key: "CRONK-2", title: "Ticket 2" });
  });
});

describe("A Discovered Ticket filed in another Project than its source", () => {
  it("records the Ticket whose Claim the Agent holds as its source, inferred or named", async () => {
    const { admin, session } = await delegatedSetup();
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const inferred = await agent.post("/api/projects/OPS/tickets", { title: "Deploy is flaky" });
    const named = await agent.post("/api/projects/OPS/tickets", { title: "Logs are noisy", ticket: "CRONK-1" });

    expect(inferred.status).toBe(201);
    expect(inferred.body.ticket.discovered.sourceTicket).toEqual({ key: "CRONK-1", title: "Ticket 1" });
    expect(named.status).toBe(201);
    expect(named.body.ticket.discovered.sourceTicket).toEqual({ key: "CRONK-1", title: "Ticket 1" });
    expect((await admin.get("/api/tickets/OPS-2")).body.ticket.discovered.sourceTicket).toEqual({ key: "CRONK-1", title: "Ticket 1" });
  });
});

describe("A source Ticket in another Project", () => {
  it("is still refused for a Decision, a Suggestion and an Artifact, unlike for a Discovered Ticket", async () => {
    const { admin, session } = await delegatedSetup();
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    const { document } = (await admin.post("/api/projects/OPS/documents", { title: "Runbook", body: "v1" })).body;
    await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const ownProject = (res: { status: number; body: { error?: string } }) => res.status === 400 && /of its own Project/.test(res.body.error ?? "");
    expect(ownProject(await agent.post("/api/projects/OPS/decisions", { title: "Deploy on Fridays", ticket: "CRONK-1" }))).toBe(true);
    const suggested = await agent.post("/api/suggestions", { item: { kind: "document", id: document.id }, baseVersion: 1, content: { body: "v2" }, reasoning: "Better.", ticket: "CRONK-1" });
    expect(ownProject(suggested)).toBe(true);
    expect(ownProject(await agent.upload("/api/projects/OPS/artifacts?title=Page&ticket=CRONK-1", await tarGz({ "index.html": "<p>hi</p>" })))).toBe(true);
    expect((await agent.post("/api/projects/OPS/tickets", { title: "Found", ticket: "CRONK-1" })).status).toBe(201);
  });
});

describe("A Discovered Ticket's source in a Project its reader can't read", () => {
  it("shows as null on the Ticket's reads and Inbox and Triage items, and in full to a reader who can read it", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/projects/OPS/tickets", { title: "Found" });
    const source = { key: "CRONK-1", title: "Ticket 1" };

    expect((await admin.get("/api/tickets/OPS-1")).body.ticket.discovered.sourceTicket).toEqual(source);
    const read = (await bob.get("/api/tickets/OPS-1")).body.ticket.discovered;
    expect(read).toMatchObject({ agent: { name: "claude-laptop" }, sourceTicket: null });
    expect((await bob.get("/api/projects/OPS/tickets")).body.tickets[0].discovered.sourceTicket).toBeNull();
    expect(JSON.stringify((await bob.get("/api/tickets/OPS-1")).body)).not.toContain("CRONK-1");

    await admin.patch("/api/tickets/OPS-1", { assigneeId: null });
    const triage = (await bob.get("/api/triage")).body.items;
    expect(triage[0].ticket).toMatchObject({ key: "OPS-1", discovered: { sourceTicket: null } });
    expect((await admin.get("/api/triage")).body.items[0].ticket.discovered.sourceTicket).toEqual(source);

    await bob.patch("/api/tickets/OPS-1", { assigneeId: bobId });
    const inbox = (await bob.get("/api/inbox?kind=discovered")).body.items;
    expect(inbox[0].ticket).toMatchObject({ key: "OPS-1", discovered: { sourceTicket: null } });
    expect(JSON.stringify(inbox)).not.toContain("CRONK-1");
  });
});

describe("Routing a Discovered Ticket filed in another Project than its source", () => {
  it("goes to the source's Assignee, and waits in Triage once they can't see its Project", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    const bobBot = await registerAgent(bob, "bob-bot");
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: bobId, delegateId: bobBot.agentId });
    const agent = await startSession(cronk, bobBot.secret);
    await agent.post("/api/tickets/CRONK-1/claim");

    const seen = await agent.post("/api/projects/OPS/tickets", { title: "Seen by Bob" });
    expect(seen.body.ticket).toMatchObject({ assignee: { id: bobId }, discovered: { sourceTicket: { key: "CRONK-1" } } });

    // An Agent files only where its Owner can write, and the source's Assignee is its Owner while it holds the Claim,
    // so the Assignee loses sight of the Project only after filing; the Ticket then waits in Triage.
    await admin.patch("/api/projects/OPS", { visibility: "private" });
    expect(await waiting(admin, "/api/triage")).toEqual(["discovered OPS-1"]);
    expect((await admin.get("/api/tickets/OPS-1")).body.ticket.assignee).toMatchObject({ id: bobId });
  });
});

describe("An Agent's own Discovered Ticket", () => {
  it("is the Agent's to edit, attach files to and link Documents to without a Claim, from any of its Agent Sessions, until a User delegates it", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const filer = await session();
    await filer.post("/api/projects/CRONK/tickets", { title: "Found" });
    const later = await session();
    const plan = (await admin.post("/api/projects/CRONK/documents", { title: "Plan" })).body.document.id;

    expect((await later.patch("/api/tickets/CRONK-2", { title: "Found: stale cache", description: "Details.", priority: "high", labels: ["bug"] })).status).toBe(200);
    expect((await later.upload("/api/tickets/CRONK-2/attachments?name=log.txt", Buffer.from("trace"), "text/plain")).status).toBe(201);
    expect((await later.post(`/api/tickets/CRONK-2/documents/${plan}`)).status).toBe(201);
    // Other Relations still need the Claim: only blocks, with a reason, come from a Discovered Ticket without one.
    expect((await later.post("/api/tickets/CRONK-2/relations", { kind: "relates_to", ticketKey: "CRONK-1" })).status).toBe(409);
    expect((await admin.get("/api/tickets/CRONK-2")).body.ticket).toMatchObject({ title: "Found: stale cache", priority: "high", labels: ["bug"] });

    // Another Agent, even of the same Owner, needs the Claim as for any Ticket.
    const other = await startSession(cronk, (await registerAgent(admin, "codex")).secret);
    expect((await other.patch("/api/tickets/CRONK-2", { title: "Mine now" })).status).toBe(409);

    await admin.patch("/api/tickets/CRONK-2", { delegateId: claude.agentId });
    const refused = await later.patch("/api/tickets/CRONK-2", { title: "Again" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Claim CRONK-2 in your Agent Session before editing it: it isn't Claimed");
    expect((await later.upload("/api/tickets/CRONK-2/attachments?name=more.txt", Buffer.from("x"), "text/plain")).status).toBe(409);
    // Taking the Delegation away again doesn't hand the Ticket back to the Agent.
    await admin.patch("/api/tickets/CRONK-2", { delegateId: null });
    expect((await later.patch("/api/tickets/CRONK-2", { title: "Again" })).status).toBe(409);
  });

  it("is no longer the Agent's to edit once a User cancels it", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Found" });

    await admin.patch("/api/tickets/CRONK-2", { statusId: await statusIn(admin, "canceled") });

    expect((await agent.patch("/api/tickets/CRONK-2", { title: "Still found" })).status).toBe(409);
  });

  it("stays out of the Agent's hands once a User finishes it, even if a User moves it back to Backlog undelegated", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Found" });
    const plan = (await admin.post("/api/projects/CRONK/documents", { title: "Plan" })).body.document.id;

    await admin.patch("/api/tickets/CRONK-2", { statusId: await statusIn(admin, "completed") });
    await admin.patch("/api/tickets/CRONK-2", { statusId: await statusIn(admin, "backlog") });

    const refused = await agent.patch("/api/tickets/CRONK-2", { title: "Still found" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Claim CRONK-2 in your Agent Session before editing it: it isn't Claimed");
    expect((await agent.upload("/api/tickets/CRONK-2/attachments?name=log.txt", Buffer.from("trace"), "text/plain")).status).toBe(409);
    expect((await agent.post(`/api/tickets/CRONK-2/documents/${plan}`)).status).toBe(409);
    expect((await admin.get("/api/tickets/CRONK-2")).body.ticket.title).toBe("Found");
  });

  it("can't be worked on until a User delegates it: Claiming and moving it are refused, saying why", async () => {
    const { admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Found" });
    const started = await statusIn(admin, "started");

    const claim = await agent.post("/api/tickets/CRONK-2/claim");
    expect(claim.status).toBe(409);
    expect(claim.body.error).toContain("CRONK-2 is a Discovered Ticket waiting for a User to delegate it");
    expect((await agent.patch("/api/tickets/CRONK-2", { statusId: started })).status).toBe(409);

    await admin.patch("/api/tickets/CRONK-2", { delegateId: claude.agentId });
    expect((await agent.post("/api/tickets/CRONK-2/claim")).status).toBe(200);
    expect((await agent.patch("/api/tickets/CRONK-2", { statusId: started })).status).toBe(200);
  });
});

/** What `client`'s Inbox or Triage (`path`) holds, one line per item: its kind and the Ticket it is on. */
async function waiting(client: { get: (path: string) => Promise<{ status: number; body: any }> }, path = "/api/inbox"): Promise<string[]> {
  const res = await client.get(path);
  if (res.status !== 200) throw new Error(`Listing ${path} failed: ${JSON.stringify(res.body)}`);
  return res.body.items.map((item: any) => `${item.kind} ${item.ticket?.key ?? ""}`.trim());
}

describe("Discovered Tickets in the Inbox", () => {
  it("wait in their Assignee's Inbox until a User delegates, keeps or cancels them", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    for (const title of ["One", "Two", "Three"]) {
      await agent.post("/api/projects/CRONK/tickets", { title });
      cronk.clock.advance(60_000);
    }

    const { items } = (await admin.get("/api/inbox?kind=discovered")).body;
    expect(items[0]).toMatchObject({ kind: "discovered", ticket: { key: "CRONK-2", discovered: { agent: { id: claude.agentId } } } });
    expect(await waiting(admin)).toEqual(["discovered CRONK-2", "discovered CRONK-3", "discovered CRONK-4"]);
    expect(await waiting(admin, `/api/inbox?agent=${claude.agentId}`)).toEqual(["discovered CRONK-2", "discovered CRONK-3", "discovered CRONK-4"]);

    expect((await admin.patch("/api/tickets/CRONK-2", { delegateId: claude.agentId })).status).toBe(200);
    const kept = await admin.post("/api/tickets/CRONK-3/keep");
    expect(kept.status).toBe(200);
    expect(kept.body.ticket).toMatchObject({ status: { category: "backlog" }, delegate: null, discovered: { kept: true } });
    // Keeping it is recorded in its history, as the User's.
    const { changes } = (await admin.get("/api/tickets/CRONK-3/changes")).body;
    expect(changes.at(-1)).toMatchObject({ change: "kept", actor: { kind: "user", name: "Ada" } });
    expect((await admin.patch("/api/tickets/CRONK-4", { statusId: await statusIn(admin, "canceled") })).status).toBe(200);

    expect(await waiting(admin)).toEqual([]);
  });

  it("is kept only by a User with Write, and only while it waits", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Found" });
    const rita = await joinAs(cronk, admin, "rita@example.com");
    await admin.put(`/api/projects/CRONK/members/${(await rita.get("/api/me")).body.user.id}`, { access: "read" });

    expect((await agent.post("/api/tickets/CRONK-2/keep")).status).toBe(403);
    expect((await rita.post("/api/tickets/CRONK-2/keep")).status).toBe(403);
    expect((await admin.post("/api/tickets/CRONK-1/keep")).status).toBe(409);
    expect((await admin.post("/api/tickets/CRONK-2/keep")).status).toBe(200);
    expect((await admin.post("/api/tickets/CRONK-2/keep")).status).toBe(409);
  });

  it("stay settled once a User finishes them, even moved back to Backlog undelegated: out of the Inbox and Triage, with nothing to keep", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    for (const title of ["Done", "Dropped", "Unassigned", "Fresh"]) await agent.post("/api/projects/CRONK/tickets", { title });
    await admin.patch("/api/tickets/CRONK-4", { assigneeId: null });
    const backlog = await statusIn(admin, "backlog");

    await admin.patch("/api/tickets/CRONK-2", { statusId: await statusIn(admin, "completed") });
    await admin.patch("/api/tickets/CRONK-3", { statusId: await statusIn(admin, "canceled") });
    await admin.patch("/api/tickets/CRONK-4", { statusId: await statusIn(admin, "completed") });
    for (const key of ["CRONK-2", "CRONK-3", "CRONK-4"]) expect((await admin.patch(`/api/tickets/${key}`, { statusId: backlog })).status).toBe(200);

    // The one never finished still waits, in its Assignee's Inbox.
    expect(await waiting(admin)).toEqual(["discovered CRONK-5"]);
    expect(await waiting(admin, "/api/triage")).toEqual([]);
    const refused = await admin.post("/api/tickets/CRONK-2/keep");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("isn't a Discovered Ticket waiting");
    expect((await admin.post("/api/tickets/CRONK-3/keep")).status).toBe(409);
    expect((await admin.get("/api/tickets/CRONK-2")).body.ticket.discovered).toMatchObject({ kept: false, everFinished: true });
    expect((await admin.get("/api/tickets/CRONK-5")).body.ticket.discovered).toMatchObject({ kept: false, everFinished: false });
    expect((await admin.post("/api/tickets/CRONK-5/keep")).status).toBe(200);
  });

  it("are told apart from finished ones in a fixed number of queries, their history looked up by index, however many there are", async () => {
    // The server's own looks for lapsed Claims read the history too, so they are left out.
    const { cronk, admin, session } = await delegatedSetup(1, { lapseCheckMs: 3_600_000 });
    const agent = await session();
    const backlog = await statusIn(admin, "backlog");
    const completed = await statusIn(admin, "completed");
    /** Files a Discovered Ticket, finished and moved back to Backlog when `finished`, unassigned when `unassigned`. */
    const discover = async ({ finished = false, unassigned = false } = {}) => {
      const { key } = (await agent.post("/api/projects/CRONK/tickets", { title: "Found" })).body.ticket;
      if (unassigned) await admin.patch(`/api/tickets/${key}`, { assigneeId: null });
      if (finished) for (const statusId of [completed, backlog]) await admin.patch(`/api/tickets/${key}`, { statusId });
    };
    const listings = ["/api/inbox?kind=discovered", "/api/triage?kind=discovered", "/api/projects/CRONK/tickets"];
    const historyQueries = async () => {
      const counts: number[] = [];
      for (const path of listings) counts.push(await cronk.queriesOn("ticket_changes", () => admin.get(path)));
      // Each item's Reports too, which Ticket items carry.
      for (const path of listings.slice(0, 2)) counts.push(await cronk.queriesOn("documents", () => admin.get(path)));
      return counts;
    };
    for (const options of [{}, { unassigned: true }, { finished: true, unassigned: true }]) await discover(options);
    const withFew = await historyQueries();

    for (const options of [{}, { unassigned: true }, { finished: true }, { finished: true, unassigned: true }]) await discover(options);

    expect(await historyQueries()).toEqual(withFew);
    for (const path of listings) expect(await cronk.tablesReadWhole(() => admin.get(path))).not.toContain("ticket_changes");
    expect(await waiting(admin)).toEqual(["discovered CRONK-2", "discovered CRONK-5"]);
    expect(await waiting(admin, "/api/triage")).toEqual(["discovered CRONK-3", "discovered CRONK-6"]);
  });
});

describe("Discovered Tickets in Triage", () => {
  it("lists an unassigned one waiting to the Users with Write in its Project, until one takes it into their Inbox", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Found" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    const rita = await joinAs(cronk, admin, "rita@example.com");
    await admin.put(`/api/projects/CRONK/members/${(await rita.get("/api/me")).body.user.id}`, { access: "read" });
    expect(await waiting(bob, "/api/triage")).toEqual([]);

    await admin.patch("/api/tickets/CRONK-2", { assigneeId: null });

    expect(await waiting(bob, "/api/triage")).toEqual(["discovered CRONK-2"]);
    expect(await waiting(admin, "/api/triage?kind=discovered")).toEqual(["discovered CRONK-2"]);
    expect(await waiting(rita, "/api/triage")).toEqual([]);
    expect(await waiting(admin)).toEqual([]);

    // Take it: Bob assigns it to himself.
    expect((await bob.patch("/api/tickets/CRONK-2", { assigneeId: bobId })).status).toBe(200);
    expect(await waiting(admin, "/api/triage")).toEqual([]);
    expect(await waiting(bob)).toEqual(["discovered CRONK-2"]);
  });
});

describe("A Discovered Ticket whose Assignee can no longer act on it", () => {
  it("goes to Triage while its Assignee is deactivated or can't see its Project, keeping its Assignee", async () => {
    const { cronk, admin } = await delegatedSetup(0);
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    const bobs = await startSession(cronk, (await registerAgent(bob, "bob-bot")).secret);
    await bobs.post("/api/projects/CRONK/tickets", { title: "Found" });
    expect(await waiting(bob)).toEqual(["discovered CRONK-1"]);

    await admin.patch(`/api/users/${bobId}`, { active: false });
    expect(await waiting(admin, "/api/triage")).toEqual(["discovered CRONK-1"]);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.assignee).toMatchObject({ id: bobId });

    await admin.patch(`/api/users/${bobId}`, { active: true });
    expect(await waiting(admin, "/api/triage")).toEqual([]);
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    expect(await waiting(admin, "/api/triage")).toEqual(["discovered CRONK-1"]);
  });
});

describe("A Report", () => {
  it("lists the Discovered Tickets filed from its Ticket during the Claim it was written in", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Before the Claim" });
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/projects/CRONK/tickets", { title: "Stale cache" });
    await agent.post("/api/projects/CRONK/tickets", { title: "Slow query" });
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed." });

    const reports = (await admin.get("/api/tickets/CRONK-1/reports")).body.reports;
    expect(reports[0].discovered).toEqual([
      { key: "CRONK-3", title: "Stale cache", status: expect.objectContaining({ category: "backlog" }) },
      { key: "CRONK-4", title: "Slow query", status: expect.objectContaining({ category: "backlog" }) },
    ]);
  });

  it("lists those filed in other Projects to each reader who can read their Project", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    await admin.patch("/api/projects/OPS", { visibility: "private" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/projects/CRONK/tickets", { title: "Stale cache" });
    await agent.post("/api/projects/OPS/tickets", { title: "Deploy is flaky" });
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed." });

    const listed = async (reader: typeof admin) => (await reader.get("/api/tickets/CRONK-1/reports")).body.reports[0].discovered.map((t: any) => t.key);
    expect(await listed(admin)).toEqual(["CRONK-2", "OPS-1"]);
    expect(await listed(bob)).toEqual(["CRONK-2"]);
  });

  it("pushed live lists those filed in other Projects only to watchers who can read their Project", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    await admin.patch("/api/projects/OPS", { visibility: "private" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/projects/OPS/tickets", { title: "Deploy is flaky" });
    const bobs = await bob.events("/api/tickets/CRONK-1/events");
    const adas = await admin.events("/api/tickets/CRONK-1/events");
    expect((await bobs.next())?.event).toBe("ready");
    expect((await adas.next())?.event).toBe("ready");

    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed." });

    const pushed = async (stream: typeof bobs) => {
      for (let event = await stream.next(); event; event = await stream.next()) if (event.event === "report") return event.data.report.discovered.map((t: any) => t.key);
    };
    expect(await pushed(adas)).toEqual(["OPS-1"]);
    expect(await pushed(bobs)).toEqual([]);
    bobs.close();
    adas.close();
  });
});
