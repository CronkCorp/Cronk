import { describe, expect, it } from "vitest";
import { agentOf, joinAs, startInstalledCronk } from "./harness.js";

describe("marking a Document Protected", () => {
  it("is done and undone by a User with Write, each recorded in its protection history", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { document } = (await admin.post("/api/projects/CRONK/documents", { title: "Architecture", body: "How it is built." })).body;
    expect(document).toMatchObject({ protected: false, protectedBy: null, covers: 0 });

    cronk.clock.advance(60_000);
    const marked = await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
    expect(marked.status).toBe(200);
    expect(marked.body.document).toMatchObject({ protected: true, protectedBy: { id: document.id, title: "Architecture" }, version: 1 });
    expect((await admin.get(`/api/documents/${document.id}`)).body.document.protected).toBe(true);

    cronk.clock.advance(60_000);
    const unmarked = await admin.post(`/api/documents/${document.id}/protection`, { protected: false });
    expect(unmarked.body.document).toMatchObject({ protected: false, protectedBy: null });

    const history = await admin.get(`/api/documents/${document.id}/protection`);
    expect(history.status).toBe(200);
    expect(history.body.markings).toEqual([
      { protected: false, at: "2026-01-01T09:02:00.000Z", actor: { kind: "user", id: ada.id, name: "Ada" } },
      { protected: true, at: "2026-01-01T09:01:00.000Z", actor: { kind: "user", id: ada.id, name: "Ada" } },
    ]);
  });

  it("records nothing when the mark is already as asked", async () => {
    const { admin } = await startInstalledCronk();
    const { document } = (await admin.post("/api/workspace/documents", { title: "Handbook" })).body;

    await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
    await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
    await admin.post(`/api/workspace/documents`, { title: "Other" });

    expect((await admin.get(`/api/documents/${document.id}/protection`)).body.markings).toHaveLength(1);
  });

  it("is refused to a User with only Read, and to Agents", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const bea = await joinAs(cronk, admin, "bea@example.com");
    const beaUser = (await bea.get("/api/me")).body.user;
    await admin.put(`/api/projects/CRONK/members/${beaUser.id}`, { access: "read" });
    const agent = await agentOf(cronk, admin, "claude");
    const { document } = (await admin.post("/api/projects/CRONK/documents", { title: "Architecture" })).body;

    expect((await bea.post(`/api/documents/${document.id}/protection`, { protected: true })).status).toBe(403);
    const byAgent = await agent.post(`/api/documents/${document.id}/protection`, { protected: true });
    expect(byAgent.status).toBe(403);
    expect(byAgent.body.error).toMatch(/Only a User/);
    expect((await admin.get(`/api/documents/${document.id}`)).body.document.protected).toBe(false);
  });
});

/** A Project page tree: Architecture with Storage under it and Backups under that, and Handbook beside it. */
async function pageTree() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  const add = async (title: string, parentId?: string) =>
    (await admin.post("/api/projects/CRONK/documents", { title, body: `About ${title}.`, parentId })).body.document as { id: string; version: number };
  const architecture = await add("Architecture");
  const storage = await add("Storage", architecture.id);
  const backups = await add("Backups", storage.id);
  const handbook = await add("Handbook");
  return { cronk, admin, add, architecture, storage, backups, handbook };
}

