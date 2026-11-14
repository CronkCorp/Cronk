import { describe, expect, it } from "vitest";
import { startInstalledCronk, type Client } from "./harness.js";

async function projectWithTickets(client: Client, key: string, count: number) {
  const res = await client.post("/api/projects", { name: key, key });
  if (res.status !== 201) throw new Error(`Creating Project ${key} failed: ${JSON.stringify(res.body)}`);
  for (let i = 1; i <= count; i++) await client.post(`/api/projects/${key}/tickets`, { title: `Ticket ${i}` });
}

describe("Ticket Priority", () => {
  it("starts at None and can be set and changed", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.priority).toBe("none");

    for (const priority of ["urgent", "high", "medium", "low", "none"]) {
      const res = await admin.patch("/api/tickets/CRONK-1", { priority });
      expect(res.status).toBe(200);
      expect(res.body.ticket.priority).toBe(priority);
    }
    expect((await admin.patch("/api/tickets/CRONK-1", { priority: "critical" })).status).toBe(400);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.priority).toBe("none");
  });

  it("changes are recorded in the history", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    await admin.patch("/api/tickets/CRONK-1", { priority: "high" });
    await admin.patch("/api/tickets/CRONK-1", { priority: "high" });

    const { changes } = (await admin.get("/api/tickets/CRONK-1/history")).body;
    expect(changes.slice(1)).toMatchObject([{ change: "priority", from: "none", to: "high" }]);
  });
});

describe("Ticket Labels", () => {
  it("start empty and can be set and changed, trimmed and without repeats", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.labels).toEqual([]);

    const set = await admin.patch("/api/tickets/CRONK-1", { labels: [" bug ", "ui", "Bug"] });
    expect(set.status).toBe(200);
    expect(set.body.ticket.labels).toEqual(["bug", "ui"]);

    await admin.patch("/api/tickets/CRONK-1", { labels: ["ui", "backend"] });
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.labels).toEqual(["ui", "backend"]);

    expect((await admin.patch("/api/tickets/CRONK-1", { labels: [" "] })).status).toBe(400);
  });

  it("changes are recorded in the history", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    await admin.patch("/api/tickets/CRONK-1", { labels: ["bug"] });
    await admin.patch("/api/tickets/CRONK-1", { labels: ["bug "] });
    await admin.patch("/api/tickets/CRONK-1", { labels: [] });

    const { changes } = (await admin.get("/api/tickets/CRONK-1/history")).body;
    expect(changes.slice(1)).toMatchObject([
      { change: "labels", from: [], to: ["bug"] },
      { change: "labels", from: ["bug"], to: [] },
    ]);
  });

  it("in use in a Project are listed for filtering", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 2);
    await projectWithTickets(admin, "WEB", 1);
    await admin.patch("/api/tickets/CRONK-1", { labels: ["ui", "bug"] });
    await admin.patch("/api/tickets/CRONK-2", { labels: ["bug", "docs"] });
    await admin.patch("/api/tickets/WEB-1", { labels: ["web-only"] });

    const res = await admin.get("/api/projects/CRONK/labels");
    expect(res.status).toBe(200);
    expect(res.body.labels).toEqual(["bug", "docs", "ui"]);
  });
});

describe("Ticket Assignee", () => {
  it("starts unset and can be set to a User of the Workspace and cleared", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const users = await admin.get("/api/users");
    expect(users.status).toBe(200);
    const [ada] = users.body.users;
    expect(ada).toMatchObject({ name: "Ada" });
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.assignee).toBeNull();

    const assigned = await admin.patch("/api/tickets/CRONK-1", { assigneeId: ada.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.ticket.assignee).toEqual({ id: ada.id, name: "Ada" });

    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.assignee).toEqual({ id: ada.id, name: "Ada" });

    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: null })).body.ticket.assignee).toBeNull();

    const { changes } = (await admin.get("/api/tickets/CRONK-1/history")).body;
    expect(changes.slice(1)).toMatchObject([
      { change: "assignee", from: null, to: { id: ada.id, name: "Ada" } },
      { change: "assignee", from: { id: ada.id, name: "Ada" }, to: null },
    ]);
  });
});
