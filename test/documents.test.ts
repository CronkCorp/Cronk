import { describe, expect, it } from "vitest";
import { startInstalledCronk } from "./harness.js";

describe("Documents", () => {
  it("are created in a Project as Markdown, at Version 1", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });

    const created = await admin.post("/api/projects/CRONK/documents", { title: "Onboarding", body: "# Hello\n\nSee CRONK-1." });
    expect(created.status).toBe(201);
    expect(created.body.document).toMatchObject({
      projectKey: "CRONK",
      parentId: null,
      title: "Onboarding",
      body: "# Hello\n\nSee CRONK-1.",
      version: 1,
    });

    const got = await admin.get(`/api/documents/${created.body.document.id}`);
    expect(got.status).toBe(200);
    expect(got.body.document).toEqual(created.body.document);
  });
});

describe("saving a Document", () => {
  it("creates a new Version when based on the current one", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { id } = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "v1" })).body.document;
    cronk.clock.advance(60_000);

    const saved = await admin.patch(`/api/documents/${id}`, { baseVersion: 1, body: "v2" });
    expect(saved.status).toBe(200);
    expect(saved.body.document).toMatchObject({ title: "Plan", body: "v2", version: 2, updatedAt: "2026-01-01T09:01:00.000Z" });
    const renamed = await admin.patch(`/api/documents/${id}`, { baseVersion: 2, title: "The plan" });
    expect(renamed.body.document).toMatchObject({ title: "The plan", body: "v2", version: 3 });
    expect((await admin.get(`/api/documents/${id}`)).body.document).toMatchObject({ title: "The plan", body: "v2", version: 3 });
  });

  it("is refused when based on an outdated Version, returning the current Version", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { id } = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "v1" })).body.document;
    await admin.patch(`/api/documents/${id}`, { baseVersion: 1, body: "theirs" });

    const stale = await admin.patch(`/api/documents/${id}`, { baseVersion: 1, body: "mine" });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/Version 2/);
    expect(stale.body.current).toEqual({
      number: 2,
      title: "Plan",
      body: "theirs",
      at: cronk.clock.now().toISOString(),
      actor: { kind: "user", id: ada.id, name: "Ada" },
      restoredFrom: null,
    });
    expect((await admin.get(`/api/documents/${id}`)).body.document).toMatchObject({ body: "theirs", version: 2 });
  });

  it("must name the Version it is based on", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { id } = (await admin.post("/api/projects/CRONK/documents", { title: "Plan" })).body.document;

    const res = await admin.patch(`/api/documents/${id}`, { body: "no base" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/baseVersion/);
  });
});
