import { describe, expect, it } from "vitest";
import { registerAgent, startInstalledCronk } from "./harness.js";

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

describe("Versions", () => {
  it("are listed newest first with the Actor who saved each, and the Agent Session an Agent saved in", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { id } = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "v1" })).body.document;
    const claude = await registerAgent(admin, "claude-laptop");
    const session = (await cronk.client(claude.secret).post("/api/agent-sessions")).body.session;
    cronk.clock.advance(60_000);

    const inSession = cronk.client(claude.secret, { "cronk-agent-session": session.id });
    expect((await inSession.patch(`/api/documents/${id}`, { baseVersion: 1, body: "v2" })).status).toBe(200);
    await cronk.client(claude.secret).patch(`/api/documents/${id}`, { baseVersion: 2, body: "v3" });

    const res = await admin.get(`/api/documents/${id}/versions`);
    expect(res.status).toBe(200);
    const agent = { kind: "agent", id: claude.agentId, name: "claude-laptop", owner: { id: ada.id, name: "Ada" } };
    expect(res.body.versions).toEqual([
      { number: 3, title: "Plan", at: "2026-01-01T09:01:00.000Z", actor: { ...agent, session: null }, restoredFrom: null },
      { number: 2, title: "Plan", at: "2026-01-01T09:01:00.000Z", actor: { ...agent, session: { id: session.id } }, restoredFrom: null },
      { number: 1, title: "Plan", at: "2026-01-01T09:00:00.000Z", actor: { kind: "user", id: ada.id, name: "Ada" }, restoredFrom: null },
    ]);
    expect((await admin.get(`/api/documents/${id}/versions/2`)).body.version).toMatchObject({ number: 2, body: "v2" });
    expect((await admin.get(`/api/documents/${id}/versions/9`)).status).toBe(404);
  });

  it("leave out saves that change nothing", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { id } = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "v1" })).body.document;

    const res = await admin.patch(`/api/documents/${id}`, { baseVersion: 1, title: " Plan ", body: "v1" });
    expect(res.body.document.version).toBe(1);
    expect((await admin.get(`/api/documents/${id}/versions`)).body.versions).toHaveLength(1);
  });

  it("can be restored, which saves a new Version with the earlier title and body", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { id } = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "v1" })).body.document;
    await admin.patch(`/api/documents/${id}`, { baseVersion: 1, title: "Plan B", body: "v2" });

    const restored = await admin.post(`/api/documents/${id}/versions/1/restore`, { baseVersion: 2 });
    expect(restored.status).toBe(200);
    expect(restored.body.document).toMatchObject({ title: "Plan", body: "v1", version: 3 });
    const [latest] = (await admin.get(`/api/documents/${id}/versions`)).body.versions;
    expect(latest).toMatchObject({ number: 3, title: "Plan", restoredFrom: 1 });

    const stale = await admin.post(`/api/documents/${id}/versions/2/restore`, { baseVersion: 2 });
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({ number: 3, body: "v1" });
    expect((await admin.post(`/api/documents/${id}/versions/7/restore`, { baseVersion: 3 })).status).toBe(404);
  });
});

/** A page tree as `title` (depth by indentation), for comparing arrangements at a glance. */
const outline = (documents: { title: string; depth: number }[]) => documents.map((d) => `${"  ".repeat(d.depth)}${d.title}`);

describe("the page tree", () => {
  it("lists a Project's Documents depth first, siblings in the order they were added", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const create = async (title: string, parentId?: string) =>
      (await admin.post("/api/projects/CRONK/documents", { title, ...(parentId && { parentId }) })).body.document.id as string;
    const guides = await create("Guides");
    await create("Roadmap");
    const setup = await create("Setup", guides);
    await create("Docker", setup);
    await create("Style", guides);

    const res = await admin.get("/api/projects/CRONK/documents");
    expect(res.status).toBe(200);
    expect(outline(res.body.documents)).toEqual(["Guides", "  Setup", "    Docker", "  Style", "Roadmap"]);
    expect(res.body.documents[1]).toEqual({ id: setup, parentId: guides, title: "Setup", depth: 1 });
  });

  it("keeps Workspace Documents in a tree of their own", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/documents", { title: "Project doc" });
    const handbook = await admin.post("/api/workspace/documents", { title: "Handbook", body: "Welcome" });
    expect(handbook.status).toBe(201);
    expect(handbook.body.document).toMatchObject({ projectId: null, projectKey: null, title: "Handbook", version: 1 });

    expect(outline((await admin.get("/api/workspace/documents")).body.documents)).toEqual(["Handbook"]);
    expect(outline((await admin.get("/api/projects/CRONK/documents")).body.documents)).toEqual(["Project doc"]);
    const across = await admin.post("/api/projects/CRONK/documents", { title: "Stray", parentId: handbook.body.document.id });
    expect(across.status).toBe(400);
  });
});
