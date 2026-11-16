import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, registerAgent, startSession } from "./harness.js";

const reason = "It builds on the migration that leaves orphans.";

describe("Blocks from a Discovered Ticket", () => {
  it("let the Agent that filed it block another Ticket without a Claim, giving why, which takes that Ticket out of Ready", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Migration leaves orphans" });

    const added = await agent.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "cronk-1", reason });

    expect(added.status).toBe(201);
    expect(added.body.relations.blocks).toMatchObject([{ key: "CRONK-1", block: { agent: { name: "claude-laptop" }, reason } }]);
    const blocked = (await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy;
    expect(blocked).toMatchObject([{ key: "CRONK-2", title: "Migration leaves orphans", block: { agent: { name: "claude-laptop" }, reason } }]);
    const claim = await agent.post("/api/tickets/CRONK-1/claim");
    expect(claim.status).toBe(409);
    expect(claim.body.error).toContain("CRONK-1 is blocked by CRONK-2");
  });

  it("may block a Ticket of a Project the Agent can only read", async () => {
    const { admin, session } = await delegatedSetup();
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    await admin.post("/api/projects/OPS/tickets", { title: "Deploy" });
    await admin.patch("/api/projects/OPS", { agentAccess: "read" });
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Migration leaves orphans" });

    expect((await agent.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "OPS-1", reason })).status).toBe(201);
    expect((await admin.get("/api/tickets/OPS-1")).body.relations.blockedBy).toMatchObject([{ key: "CRONK-2", block: { reason } }]);
  });

  it("come only from the Agent's own Discovered Ticket waiting for a User, and only as blocks, with a reason", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup(2);
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Found" });
    const block = (key: string, body: object = {}) => agent.post(`/api/tickets/${key}/relations`, { kind: "blocks", ticketKey: "CRONK-1", reason, ...body });

    // Without a reason, or as another kind of Relation.
    expect((await block("CRONK-3", { reason: undefined })).status).toBe(400);
    expect((await block("CRONK-3", { reason: "  " })).status).toBe(400);
    expect((await block("CRONK-3", { kind: "relates_to" })).status).toBe(409);
    expect((await block("CRONK-3", { kind: "blocked_by" })).status).toBe(409);
    // From a Ticket that isn't a Discovered Ticket, or is another Agent's.
    const notDiscovered = await block("CRONK-2");
    expect(notDiscovered.status).toBe(409);
    expect(notDiscovered.body.error).toContain("Claim CRONK-2");
    const codex = await startSession(cronk, (await registerAgent(admin, "codex")).secret);
    expect((await codex.post("/api/tickets/CRONK-3/relations", { kind: "blocks", ticketKey: "CRONK-1", reason })).status).toBe(409);
    // Once a User delegates it, it is work like any other, Claimed to change its Relations.
    await admin.patch("/api/tickets/CRONK-3", { delegateId: claude.agentId });
    expect((await block("CRONK-3")).status).toBe(409);
    expect((await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toEqual([]);
    // A reason is for those blocks only.
    expect((await admin.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "CRONK-1", reason })).status).toBe(400);
  });

  it("may be given when the Agent files its Discovered Ticket, which isn't filed if any of them can't be added", async () => {
    const { admin, session } = await delegatedSetup(2);
    const agent = await session();

    const filed = await agent.post("/api/projects/CRONK/tickets", {
      title: "Migration leaves orphans",
      blocks: [{ ticketKey: "CRONK-1", reason }, { ticketKey: "cronk-2", reason: "Same migration." }],
    });

    expect(filed.status).toBe(201);
    const { relations } = (await admin.get("/api/tickets/CRONK-3")).body;
    expect(relations.blocks).toMatchObject([{ key: "CRONK-1", block: { reason } }, { key: "CRONK-2", block: { reason: "Same migration." } }]);

    expect((await agent.post("/api/projects/CRONK/tickets", { title: "Also found", blocks: [{ ticketKey: "CRONK-1", reason }, { ticketKey: "CRONK-99", reason }] })).status).toBe(400);
    expect((await admin.get("/api/projects/CRONK/tickets")).body.tickets).toHaveLength(3);
    // Only an Agent's Discovered Ticket is filed with blocks.
    expect((await admin.post("/api/projects/CRONK/tickets", { title: "Mine", blocks: [{ ticketKey: "CRONK-1", reason }] })).status).toBe(400);
  });
});

