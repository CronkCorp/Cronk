import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, registerAgent, startInstalledCronk, startSession, type Client } from "./harness.js";

/** Ada, the Admin, with the Project CRONK holding the Protected Document "Sign-in limits" at Version 1, and her Agent claude-laptop. */
async function protectedDocument() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  const { document } = (await admin.post("/api/projects/CRONK/documents", { title: "Sign-in limits", body: "Five per minute.\n" })).body;
  await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
  const { secret } = await registerAgent(admin, "claude-laptop");
  const agent = await startSession(cronk, secret);
  return { cronk, admin, agent, secret, documentId: document.id as string };
}

describe("an Agent suggesting a new Version of a Protected Document", () => {
  it("records the full proposed content, its base Version and reasoning, for the Agent to read back", async () => {
    const { admin, agent, documentId } = await protectedDocument();

    const made = await agent.post("/api/suggestions", {
      item: { kind: "document", id: documentId },
      baseVersion: 1,
      content: { body: "Five per minute, and fifty per IP.\n" },
      reasoning: "The proxy passes client IPs through now.",
    });

    expect(made.status).toBe(201);
    const suggestion = made.body.suggestion;
    expect(suggestion).toMatchObject({
      id: expect.any(String),
      item: { kind: "document", id: documentId, key: null, title: "Sign-in limits", status: null, projectKey: "CRONK", protected: true },
      baseVersion: 1,
      base: { title: "Sign-in limits", body: "Five per minute.\n" },
      content: { title: "Sign-in limits", body: "Five per minute, and fifty per IP.\n" },
      reasoning: "The proxy passes client IPs through now.",
      proposedBy: { kind: "agent", name: "claude-laptop", session: { id: agent.sessionId } },
      sourceTicket: null,
      state: "open",
      outdated: false,
    });
    expect((await agent.get(`/api/suggestions/${suggestion.id}`)).body.suggestion).toEqual(suggestion);
    expect((await admin.get(`/api/suggestions/${suggestion.id}`)).body.suggestion).toEqual(suggestion);
    expect((await agent.get("/api/suggestions")).body.suggestions).toEqual([suggestion]);
    // Nothing changes until a User accepts it.
    expect((await admin.get(`/api/documents/${documentId}`)).body.document).toMatchObject({ version: 1, body: "Five per minute.\n" });
  });
});

/** Has `agent` suggest `body` as the Document's new body, from Version `baseVersion`; returns the Suggestion. */
async function suggestBody(agent: Client, documentId: string, body: string, baseVersion = 1) {
  const made = await agent.post("/api/suggestions", { item: { kind: "document", id: documentId }, baseVersion, content: { body }, reasoning: "Better." });
  if (made.status !== 201) throw new Error(`Suggesting failed: ${JSON.stringify(made.body)}`);
  return made.body.suggestion;
}