describe("protecting a Document", () => {
  it("covers every Document under it, including ones added later, and the page tree shows which", async () => {
    const { admin, add, architecture, storage, backups, handbook } = await pageTree();

    await admin.post(`/api/documents/${architecture.id}/protection`, { protected: true });
    const later = await add("Live updates", storage.id);

    expect((await admin.get(`/api/documents/${architecture.id}`)).body.document).toMatchObject({ protected: true, covers: 3 });
    for (const { id } of [storage, backups, later]) {
      expect((await admin.get(`/api/documents/${id}`)).body.document).toMatchObject({
        protected: true,
        protectedBy: { id: architecture.id, title: "Architecture" },
        covers: 0,
      });
    }
    expect((await admin.get(`/api/documents/${handbook.id}`)).body.document.protected).toBe(false);
    const tree = (await admin.get("/api/projects/CRONK/documents")).body.documents;
    expect(tree.map((d: { title: string; protected: boolean }) => [d.title, d.protected])).toEqual([
      ["Architecture", true],
      ["Storage", true],
      ["Backups", true],
      ["Live updates", true],
      ["Handbook", false],
    ]);
  });

  it("names the nearest marked Document above as what covers it", async () => {
    const { admin, architecture, storage, backups } = await pageTree();

    await admin.post(`/api/documents/${architecture.id}/protection`, { protected: true });
    await admin.post(`/api/documents/${storage.id}/protection`, { protected: true });

    expect((await admin.get(`/api/documents/${backups.id}`)).body.document.protectedBy).toEqual({ id: storage.id, title: "Storage" });
    await admin.post(`/api/documents/${storage.id}/protection`, { protected: false });
    expect((await admin.get(`/api/documents/${storage.id}`)).body.document.protectedBy).toEqual({ id: architecture.id, title: "Architecture" });
  });

  it("stops covering a Document a User moves out of the branch, and covers one moved in", async () => {
    const { admin, architecture, storage, handbook } = await pageTree();
    await admin.post(`/api/documents/${architecture.id}/protection`, { protected: true });

    const out = await admin.post(`/api/documents/${storage.id}/move`, { parentId: null });
    expect(out.status).toBe(200);
    expect(out.body.document).toMatchObject({ protected: false, protectedBy: null });
    const into = await admin.post(`/api/documents/${handbook.id}/move`, { parentId: architecture.id });
    expect(into.body.document).toMatchObject({ protected: true, protectedBy: { id: architecture.id } });
  });
});

describe("an Agent and a Protected Document", () => {
  it("is refused every change to it or anything under it, pointed to Suggestions, but may read it and comment", async () => {
    const { cronk, admin, architecture, storage } = await pageTree();
    const agent = await agentOf(cronk, admin, "claude");
    await admin.post(`/api/documents/${architecture.id}/protection`, { protected: true });

    const refused = [
      await agent.patch(`/api/documents/${storage.id}`, { baseVersion: 1, body: "Rewritten." }),
      await agent.post(`/api/documents/${architecture.id}/replace-section`, { baseVersion: 1, heading: "Anything", body: "x" }),
      await agent.post(`/api/documents/${storage.id}/versions/1/restore`, { baseVersion: 1 }),
      await agent.post(`/api/documents/${storage.id}/move`, { parentId: architecture.id, position: 0 }),
      await agent.delete(`/api/documents/${storage.id}?baseVersion=1`),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Protected.*Suggestion/);
    }
    expect(refused[0]!.body.error).toMatch(/^Storage is Protected/);

    expect((await agent.get(`/api/documents/${storage.id}`)).status).toBe(200);
    expect((await agent.post(`/api/documents/${storage.id}/comments`, { body: "This misses the backups." })).status).toBe(201);
    expect((await admin.get(`/api/documents/${storage.id}`)).body.document).toMatchObject({ body: "About Storage.", version: 1, parentId: architecture.id });
    expect((await admin.patch(`/api/documents/${storage.id}`, { baseVersion: 1, body: "A User may." })).status).toBe(200);
  });

  it("is refused adding a Document under the branch, or moving one into or out of it", async () => {
    const { cronk, admin, architecture, storage, handbook } = await pageTree();
    const agent = await agentOf(cronk, admin, "claude");
    const loose = (await agent.post("/api/projects/CRONK/documents", { title: "Loose notes" })).body.document;
    await admin.post(`/api/documents/${storage.id}/protection`, { protected: true });

    const under = await agent.post("/api/projects/CRONK/documents", { title: "Restore drills", parentId: storage.id });
    const into = await agent.post(`/api/documents/${loose.id}/move`, { parentId: storage.id });
    const out = await agent.post(`/api/documents/${storage.id}/move`, { parentId: handbook.id });
    for (const res of [under, into, out]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Protected.*Suggestion/);
    }
    expect(into.body.error).toMatch(/^Storage is Protected/);

    // Outside the branch, and above it, the Agent works as before.
    expect((await agent.post("/api/projects/CRONK/documents", { title: "Roadmap", parentId: architecture.id })).status).toBe(201);
    expect((await agent.post(`/api/documents/${loose.id}/move`, { parentId: handbook.id })).status).toBe(200);
    expect((await agent.patch(`/api/documents/${architecture.id}`, { baseVersion: 1, body: "Still open to Agents." })).status).toBe(200);
  });
});

