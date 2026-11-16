import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, registerAgent, startSession } from "./harness.js";

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
  it("is the Ticket the Agent names, which must be one of the same Project whose Claim it holds", async () => {
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
    // Its Claim on OPS-1 doesn't fit a CRONK Ticket, so naming it is refused.
    expect((await agent.post("/api/projects/CRONK/tickets", { title: "Found", ticket: "OPS-1" })).status).toBe(400);
    await agent.delete("/api/tickets/CRONK-1/claim");
    expect((await agent.post("/api/projects/CRONK/tickets", { title: "Found", ticket: "CRONK-1" })).status).toBe(409);
    // A User names no source.
    expect((await admin.post("/api/projects/CRONK/tickets", { title: "Mine", ticket: "CRONK-2" })).status).toBe(400);
  });
});

describe("An Agent's own Discovered Ticket", () => {
  it("is the Agent's to edit, attach to and relate without a Claim, from any of its Agent Sessions, until a User delegates it", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const filer = await session();
    await filer.post("/api/projects/CRONK/tickets", { title: "Found" });
    const later = await session();
    const plan = (await admin.post("/api/projects/CRONK/documents", { title: "Plan" })).body.document.id;

    expect((await later.patch("/api/tickets/CRONK-2", { title: "Found: stale cache", description: "Details.", priority: "high", labels: ["bug"] })).status).toBe(200);
    expect((await later.upload("/api/tickets/CRONK-2/attachments?name=log.txt", Buffer.from("trace"), "text/plain")).status).toBe(201);
    expect((await later.post(`/api/tickets/CRONK-2/documents/${plan}`)).status).toBe(201);
    expect((await later.post("/api/tickets/CRONK-2/relations", { kind: "relates_to", ticketKey: "CRONK-1" })).status).toBe(201);
    expect((await admin.get("/api/tickets/CRONK-2")).body.ticket).toMatchObject({ title: "Found: stale cache", priority: "high", labels: ["bug"] });

    // Another Agent, even of the same Owner, needs the Claim as for any Ticket.
    const other = await startSession(cronk, (await registerAgent(admin, "codex")).secret);
    expect((await other.patch("/api/tickets/CRONK-2", { title: "Mine now" })).status).toBe(409);

    await admin.patch("/api/tickets/CRONK-2", { delegateId: claude.agentId });
    const refused = await later.patch("/api/tickets/CRONK-2", { title: "Again" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Claim CRONK-2 in your Agent Session before editing it: it isn't Claimed");
    expect((await later.upload("/api/tickets/CRONK-2/attachments?name=more.txt", Buffer.from("x"), "text/plain")).status).toBe(409);
  });

  it("can't be worked on until a User delegates it: Claiming and moving it are refused, saying why", async () => {
    const { admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Found" });
    const started = ((await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[]).find((s) => s.category === "started")!.id;

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

/** The id of the CRONK Status in `category`. */
async function statusIn(admin: { get: (path: string) => Promise<{ body: any }> }, category: string): Promise<string> {
  return ((await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[]).find((s) => s.category === category)!.id;
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
