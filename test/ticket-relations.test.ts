import { describe, expect, it } from "vitest";
import { joinAs, projectWithTickets, startInstalledCronk } from "./harness.js";

const keys = (refs: { key: string }[]) => refs.map((r) => r.key);

describe("Sub-Tickets", () => {
  it("are made by giving a Ticket a parent, which then lists them", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 3);

    const res = await admin.patch("/api/tickets/CRONK-2", { parentKey: "cronk-1" });
    expect(res.status).toBe(200);
    expect(res.body.ticket.parent).toMatchObject({ key: "CRONK-1", title: "Ticket 1" });
    await admin.patch("/api/tickets/CRONK-3", { parentKey: "CRONK-1" });

    const parent = await admin.get("/api/tickets/CRONK-1");
    expect(parent.body.ticket.parent).toBeNull();
    expect(parent.body.subTickets).toEqual([
      { key: "CRONK-2", title: "Ticket 2", status: expect.objectContaining({ name: "Backlog" }) },
      { key: "CRONK-3", title: "Ticket 3", status: expect.objectContaining({ name: "Backlog" }) },
    ]);

    expect((await admin.patch("/api/tickets/CRONK-2", { parentKey: null })).body.ticket.parent).toBeNull();
    expect(keys((await admin.get("/api/tickets/CRONK-1")).body.subTickets)).toEqual(["CRONK-3"]);

    const { changes } = (await admin.get("/api/tickets/CRONK-2/changes")).body;
    expect(changes.slice(1)).toMatchObject([
      { change: "parent", from: null, to: { key: "CRONK-1", title: "Ticket 1" } },
      { change: "parent", from: { key: "CRONK-1", title: "Ticket 1" }, to: null },
    ]);
  });

  it("can't have themselves, one of their own Sub-Tickets, or a Ticket in another Project as parent", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 3);
    await projectWithTickets(admin, "WEB", 1);
    await admin.patch("/api/tickets/CRONK-2", { parentKey: "CRONK-1" });
    await admin.patch("/api/tickets/CRONK-3", { parentKey: "CRONK-2" });

    expect((await admin.patch("/api/tickets/CRONK-1", { parentKey: "CRONK-1" })).status).toBe(400);
    expect((await admin.patch("/api/tickets/CRONK-1", { parentKey: "CRONK-3" })).status).toBe(409);
    expect((await admin.patch("/api/tickets/CRONK-1", { parentKey: "WEB-1" })).status).toBe(400);
    expect((await admin.patch("/api/tickets/CRONK-1", { parentKey: "CRONK-99" })).status).toBe(400);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.parent).toBeNull();
  });
});

