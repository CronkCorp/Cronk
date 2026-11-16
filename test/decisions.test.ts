import { describe, expect, it } from "vitest";
import { agentOf, joinAs, startInstalledCronk } from "./harness.js";

describe("Decisions", () => {
  it("are recorded in a Project as proposed, keyed by the Project's key and their number", async () => {
    const { admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });

    const created = await admin.post("/api/projects/CRONK/decisions", { title: "Postgres for storage", body: "We use Postgres.", group: "Storage" });
    expect(created.status).toBe(201);
    expect(created.body.decision).toMatchObject({
      key: "CRONK-D1",
      number: 1,
      projectKey: "CRONK",
      title: "Postgres for storage",
      status: "proposed",
      group: "Storage",
      body: "We use Postgres.",
      version: 1,
      supersedes: [],
      supersededBy: null,
      proposedBy: { kind: "user", id: ada.id, name: "Ada" },
      createdAt: "2026-01-01T09:00:00.000Z",
    });

    const got = await admin.get("/api/decisions/cronk-d1");
    expect(got.status).toBe(200);
    expect(got.body.decision).toEqual(created.body.decision);
  });
});

describe("Decision keys", () => {
  it("are allocated in order per Project and in the Workspace, which is keyed D<n>", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Site", key: "SITE" });

    const keys = [];
    for (const path of ["/api/projects/CRONK", "/api/workspace", "/api/projects/CRONK", "/api/projects/SITE", "/api/workspace", "/api/projects/CRONK"]) {
      const res = await admin.post(`${path}/decisions`, { title: "A choice" });
      expect(res.status).toBe(201);
      keys.push(res.body.decision.key);
    }

    expect(keys).toEqual(["CRONK-D1", "D1", "CRONK-D2", "SITE-D1", "D2", "CRONK-D3"]);
    expect((await admin.get("/api/decisions/d2")).body.decision).toMatchObject({ key: "D2", projectId: null, projectKey: null });
    expect((await admin.get("/api/decisions/SITE-D2")).status).toBe(404);
    expect((await admin.get("/api/decisions/CRONK-2")).status).toBe(404);
  });

  it("never repeat when Decisions are recorded at the same time", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });

    const made = await Promise.all([1, 2, 3, 4].map(() => admin.post("/api/projects/CRONK/decisions", { title: "Same time" })));

    expect(made.map((r) => r.body.decision.key).sort()).toEqual(["CRONK-D1", "CRONK-D2", "CRONK-D3", "CRONK-D4"]);
  });
});

describe("a new Decision", () => {
  it("starts with the ADR sections when no body is given", async () => {
    const { admin } = await startInstalledCronk();

    const { decision } = (await admin.post("/api/workspace/decisions", { title: "Compose for installs", group: "  " })).body;

    expect(decision.group).toBeNull();
    expect(decision.body).toMatch(/^What was decided, and why\.\n\n## Consequences\n[\s\S]*\n## Considered Options\n/);
  });
});

describe("editing a Decision", () => {
  it("saves a new Version when based on the current one, and keeps every Version", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Postgres", body: "v1" });
    cronk.clock.advance(60_000);

    const edited = await admin.patch("/api/decisions/CRONK-D1", { baseVersion: 1, title: "Postgres for storage", body: "v2", group: "Storage" });
    expect(edited.status).toBe(200);
    expect(edited.body.decision).toMatchObject({ title: "Postgres for storage", body: "v2", group: "Storage", version: 2, updatedAt: "2026-01-01T09:01:00.000Z" });
    const regrouped = await admin.patch("/api/decisions/CRONK-D1", { baseVersion: 2, group: null });
    expect(regrouped.body.decision).toMatchObject({ title: "Postgres for storage", body: "v2", group: null, version: 3 });
    // A save that changes nothing makes no Version.
    expect((await admin.patch("/api/decisions/CRONK-D1", { baseVersion: 3, body: "v2" })).body.decision.version).toBe(3);

    const versions = (await admin.get("/api/decisions/CRONK-D1/versions")).body.versions;
    expect(versions.map((v: { number: number; title: string }) => [v.number, v.title])).toEqual([
      [3, "Postgres for storage"],
      [2, "Postgres for storage"],
      [1, "Postgres"],
    ]);
    expect((await admin.get("/api/decisions/CRONK-D1/versions/1")).body.version).toEqual({
      number: 1,
      title: "Postgres",
      body: "v1",
      status: "proposed",
      group: null,
      supersedes: [],
      at: "2026-01-01T09:00:00.000Z",
      actor: { kind: "user", id: ada.id, name: "Ada" },
    });
    expect((await admin.get("/api/decisions/CRONK-D1/versions/4")).status).toBe(404);
  });

  it("is refused when based on an outdated Version, returning the current Version", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/workspace/decisions", { title: "Compose", body: "v1" });
    await admin.patch("/api/decisions/D1", { baseVersion: 1, body: "theirs" });

    const stale = await admin.patch("/api/decisions/D1", { baseVersion: 1, body: "mine" });

    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/Version 2/);
    expect(stale.body.current).toMatchObject({ number: 2, body: "theirs" });
    expect((await admin.get("/api/decisions/D1")).body.decision).toMatchObject({ body: "theirs", version: 2 });
  });
});