describe("accepting a Suggestion", () => {
  it("unchanged, makes it the item's next Version credited to the Agent, recording the User who accepted it", async () => {
    const { cronk, admin, agent, documentId } = await protectedDocument();
    const ada = (await admin.get("/api/me")).body.user;
    const suggestion = await suggestBody(agent, documentId, "Fifty per IP.\n");
    cronk.clock.advance(60_000);

    const accepted = await admin.post(`/api/suggestions/${suggestion.id}/accept`);

    expect(accepted.status).toBe(200);
    expect(accepted.body.suggestion).toMatchObject({
      state: "accepted",
      acceptedWithEdits: false,
      resultVersion: 2,
      decidedBy: { id: ada.id, name: "Ada" },
      decidedAt: "2026-01-01T09:01:00.000Z",
      item: { version: 2 },
    });
    expect((await admin.get(`/api/documents/${documentId}`)).body.document).toMatchObject({ version: 2, body: "Fifty per IP.\n" });
    expect((await admin.get(`/api/documents/${documentId}/versions/2`)).body.version).toMatchObject({
      actor: { kind: "agent", name: "claude-laptop", session: { id: agent.sessionId } },
      suggestion: { id: suggestion.id, acceptedWithEdits: false, acceptedBy: { id: ada.id, name: "Ada" } },
    });
    expect((await admin.get(`/api/documents/${documentId}/versions/1`)).body.version.suggestion).toBeNull();
    // Decided once only.
    expect((await admin.post(`/api/suggestions/${suggestion.id}/accept`)).status).toBe(409);
    expect((await admin.post(`/api/suggestions/${suggestion.id}/reject`, { reason: "Too late." })).status).toBe(409);
  });

  it("edited first, credits the new Version to the User and links it to the Suggestion", async () => {
    const { admin, agent, documentId } = await protectedDocument();
    const ada = (await admin.get("/api/me")).body.user;
    const suggestion = await suggestBody(agent, documentId, "Fifty per IP.\n");

    const accepted = await admin.post(`/api/suggestions/${suggestion.id}/accept`, { content: { body: "Forty per IP.\n" } });

    expect(accepted.body.suggestion).toMatchObject({ state: "accepted", acceptedWithEdits: true, resultVersion: 2, content: { body: "Fifty per IP.\n" } });
    expect((await admin.get(`/api/documents/${documentId}/versions/2`)).body.version).toMatchObject({
      body: "Forty per IP.\n",
      actor: { kind: "user", id: ada.id },
      suggestion: { id: suggestion.id, acceptedWithEdits: true, acceptedBy: { id: ada.id } },
    });
    expect((await admin.get(`/api/documents/${documentId}/versions`)).body.versions[0].suggestion).toMatchObject({ id: suggestion.id });
  });

  it("is for a User with Write where the item lives, and never an Agent", async () => {
    const { cronk, admin, agent, documentId } = await protectedDocument();
    const bea = await joinAs(cronk, admin, "bea@example.com");
    await admin.put(`/api/projects/CRONK/members/${(await bea.get("/api/me")).body.user.id}`, { access: "read" });
    const suggestion = await suggestBody(agent, documentId, "Fifty per IP.\n");

    expect((await bea.post(`/api/suggestions/${suggestion.id}/accept`)).status).toBe(403);
    expect((await agent.post(`/api/suggestions/${suggestion.id}/accept`)).status).toBe(403);
    expect((await bea.get(`/api/suggestions/${suggestion.id}`)).status).toBe(200);
    expect((await admin.get(`/api/suggestions/${suggestion.id}`)).body.suggestion.state).toBe("open");
  });

  it("is refused while the item has a newer Version than the Suggestion's base, which marks it outdated", async () => {
    const { admin, agent, documentId } = await protectedDocument();
    const suggestion = await suggestBody(agent, documentId, "Fifty per IP.\n");
    await admin.patch(`/api/documents/${documentId}`, { baseVersion: 1, body: "Six per minute.\n" });

    expect((await admin.get(`/api/suggestions/${suggestion.id}`)).body.suggestion).toMatchObject({ outdated: true, item: { version: 2 } });
    const refused = await admin.post(`/api/suggestions/${suggestion.id}/accept`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/outdated/);
    expect((await admin.get(`/api/documents/${documentId}`)).body.document.body).toBe("Six per minute.\n");
  });
});

describe("rejecting a Suggestion", () => {
  it("needs a reason, which the Suggestion keeps and which reaches the Agent as Waiting Work in its next Agent Session", async () => {
    const { cronk, admin, agent, secret, documentId } = await protectedDocument();
    const ada = (await admin.get("/api/me")).body.user;
    const suggestion = await suggestBody(agent, documentId, "Fifty per IP.\n");
    cronk.clock.advance(60_000);

    for (const reason of ["", "   "]) expect((await admin.post(`/api/suggestions/${suggestion.id}/reject`, { reason })).status).toBe(400);
    const rejected = await admin.post(`/api/suggestions/${suggestion.id}/reject`, { reason: "  The proxy still hides IPs.  " });

    expect(rejected.status).toBe(200);
    expect(rejected.body.suggestion).toMatchObject({ state: "rejected", reason: "The proxy still hides IPs.", decidedBy: { id: ada.id }, resultVersion: null });
    expect((await admin.get(`/api/documents/${documentId}`)).body.document.version).toBe(1);
    expect((await agent.get("/api/suggestions?state=rejected")).body.suggestions).toMatchObject([{ id: suggestion.id }]);
    expect((await agent.get("/api/suggestions?state=open")).body.suggestions).toEqual([]);

    const welcomed = await cronk.client(secret).post("/api/agent-sessions");
    expect(welcomed.body.welcome.waitingWork).toEqual([
      {
        reason: "suggestion_rejected",
        comment: null,
        suggestion: {
          id: suggestion.id,
          item: { kind: "document", id: documentId, key: null, title: "Sign-in limits", projectKey: "CRONK" },
          reason: "The proxy still hides IPs.",
          rejectedBy: { kind: "user", id: ada.id, name: "Ada" },
          at: "2026-01-01T09:01:00.000Z",
        },
        ticket: null,
        document: null,
        artifact: null,
      },
    ]);
    expect((await cronk.client(secret).post("/api/agent-sessions")).body.welcome.waitingWork).toEqual([]);
  });

  it("pushes the reason to the Agent's live Agent Sessions", async () => {
    const { admin, agent, documentId } = await protectedDocument();
    const suggestion = await suggestBody(agent, documentId, "Fifty per IP.\n");
    const stream = await agent.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.post(`/api/suggestions/${suggestion.id}/reject`, { reason: "No." });

    expect(await stream.next()).toMatchObject({ event: "waiting", data: { waiting: { reason: "suggestion_rejected", suggestion: { id: suggestion.id, reason: "No." } } } });
  });
});

