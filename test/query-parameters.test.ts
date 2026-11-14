import { describe, expect, it } from "vitest";
import { startInstalledCronk } from "./harness.js";

describe("Query parameters a route doesn't declare", () => {
  it("are refused on a route that takes none, naming the parameter", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "First" });

    expect((await admin.get("/api/tickets/CRONK-1")).status).toBe(200);
    const res = await admin.get("/api/tickets/CRONK-1?fields=title");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('querystring has unknown field "fields"');
  });

  it("are refused on a write, which then changes nothing", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "First" });

    const res = await admin.patch("/api/tickets/CRONK-1?notify=false", { title: "Renamed" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('querystring has unknown field "notify"');
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.title).toBe("First");
  });
});
