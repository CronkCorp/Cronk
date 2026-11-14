import { describe, expect, it } from "vitest";
import { startInstalledCronk, type Client } from "./harness.js";

async function projectWithTickets(client: Client, key: string, count: number) {
  const res = await client.post("/api/projects", { name: key, key });
  if (res.status !== 201) throw new Error(`Creating Project ${key} failed: ${JSON.stringify(res.body)}`);
  for (let i = 1; i <= count; i++) await client.post(`/api/projects/${key}/tickets`, { title: `Ticket ${i}` });
}

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

    const { changes } = (await admin.get("/api/tickets/CRONK-2/history")).body;
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
