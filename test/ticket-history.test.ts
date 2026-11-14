import { describe, expect, it } from "vitest";
import { startInstalledCronk } from "./harness.js";

describe("Ticket history", () => {
  it("records every change with the Actor who made it and when", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { statuses } = (await admin.get("/api/projects/CRONK")).body;
    const [backlog, todo] = statuses;

    await admin.post("/api/projects/CRONK/tickets", { title: "Add login", description: "v1" });
    cronk.clock.advance(60_000);
    await admin.patch("/api/tickets/CRONK-1", { title: "Add sign-in", description: "v2" });
    cronk.clock.advance(60_000);
    await admin.patch("/api/tickets/CRONK-1", { statusId: todo.id });

    const history = await admin.get("/api/tickets/CRONK-1/history");
    expect(history.status).toBe(200);
    const actor = { kind: "user", id: ada.id, name: "Ada" };
    expect(history.body.entries).toEqual([
      { at: "2026-01-01T09:00:00.000Z", actor, change: "created", title: "Add login", description: "v1", status: backlog },
      { at: "2026-01-01T09:01:00.000Z", actor, change: "title", from: "Add login", to: "Add sign-in" },
      { at: "2026-01-01T09:01:00.000Z", actor, change: "description", from: "v1", to: "v2" },
      { at: "2026-01-01T09:02:00.000Z", actor, change: "status", from: backlog, to: todo },
    ]);
  });

  it("leaves out edits that change nothing", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const [backlog] = (await admin.get("/api/projects/CRONK")).body.statuses;
    await admin.post("/api/projects/CRONK/tickets", { title: "Same" });

    await admin.patch("/api/tickets/CRONK-1", { title: " Same ", description: "", statusId: backlog.id });

    const { entries } = (await admin.get("/api/tickets/CRONK-1/history")).body;
    expect(entries.map((e: { change: string }) => e.change)).toEqual(["created"]);
  });
});