describe("a Protected Term", () => {
  it("is marked and unmarked by a User with Write, recorded in its protection history, and listed as Protected", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { term } = (await admin.post("/api/projects/CRONK/terms", { name: "Claim", definition: "A hold on a Ticket." })).body;
    expect(term.protected).toBe(false);
    const agent = await agentOf(cronk, admin, "claude");

    const marked = await admin.post(`/api/terms/${term.id}/protection`, { protected: true });
    expect(marked.status).toBe(200);
    expect(marked.body.term).toMatchObject({ protected: true, version: 1 });
    expect((await admin.get("/api/projects/CRONK/terms")).body.terms[0].protected).toBe(true);
    expect((await agent.post(`/api/terms/${term.id}/protection`, { protected: false })).status).toBe(403);
    expect((await admin.get(`/api/terms/${term.id}/protection`)).body.markings).toEqual([
      { protected: true, at: "2026-01-01T09:00:00.000Z", actor: { kind: "user", id: ada.id, name: "Ada" } },
    ]);
  });

  it("refuses Agents' edits and deletes, pointing to Suggestions, while a User still edits it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const { term } = (await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold on a Ticket." })).body;
    const agent = await agentOf(cronk, admin, "claude");
    await admin.post(`/api/terms/${term.id}/protection`, { protected: true });

    for (const res of [
      await agent.patch(`/api/terms/${term.id}`, { baseVersion: 1, definition: "A lock." }),
      await agent.delete(`/api/terms/${term.id}?baseVersion=1`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/^Claim is Protected.*Suggestion/);
    }
    expect((await admin.get(`/api/terms/${term.id}`)).body.term).toMatchObject({ definition: "A hold on a Ticket.", version: 1 });
    expect((await admin.patch(`/api/terms/${term.id}`, { baseVersion: 1, definition: "An exclusive hold." })).status).toBe(200);

    await admin.post(`/api/terms/${term.id}/protection`, { protected: false });
    expect((await agent.patch(`/api/terms/${term.id}`, { baseVersion: 2, definition: "An Agent's words." })).status).toBe(200);
  });
});

describe("a Protected Decision", () => {
  it("is Protected once accepted, as marked by the User who accepted it, and a User may unmark it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { decision } = (await admin.post("/api/projects/CRONK/decisions", { title: "Postgres for storage", body: "We use Postgres." })).body;
    expect(decision.protected).toBe(false);

    cronk.clock.advance(60_000);
    const accepted = await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    expect(accepted.body.decision.protected).toBe(true);
    expect((await admin.get("/api/projects/CRONK/decisions")).body.decisions[0].protected).toBe(true);
    expect((await admin.get("/api/decisions/CRONK-D1/protection")).body.markings).toEqual([
      { protected: true, at: "2026-01-01T09:01:00.000Z", actor: { kind: "user", id: ada.id, name: "Ada" } },
    ]);

    const agent = await agentOf(cronk, admin, "claude");
    const refused = await agent.patch("/api/decisions/CRONK-D1", { baseVersion: 2, body: "Rewritten." });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/only while it is proposed.*Protected.*Suggestion/);

    const unmarked = await admin.post("/api/decisions/CRONK-D1/protection", { protected: false });
    expect(unmarked.status).toBe(200);
    expect(unmarked.body.decision).toMatchObject({ protected: false, status: "accepted", version: 2 });
    // Saving it again, still accepted, leaves the User's choice alone.
    await admin.patch("/api/decisions/CRONK-D1", { baseVersion: 2, body: "We use Postgres 17." });
    expect((await admin.get("/api/decisions/CRONK-D1")).body.decision.protected).toBe(false);
  });

  it("can be marked while proposed, and refuses Agents' edits with a pointer to Suggestions", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/workspace/decisions", { title: "Compose for installs" });
    const agent = await agentOf(cronk, admin, "claude");

    expect((await agent.post("/api/decisions/D1/protection", { protected: true })).status).toBe(403);
    expect((await admin.post("/api/decisions/D1/protection", { protected: true })).body.decision).toMatchObject({ protected: true, status: "proposed" });

    const edit = await agent.patch("/api/decisions/D1", { baseVersion: 1, body: "Rewritten." });
    expect(edit.status).toBe(403);
    expect(edit.body.error).toMatch(/^D1 is Protected.*Suggestion/);
  });
});

