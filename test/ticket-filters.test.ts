import { describe, expect, it } from "vitest";
import { startInstalledCronk, type Client } from "./harness.js";

/**
 * CRONK-1: Backlog,     urgent, ["bug", "ui"], Ada
 * CRONK-2: Todo,        high,   ["bug"]
 * CRONK-3: In Progress, none,   ["UI"],        Ada
 * CRONK-4: Done,        urgent, []
 * WEB-1:   Backlog,     urgent, ["bug"],       Ada  (another Project; never listed)
 */
async function seed(admin: Client) {
  const ada = (await admin.get("/api/me")).body.user;
  for (const key of ["CRONK", "WEB"]) await admin.post("/api/projects", { name: key, key });
  for (let i = 1; i <= 4; i++) await admin.post("/api/projects/CRONK/tickets", { title: `Ticket ${i}` });
  await admin.post("/api/projects/WEB/tickets", { title: "Elsewhere" });
  const statuses: { id: string; name: string }[] = (await admin.get("/api/projects/CRONK")).body.statuses;
  const status = (name: string) => statuses.find((s) => s.name === name)!.id;

  await admin.patch("/api/tickets/CRONK-1", { priority: "urgent", labels: ["bug", "ui"], assigneeId: ada.id });
  await admin.patch("/api/tickets/CRONK-2", { priority: "high", labels: ["bug"], statusId: status("Todo") });
  await admin.patch("/api/tickets/CRONK-3", { labels: ["UI"], assigneeId: ada.id, statusId: status("In Progress") });
  await admin.patch("/api/tickets/CRONK-4", { priority: "urgent", statusId: status("Done") });
  await admin.patch("/api/tickets/WEB-1", { priority: "urgent", labels: ["bug"], assigneeId: ada.id });
  return { ada, status };
}

async function listed(admin: Client, query: string) {
  const res = await admin.get(`/api/projects/CRONK/tickets?${query}`);
  expect(res.status, query).toBe(200);
  return res.body.tickets.map((t: { key: string }) => t.key);
}

describe("Filtering a Project's Tickets", () => {
  it("narrows by Status, Status Category, Assignee, Priority or Label", async () => {
    const { admin } = await startInstalledCronk();
    const { ada, status } = await seed(admin);

    expect(await listed(admin, "")).toEqual(["CRONK-1", "CRONK-2", "CRONK-3", "CRONK-4"]);
    expect(await listed(admin, `status=${status("Todo")}`)).toEqual(["CRONK-2"]);
    expect(await listed(admin, "category=started")).toEqual(["CRONK-3"]);
    expect(await listed(admin, `assignee=${ada.id}`)).toEqual(["CRONK-1", "CRONK-3"]);
    expect(await listed(admin, "assignee=none")).toEqual(["CRONK-2", "CRONK-4"]);
    expect(await listed(admin, "priority=urgent")).toEqual(["CRONK-1", "CRONK-4"]);
    expect(await listed(admin, "priority=none")).toEqual(["CRONK-3"]);
    expect(await listed(admin, "label=ui")).toEqual(["CRONK-1", "CRONK-3"]);
  });

  it("narrows by Delegate, or to Tickets no Agent is delegated", async () => {
    const { admin } = await startInstalledCronk();
    const { ada } = await seed(admin);
    const laptop = (await admin.post("/api/agents", { name: "claude-laptop" })).body.agent;
    const desktop = (await admin.post("/api/agents", { name: "claude-desktop" })).body.agent;
    await admin.patch("/api/tickets/CRONK-1", { delegateId: laptop.id });
    await admin.patch("/api/tickets/CRONK-3", { delegateId: desktop.id });
    await admin.patch("/api/tickets/WEB-1", { delegateId: laptop.id });

    expect(await listed(admin, `delegate=${laptop.id}`)).toEqual(["CRONK-1"]);
    expect(await listed(admin, `delegate=${laptop.id}&delegate=${desktop.id}`)).toEqual(["CRONK-1", "CRONK-3"]);
    expect(await listed(admin, "delegate=none")).toEqual(["CRONK-2", "CRONK-4"]);
    expect(await listed(admin, `delegate=${desktop.id}&assignee=${ada.id}`)).toEqual(["CRONK-3"]);
    expect((await admin.get("/api/projects/CRONK/tickets?delegate=someone")).status).toBe(400);
  });

  it("matches any of several values for one field, and all of the fields given", async () => {
    const { admin } = await startInstalledCronk();
    const { ada } = await seed(admin);

    expect(await listed(admin, "priority=urgent&priority=high")).toEqual(["CRONK-1", "CRONK-2", "CRONK-4"]);
    expect(await listed(admin, "category=backlog&category=completed")).toEqual(["CRONK-1", "CRONK-4"]);
    expect(await listed(admin, "priority=urgent&label=bug")).toEqual(["CRONK-1"]);
    expect(await listed(admin, `label=bug&assignee=${ada.id}&category=backlog`)).toEqual(["CRONK-1"]);
    expect(await listed(admin, "label=docs")).toEqual([]);
  });

  it("refuses values that can't match", async () => {
    const { admin } = await startInstalledCronk();
    await seed(admin);
    for (const query of ["priority=critical", "category=done", "status=not-a-uuid", "assignee=someone"]) {
      expect((await admin.get(`/api/projects/CRONK/tickets?${query}`)).status, query).toBe(400);
    }
  });

  it("refuses a filter it doesn't know, naming it, rather than listing every Ticket", async () => {
    const { admin } = await startInstalledCronk();
    await seed(admin);
    const res = await admin.get("/api/projects/CRONK/tickets?labels=bug");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('querystring has unknown field "labels"');
  });
});
