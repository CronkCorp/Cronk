import { describe, expect, it } from "vitest";
import { agentOf, joinAs, startInstalledCronk } from "./harness.js";

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

  it("is written only by Admins, and read by Members and Agents the Workspace lets in", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.put("/api/workspace/guidance", { markdown: "Be kind.", baseVersion: 0 });
    const member = await joinAs(cronk, admin, "bob@example.com");
    const claude = await agentOf(cronk, admin, "claude-laptop");

    expect((await member.get("/api/workspace/guidance")).body.guidance.markdown).toBe("Be kind.");
    expect((await claude.get("/api/workspace/guidance")).body.guidance.markdown).toBe("Be kind.");
    expect((await member.put("/api/workspace/guidance", { markdown: "Be rude.", baseVersion: 1 })).status).toBe(403);
    expect((await claude.put("/api/workspace/guidance", { markdown: "Be rude.", baseVersion: 1 })).status).toBe(403);

    await admin.patch("/api/workspace", { agentAccess: "none" });
    expect((await claude.get("/api/workspace/guidance")).status).toBe(403);
    expect((await claude.get("/api/workspace/guidance/versions")).status).toBe(403);
    expect((await admin.get("/api/workspace/guidance")).body.guidance).toEqual({ markdown: "Be kind.", version: 1 });
  });
});

describe("Project Guidance", () => {
  it("is written by Users with Write in the Project, versioned apart from the Workspace's", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.put("/api/workspace/guidance", { markdown: "Workspace rules.", baseVersion: 0 });
    const writer = await joinAs(cronk, admin, "bob@example.com");
    const writerId = (await writer.get("/api/me")).body.user.id;

    expect((await writer.get("/api/projects/cronk/guidance")).body).toEqual({ guidance: { markdown: "", version: 0 } });
    const saved = await writer.put("/api/projects/cronk/guidance", { markdown: "Use pnpm.", baseVersion: 0 });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ guidance: { markdown: "Use pnpm.", version: 1 } });
    expect((await admin.get("/api/projects/CRONK/guidance")).body.guidance).toEqual({ markdown: "Use pnpm.", version: 1 });
    expect((await admin.get("/api/projects/CRONK/guidance/versions")).body.versions).toEqual([
      { version: 1, markdown: "Use pnpm.", at: "2026-01-01T09:00:00.000Z", actor: { kind: "user", id: writerId, name: "bob" } },
    ]);
    expect((await admin.get("/api/workspace/guidance")).body.guidance).toEqual({ markdown: "Workspace rules.", version: 1 });

    const stale = await admin.put("/api/projects/CRONK/guidance", { markdown: "Use npm.", baseVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.guidance).toEqual({ markdown: "Use pnpm.", version: 1 });
  });

  it("is read by anyone who can see the Project, and refused to Readers, Agents and those who can't see it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.put("/api/projects/CRONK/guidance", { markdown: "Use pnpm.", baseVersion: 0 });
    const reader = await joinAs(cronk, admin, "bob@example.com");
    await admin.put(`/api/projects/CRONK/members/${(await reader.get("/api/me")).body.user.id}`, { access: "read" });
    const claude = await agentOf(cronk, admin, "claude-laptop");

    expect((await reader.get("/api/projects/CRONK/guidance")).body.guidance.markdown).toBe("Use pnpm.");
    expect((await claude.get("/api/projects/CRONK/guidance")).body.guidance.markdown).toBe("Use pnpm.");
    expect((await reader.put("/api/projects/CRONK/guidance", { markdown: "Use npm.", baseVersion: 1 })).status).toBe(403);
    expect((await claude.put("/api/projects/CRONK/guidance", { markdown: "Use npm.", baseVersion: 1 })).status).toBe(403);
    expect((await reader.get("/api/projects/SECRET/guidance")).status).toBe(404);
    expect((await reader.get("/api/projects/SECRET/guidance/versions")).status).toBe(404);
    expect((await reader.put("/api/projects/SECRET/guidance", { markdown: "Hi.", baseVersion: 0 })).status).toBe(404);

    await admin.patch("/api/projects/CRONK", { agentAccess: "none" });
    expect((await claude.get("/api/projects/CRONK/guidance")).status).toBe(404);
    expect((await admin.get("/api/projects/CRONK/guidance")).body.guidance).toEqual({ markdown: "Use pnpm.", version: 1 });
  });
});
