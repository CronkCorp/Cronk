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
});
