import { describe, expect, it } from "vitest";
import { delegatedSetup, registerAgent, startSession } from "./harness.js";

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
});
