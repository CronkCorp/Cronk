import { describe, expect, it } from "vitest";
import { joinAs, startInstalledCronk } from "./harness.js";

describe("Workspace Guidance", () => {
  it("starts empty, and an Admin can write it", async () => {
    const { admin } = await startInstalledCronk();
    expect((await admin.get("/api/workspace/guidance")).body).toEqual({ guidance: { markdown: "", version: 0 } });

    const written = await admin.put("/api/workspace/guidance", { markdown: "Write tests first.", baseVersion: 0 });
    expect(written.status).toBe(200);
    expect(written.body).toEqual({ guidance: { markdown: "Write tests first.", version: 1 } });
    expect((await admin.get("/api/workspace/guidance")).body).toEqual({ guidance: { markdown: "Write tests first.", version: 1 } });
  });

  it("refuses a save based on an outdated Version, answering the current Guidance", async () => {
    const { admin } = await startInstalledCronk();
    await admin.put("/api/workspace/guidance", { markdown: "First.", baseVersion: 0 });

    const stale = await admin.put("/api/workspace/guidance", { markdown: "Mine.", baseVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: expect.any(String), guidance: { markdown: "First.", version: 1 } });
    expect((await admin.get("/api/workspace/guidance")).body.guidance).toEqual({ markdown: "First.", version: 1 });
  });

  it("lets only one of two saves on the same Version through", async () => {
    const { admin } = await startInstalledCronk();

    const saves = await Promise.all(["A.", "B.", "C."].map((markdown) => admin.put("/api/workspace/guidance", { markdown, baseVersion: 0 })));

    expect(saves.map((s) => s.status).sort()).toEqual([200, 409, 409]);
    expect((await admin.get("/api/workspace/guidance")).body.guidance.version).toBe(1);
  });

  it("keeps every Version with the User who saved it and when", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    const grace = await joinAs(cronk, admin, "grace@example.com", "admin");
    const graceId = (await grace.get("/api/me")).body.user.id;
    await admin.put("/api/workspace/guidance", { markdown: "First.", baseVersion: 0 });
    cronk.clock.advance(60_000);
    await grace.put("/api/workspace/guidance", { markdown: "Second.", baseVersion: 1 });

    const versions = await admin.get("/api/workspace/guidance/versions");
    expect(versions.status).toBe(200);
    expect(versions.body).toEqual({
      versions: [
        { version: 1, markdown: "First.", at: "2026-01-01T09:00:00.000Z", actor: { kind: "user", id: ada.id, name: "Ada" } },
        { version: 2, markdown: "Second.", at: "2026-01-01T09:01:00.000Z", actor: { kind: "user", id: graceId, name: "grace" } },
      ],
    });
  });
});