/** The Inbox of `client`, as `kind title` lines, in order. */
const inboxLines = async (client: Client) =>
  ((await client.get("/api/inbox")).body.items as { kind: string; suggestion?: { item: { title: string } }; ticket?: { key: string } | null }[]).map(
    (i) => `${i.kind} ${i.suggestion?.item.title ?? i.ticket?.key}`,
  );

describe("where a Suggestion waits", () => {
  it("on a Project item made outside any Claim, is the Agent's Owner's Inbox, until a User decides it", async () => {
    const { cronk, admin, agent, documentId } = await protectedDocument();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const inbox = await admin.events("/api/inbox/events");
    expect((await inbox.next())?.event).toBe("ready");

    const suggestion = await suggestBody(agent, documentId, "Fifty per IP.\n");

    expect((await inbox.next())?.event).toBe("changed");
    expect(suggestion.reviewer).toMatchObject({ name: "Ada" });
    expect((await admin.get("/api/inbox")).body.items).toMatchObject([
      { kind: "suggestion", at: "2026-01-01T09:00:00.000Z", suggestion: { id: suggestion.id, reasoning: "Better.", base: { body: "Five per minute.\n" } } },
    ]);
    expect(await inboxLines(bob)).toEqual([]);
    expect((await admin.get("/api/inbox?kind=suggestion")).body.items).toHaveLength(1);
    expect((await admin.get("/api/inbox?kind=review")).body.items).toEqual([]);
    expect((await admin.get(`/api/inbox?agent=${suggestion.proposedBy.id}`)).body.items).toHaveLength(1);

    await bob.post(`/api/suggestions/${suggestion.id}/accept`);
    expect((await inbox.next())?.event).toBe("changed");
    expect(await inboxLines(admin)).toEqual([]);
  });

  it("made while holding a Claim, is the Inbox of the Ticket's Assignee, even once reassigned", async () => {
    const { cronk, admin, session } = await delegatedSetup(1);
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    const { document } = (await admin.post("/api/projects/CRONK/documents", { title: "Architecture", body: "v1" })).body;
    await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const suggestion = await suggestBody(agent, document.id, "v2");

    expect(suggestion.sourceTicket).toEqual({ key: "CRONK-1", title: "Ticket 1" });
    expect(await inboxLines(admin)).toEqual(["suggestion Architecture"]);
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: bobId });
    expect(await inboxLines(admin)).toEqual([]);
    expect(await inboxLines(bob)).toEqual(["suggestion Architecture"]);
    expect((await bob.get(`/api/suggestions/${suggestion.id}`)).body.suggestion.reviewer).toMatchObject({ id: bobId });

    await bob.post(`/api/suggestions/${suggestion.id}/reject`, { reason: "Not now." });
    expect(await inboxLines(bob)).toEqual([]);
  });

  it("on a Workspace item, is Triage: nobody's Inbox", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const { document } = (await admin.post("/api/workspace/documents", { title: "Handbook", body: "v1" })).body;
    await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
    const agent = await startSession(cronk, (await registerAgent(admin, "claude-laptop")).secret);

    const suggestion = await suggestBody(agent, document.id, "v2");

    expect(suggestion.reviewer).toBeNull();
    expect(await inboxLines(admin)).toEqual([]);
    expect((await admin.post(`/api/suggestions/${suggestion.id}/accept`)).body.suggestion.state).toBe("accepted");
  });
});