describe("Ticket relations", () => {
  it("blocks / blocked by can be added from either side and show on both Tickets", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 3);
    await projectWithTickets(admin, "WEB", 1);

    const added = await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "cronk-2" });
    expect(added.status).toBe(201);
    expect(keys(added.body.relations.blocks)).toEqual(["CRONK-2"]);
    await admin.post("/api/tickets/CRONK-3/relations", { kind: "blocked_by", ticketKey: "CRONK-1" });
    await admin.post("/api/tickets/WEB-1/relations", { kind: "blocks", ticketKey: "CRONK-1" });

    const one = (await admin.get("/api/tickets/CRONK-1")).body.relations;
    expect(keys(one.blocks)).toEqual(["CRONK-2", "CRONK-3"]);
    expect(one.blockedBy).toEqual([{ key: "WEB-1", title: "Ticket 1", status: expect.objectContaining({ name: "Backlog" }), blockId: expect.any(String), block: null }]);
    expect(one.relatesTo).toEqual([]);
    const two = (await admin.get("/api/tickets/CRONK-2")).body.relations;
    expect(keys(two.blockedBy)).toEqual(["CRONK-1"]);
    expect(two.blocks).toEqual([]);
  });

  it("relates to is shown the same way on both Tickets", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 3);

    await admin.post("/api/tickets/CRONK-2/relations", { kind: "relates_to", ticketKey: "CRONK-1" });
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "relates_to", ticketKey: "CRONK-2" });
    await admin.post("/api/tickets/CRONK-3/relations", { kind: "relates_to", ticketKey: "CRONK-1" });

    expect(keys((await admin.get("/api/tickets/CRONK-1")).body.relations.relatesTo)).toEqual(["CRONK-2", "CRONK-3"]);
    expect(keys((await admin.get("/api/tickets/CRONK-2")).body.relations.relatesTo)).toEqual(["CRONK-1"]);
    expect((await admin.get("/api/tickets/CRONK-2")).body.relations.blocks).toEqual([]);
  });

  it("can be removed from either Ticket", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 3);
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "relates_to", ticketKey: "CRONK-3" });

    const removed = await admin.delete("/api/tickets/CRONK-2/relations/blocked_by/cronk-1");
    expect(removed.status).toBe(200);
    expect(removed.body.relations.blockedBy).toEqual([]);
    expect((await admin.delete("/api/tickets/CRONK-3/relations/relates_to/CRONK-1")).status).toBe(200);

    expect((await admin.get("/api/tickets/CRONK-1")).body.relations).toEqual({ blocks: [], blockedBy: [], relatesTo: [] });
    expect((await admin.delete("/api/tickets/CRONK-1/relations/blocks/CRONK-2")).status).toBe(404);
    expect((await admin.delete("/api/tickets/CRONK-1/relations/owns/CRONK-2")).status).toBe(400);
  });

  it("are recorded in both Tickets' history", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 2);
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await admin.delete("/api/tickets/CRONK-1/relations/blocks/CRONK-2");

    const one = (await admin.get("/api/tickets/CRONK-1/changes")).body.changes;
    expect(one.slice(1)).toMatchObject([
      { change: "relation added", kind: "blocks", ticket: { key: "CRONK-2", title: "Ticket 2" } },
      { change: "relation removed", kind: "blocks", ticket: { key: "CRONK-2", title: "Ticket 2" } },
    ]);
    const two = (await admin.get("/api/tickets/CRONK-2/changes")).body.changes;
    expect(two.slice(1)).toMatchObject([
      { change: "relation added", kind: "blocked_by", ticket: { key: "CRONK-1" } },
      { change: "relation removed", kind: "blocked_by", ticket: { key: "CRONK-1" } },
    ]);
  });

  it("refuse a Ticket blocking or relating to itself, or a Ticket that doesn't exist", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    for (const kind of ["blocks", "blocked_by", "relates_to"]) {
      expect((await admin.post("/api/tickets/CRONK-1/relations", { kind, ticketKey: "CRONK-1" })).status, kind).toBe(400);
      expect((await admin.post("/api/tickets/CRONK-1/relations", { kind, ticketKey: "CRONK-9" })).status, kind).toBe(400);
    }
    expect((await admin.post("/api/tickets/CRONK-1/relations", { kind: "owns", ticketKey: "CRONK-1" })).status).toBe(400);
    expect((await admin.post("/api/tickets/CRONK-9/relations", { kind: "blocks", ticketKey: "CRONK-1" })).status).toBe(404);
  });

  it("refuse a blocking cycle, however long, but allow relating Tickets that block each other", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 3);
    await projectWithTickets(admin, "WEB", 1);
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await admin.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "WEB-1" });
    await admin.post("/api/tickets/WEB-1/relations", { kind: "blocks", ticketKey: "CRONK-3" });

    expect((await admin.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "CRONK-1" })).status).toBe(409);
    expect((await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocked_by", ticketKey: "CRONK-3" })).status).toBe(409);
    expect((await admin.post("/api/tickets/CRONK-3/relations", { kind: "blocks", ticketKey: "CRONK-1" })).status).toBe(409);
    expect(keys((await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy)).toEqual([]);

    expect((await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-3" })).status).toBe(201);
    expect((await admin.post("/api/tickets/CRONK-3/relations", { kind: "relates_to", ticketKey: "CRONK-1" })).status).toBe(201);
  });

  it("never form a blocking cycle when added at the same time", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 2);

    const results = await Promise.all([
      admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" }),
      admin.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "CRONK-1" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const one = (await admin.get("/api/tickets/CRONK-1")).body.relations;
    expect(one.blocks.length + one.blockedBy.length).toBe(1);
  });

  it("refuse a block naming a missing or hidden Ticket, or one the User can only read, without waiting for another block being added", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await projectWithTickets(admin, "CRONK", 3);
    await projectWithTickets(admin, "SECRET", 1);
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await projectWithTickets(admin, "DOCS", 1);
    await admin.put(`/api/projects/DOCS/members/${(await bob.get("/api/me")).body.user.id}`, { access: "read" });

    // A block waiting on CRONK-3 holds the Workspace's blocking lock until CRONK-3 is let go.
    const held = await cronk.holdRow("tickets", (await admin.get("/api/tickets/CRONK-3")).body.ticket.id);
    const waiting = admin.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "CRONK-3" });
    await held.waiters(1);

    for (const kind of ["blocks", "blocked_by"]) {
      expect((await bob.post("/api/tickets/CRONK-9/relations", { kind, ticketKey: "CRONK-1" })).status, kind).toBe(404);
      expect((await bob.post("/api/tickets/SECRET-1/relations", { kind, ticketKey: "CRONK-1" })).status, kind).toBe(404);
      expect((await bob.post("/api/tickets/CRONK-1/relations", { kind, ticketKey: "CRONK-9" })).status, kind).toBe(400);
      expect((await bob.post("/api/tickets/CRONK-1/relations", { kind, ticketKey: "SECRET-1" })).status, kind).toBe(400);
      expect((await bob.post("/api/tickets/CRONK-1/relations", { kind, ticketKey: "CRONK-1" })).status, kind).toBe(400);
      expect((await bob.post("/api/tickets/DOCS-1/relations", { kind, ticketKey: "CRONK-1" })).status, kind).toBe(403);
      expect((await bob.post("/api/tickets/CRONK-1/relations", { kind, ticketKey: "DOCS-1" })).status, kind).toBe(403);
    }
    await held.release();
    expect((await waiting).status).toBe(201);
  });
});
