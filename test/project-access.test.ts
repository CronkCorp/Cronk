import { describe, expect, it } from "vitest";
import { joinAs, projectWithTickets, startInstalledCronk, type Client } from "./harness.js";

async function userId(client: Client): Promise<string> {
  return (await client.get("/api/me")).body.user.id;
}

const keysOf = (res: { body: { projects: { key: string }[] } }) => res.body.projects.map((p) => p.key);

describe("open and private Projects", () => {
  it("hides a private Project from Members who weren't invited to it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.post("/api/projects", { name: "Open", key: "OPEN" });
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.post("/api/projects/SECRET/tickets", { title: "Hidden" });

    const madePrivate = await admin.patch("/api/projects/SECRET", { visibility: "private" });
    expect(madePrivate.status).toBe(200);
    expect(madePrivate.body.project).toMatchObject({ visibility: "private" });

    expect(keysOf(await bob.get("/api/projects"))).toEqual(["OPEN"]);
    expect(keysOf(await admin.get("/api/projects"))).toEqual(["OPEN", "SECRET"]);
    for (const res of [
      await bob.get("/api/projects/SECRET"),
      await bob.patch("/api/projects/SECRET", { name: "Mine now" }),
      await bob.get("/api/projects/SECRET/tickets"),
      await bob.post("/api/projects/SECRET/tickets", { title: "Snooping" }),
      await bob.get("/api/tickets/SECRET-1"),
      await bob.patch("/api/tickets/SECRET-1", { title: "Snooped" }),
      await bob.get("/api/tickets/SECRET-1/history"),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await admin.get("/api/tickets/SECRET-1")).body.ticket.title).toBe("Hidden");
  });
});

describe("Project members", () => {
  it("lets an Admin invite a Member to a private Project with Read or Write access", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });

    const added = await admin.put(`/api/projects/SECRET/members/${await userId(bob)}`, { access: "write" });
    expect(added.status).toBe(200);
    const members = await admin.get("/api/projects/SECRET/members");
    expect(members.body.members).toEqual([{ user: expect.objectContaining({ name: "bob" }), access: "write" }]);

    expect(keysOf(await bob.get("/api/projects"))).toEqual(["SECRET"]);
    expect((await bob.get("/api/projects/SECRET")).body.project).toMatchObject({ key: "SECRET", access: "write" });
    expect((await bob.post("/api/projects/SECRET/tickets", { title: "Bob's" })).status).toBe(201);

    await admin.put(`/api/projects/SECRET/members/${await userId(bob)}`, { access: "read" });
    expect((await bob.get("/api/projects/SECRET")).body.project.access).toBe("read");

    expect((await admin.delete(`/api/projects/SECRET/members/${await userId(bob)}`)).status).toBe(204);
    expect((await bob.get("/api/projects/SECRET")).status).toBe(404);
    expect((await admin.get("/api/projects/SECRET/members")).body.members).toEqual([]);
  });

  it("refuses every write from a Member with Read access, but lets them read", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Existing" });
    const { statuses } = (await admin.get("/api/projects/CRONK")).body;
    await admin.put(`/api/projects/CRONK/members/${await userId(bob)}`, { access: "read" });

    for (const res of [
      await bob.patch("/api/projects/CRONK", { name: "Renamed" }),
      await bob.patch("/api/projects/CRONK", { archived: true }),
      await bob.post("/api/projects/CRONK/tickets", { title: "New" }),
      await bob.patch("/api/tickets/CRONK-1", { title: "Edited" }),
      await bob.patch("/api/tickets/CRONK-1", { statusId: statuses[2].id }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Read access/);
    }

    expect((await bob.get("/api/projects/CRONK")).body.project).toMatchObject({ name: "Cronk", archived: false, access: "read" });
    expect((await bob.get("/api/projects/CRONK/tickets")).body.tickets.map((t: { title: string }) => t.title)).toEqual(["Existing"]);
    expect((await bob.get("/api/tickets/CRONK-1")).body.ticket).toMatchObject({ title: "Existing", status: { name: "Backlog" } });
    expect((await bob.get("/api/tickets/CRONK-1/history")).body.changes).toHaveLength(1);
  });

  it("gives every Member Write access in an open Project unless listed otherwise", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await bob.post("/api/projects", { name: "Cronk", key: "CRONK" });
    expect((await bob.get("/api/projects")).body.projects).toEqual([expect.objectContaining({ key: "CRONK", access: "write" })]);
    expect((await bob.post("/api/projects/CRONK/tickets", { title: "Mine" })).status).toBe(201);
  });

  it("only lets an Admin change visibility and members", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = await userId(bob);
    await bob.post("/api/projects", { name: "Cronk", key: "CRONK" });
    expect((await bob.patch("/api/projects/CRONK", { visibility: "private" })).status).toBe(403);
    expect((await bob.put(`/api/projects/CRONK/members/${bobId}`, { access: "write" })).status).toBe(403);
    expect((await bob.delete(`/api/projects/CRONK/members/${bobId}`)).status).toBe(403);
    expect((await bob.get("/api/projects/CRONK")).body.project.visibility).toBe("open");
  });

  it("refuses to list an Admin or an unknown User as a member", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    expect((await admin.put(`/api/projects/CRONK/members/${await userId(admin)}`, { access: "read" })).status).toBe(400);
    expect((await admin.put("/api/projects/CRONK/members/00000000-0000-4000-8000-000000000000", { access: "read" })).status).toBe(404);
    expect((await admin.put("/api/projects/NOPE/members/00000000-0000-4000-8000-000000000000", { access: "read" })).status).toBe(404);
  });
});

