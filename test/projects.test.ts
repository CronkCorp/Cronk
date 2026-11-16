import { describe, expect, it } from "vitest";
import { registerAgent, startInstalledCronk, startSession } from "./harness.js";

describe("Projects", () => {
  it("are created with a name and a key, and come with the default Statuses", async () => {
    const { admin } = await startInstalledCronk();

    const created = await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({ name: "Cronk", key: "CRONK", archived: false });

    const fetched = await admin.get("/api/projects/CRONK");
    expect(fetched.status).toBe(200);
    expect(fetched.body.project).toMatchObject({ name: "Cronk", key: "CRONK" });
    expect(fetched.body.statuses.map((s: { name: string; category: string }) => [s.name, s.category])).toEqual([
      ["Backlog", "backlog"],
      ["Todo", "unstarted"],
      ["In Progress", "started"],
      ["In Review", "in_review"],
      ["Done", "completed"],
      ["Canceled", "canceled"],
    ]);
  });

  it("need a key no other Project has, compared without case", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });

    const clash = await admin.post("/api/projects", { name: "Other", key: "cronk" });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/CRONK/);
  });

  it("refuse a key that isn't 2-10 letters or digits starting with a letter", async () => {
    const { admin } = await startInstalledCronk();
    for (const key of ["C", "1ABC", "CR-ONK", "ABCDEFGHIJK", ""]) {
      expect((await admin.post("/api/projects", { name: "Bad", key })).status, key).toBe(400);
    }
    const lower = await admin.post("/api/projects", { name: "Lower", key: "web2" });
    expect(lower.body.project.key).toBe("WEB2");
  });

  it("are listed in the overview by name", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Website", key: "WEB" });
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });

    const listed = await admin.get("/api/projects");
    expect(listed.status).toBe(200);
    expect(listed.body.projects.map((p: { key: string }) => p.key)).toEqual(["CRONK", "WEB"]);
  });

  it("leave the default overview when archived but stay accessible, and can be restored", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Old site", key: "OLD" });
    await admin.post("/api/projects/OLD/tickets", { title: "Legacy work" });

    const archived = await admin.patch("/api/projects/OLD", { archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.project).toMatchObject({ key: "OLD", archived: true });

    expect((await admin.get("/api/projects")).body.projects.map((p: { key: string }) => p.key)).toEqual(["CRONK"]);
    expect((await admin.get("/api/projects?archived=true")).body.projects.map((p: { key: string }) => p.key)).toEqual(["OLD"]);
    expect((await admin.get("/api/projects/OLD")).body.project).toMatchObject({ name: "Old site", archived: true });
    expect((await admin.get("/api/tickets/OLD-1")).body.ticket.title).toBe("Legacy work");

    await admin.patch("/api/projects/OLD", { archived: false });
    expect((await admin.get("/api/projects")).body.projects.map((p: { key: string }) => p.key)).toEqual(["CRONK", "OLD"]);
  });

  it("can be renamed but keep their key", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const renamed = await admin.patch("/api/projects/CRONK", { name: " Cronk app " });
    expect(renamed.body.project).toMatchObject({ name: "Cronk app", key: "CRONK" });
    const rekeyed = await admin.patch("/api/projects/CRONK", { key: "APP" });
    expect(rekeyed.status).toBe(400);
    expect(rekeyed.body.error).toBe('body has unknown field "key"');
    expect((await admin.get("/api/projects/CRONK")).body.project).toMatchObject({ name: "Cronk app", key: "CRONK" });
    expect((await admin.get("/api/projects/APP")).status).toBe(404);
  });

  it("name a misspelt field when refusing it, even while a required field is missing", async () => {
    const { admin } = await startInstalledCronk();
    const res = await admin.post("/api/projects", { name: "Cronk", kee: "CRONK" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('body has unknown field "kee"');
    expect((await admin.get("/api/projects")).body.projects).toEqual([]);
  });

  it("are only shown to signed-in Users", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Secret" });
    const stranger = cronk.client();
    for (const res of [
      await stranger.get("/api/projects"),
      await stranger.post("/api/projects", { name: "Mine", key: "MINE" }),
      await stranger.get("/api/projects/CRONK"),
      await stranger.patch("/api/projects/CRONK", { archived: true }),
      await stranger.post("/api/projects/CRONK/tickets", { title: "Spam" }),
      await stranger.get("/api/projects/CRONK/tickets"),
      await stranger.get("/api/tickets/CRONK-1"),
      await stranger.patch("/api/tickets/CRONK-1", { title: "Pwned" }),
      await stranger.get("/api/tickets/CRONK-1/changes"),
    ]) {
      expect(res.status).toBe(401);
    }
  });
});

describe("Projects, managed by an Agent", () => {
  it("can't be renamed, archived or unarchived by an Agent, one change at a time or several at once", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Old site", key: "OLD" });
    await admin.patch("/api/projects/OLD", { archived: true });
    const claude = await startSession(cronk, (await registerAgent(admin, "claude-laptop")).secret);
    const cronkBefore = (await admin.get("/api/projects/CRONK")).body.project;
    const oldBefore = (await admin.get("/api/projects/OLD")).body.project;

    for (const res of [
      await claude.patch("/api/projects/CRONK", { name: "Renamed" }),
      await claude.patch("/api/projects/CRONK", { archived: true }),
      await claude.patch("/api/projects/OLD", { archived: false }),
      await claude.patch("/api/projects/OLD", { name: "Old site", archived: false }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Only a User can rename or archive a Project/);
    }
    expect((await admin.get("/api/projects/CRONK")).body.project).toEqual(cronkBefore);
    expect((await admin.get("/api/projects/OLD")).body.project).toEqual(oldBefore);
  });
});
