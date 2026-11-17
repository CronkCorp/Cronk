import { describe, expect, it } from "vitest";
import { agentOf, joinAs, startInstalledCronk } from "./harness.js";

describe("Terms", () => {
  it("are created for the Workspace with a name, definition, words to avoid and a group, at Version 1", async () => {
    const { admin } = await startInstalledCronk();

    const created = await admin.post("/api/workspace/terms", {
      name: "Ticket",
      definition: "A unit of work tracked within a Project.",
      avoid: ["Issue", "task"],
      group: "Work",
    });
    expect(created.status).toBe(201);
    expect(created.body.term).toMatchObject({
      projectKey: null,
      name: "Ticket",
      definition: "A unit of work tracked within a Project.",
      avoid: ["Issue", "task"],
      group: "Work",
      version: 1,
      overrides: null,
      overriddenBy: [],
    });

    const got = await admin.get(`/api/terms/${created.body.term.id}`);
    expect(got.status).toBe(200);
    expect(got.body.term).toEqual(created.body.term);
    expect((await admin.get("/api/workspace/terms")).body.terms).toEqual([created.body.term]);
  });

  it("refuse a second Term of the same name in the same place, ignoring case", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." });

    const again = await admin.post("/api/workspace/terms", { name: "  ticket ", definition: "Something else." });
    expect(again.status).toBe(409);
    expect((await admin.get("/api/workspace/terms")).body.terms).toHaveLength(1);
  });
});

describe("a Project Term", () => {
  it("replaces the Workspace Term of the same name within its Project, ignoring case, and both show it", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Website", key: "SITE" });
    const customer = (await admin.post("/api/workspace/terms", { name: "Customer", definition: "A paying organization." })).body.term;
    const ticket = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." })).body.term;

    const created = await admin.post("/api/projects/CRONK/terms", { name: "customer", definition: "A billing account." });
    expect(created.status).toBe(201);
    const override = created.body.term;
    expect(override).toMatchObject({
      projectKey: "CRONK",
      name: "customer",
      overrides: { id: customer.id, name: "Customer", definition: "A paying organization." },
      overriddenBy: [],
    });

    const inCronk = (await admin.get("/api/projects/CRONK/terms")).body.terms;
    expect(inCronk.map((t: any) => [t.name, t.projectKey])).toEqual([
      ["customer", "CRONK"],
      ["Ticket", null],
    ]);
    const inSite = (await admin.get("/api/projects/SITE/terms")).body.terms;
    expect(inSite.map((t: any) => [t.name, t.projectKey])).toEqual([
      ["Customer", null],
      ["Ticket", null],
    ]);

    const workspaceCustomer = (await admin.get(`/api/terms/${customer.id}`)).body.term;
    expect(workspaceCustomer.overriddenBy).toEqual([{ id: override.id, name: "customer", projectKey: "CRONK" }]);
    expect((await admin.get(`/api/terms/${ticket.id}`)).body.term.overriddenBy).toEqual([]);
  });

  it("is looked up by name, ignoring case, among the Terms that apply in its Project", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/workspace/terms", { name: "Customer", definition: "A paying organization." });
    await admin.post("/api/projects/CRONK/terms", { name: "Customer", definition: "A billing account." });

    const found = await admin.get("/api/projects/CRONK/terms?name=CUSTOMER");
    expect(found.body.terms.map((t: any) => t.definition)).toEqual(["A billing account."]);
    expect((await admin.get("/api/workspace/terms?name=customer")).body.terms.map((t: any) => t.definition)).toEqual(["A paying organization."]);
  });

  it("hides overrides in Projects the reader can't see", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    const customer = (await admin.post("/api/workspace/terms", { name: "Customer", definition: "A paying organization." })).body.term;
    await admin.post("/api/projects/SECRET/terms", { name: "Customer", definition: "A secret account." });
    const member = await joinAs(cronk, admin, "bob@example.com");

    expect((await member.get(`/api/terms/${customer.id}`)).body.term.overriddenBy).toEqual([]);
    expect((await admin.get(`/api/terms/${customer.id}`)).body.term.overriddenBy).toHaveLength(1);
  });
});