describe("making a Suggestion", () => {
  it("is refused for an item an Agent may change directly, and to Users, who change Protected items directly", async () => {
    const { admin, agent, documentId } = await protectedDocument();
    const { document: open } = (await admin.post("/api/projects/CRONK/documents", { title: "Notes", body: "v1" })).body;
    const suggest = (client: Client, id: string) =>
      client.post("/api/suggestions", { item: { kind: "document", id }, baseVersion: 1, content: { body: "v2" }, reasoning: "Better." });

    const unprotected = await suggest(agent, open.id);
    expect(unprotected.status).toBe(409);
    expect(unprotected.body.error).toMatch(/isn't Protected/);
    expect((await suggest(admin, documentId)).status).toBe(403);
  });

  it("needs a Version the item has, a change, reasoning, and only the fields its kind holds", async () => {
    const { agent, documentId } = await protectedDocument();
    const suggest = (body: object) => agent.post("/api/suggestions", { item: { kind: "document", id: documentId }, baseVersion: 1, content: { body: "v2" }, reasoning: "Better.", ...body });

    expect((await suggest({ baseVersion: 2 })).status).toBe(404);
    const unchanged = await suggest({ content: { body: "Five per minute.\n", title: " Sign-in limits " } });
    expect(unchanged.status).toBe(400);
    expect(unchanged.body.error).toMatch(/changes nothing/);
    expect((await suggest({ reasoning: "   " })).status).toBe(400);
    const stray = await suggest({ content: { definition: "A Term's" } });
    expect(stray.status).toBe(400);
    expect(stray.body.error).toMatch(/title, body/);
    expect((await suggest({ content: { title: "  " } })).status).toBe(400);
    expect((await suggest({})).status).toBe(201);
  });

  it("is refused to an Agent that may only read where the item lives, or can't see it", async () => {
    const { cronk, admin, documentId } = await protectedDocument();
    const reader = await startSession(cronk, (await registerAgent(admin, "reader", { readOnly: true })).secret);
    const suggest = (client: Client) =>
      client.post("/api/suggestions", { item: { kind: "document", id: documentId }, baseVersion: 1, content: { body: "v2" }, reasoning: "Better." });

    expect((await suggest(reader)).status).toBe(403);
    const { secret } = await registerAgent(admin, "outsider");
    expect((await suggest(cronk.client(secret))).status).toBe(403);
    await admin.patch("/api/projects/CRONK", { agentAccess: "read" });
    const agent = await startSession(cronk, secret);
    const refused = await suggest(agent);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Agent Access is Read/);
    await admin.patch("/api/projects/CRONK", { agentAccess: "none" });
    expect((await suggest(agent)).status).toBe(404);
  });
});

