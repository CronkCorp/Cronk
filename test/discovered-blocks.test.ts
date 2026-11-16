import { describe, expect, it } from "vitest";
import { delegatedSetup } from "./harness.js";

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
});
