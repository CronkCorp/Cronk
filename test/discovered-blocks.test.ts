import { describe, expect, it } from "vitest";
import { agentOf, delegatedSetup, joinAs, registerAgent, startSession } from "./harness.js";

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

  it("are added when two filed at once, each from a Claim the other blocks, would otherwise wait on each other", async () => {
    const { cronk, admin, adaId, claude, session } = await delegatedSetup();
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    await admin.post("/api/projects/OPS/tickets", { title: "Deploy" });
    await admin.patch("/api/tickets/OPS-1", { assigneeId: adaId, delegateId: claude.agentId });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/OPS-1/claim");
    const projectId = async (key: string) => (await admin.get(`/api/projects/${key}`)).body.project.id;

    // Both filings wait on their Project, so each goes on to lock its source while the other does.
    const heldCronk = await cronk.holdRow("projects", await projectId("CRONK"));
    const heldOps = await cronk.holdRow("projects", await projectId("OPS"));
    const fromCronk = agent.post("/api/projects/CRONK/tickets", { title: "Found in CRONK", ticket: "CRONK-1", blocks: [{ ticketKey: "OPS-1", reason }] });
    const fromOps = agent.post("/api/projects/OPS/tickets", { title: "Found in OPS", ticket: "OPS-1", blocks: [{ ticketKey: "CRONK-1", reason }] });
    await heldCronk.waiters(2);
    await Promise.all([heldCronk.release(), heldOps.release()]);

    expect([(await fromCronk).status, (await fromOps).status]).toEqual([201, 201]);
    expect((await admin.get("/api/tickets/OPS-1")).body.relations.blockedBy).toMatchObject([{ key: "CRONK-2", block: { reason } }]);
    expect((await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toMatchObject([{ key: "OPS-2", block: { reason } }]);
  });

  it("are added while a User blocks the same Ticket at once", async () => {
    const { cronk, admin, session } = await delegatedSetup(3);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const blockedId = (await admin.get("/api/tickets/CRONK-2")).body.ticket.id;

    // The filing waits on CRONK-2 first, then the User's block, which already holds the Workspace's blocking lock.
    const held = await cronk.holdRow("tickets", blockedId);
    const filing = agent.post("/api/projects/CRONK/tickets", { title: "Found", ticket: "CRONK-1", blocks: [{ ticketKey: "CRONK-2", reason }] });
    await held.waiters(1);
    const blocking = admin.post("/api/tickets/CRONK-3/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await held.waiters(2);
    await held.release();

    expect([(await filing).status, (await blocking).status]).toEqual([201, 201]);
    expect((await admin.get("/api/tickets/CRONK-2")).body.relations.blockedBy.map((t: any) => t.key).sort()).toEqual(["CRONK-3", "CRONK-4"]);
  });
});

describe("Blocks added at once by holders of the Tickets' Claims", () => {
  it("queue rather than deadlock when two Agents block each other's Ticket: one is added, the other would close a cycle", async () => {
    const { cronk, admin, adaId, session } = await delegatedSetup(4);
    const codex = await registerAgent(admin, "codex");
    await admin.patch("/api/tickets/CRONK-2", { assigneeId: adaId, delegateId: codex.agentId });
    const onFirst = await session();
    const onSecond = await startSession(cronk, codex.secret);
    expect((await onFirst.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    expect((await onSecond.post("/api/tickets/CRONK-2/claim")).status).toBe(200);

    // A User's block holds the Workspace's blocking lock while it waits on CRONK-3, so both Agents' blocks queue behind it.
    const held = await cronk.holdRow("tickets", (await admin.get("/api/tickets/CRONK-3")).body.ticket.id);
    const byUser = admin.post("/api/tickets/CRONK-4/relations", { kind: "blocks", ticketKey: "CRONK-3" });
    await held.waiters(1);
    const first = onFirst.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await held.waiters(2);
    const second = onSecond.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "CRONK-1" });
    await held.waiters(3);
    await held.release();

    expect((await byUser).status).toBe(201);
    expect([(await first).status, (await second).status].sort()).toEqual([201, 409]);
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

/**
 * Ada sees every Project; Bob has Write in CRONK only, so he can't see the Ops Project, which is private.
 * Ada's Agent files OPS-1 there as a Discovered Ticket blocking CRONK-1.
 */
async function hiddenBlockSetup() {
  const setup = await delegatedSetup();
  const { cronk, admin, session } = setup;
  await admin.post("/api/projects", { name: "Ops", key: "OPS" });
  await admin.patch("/api/projects/OPS", { visibility: "private" });
  const bob = await joinAs(cronk, admin, "bob@example.com");
  const agent = await session();
  await agent.post("/api/projects/OPS/tickets", { title: "Migration leaves orphans", blocks: [{ ticketKey: "CRONK-1", reason }] });
  return { ...setup, bob, agent };
}

describe("A block from a Discovered Ticket the User can't see", () => {
  it("shows on the blocked Ticket as a placeholder with the Agent and why, but nothing of the Ticket", async () => {
    const { admin, bob } = await hiddenBlockSetup();

    const { relations } = (await bob.get("/api/tickets/CRONK-1")).body;

    expect(relations.blockedBy).toEqual([{ hidden: true, blockId: expect.any(String), block: { agent: { id: expect.any(String), name: "claude-laptop" }, reason } }]);
    expect(JSON.stringify(relations)).not.toMatch(/OPS|Migration leaves/);
    const seen = (await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy;
    expect(seen).toMatchObject([{ key: "OPS-1", title: "Migration leaves orphans", block: { reason } }]);
    expect(seen[0].hidden).toBeUndefined();
  });
});

describe("Removing a block by its id", () => {
  it("is open to a User with Write on the blocked Ticket who can't see the Discovered Ticket, and makes that Ticket Ready again", async () => {
    const { admin, bob, agent } = await hiddenBlockSetup();
    const [{ blockId }] = (await bob.get("/api/tickets/CRONK-1")).body.relations.blockedBy;
    const stream = await admin.events("/api/inbox/events");
    expect((await stream.next())?.event).toBe("ready");

    const removed = await bob.delete(`/api/tickets/cronk-1/blocked-by/${blockId}`);

    expect(removed.status).toBe(200);
    expect(removed.body.relations.blockedBy).toEqual([]);
    expect(JSON.stringify(removed.body)).not.toMatch(/OPS|Migration leaves/);
    expect(await stream.next()).toMatchObject({ event: "changed" });
    expect((await admin.get("/api/tickets/OPS-1")).body.relations.blocks).toEqual([]);
    for (const key of ["CRONK-1", "OPS-1"]) {
      const changes = (await admin.get(`/api/tickets/${key}/changes`)).body.changes.map((c: any) => `${c.change} by ${c.actor.kind}`);
      expect(changes.slice(-2)).toEqual(["relation added by agent", "relation removed by user"]);
    }
    expect((await agent.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
  });

  it("answers the same for an unknown id, a block a User added, and a block on a Ticket the caller can't change", async () => {
    const { admin, bob, agent } = await hiddenBlockSetup();
    const bobId = (await bob.get("/api/me")).body.user.id;
    await admin.post("/api/projects", { name: "Web", key: "WEB" });
    await admin.post("/api/projects/WEB/tickets", { title: "Landing page" });
    await admin.put(`/api/projects/WEB/members/${bobId}`, { access: "read" });
    await agent.post("/api/tickets/OPS-1/relations", { kind: "blocks", ticketKey: "WEB-1", reason });
    await admin.post("/api/projects/CRONK/tickets", { title: "Release" });
    await admin.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "CRONK-1" });
    const userAdded = (await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy.find((b: any) => b.key === "CRONK-2").blockId;
    const [onReadOnly] = (await bob.get("/api/tickets/WEB-1")).body.relations.blockedBy;
    expect(onReadOnly).toMatchObject({ hidden: true });

    const answers = await Promise.all(
      [crypto.randomUUID(), userAdded, onReadOnly.blockId].map(async (id) => {
        const res = await bob.delete(`/api/tickets/CRONK-1/blocked-by/${id}`);
        return { status: res.status, body: res.body };
      }),
    );

    expect(answers[0]).toEqual({ status: 404, body: { error: "No such block" } });
    expect(answers).toEqual([answers[0], answers[0], answers[0]]);
    // From the Ticket Bob only reads, every id answers as his Read access does, whatever the id.
    const [unknown, known] = await Promise.all([crypto.randomUUID(), onReadOnly.blockId].map((id) => bob.delete(`/api/tickets/WEB-1/blocked-by/${id}`)));
    expect([unknown!.status, known!.status]).toEqual([403, 403]);
    expect(unknown!.body).toEqual(known!.body);
    expect((await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toHaveLength(2);
    expect((await admin.get("/api/tickets/WEB-1")).body.relations.blockedBy).toHaveLength(1);
  });

  it("is left to Users: an Agent removes its block by the other Ticket's key, as before", async () => {
    const { agent, bob } = await hiddenBlockSetup();
    const [{ blockId }] = (await bob.get("/api/tickets/CRONK-1")).body.relations.blockedBy;

    expect((await agent.delete(`/api/tickets/CRONK-1/blocked-by/${blockId}`)).status).toBe(403);
    expect((await bob.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toHaveLength(1);
  });
});

describe("A Discovered Ticket's blocks in the Inbox and Triage", () => {
  it("count the paused Tickets the User can't see, and say which blocks the User may remove", async () => {
    const { cronk, admin } = await delegatedSetup(2);
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    for (const [key, title] of [["OPS", "Deploy"], ["WEB", "Landing page"]]) {
      await admin.post("/api/projects", { name: key, key });
      await admin.post(`/api/projects/${key}/tickets`, { title });
      await admin.patch(`/api/projects/${key}`, { visibility: "private" });
    }
    await admin.put(`/api/projects/OPS/members/${bobId}`, { access: "read" });
    await admin.put(`/api/projects/WEB/members/${bobId}`, { access: "read" });
    const agent = await agentOf(cronk, bob, "codex");
    await agent.post("/api/projects/CRONK/tickets", {
      title: "Migration leaves orphans",
      blocks: [{ ticketKey: "CRONK-1", reason }, { ticketKey: "OPS-1", reason }, { ticketKey: "WEB-1", reason }],
    });
    // A block Ada added from it needs Write on both Tickets to remove, which Bob has in CRONK only.
    await admin.post("/api/tickets/CRONK-3/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await admin.delete(`/api/projects/WEB/members/${bobId}`);

    const [item] = (await bob.get("/api/inbox?kind=discovered")).body.items;

    expect(item.ticket.key).toBe("CRONK-3");
    expect(item.hiddenBlocks).toBe(1);
    expect(item.blocks.map((b: any) => [b.key, b.canRemove])).toEqual([
      ["CRONK-1", true],
      ["CRONK-2", true],
      ["OPS-1", false],
    ]);
    // As Ada sees it in Triage once no one is assigned, every block is hers to remove.
    await admin.patch("/api/tickets/CRONK-3", { assigneeId: null });
    const [triaged] = (await admin.get("/api/triage?kind=discovered")).body.items;
    expect(triaged.hiddenBlocks).toBe(0);
    expect(triaged.blocks.map((b: any) => b.canRemove)).toEqual([true, true, true, true]);
    expect((await bob.get("/api/triage?kind=discovered")).body.items[0]).toMatchObject({ hiddenBlocks: 1, blocks: [{ canRemove: true }, { canRemove: true }, { canRemove: false }] });
  });
});
