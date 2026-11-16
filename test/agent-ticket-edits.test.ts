import { describe, expect, it } from "vitest";
import { delegatedSetup } from "./harness.js";

describe("An Agent editing a Ticket's fields", () => {
  it("is refused, saying the Ticket isn't Claimed, until its Agent Session holds the Claim", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();

    const refused = await agent.patch("/api/tickets/CRONK-1", { title: "Renamed" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Claim CRONK-1 in your Agent Session before editing it: it isn't Claimed");
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.title).toBe("Ticket 1");

    await agent.post("/api/tickets/CRONK-1/claim");
    const edited = await agent.patch("/api/tickets/CRONK-1", { title: "Renamed" });
    expect(edited.status).toBe(200);
    expect(edited.body.ticket.title).toBe("Renamed");
  });

  it("is refused for each field while another Agent Session holds the Claim, naming its Agent, and allowed to the holder", async () => {
    const { admin, session } = await delegatedSetup(2);
    const holder = await session();
    const other = await session();
    await holder.post("/api/tickets/CRONK-1/claim");
    const edits = [
      { title: "Renamed" },
      { description: "New description" },
      { priority: "high" },
      { labels: ["bug"] },
      { parentKey: "CRONK-2" },
      { parentKey: null },
    ];

    for (const edit of edits) {
      const refused = await other.patch("/api/tickets/CRONK-1", edit);
      expect(refused.status, JSON.stringify(edit)).toBe(409);
      expect(refused.body.error).toBe("Claim CRONK-1 in your Agent Session before editing it: it is Claimed by claude-laptop in another Agent Session");
    }
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket).toMatchObject({ title: "Ticket 1", description: "", labels: [], parent: null });

    for (const edit of edits) expect((await holder.patch("/api/tickets/CRONK-1", edit)).status, JSON.stringify(edit)).toBe(200);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket).toMatchObject({
      title: "Renamed",
      description: "New description",
      priority: "high",
      labels: ["bug"],
      parent: null,
    });
  });
});

describe("An Agent changing a Ticket's Relations", () => {
  it("is refused, saying why, unless its Agent Session holds the Claim on the Ticket it changes", async () => {
    const { admin, session } = await delegatedSetup(2);
    const holder = await session();
    const other = await session();
    const relation = { kind: "blocked_by", ticketKey: "CRONK-2" };

    const unclaimed = await holder.post("/api/tickets/CRONK-1/relations", relation);
    expect(unclaimed.status).toBe(409);
    expect(unclaimed.body.error).toBe("Claim CRONK-1 in your Agent Session before changing its Relations: it isn't Claimed");

    await holder.post("/api/tickets/CRONK-1/claim");
    const added = await other.post("/api/tickets/CRONK-1/relations", relation);
    expect(added.status).toBe(409);
    expect(added.body.error).toBe("Claim CRONK-1 in your Agent Session before changing its Relations: it is Claimed by claude-laptop in another Agent Session");
    expect((await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toEqual([]);

    expect((await holder.post("/api/tickets/CRONK-1/relations", relation)).status).toBe(201);
    const removed = await other.delete("/api/tickets/CRONK-1/relations/blocked_by/CRONK-2");
    expect(removed.status).toBe(409);
    expect(removed.body.error).toMatch(/^Claim CRONK-1 in your Agent Session before changing its Relations/);
    expect((await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toMatchObject([{ key: "CRONK-2" }]);

    expect((await holder.delete("/api/tickets/CRONK-1/relations/blocked_by/CRONK-2")).status).toBe(200);
    expect((await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toEqual([]);
  });
});

describe("A User editing a Ticket", () => {
  it("needs no Claim, even while an Agent Session holds it", async () => {
    const { admin, session } = await delegatedSetup(2);
    await (await session()).post("/api/tickets/CRONK-1/claim");

    const edited = await admin.patch("/api/tickets/CRONK-1", { title: "Renamed", description: "D", priority: "low", labels: ["ui"], parentKey: "CRONK-2" });
    expect(edited.status).toBe(200);
    expect(edited.body.ticket).toMatchObject({ title: "Renamed", description: "D", priority: "low", labels: ["ui"], parent: { key: "CRONK-2" } });
    expect((await admin.post("/api/tickets/CRONK-1/relations", { kind: "relates_to", ticketKey: "CRONK-2" })).status).toBe(201);
    expect((await admin.delete("/api/tickets/CRONK-1/relations/relates_to/CRONK-2")).status).toBe(200);
  });
});

describe("An Agent commenting on a Ticket", () => {
  it("needs no Claim, whether the Ticket is not Claimed or Claimed by another Agent Session", async () => {
    const { session } = await delegatedSetup();
    const holder = await session();
    const other = await session();

    expect((await other.post("/api/tickets/CRONK-1/comments", { body: "Before anyone Claims it" })).status).toBe(201);
    await holder.post("/api/tickets/CRONK-1/claim");
    expect((await other.post("/api/tickets/CRONK-1/comments", { body: "While another Session holds it" })).status).toBe(201);
  });
});