describe("deactivated Users", () => {
  it("are refused by every API operation, even with a sign-in from before", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Existing" });
    await admin.patch(`/api/users/${await userId(bob)}`, { active: false });

    for (const res of [
      await bob.get("/api/projects"),
      await bob.post("/api/projects", { name: "Mine", key: "MINE" }),
      await bob.get("/api/projects/CRONK"),
      await bob.post("/api/projects/CRONK/tickets", { title: "New" }),
      await bob.get("/api/tickets/CRONK-1"),
      await bob.patch("/api/tickets/CRONK-1", { title: "Edited" }),
      await bob.get("/api/users"),
      await bob.get("/api/workspace"),
    ]) {
      expect(res.status).toBe(401);
    }
  });
});

describe("Project members and roles", () => {
  it("drops a Member's Project listings when they are made an Admin, so demoting them doesn't bring old access back", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = await userId(bob);
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.put(`/api/projects/SECRET/members/${bobId}`, { access: "read" });

    await admin.patch(`/api/users/${bobId}`, { role: "admin" });
    expect((await admin.get("/api/projects/SECRET/members")).body.members).toEqual([]);
    expect((await bob.get("/api/projects/SECRET")).body.project.access).toBe("write");

    await admin.patch(`/api/users/${bobId}`, { role: "member" });
    expect((await bob.get("/api/projects/SECRET")).status).toBe(404);
  });
});

describe("Ticket fields and Relations under Project access", () => {
  it("lets a Member with Read access see a Ticket's fields and Relations but change none of them", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await projectWithTickets(admin, "CRONK", 2);
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await admin.patch("/api/tickets/CRONK-1", { labels: ["bug"] });
    await admin.put(`/api/projects/CRONK/members/${await userId(bob)}`, { access: "read" });

    expect((await bob.get("/api/tickets/CRONK-2")).body.relations.blockedBy).toHaveLength(1);
    expect((await bob.get("/api/projects/CRONK/labels")).body.labels).toEqual(["bug"]);
    expect((await bob.get("/api/projects/CRONK/tickets?label=bug")).body.tickets).toHaveLength(1);
    for (const res of [
      await bob.patch("/api/tickets/CRONK-1", { priority: "high" }),
      await bob.patch("/api/tickets/CRONK-1", { labels: [] }),
      await bob.patch("/api/tickets/CRONK-1", { assigneeId: await userId(bob) }),
      await bob.patch("/api/tickets/CRONK-2", { parentKey: "CRONK-1" }),
      await bob.post("/api/tickets/CRONK-2/relations", { kind: "relates_to", ticketKey: "CRONK-1" }),
      await bob.delete("/api/tickets/CRONK-2/relations/blocked_by/CRONK-1"),
    ]) {
      expect(res.status).toBe(403);
    }
  });

  it("needs Write in both Projects to relate Tickets, and treats a Ticket the User can't see as missing", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await projectWithTickets(admin, "CRONK", 1);
    await projectWithTickets(admin, "DOCS", 1);
    await projectWithTickets(admin, "SECRET", 1);
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.put(`/api/projects/DOCS/members/${await userId(bob)}`, { access: "read" });

    expect((await bob.post("/api/tickets/CRONK-1/relations", { kind: "relates_to", ticketKey: "DOCS-1" })).status).toBe(403);
    expect((await bob.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "SECRET-1" })).status).toBe(400);
    expect((await bob.delete("/api/tickets/CRONK-1/relations/blocks/SECRET-1")).status).toBe(400);
  });

  it("leaves Tickets of Projects the User can't see out of Relations and history", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await projectWithTickets(admin, "CRONK", 2);
    await projectWithTickets(admin, "SECRET", 1);
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.post("/api/tickets/SECRET-1/relations", { kind: "blocks", ticketKey: "CRONK-1" });
    await admin.post("/api/tickets/CRONK-2/relations", { kind: "blocks", ticketKey: "CRONK-1" });

    const relations = (await bob.get("/api/tickets/CRONK-1")).body.relations;
    expect(relations.blockedBy.map((r: { key: string }) => r.key)).toEqual(["CRONK-2"]);
    const history = (await bob.get("/api/tickets/CRONK-1/history")).body.changes;
    expect(history.map((c: { ticket?: { key: string } }) => c.ticket?.key)).toEqual([undefined, "CRONK-2"]);
    expect((await admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toHaveLength(2);
  });

  it("assigns a Ticket only to an active User who can see its Project", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const carol = await joinAs(cronk, admin, "carol@example.com");
    const [bobId, carolId] = [await userId(bob), await userId(carol)];
    await projectWithTickets(admin, "CRONK", 1);
    await projectWithTickets(admin, "SECRET", 1);
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.patch(`/api/users/${carolId}`, { active: false });

    expect((await admin.patch("/api/tickets/SECRET-1", { assigneeId: bobId })).status).toBe(400);
    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: carolId })).status).toBe(400);
    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: bobId })).body.ticket.assignee).toMatchObject({ name: "bob" });
  });
});