describe("upgrading an installation with accepted Decisions", () => {
  it("marks each Protected, as by the User who accepted it, then; other Decisions stay unmarked", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const grace = await joinAs(cronk, admin, "grace@example.com", "member", "Grace");
    const graceId = (await grace.get("/api/me")).body.user.id;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Accepted", body: "v1" });
    cronk.clock.advance(60_000);
    await grace.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    cronk.clock.advance(60_000);
    await admin.patch("/api/decisions/CRONK-D1", { baseVersion: 2, body: "v2" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Proposed" });

    await cronk.undoMigration(
      "0028_protected",
      `DROP TABLE protection_markings;
       ALTER TABLE documents DROP COLUMN protected; ALTER TABLE terms DROP COLUMN protected; ALTER TABLE decisions DROP COLUMN protected`,
    );
    await cronk.restart();

    expect((await admin.get("/api/decisions/CRONK-D1")).body.decision.protected).toBe(true);
    expect((await admin.get("/api/decisions/CRONK-D1/protection")).body.markings).toEqual([
      { protected: true, at: "2026-01-01T09:01:00.000Z", actor: { kind: "user", id: graceId, name: "Grace" } },
    ]);
    expect((await admin.get("/api/decisions/CRONK-D2")).body.decision.protected).toBe(false);
    expect((await admin.get("/api/decisions/CRONK-D2/protection")).body.markings).toEqual([]);
  });
});

describe("getting around a protection", () => {
  it("is refused to an Agent moving a Document that has a Protected Document under it", async () => {
    const { cronk, admin, architecture, storage, handbook } = await pageTree();
    const agent = await agentOf(cronk, admin, "claude");
    await admin.post(`/api/documents/${storage.id}/protection`, { protected: true });

    const moved = await agent.post(`/api/documents/${architecture.id}/move`, { parentId: handbook.id });
    expect(moved.status).toBe(403);
    expect(moved.body.error).toMatch(/^Storage is Protected.*Suggestion/);
    expect((await admin.get(`/api/documents/${architecture.id}`)).body.document.parentId).toBeNull();
  });

  it("is refused to an Agent naming a Project Term after a Protected Workspace Term, which would replace it there", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { term } = (await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold on a Ticket." })).body;
    await admin.post(`/api/terms/${term.id}/protection`, { protected: true });
    const agent = await agentOf(cronk, admin, "claude");

    const created = await agent.post("/api/projects/CRONK/terms", { name: "claim", definition: "A lock." });
    expect(created.status).toBe(403);
    expect(created.body.error).toMatch(/^Claim is Protected.*Suggestion/);
    const other = (await agent.post("/api/projects/CRONK/terms", { name: "Hold", definition: "A lock." })).body.term;
    const renamed = await agent.patch(`/api/terms/${other.id}`, { baseVersion: 1, name: "CLAIM" });
    expect(renamed.status).toBe(403);
    // A User may still override it.
    expect((await admin.post("/api/projects/CRONK/terms", { name: "Claim", definition: "Ours." })).status).toBe(201);
  });
});
