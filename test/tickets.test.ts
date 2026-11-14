import { describe, expect, it } from "vitest";
import { startInstalledCronk, type Client } from "./harness.js";

async function project(client: Client, key: string) {
  const res = await client.post("/api/projects", { name: key, key });
  if (res.status !== 201) throw new Error(`Creating Project ${key} failed: ${JSON.stringify(res.body)}`);
}

describe("Tickets", () => {
  it("get keys numbered in order per Project", async () => {
    const { admin } = await startInstalledCronk();
    await project(admin, "CRONK");
    await project(admin, "WEB");

    const keys = [];
    for (const [key, title] of [["CRONK", "First"], ["CRONK", "Second"], ["WEB", "Other"], ["CRONK", "Third"]] as const) {
      const res = await admin.post(`/api/projects/${key}/tickets`, { title });
      expect(res.status).toBe(201);
      keys.push(res.body.ticket.key);
    }
    expect(keys).toEqual(["CRONK-1", "CRONK-2", "WEB-1", "CRONK-3"]);
  });

  it("never share a key when created at the same time", async () => {
    const { admin } = await startInstalledCronk();
    await project(admin, "CRONK");

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => admin.post("/api/projects/CRONK/tickets", { title: `T${i}` })));
    const keys = results.map((r) => r.body.ticket.key).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    expect(keys).toEqual(Array.from({ length: 10 }, (_, i) => `CRONK-${i + 1}`));
  });

  it("have a title and Markdown description that can be viewed and edited", async () => {
    const { admin } = await startInstalledCronk();
    await project(admin, "CRONK");
    await admin.post("/api/projects/CRONK/tickets", { title: " Add login ", description: "# Why\n\nUsers need *access*." });

    const viewed = await admin.get("/api/tickets/CRONK-1");
    expect(viewed.status).toBe(200);
    expect(viewed.body.ticket).toMatchObject({
      key: "CRONK-1",
      title: "Add login",
      description: "# Why\n\nUsers need *access*.",
      status: { name: "Backlog", category: "backlog" },
    });

    const edited = await admin.patch("/api/tickets/cronk-1", { title: "Add sign-in", description: "- [ ] form" });
    expect(edited.status).toBe(200);
    expect(edited.body.ticket).toMatchObject({ key: "CRONK-1", title: "Add sign-in", description: "- [ ] form" });
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket).toMatchObject({ title: "Add sign-in", description: "- [ ] form" });
  });

  it("refuse a blank title, and answer 404 for keys that don't exist", async () => {
    const { admin } = await startInstalledCronk();
    await project(admin, "CRONK");
    expect((await admin.post("/api/projects/CRONK/tickets", { title: "  " })).status).toBe(400);
    await admin.post("/api/projects/CRONK/tickets", { title: "Real" });
    expect((await admin.patch("/api/tickets/CRONK-1", { title: "" })).status).toBe(400);

    for (const key of ["CRONK-2", "NOPE-1", "CRONK", "CRONK-x"]) {
      expect((await admin.get(`/api/tickets/${key}`)).status, key).toBe(404);
    }
    expect((await admin.post("/api/projects/NOPE/tickets", { title: "Lost" })).status).toBe(404);
  });

  it("can be moved by a User to any of their Project's Statuses", async () => {
    const { admin } = await startInstalledCronk();
    await project(admin, "CRONK");
    await admin.post("/api/projects/CRONK/tickets", { title: "Ship it" });
    const { statuses } = (await admin.get("/api/projects/CRONK")).body;

    for (const status of [...statuses].reverse()) {
      const moved = await admin.patch("/api/tickets/CRONK-1", { statusId: status.id });
      expect(moved.status).toBe(200);
      expect(moved.body.ticket.status).toEqual(status);
    }
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.status.name).toBe("Backlog");
  });

  it("can't be moved to another Project's Status", async () => {
    const { admin } = await startInstalledCronk();
    await project(admin, "CRONK");
    await project(admin, "WEB");
    await admin.post("/api/projects/CRONK/tickets", { title: "Stay home" });
    const webDone = (await admin.get("/api/projects/WEB")).body.statuses.find((s: { name: string }) => s.name === "Done");

    const moved = await admin.patch("/api/tickets/CRONK-1", { statusId: webDone.id });
    expect(moved.status).toBe(400);
    expect((await admin.patch("/api/tickets/CRONK-1", { statusId: "not-a-uuid" })).status).toBe(400);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.status.name).toBe("Backlog");
  });

  it("are listed per Project in key order, each with its Status, for the list and board views", async () => {
    const { admin } = await startInstalledCronk();
    await project(admin, "CRONK");
    await project(admin, "WEB");
    const [, todo] = (await admin.get("/api/projects/CRONK")).body.statuses;
    for (let i = 1; i <= 11; i++) await admin.post("/api/projects/CRONK/tickets", { title: `Ticket ${i}` });
    await admin.post("/api/projects/WEB/tickets", { title: "Elsewhere" });
    await admin.patch("/api/tickets/CRONK-2", { statusId: todo.id });

    const listed = await admin.get("/api/projects/CRONK/tickets");
    expect(listed.status).toBe(200);
    expect(listed.body.tickets.map((t: { key: string }) => t.key)).toEqual(Array.from({ length: 11 }, (_, i) => `CRONK-${i + 1}`));
    expect(listed.body.tickets[1]).toMatchObject({ title: "Ticket 2", status: todo });
    expect((await admin.get("/api/projects/NOPE/tickets")).status).toBe(404);
  });
});