describe("Removing a block from a Discovered Ticket", () => {
  it("is open to a User who may change the blocked Ticket, even reading the Discovered Ticket only, and makes that Ticket Ready again", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    await admin.put(`/api/projects/OPS/members/${bobId}`, { access: "read" });
    const agent = await session();
    await agent.post("/api/projects/OPS/tickets", { title: "Migration leaves orphans", blocks: [{ ticketKey: "CRONK-1", reason }] });

    const removed = await bob.delete("/api/tickets/CRONK-1/relations/blocked_by/OPS-1");

    expect(removed.status).toBe(200);
    expect(removed.body.relations.blockedBy).toEqual([]);
    expect((await admin.get("/api/tickets/OPS-1")).body.relations.blocks).toEqual([]);
    const changes = (await admin.get("/api/tickets/CRONK-1/changes")).body.changes.map((c: any) => `${c.change} by ${c.actor.kind}`);
    expect(changes.slice(-2)).toEqual(["relation added by agent", "relation removed by user"]);
    expect((await agent.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    // From the Discovered Ticket's side, Bob would change OPS-1, where he only reads.
    await agent.post("/api/tickets/OPS-1/relations", { kind: "blocks", ticketKey: "CRONK-1", reason });
    expect((await bob.delete("/api/tickets/OPS-1/relations/blocks/CRONK-1")).status).toBe(403);
  });

  it("is open to the Agent that added it while its Discovered Ticket waits for a User", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Migration leaves orphans", blocks: [{ ticketKey: "CRONK-1", reason }] });

    expect((await agent.delete("/api/tickets/CRONK-2/relations/blocks/CRONK-1")).status).toBe(200);
    expect((await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toEqual([]);
    // A block a User added from it is theirs: the Agent needs the Claim to remove it, as for any Relation.
    await admin.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "CRONK-1" });
    expect((await agent.delete("/api/tickets/CRONK-2/relations/blocks/CRONK-1")).status).toBe(409);
  });
});

describe("A Discovered Ticket in the Inbox and Triage", () => {
  it("lists the Tickets it blocks, with why", async () => {
    const { admin, session } = await delegatedSetup(2);
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Migration leaves orphans", blocks: [{ ticketKey: "CRONK-2", reason }, { ticketKey: "CRONK-1", reason: "Same." }] });
    await agent.post("/api/projects/CRONK/tickets", { title: "Docs are stale" });

    const { items } = (await admin.get("/api/inbox?kind=discovered")).body;

    expect(items.map((i: any) => [i.ticket.key, i.blocks.map((b: any) => `${b.key}: ${b.block.reason}`)])).toEqual([
      ["CRONK-3", ["CRONK-1: Same.", `CRONK-2: ${reason}`]],
      ["CRONK-4", []],
    ]);
    await admin.patch("/api/tickets/CRONK-3", { assigneeId: null });
    const triage = (await admin.get("/api/triage?kind=discovered")).body.items;
    expect(triage).toMatchObject([{ ticket: { key: "CRONK-3" }, blocks: [{ key: "CRONK-1" }, { key: "CRONK-2" }] }]);
  });

  it("changes live as blocks are added and removed later", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Migration leaves orphans" });
    const stream = await admin.events("/api/inbox/events");
    expect((await stream.next())?.event).toBe("ready");

    await agent.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "CRONK-1", reason });
    expect(await stream.next()).toMatchObject({ event: "changed" });
    await admin.delete("/api/tickets/CRONK-1/relations/blocked_by/CRONK-2");
    expect(await stream.next()).toMatchObject({ event: "changed" });
  });
});