describe("editing a Term", () => {
  it("saves a new Version with its Actor, based on the current one", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    const claude = await agentOf(cronk, admin, "claude-laptop");
    const { id } = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work.", avoid: ["Issue"] })).body.term;
    cronk.clock.advance(60_000);

    const saved = await admin.patch(`/api/terms/${id}`, { baseVersion: 1, definition: "A unit of work tracked within a Project.", group: "Work" });
    expect(saved.status).toBe(200);
    expect(saved.body.term).toMatchObject({
      name: "Ticket",
      definition: "A unit of work tracked within a Project.",
      avoid: ["Issue"],
      group: "Work",
      version: 2,
      updatedAt: "2026-01-01T09:01:00.000Z",
    });
    const byAgent = await claude.patch(`/api/terms/${id}`, { baseVersion: 2, avoid: ["Issue", "task", " ", "ISSUE"] });
    expect(byAgent.body.term).toMatchObject({ avoid: ["Issue", "task"], version: 3 });
    const unchanged = await admin.patch(`/api/terms/${id}`, { baseVersion: 3, avoid: ["Issue", "task"] });
    expect(unchanged.body.term.version).toBe(3);

    const versions = await admin.get(`/api/terms/${id}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions.map((v: any) => [v.number, v.definition, v.avoid, v.group, v.actor.kind])).toEqual([
      [3, "A unit of work tracked within a Project.", ["Issue", "task"], "Work", "agent"],
      [2, "A unit of work tracked within a Project.", ["Issue"], "Work", "user"],
      [1, "A unit of work.", ["Issue"], null, "user"],
    ]);
    expect(versions.body.versions[2]).toEqual({
      number: 1,
      name: "Ticket",
      definition: "A unit of work.",
      avoid: ["Issue"],
      group: null,
      at: "2026-01-01T09:00:00.000Z",
      actor: { kind: "user", id: ada.id, name: "Ada" },
      suggestion: null,
    });
    expect(versions.body.versions[0].actor).toMatchObject({ name: "claude-laptop", session: { id: claude.sessionId } });
  });

  it("is refused when based on an outdated Version, or when it takes another Term's name", async () => {
    const { admin } = await startInstalledCronk();
    const { id } = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." })).body.term;
    await admin.post("/api/workspace/terms", { name: "Issue", definition: "Not a Ticket." });
    await admin.patch(`/api/terms/${id}`, { baseVersion: 1, definition: "Theirs." });

    const stale = await admin.patch(`/api/terms/${id}`, { baseVersion: 1, definition: "Mine." });
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({ number: 2, definition: "Theirs." });
    expect((await admin.patch(`/api/terms/${id}`, { baseVersion: 2, name: "issue" })).status).toBe(409);
    expect((await admin.patch(`/api/terms/${id}`, { baseVersion: 2, name: "TICKET" })).body.term).toMatchObject({ name: "TICKET", version: 3 });
    expect((await admin.get(`/api/terms/${id}`)).body.term).toMatchObject({ name: "TICKET", definition: "Theirs." });
  });

  it("needs Write where the Term belongs", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { id } = (await admin.post("/api/projects/CRONK/terms", { name: "Board", definition: "Columns." })).body.term;
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    await admin.put(`/api/projects/CRONK/members/${bobId}`, { access: "read" });

    expect((await bob.get(`/api/terms/${id}`)).status).toBe(200);
    expect((await bob.patch(`/api/terms/${id}`, { baseVersion: 1, definition: "Mine." })).status).toBe(403);
    expect((await bob.post("/api/projects/CRONK/terms", { name: "Card", definition: "No." })).status).toBe(403);
  });
});

describe("deleting a Term", () => {
  it("removes it and its Versions, for a User, based on its current Version", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await agentOf(cronk, admin, "claude-laptop");
    const { id } = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." })).body.term;
    await admin.patch(`/api/terms/${id}`, { baseVersion: 1, definition: "Theirs." });

    expect((await claude.delete(`/api/terms/${id}?baseVersion=2`)).status).toBe(403);
    expect((await admin.delete(`/api/terms/${id}?baseVersion=1`)).status).toBe(409);
    expect((await admin.delete(`/api/terms/${id}?baseVersion=2`)).status).toBe(204);
    expect((await admin.get(`/api/terms/${id}`)).status).toBe(404);
    expect((await admin.get(`/api/terms/${id}/versions`)).status).toBe(404);
    expect((await admin.get("/api/workspace/terms")).body.terms).toEqual([]);
  });
});

/** Ada with the Project CRONK holding the Protected Term Claim, and claude-laptop holding the Claim on CRONK-1 to suggest from. */
async function protectedProjectTerm() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  const term = (await admin.post("/api/projects/CRONK/terms", { name: "Claim", definition: "A hold." })).body.term;
  await admin.post(`/api/terms/${term.id}/protection`, { protected: true });
  await admin.post("/api/projects/CRONK/tickets", { title: "Word it better" });
  const claude = await agentOf(cronk, admin, "claude-laptop");
  const adaId = (await admin.get("/api/me")).body.user.id;
  await admin.patch("/api/tickets/CRONK-1", { assigneeId: adaId, delegateId: (await admin.get("/api/agents")).body.agents[0].id });
  expect((await claude.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
  const suggest = async (definition: string): Promise<string> => {
    const made = await claude.post("/api/suggestions", { item: { kind: "term", id: term.id }, baseVersion: 1, content: { definition }, reasoning: "Better." });
    expect(made.status).toBe(201);
    return made.body.suggestion.id;
  };
  return { cronk, admin, term, suggest };
}

describe("a Term's Suggestion count", () => {
  it("counts its open Suggestions, wherever the Term is answered, leaving out accepted and rejected ones", async () => {
    const { admin, term, suggest } = await protectedProjectTerm();
    const counts = async () => [
      (await admin.get(`/api/terms/${term.id}`)).body.term.suggestions,
      (await admin.get("/api/projects/CRONK/terms")).body.terms[0].suggestions,
    ];
    expect(await counts()).toEqual([0, 0]);

    const accepted = await suggest("A temporary hold.");
    const rejected = await suggest("A lock.");
    await suggest("A lapsing hold.");
    expect(await counts()).toEqual([3, 3]);

    expect((await admin.post(`/api/suggestions/${rejected}/reject`, { reason: "Not a lock." })).status).toBe(200);
    expect((await admin.post(`/api/suggestions/${accepted}/accept`)).status).toBe(200);
    expect(await counts()).toEqual([1, 1]);
  });

  it("is answered on Workspace Terms too", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." });
    expect((await admin.get("/api/workspace/terms")).body.terms[0]).toMatchObject({ suggestions: 0 });
  });
});