describe("a Decision's status", () => {
  it("is changed by a User, recording who changed it and when", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const grace = await joinAs(cronk, admin, "grace@example.com");
    const graceId = (await grace.get("/api/me")).body.user.id;
    await admin.post("/api/projects/CRONK/decisions", { title: "Postgres" });
    cronk.clock.advance(60_000);

    const accepted = await grace.post("/api/decisions/CRONK-D1/status", { status: "accepted" });

    expect(accepted.status).toBe(200);
    expect(accepted.body.decision).toMatchObject({
      status: "accepted",
      version: 2,
      proposedBy: { kind: "user", id: ada.id },
      statusChangedBy: { kind: "user", id: graceId, name: "grace" },
      statusChangedAt: "2026-01-01T09:01:00.000Z",
    });
    expect((await admin.get("/api/decisions/CRONK-D1/versions/2")).body.version).toMatchObject({ status: "accepted", actor: { id: graceId } });
    // An edit keeps who changed the status.
    const edited = await admin.patch("/api/decisions/CRONK-D1", { baseVersion: 2, body: "Reasons." });
    expect(edited.body.decision).toMatchObject({ version: 3, statusChangedBy: { id: graceId }, statusChangedAt: "2026-01-01T09:01:00.000Z" });

    for (const status of ["deprecated", "rejected", "proposed"]) {
      expect((await admin.post("/api/decisions/CRONK-D1/status", { status })).body.decision.status).toBe(status);
    }
  });

  it("is never changed by an Agent, which may only read Decisions", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Postgres" });
    const claude = await agentOf(cronk, admin, "claude-laptop");

    expect((await claude.get("/api/decisions/CRONK-D1")).status).toBe(200);
    const refused = await claude.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Only a User/);
    expect((await claude.post("/api/projects/CRONK/decisions", { title: "Mine" })).status).toBe(403);
    expect((await claude.patch("/api/decisions/CRONK-D1", { baseVersion: 1, body: "Mine" })).status).toBe(403);
    expect((await admin.get("/api/decisions/CRONK-D1")).body.decision).toMatchObject({ status: "proposed", version: 1 });
  });

  it("can't be set to superseded directly, nor changed by a User with only Read", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const grace = await joinAs(cronk, admin, "grace@example.com");
    const graceId = (await grace.get("/api/me")).body.user.id;
    await admin.put(`/api/projects/CRONK/members/${graceId}`, { access: "read" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Postgres" });

    const superseded = await admin.post("/api/decisions/CRONK-D1/status", { status: "superseded" });
    expect(superseded.status).toBe(400);
    expect(superseded.body.error).toMatch(/supersede/);
    expect((await grace.post("/api/decisions/CRONK-D1/status", { status: "accepted" })).status).toBe(403);
    expect((await grace.get("/api/decisions/CRONK-D1")).status).toBe(200);
  });
});

describe("superseding a Decision", () => {
  it("takes effect when the Decision superseding it is accepted", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const grace = await joinAs(cronk, admin, "grace@example.com");
    const graceId = (await grace.get("/api/me")).body.user.id;
    await admin.post("/api/projects/CRONK/decisions", { title: "Sign-in limits in the API" });
    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });

    const newer = await admin.post("/api/projects/CRONK/decisions", { title: "Per-email limits", supersedes: ["cronk-d1"] });
    expect(newer.body.decision.supersedes).toEqual([{ key: "CRONK-D1", title: "Sign-in limits in the API", status: "accepted" }]);
    // Proposing a replacement changes nothing yet.
    expect((await admin.get("/api/decisions/CRONK-D1")).body.decision).toMatchObject({ status: "accepted", supersededBy: null });

    await grace.post("/api/decisions/CRONK-D2/status", { status: "accepted" });

    const older = (await admin.get("/api/decisions/CRONK-D1")).body.decision;
    expect(older).toMatchObject({
      status: "superseded",
      supersededBy: { key: "CRONK-D2", title: "Per-email limits", status: "accepted" },
      statusChangedBy: { id: graceId },
      version: 3,
    });
    expect((await admin.get("/api/decisions/CRONK-D2")).body.decision.supersedes).toEqual([
      { key: "CRONK-D1", title: "Sign-in limits in the API", status: "superseded" },
    ]);
  });

  it("is set by editing the newer Decision, and applies at once if it is already accepted", async () => {
    const { admin } = await startInstalledCronk();
    for (const title of ["Old", "Rejected idea", "New"]) await admin.post("/api/workspace/decisions", { title });
    await admin.post("/api/decisions/D2/status", { status: "rejected" });
    await admin.post("/api/decisions/D3/status", { status: "accepted" });

    const edited = await admin.patch("/api/decisions/D3", { baseVersion: 2, supersedes: ["D1", "D2"] });

    expect(edited.status).toBe(200);
    expect((await admin.get("/api/decisions/D1")).body.decision).toMatchObject({ status: "superseded", supersededBy: { key: "D3" } });
    // A rejected proposal stays rejected, with its reasons.
    expect((await admin.get("/api/decisions/D2")).body.decision).toMatchObject({ status: "rejected", supersededBy: null });
    expect((await admin.get("/api/decisions/D3/versions/3")).body.version.supersedes).toEqual(["D1", "D2"]);
  });

  it("names only other Decisions of the same Project or Workspace", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/workspace/decisions", { title: "Workspace-wide" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Here" });

    for (const supersedes of [["D1"], ["CRONK-D9"], ["CRONK-D1"], ["nonsense"]]) {
      const res = await admin.patch("/api/decisions/CRONK-D1", { baseVersion: 1, supersedes });
      expect(res.status, supersedes[0]).toBe(400);
    }
    expect((await admin.post("/api/projects/CRONK/decisions", { title: "Elsewhere", supersedes: ["D1"] })).status).toBe(400);
  });
});