describe("Suggestions on other kinds of item", () => {
  it("change a Protected Term, keeping the fields left out", async () => {
    const { cronk, admin, agent } = await protectedDocument();
    const { term } = (await admin.post("/api/projects/CRONK/terms", { name: "Claim", definition: "A hold.", avoid: ["Lock"] })).body;
    await admin.post(`/api/terms/${term.id}/protection`, { protected: true });

    const made = await agent.post("/api/suggestions", { item: { kind: "term", id: term.id }, baseVersion: 1, content: { definition: "A temporary hold.", avoid: ["Lock", " lease "] }, reasoning: "Say it ends." });
    expect(made.status).toBe(201);
    expect(made.body.suggestion).toMatchObject({
      item: { kind: "term", id: term.id, title: "Claim", protected: true },
      base: { name: "Claim", definition: "A hold.", avoid: ["Lock"], group: null },
      content: { name: "Claim", definition: "A temporary hold.", avoid: ["Lock", "lease"], group: null },
    });
    cronk.clock.advance(60_000);
    await admin.post(`/api/suggestions/${made.body.suggestion.id}/accept`);

    expect((await admin.get(`/api/terms/${term.id}`)).body.term).toMatchObject({ definition: "A temporary hold.", avoid: ["Lock", "lease"], version: 2 });
    expect((await admin.get(`/api/terms/${term.id}/versions`)).body.versions[0]).toMatchObject({
      actor: { kind: "agent", name: "claude-laptop" },
      suggestion: { id: made.body.suggestion.id, acceptedWithEdits: false },
    });
  });

  it("change an accepted Decision, which is Protected, but not a proposed one the Agent may edit", async () => {
    const { admin, agent } = await protectedDocument();
    await admin.post("/api/projects/CRONK/decisions", { title: "Postgres", body: "v1" });
    await agent.post("/api/projects/CRONK/decisions", { title: "Compose", body: "v1" });
    const suggest = (key: string, baseVersion: number) =>
      agent.post("/api/suggestions", { item: { kind: "decision", key }, baseVersion, content: { body: "v2", group: " Storage " }, reasoning: "Clearer." });

    expect((await suggest("CRONK-D2", 1)).status).toBe(409);
    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    const made = await suggest("cronk-d1", 2);
    expect(made.status).toBe(201);
    expect(made.body.suggestion).toMatchObject({ item: { kind: "decision", key: "CRONK-D1", title: "Postgres", status: "accepted", protected: true }, content: { title: "Postgres", body: "v2", group: "Storage" } });

    await admin.post(`/api/suggestions/${made.body.suggestion.id}/accept`, { content: { title: "Postgres for storage" } });

    expect((await admin.get("/api/decisions/CRONK-D1")).body.decision).toMatchObject({ title: "Postgres for storage", body: "v2", group: "Storage", status: "accepted", version: 3 });
    expect((await admin.get("/api/decisions/CRONK-D1/versions/3")).body.version).toMatchObject({ actor: { kind: "user" }, suggestion: { acceptedWithEdits: true } });
  });

  it("change Guidance, which only Users write, from its first Version on; the Workspace's takes an Admin to accept", async () => {
    const { cronk, admin, agent } = await protectedDocument();
    const bob = await joinAs(cronk, admin, "bob@example.com");

    const project = await agent.post("/api/suggestions", { item: { kind: "guidance", project: "cronk" }, baseVersion: 0, content: { markdown: "Use pnpm." }, reasoning: "We do." });
    expect(project.body.suggestion).toMatchObject({ item: { kind: "guidance", id: null, title: "Guidance", projectKey: "CRONK", version: 0 }, base: { markdown: "" } });
    await bob.post(`/api/suggestions/${project.body.suggestion.id}/accept`);
    expect((await admin.get("/api/projects/CRONK/guidance/versions")).body.versions).toMatchObject([
      { version: 1, markdown: "Use pnpm.", actor: { kind: "agent", name: "claude-laptop" }, suggestion: { id: project.body.suggestion.id } },
    ]);

    await admin.put("/api/workspace/guidance", { markdown: "Be kind.", baseVersion: 0 });
    const workspace = await agent.post("/api/suggestions", { item: { kind: "guidance" }, baseVersion: 1, content: { markdown: "Be kind and brief." }, reasoning: "Shorter." });
    expect(workspace.body.suggestion).toMatchObject({ item: { projectKey: null }, reviewer: null });
    expect((await bob.post(`/api/suggestions/${workspace.body.suggestion.id}/accept`)).status).toBe(403);
    await admin.post(`/api/suggestions/${workspace.body.suggestion.id}/accept`);
    expect((await admin.get("/api/workspace/guidance")).body.guidance).toEqual({ markdown: "Be kind and brief.", version: 2 });
  });
});

describe("an Agent refused a change it may not make", () => {
  it("is told how to suggest it instead", async () => {
    const { admin, agent, documentId } = await protectedDocument();
    await admin.post("/api/projects/CRONK/decisions", { title: "Postgres", body: "v1" });
    await admin.post("/api/decisions/CRONK-D1/protection", { protected: false });
    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    await admin.post("/api/decisions/CRONK-D1/protection", { protected: false });

    for (const refused of [
      await agent.patch(`/api/documents/${documentId}`, { baseVersion: 1, body: "v2" }),
      await agent.patch("/api/decisions/CRONK-D1", { baseVersion: 2, body: "v2" }),
      await agent.put("/api/projects/CRONK/guidance", { markdown: "v1", baseVersion: 0 }),
    ]) {
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/POST \/api\/suggestions/);
    }
  });
});
