import { describe, expect, it } from "vitest";
import { startInstalledCronk, type Client } from "./harness.js";

interface Status {
  id: string;
  name: string;
  category: string;
}

async function createProject(client: Client, key: string) {
  const res = await client.post("/api/projects", { name: key, key });
  if (res.status !== 201) throw new Error(`Creating Project ${key} failed: ${JSON.stringify(res.body)}`);
}

async function statuses(client: Client, key = "CRONK"): Promise<Status[]> {
  return (await client.get(`/api/projects/${key}`)).body.statuses;
}

const names = (list: Status[]) => list.map((s) => s.name);

async function statusNamed(client: Client, name: string, key = "CRONK"): Promise<Status> {
  const status = (await statuses(client, key)).find((s) => s.name === name);
  if (!status) throw new Error(`No Status named ${name} in ${key}`);
  return status;
}

describe("Statuses", () => {
  it("can be added to any Status Category, landing last in it", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");

    const added = await admin.post("/api/projects/CRONK/statuses", { name: " In QA ", category: "started" });
    expect(added.status).toBe(201);
    expect(added.body.status).toMatchObject({ name: "In QA", category: "started" });
    await admin.post("/api/projects/CRONK/statuses", { name: "Icebox", category: "backlog" });

    expect(names(await statuses(admin))).toEqual(["Backlog", "Icebox", "Todo", "In Progress", "In QA", "In Review", "Done", "Canceled"]);
  });

  it("need a name no other Status of the Project has, compared without case, and a known Status Category", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");
    await createProject(admin, "WEB");

    const clash = await admin.post("/api/projects/CRONK/statuses", { name: "in progress", category: "in_review" });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/in progress/);
    expect((await admin.post("/api/projects/WEB/statuses", { name: "In QA", category: "started" })).status).toBe(201);
    expect((await admin.post("/api/projects/CRONK/statuses", { name: "In QA", category: "started" })).status).toBe(201);

    expect((await admin.post("/api/projects/CRONK/statuses", { name: "Shipped", category: "deployed" })).status).toBe(400);
    expect((await admin.post("/api/projects/CRONK/statuses", { name: " ", category: "started" })).status).toBe(400);
    expect((await admin.post("/api/projects/NOPE/statuses", { name: "Shipped", category: "completed" })).status).toBe(404);
  });

  it("can be renamed, and their Tickets show the new name", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");
    await admin.post("/api/projects/CRONK/tickets", { title: "Add sign-in" });
    const backlog = await statusNamed(admin, "Backlog");

    const renamed = await admin.patch(`/api/projects/CRONK/statuses/${backlog.id}`, { name: " Ideas " });
    expect(renamed.status).toBe(200);
    expect(renamed.body.status).toEqual({ id: backlog.id, name: "Ideas", category: "backlog" });
    expect(names(await statuses(admin))[0]).toBe("Ideas");
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.status.name).toBe("Ideas");

    expect((await admin.patch(`/api/projects/CRONK/statuses/${backlog.id}`, { name: "IDEAS" })).status).toBe(200);
    const clash = await admin.patch(`/api/projects/CRONK/statuses/${backlog.id}`, { name: "done" });
    expect(clash.status).toBe(409);
    // A Status keeps its Status Category for life: moving it could empty a Category.
    await admin.patch(`/api/projects/CRONK/statuses/${backlog.id}`, { category: "completed" });
    expect((await statusNamed(admin, "IDEAS")).category).toBe("backlog");
  });

  it("are only changed through their own Project", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");
    await createProject(admin, "WEB");
    const webBacklog = await statusNamed(admin, "Backlog", "WEB");

    expect((await admin.patch(`/api/projects/CRONK/statuses/${webBacklog.id}`, { name: "Mine" })).status).toBe(404);
    expect((await admin.patch("/api/projects/CRONK/statuses/not-a-uuid", { name: "Mine" })).status).toBe(404);
    expect((await statusNamed(admin, "Backlog", "WEB")).id).toBe(webBacklog.id);
  });

  it("can be reordered within their Status Category, and new Tickets start in the first", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");
    await admin.post("/api/projects/CRONK/statuses", { name: "Icebox", category: "backlog" });
    await admin.post("/api/projects/CRONK/statuses", { name: "Triage", category: "backlog" });
    const triage = await statusNamed(admin, "Triage");

    const moved = await admin.patch(`/api/projects/CRONK/statuses/${triage.id}`, { position: 0 });
    expect(moved.status).toBe(200);
    expect(names(await statuses(admin)).slice(0, 4)).toEqual(["Triage", "Backlog", "Icebox", "Todo"]);
    const created = await admin.post("/api/projects/CRONK/tickets", { title: "Look at this" });
    expect(created.body.ticket.status.name).toBe("Triage");

    await admin.patch(`/api/projects/CRONK/statuses/${triage.id}`, { position: 1 });
    expect(names(await statuses(admin)).slice(0, 4)).toEqual(["Backlog", "Triage", "Icebox", "Todo"]);
    await admin.patch(`/api/projects/CRONK/statuses/${triage.id}`, { position: 2 });
    expect(names(await statuses(admin)).slice(0, 4)).toEqual(["Backlog", "Icebox", "Triage", "Todo"]);

    // Positions count within the Status Category; Categories keep their fixed order.
    const outside = await admin.patch(`/api/projects/CRONK/statuses/${triage.id}`, { position: 3 });
    expect(outside.status).toBe(400);
    expect((await admin.patch(`/api/projects/CRONK/statuses/${triage.id}`, { position: -1 })).status).toBe(400);
    expect(names(await statuses(admin)).slice(0, 4)).toEqual(["Backlog", "Icebox", "Triage", "Todo"]);
  });

  it("can be removed when no Ticket is in them", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");
    const qa = (await admin.post("/api/projects/CRONK/statuses", { name: "In QA", category: "started" })).body.status;

    const removed = await admin.delete(`/api/projects/CRONK/statuses/${qa.id}`);
    expect(removed.status).toBe(204);
    expect(names(await statuses(admin))).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"]);
    expect((await admin.delete(`/api/projects/CRONK/statuses/${qa.id}`)).status).toBe(404);
  });

  it("can't remove the last Status of a Status Category", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");
    const done = await statusNamed(admin, "Done");

    const refused = await admin.delete(`/api/projects/CRONK/statuses/${done.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/last/);

    const shipped = (await admin.post("/api/projects/CRONK/statuses", { name: "Shipped", category: "completed" })).body.status;
    expect((await admin.delete(`/api/projects/CRONK/statuses/${done.id}`)).status).toBe(204);
    expect((await admin.delete(`/api/projects/CRONK/statuses/${shipped.id}`)).status).toBe(409);
    expect(names(await statuses(admin))).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Shipped", "Canceled"]);
  });

  it("in use are removed only by moving their Tickets to another Status, which their history records", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");
    const qa = (await admin.post("/api/projects/CRONK/statuses", { name: "In QA", category: "started" })).body.status;
    const review = await statusNamed(admin, "In Review");
    await admin.post("/api/projects/CRONK/tickets", { title: "Add sign-in" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Add sign-out" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Stay put" });
    await admin.patch("/api/tickets/CRONK-1", { statusId: qa.id });
    await admin.patch("/api/tickets/CRONK-2", { statusId: qa.id });

    const asked = await admin.delete(`/api/projects/CRONK/statuses/${qa.id}`);
    expect(asked.status).toBe(409);
    expect(asked.body.error).toMatch(/2 Tickets/);
    expect(names(await statuses(admin))).toContain("In QA");

    expect((await admin.delete(`/api/projects/CRONK/statuses/${qa.id}?moveTo=${qa.id}`)).status).toBe(400);
    const webReview = (await admin.post("/api/projects", { name: "WEB", key: "WEB" }), await statusNamed(admin, "In Review", "WEB"));
    expect((await admin.delete(`/api/projects/CRONK/statuses/${qa.id}?moveTo=${webReview.id}`)).status).toBe(400);
    expect((await admin.delete(`/api/projects/CRONK/statuses/${qa.id}?moveTo=not-a-uuid`)).status).toBe(400);

    const removed = await admin.delete(`/api/projects/CRONK/statuses/${qa.id}?moveTo=${review.id}`);
    expect(removed.status).toBe(204);
    expect(names(await statuses(admin))).not.toContain("In QA");
    const tickets = (await admin.get("/api/projects/CRONK/tickets")).body.tickets;
    expect(tickets.map((t: { key: string; status: Status }) => [t.key, t.status.name])).toEqual([
      ["CRONK-1", "In Review"],
      ["CRONK-2", "In Review"],
      ["CRONK-3", "Backlog"],
    ]);
    const history = (await admin.get("/api/tickets/CRONK-1/history")).body.changes;
    expect(history.at(-1)).toMatchObject({
      change: "status",
      actor: { name: "Ada" },
      from: { name: "In QA", category: "started" },
      to: { name: "In Review", category: "in_review" },
    });
  });

  it("leave no Ticket behind when Tickets move into a Status while it is removed", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");
    const qa = (await admin.post("/api/projects/CRONK/statuses", { name: "In QA", category: "started" })).body.status;
    const review = await statusNamed(admin, "In Review");
    for (let i = 0; i < 20; i++) await admin.post("/api/projects/CRONK/tickets", { title: `T${i}` });

    const move = (n: number) => admin.patch(`/api/tickets/CRONK-${n}`, { statusId: qa.id });
    const results = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => move(i + 1)),
      admin.delete(`/api/projects/CRONK/statuses/${qa.id}?moveTo=${review.id}`),
      ...Array.from({ length: 10 }, (_, i) => move(i + 11)),
    ]);
    expect(results[10]!.status).toBe(204);
    for (const result of results) expect([200, 204, 400]).toContain(result.status);

    const tickets = (await admin.get("/api/projects/CRONK/tickets")).body.tickets;
    expect(tickets.filter((t: { status: Status }) => t.status.id === qa.id)).toEqual([]);
  });

  it("leave no Ticket behind when Tickets are created while the first Status is removed", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");
    const backlog = await statusNamed(admin, "Backlog");
    const icebox = (await admin.post("/api/projects/CRONK/statuses", { name: "Icebox", category: "backlog" })).body.status;

    const create = (i: number) => admin.post("/api/projects/CRONK/tickets", { title: `T${i}` });
    const results = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => create(i)),
      admin.delete(`/api/projects/CRONK/statuses/${backlog.id}?moveTo=${icebox.id}`),
      ...Array.from({ length: 10 }, (_, i) => create(i + 10)),
    ]);
    for (const result of results) expect([201, 204]).toContain(result.status);

    const tickets = (await admin.get("/api/projects/CRONK/tickets")).body.tickets;
    expect(tickets).toHaveLength(20);
    expect(tickets.filter((t: { status: Status }) => t.status.id !== icebox.id)).toEqual([]);
  });
});
