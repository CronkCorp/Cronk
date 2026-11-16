import { describe, expect, it } from "vitest";
import { joinAs, registerAgent, startInstalledCronk, startSession, type Client } from "./harness.js";

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
      item: { kind: "document", id: documentId, key: null, title: "Sign-in limits", projectKey: "CRONK", protected: true },
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
