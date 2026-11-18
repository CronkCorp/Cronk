import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, registerAgent, startInstalledCronk, startSession, statusIn, type Client } from "./harness.js";

/** What `client`'s Triage holds, one line per item: its kind and what it is on. */
async function triageLines(client: Client, query = ""): Promise<string[]> {
  const res = await client.get(`/api/triage${query}`);
  if (res.status !== 200) throw new Error(`Listing Triage failed: ${JSON.stringify(res.body)}`);
  return res.body.items.map((item: any) => (item.kind === "suggestion" ? `suggestion ${item.suggestion.item.title}` : `${item.kind} ${item.ticket.key}`));
}

/** Ada, the Admin, and Bob, a Member, with Ada's Agent claude-laptop in an Agent Session, and the Protected Workspace Document "Handbook". */
async function workspaceSetup() {
  const { cronk, admin } = await startInstalledCronk();
  const bob = await joinAs(cronk, admin, "bob@example.com");
  const { document } = (await admin.post("/api/workspace/documents", { title: "Handbook", body: "v1" })).body;
  await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
  const claude = await registerAgent(admin, "claude-laptop");
  const agent = await startSession(cronk, claude.secret);
  return { cronk, admin, bob, agent, claude, handbookId: document.id as string };
}

/** Has `agent` suggest a new body for the Document; returns the Suggestion. */
async function suggestBody(agent: Client, documentId: string, body: string) {
  const made = await agent.post("/api/suggestions", { item: { kind: "document", id: documentId }, baseVersion: 1, content: { body }, reasoning: "Better." });
  if (made.status !== 201) throw new Error(`Suggesting failed: ${JSON.stringify(made.body)}`);
  return made.body.suggestion;
}

describe("Triage", () => {
  it("lists the open Suggestions on Workspace items to every User who could act on them, and the Workspace's Guidance only to Admins", async () => {
    const { cronk, admin, bob, agent, handbookId } = await workspaceSetup();
    await admin.put("/api/workspace/guidance", { markdown: "Be kind.", baseVersion: 0 });

    const suggestion = await suggestBody(agent, handbookId, "v2");
    cronk.clock.advance(60_000);
    await agent.post("/api/suggestions", { item: { kind: "guidance" }, baseVersion: 1, content: { markdown: "Be kind and brief." }, reasoning: "Shorter." });

    const { items } = (await admin.get("/api/triage")).body;
    expect(items[0]).toMatchObject({ kind: "suggestion", at: suggestion.at, suggestion: { id: suggestion.id, reviewer: null } });
    expect(await triageLines(admin)).toEqual(["suggestion Handbook", "suggestion Guidance"]);
    expect(await triageLines(bob)).toEqual(["suggestion Handbook"]);
    // Nobody's Inbox holds them.
    expect((await admin.get("/api/inbox")).body.items).toEqual([]);
  });

  it("drops an item for everyone as soon as someone acts on it", async () => {
    const { cronk, admin, bob, agent, handbookId } = await workspaceSetup();
    const first = await suggestBody(agent, handbookId, "v2");
    cronk.clock.advance(60_000);
    const { document } = (await admin.post("/api/workspace/documents", { title: "Runbook", body: "v1" })).body;
    await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
    const second = await suggestBody(agent, document.id, "v2");
    expect(await triageLines(bob)).toEqual(["suggestion Handbook", "suggestion Runbook"]);

    expect((await bob.post(`/api/suggestions/${first.id}/reject`, { reason: "Not now." })).status).toBe(200);
    expect(await triageLines(admin)).toEqual(["suggestion Runbook"]);
    expect(await triageLines(bob)).toEqual(["suggestion Runbook"]);
    expect((await admin.post(`/api/suggestions/${second.id}/accept`)).status).toBe(200);
    expect(await triageLines(admin)).toEqual([]);
    expect(await triageLines(bob)).toEqual([]);
  });
});

describe("Triage on Project items", () => {
  it("lists an open Suggestion whose reviewers are all inactive to the Users with Write in its Project", async () => {
    const { cronk, admin, bob } = await workspaceSetup();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    const { document } = (await admin.post("/api/projects/CRONK/documents", { title: "Architecture", body: "v1" })).body;
    await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
    const carol = await joinAs(cronk, admin, "carol@example.com");
    const carolId = (await carol.get("/api/me")).body.user.id;
    const rita = await joinAs(cronk, admin, "rita@example.com");
    await admin.put(`/api/projects/CRONK/members/${(await rita.get("/api/me")).body.user.id}`, { access: "read" });
    const carols = await startSession(cronk, (await registerAgent(carol, "carol-bot")).secret);
    await suggestBody(carols, document.id, "v2");
    // Carol's Inbox holds it while she is active.
    expect(await triageLines(admin)).toEqual([]);

    await admin.patch(`/api/users/${carolId}`, { active: false });

    expect(await triageLines(admin)).toEqual(["suggestion Architecture"]);
    expect(await triageLines(bob)).toEqual(["suggestion Architecture"]);
    expect(await triageLines(rita)).toEqual([]);
    // Bob loses sight of it once CRONK is private and he isn't listed.
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    expect(await triageLines(bob)).toEqual([]);
    expect(await triageLines(admin)).toEqual(["suggestion Architecture"]);
    expect(await triageLines(admin, "?project=cronk")).toEqual(["suggestion Architecture"]);
    expect(await triageLines(admin, "?project=OPS")).toEqual([]);
  });
});

describe("Triage's Unverified completions", () => {
  it("lists an Unverified completion whose Ticket has no Assignee to the Users with Write in its Project, until one Accepts it", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const rita = await joinAs(cronk, admin, "rita@example.com");
    await admin.put(`/api/projects/CRONK/members/${(await rita.get("/api/me")).body.user.id}`, { access: "read" });
    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed the cache." });
    await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "completed") });
    expect(await triageLines(admin)).toEqual([]);

    await admin.patch("/api/tickets/CRONK-1", { assigneeId: null });

    const { items } = (await bob.get("/api/triage")).body;
    expect(items).toMatchObject([{ kind: "unverified", ticket: { key: "CRONK-1", verification: "unverified", assignee: null }, reports: [{ title: "Done" }] }]);
    expect(await triageLines(admin)).toEqual(["unverified CRONK-1"]);
    expect(await triageLines(rita)).toEqual([]);
    expect(await triageLines(admin, "?kind=suggestion")).toEqual([]);
    expect((await admin.get("/api/inbox")).body.items).toEqual([]);

    expect((await bob.post("/api/tickets/CRONK-1/accept")).status).toBe(200);
    expect(await triageLines(admin)).toEqual([]);
    expect(await triageLines(bob)).toEqual([]);
  });
});

describe("Triage's live updates", () => {
  it("reach every signed-in User's Inbox stream that asks for them as a triage event whenever Triage may have changed, so they can fetch it again", async () => {
    const { cronk, admin, bob, agent, handbookId } = await workspaceSetup();
    const stream = await bob.events("/api/inbox/events?triage=true");
    expect((await stream.next())?.event).toBe("ready");

    const suggestion = await suggestBody(agent, handbookId, "v2");
    expect(await stream.next()).toMatchObject({ event: "triage" });
    await admin.post(`/api/suggestions/${suggestion.id}/accept`);
    expect(await stream.next()).toMatchObject({ event: "triage" });

    // A reviewer leaving sends a Project item's Suggestion to Triage.
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { document } = (await admin.post("/api/projects/CRONK/documents", { title: "Architecture", body: "v1" })).body;
    await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
    const carol = await joinAs(cronk, admin, "carol@example.com");
    await suggestBody(await startSession(cronk, (await registerAgent(carol, "carol-bot")).secret), document.id, "v2");
    expect(await stream.next()).toMatchObject({ event: "triage" });
    await admin.patch(`/api/users/${(await carol.get("/api/me")).body.user.id}`, { active: false });
    expect(await stream.next()).toMatchObject({ event: "triage" });
  });

  it("is refused to Agents", async () => {
    const { agent } = await workspaceSetup();
    expect((await agent.get("/api/triage")).status).toBe(403);
  });
});

/**
 * Ada, the Admin; Bob, a Member with Write in the open Project CRONK; Rita, with Read there; and Carol, Assignee of CRONK-1, which
 * is delegated to her Agent carol-bot.
 */
async function carolsDelegatedTicket() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  await admin.post("/api/projects/CRONK/tickets", { title: "Fix the cache" });
  const bob = await joinAs(cronk, admin, "bob@example.com");
  const rita = await joinAs(cronk, admin, "rita@example.com");
  const ritaId = (await rita.get("/api/me")).body.user.id;
  await admin.put(`/api/projects/CRONK/members/${ritaId}`, { access: "read" });
  const carol = await joinAs(cronk, admin, "carol@example.com");
  const carolId: string = (await carol.get("/api/me")).body.user.id;
  const carolBot = await registerAgent(carol, "carol-bot");
  const assigned = await admin.patch("/api/tickets/CRONK-1", { assigneeId: carolId, delegateId: carolBot.agentId });
  if (assigned.status !== 200) throw new Error(`Assigning failed: ${JSON.stringify(assigned.body)}`);
  return { cronk, admin, bob, rita, carol, carolId, carolBot };
}

describe("Triage's unattended Tickets", () => {
  it("lists a delegated Ticket whose Assignee is deactivated to the Users with Write in its Project, saying why", async () => {
    const { admin, bob, rita, carolId } = await carolsDelegatedTicket();
    expect(await triageLines(admin)).toEqual([]);

    await admin.patch(`/api/users/${carolId}`, { active: false });

    const { items } = (await bob.get("/api/triage")).body;
    expect(items).toMatchObject([{ kind: "unattended", reason: "deactivated", ticket: { key: "CRONK-1", assignee: { id: carolId }, delegate: { name: "carol-bot" } } }]);
    expect(await triageLines(admin)).toEqual(["unattended CRONK-1"]);
    expect(await triageLines(rita)).toEqual([]);
    expect(await triageLines(admin, "?kind=unattended")).toEqual(["unattended CRONK-1"]);
    expect(await triageLines(admin, "?kind=suggestion")).toEqual([]);
  });

  it("lists a delegated Ticket whose Assignee loses access to its Project, when they leave a private Project's members or it becomes private without them", async () => {
    const { admin, bob, rita, carolId } = await carolsDelegatedTicket();
    const bobId = (await bob.get("/api/me")).body.user.id;
    await admin.put(`/api/projects/CRONK/members/${bobId}`, { access: "write" });
    await admin.put(`/api/projects/CRONK/members/${carolId}`, { access: "read" });
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    // Read is still access: Carol can see CRONK-1 in her Inbox.
    expect(await triageLines(admin)).toEqual([]);

    expect((await admin.delete(`/api/projects/CRONK/members/${carolId}`)).status).toBe(204);

    expect((await bob.get("/api/triage")).body.items).toMatchObject([{ kind: "unattended", reason: "no_access", ticket: { key: "CRONK-1" } }]);
    expect(await triageLines(admin)).toEqual(["unattended CRONK-1"]);
    expect(await triageLines(rita)).toEqual([]);

    // Back to open, Carol has Write again; private again without her listed, she has nothing.
    await admin.patch("/api/projects/CRONK", { visibility: "open" });
    expect(await triageLines(admin)).toEqual([]);
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    expect(await triageLines(bob)).toEqual(["unattended CRONK-1"]);
  });

  it("drops it for everyone once it is reassigned to an active User with access, or its Assignee is reactivated", async () => {
    const { cronk, admin, bob, carolId } = await carolsDelegatedTicket();
    await admin.post("/api/projects/CRONK/tickets", { title: "Tidy the logs" });
    await admin.patch("/api/tickets/CRONK-2", { assigneeId: carolId, statusId: await statusIn(admin, "in_review") });
    const dave = await joinAs(cronk, admin, "dave@example.com");
    const daveId = (await dave.get("/api/me")).body.user.id;
    const bobId = (await bob.get("/api/me")).body.user.id;
    await admin.put(`/api/projects/CRONK/members/${bobId}`, { access: "write" });
    await admin.put(`/api/projects/CRONK/members/${carolId}`, { access: "write" });
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    await admin.patch(`/api/users/${carolId}`, { active: false });
    expect(await triageLines(bob)).toEqual(["unattended CRONK-1", "unattended CRONK-2"]);

    // Dave is active but can't see CRONK, so it can't go to him.
    expect((await admin.patch("/api/tickets/CRONK-2", { assigneeId: daveId })).status).toBe(400);
    expect(await triageLines(bob)).toEqual(["unattended CRONK-1", "unattended CRONK-2"]);
    expect((await bob.patch("/api/tickets/CRONK-2", { assigneeId: bobId })).status).toBe(200);
    expect(await triageLines(admin)).toEqual(["unattended CRONK-1"]);
    expect(await triageLines(bob)).toEqual(["unattended CRONK-1"]);

    await admin.patch(`/api/users/${carolId}`, { active: true });
    expect(await triageLines(admin)).toEqual([]);
    expect(await triageLines(bob)).toEqual([]);
  });

  it("drops it once it is neither delegated nor In Review, and never lists such a Ticket", async () => {
    const { admin, carolId } = await carolsDelegatedTicket();
    await admin.post("/api/projects/CRONK/tickets", { title: "Tidy the logs" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Write the docs" });
    await admin.patch("/api/tickets/CRONK-2", { assigneeId: carolId });
    await admin.patch("/api/tickets/CRONK-3", { assigneeId: carolId, statusId: await statusIn(admin, "in_review") });
    await admin.patch(`/api/users/${carolId}`, { active: false });
    expect(await triageLines(admin)).toEqual(["unattended CRONK-1", "unattended CRONK-3"]);

    await admin.patch("/api/tickets/CRONK-1", { delegateId: null });
    await admin.patch("/api/tickets/CRONK-3", { statusId: await statusIn(admin, "completed") });
    expect(await triageLines(admin)).toEqual([]);
  });

  it("leaves the Ticket's Assignee, Delegate and Changes as they were when its Assignee is deactivated", async () => {
    const { admin, carolId, carolBot } = await carolsDelegatedTicket();
    const before = (await admin.get("/api/tickets/CRONK-1")).body.ticket;
    const changes = (await admin.get("/api/tickets/CRONK-1/changes")).body.changes;

    expect((await admin.patch(`/api/users/${carolId}`, { active: false })).status).toBe(200);

    const after = (await admin.get("/api/tickets/CRONK-1")).body.ticket;
    expect(after.assignee).toEqual(before.assignee);
    expect(after.assignee.id).toBe(carolId);
    expect(after.delegate).toEqual({ id: carolBot.agentId, name: "carol-bot" });
    expect((await admin.get("/api/tickets/CRONK-1/changes")).body.changes).toEqual(changes);
  });

  it("lists a delegated Ticket that upgrading assigned to its Delegate's deactivated Owner", async () => {
    const { cronk, admin, bob, carolId } = await carolsDelegatedTicket();
    await admin.patch(`/api/users/${carolId}`, { active: false });
    // As before the rule that delegated work has an Assignee: CRONK-1 delegated to carol-bot with none.
    await cronk.undoMigration("0018_assign_delegated_tickets", "UPDATE tickets SET assignee_id = NULL");
    await cronk.restart();

    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.assignee).toMatchObject({ id: carolId });
    expect((await bob.get("/api/triage")).body.items).toMatchObject([{ kind: "unattended", reason: "deactivated", ticket: { key: "CRONK-1" } }]);
  });

  it("tells Triage when the Ticket is reassigned or its Assignee reactivated, so the count updates", async () => {
    const { admin, bob, carolId } = await carolsDelegatedTicket();
    await admin.patch(`/api/users/${carolId}`, { active: false });
    const stream = await bob.events("/api/inbox/events?triage=true");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch(`/api/users/${carolId}`, { active: true });
    expect(await stream.next()).toMatchObject({ event: "triage" });
    await admin.patch(`/api/users/${carolId}`, { active: false });
    expect(await stream.next()).toMatchObject({ event: "triage" });
    expect(await triageLines(bob)).toEqual(["unattended CRONK-1"]);
    await bob.patch("/api/tickets/CRONK-1", { assigneeId: (await bob.get("/api/me")).body.user.id });
    // Bob's own Inbox hears of it first, as he is now its Assignee.
    expect(await stream.next()).toMatchObject({ event: "changed" });
    expect(await stream.next()).toMatchObject({ event: "triage" });
    expect(await triageLines(bob)).toEqual([]);
  });

  it("isn't shown to a User who can't see its Project", async () => {
    const { cronk, admin, carolId } = await carolsDelegatedTicket();
    const eve = await joinAs(cronk, admin, "eve@example.com");
    await admin.put(`/api/projects/CRONK/members/${carolId}`, { access: "write" });
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    await admin.patch(`/api/users/${carolId}`, { active: false });
    expect(await triageLines(admin)).toEqual(["unattended CRONK-1"]);
    expect(await triageLines(eve)).toEqual([]);
  });

  it("tells Triage when an Assignee loses access to a Project", async () => {
    const { admin, bob, carolId } = await carolsDelegatedTicket();
    await admin.put(`/api/projects/CRONK/members/${carolId}`, { access: "write" });
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    const stream = await bob.events("/api/inbox/events?triage=true");
    expect((await stream.next())?.event).toBe("ready");

    await admin.delete(`/api/projects/CRONK/members/${carolId}`);
    expect(await stream.next()).toMatchObject({ event: "triage" });
  });
});

/** As `carolsDelegatedTicket`, with CRONK-1 under Autonomous Delegation and carol-bot having completed it with a Report, leaving it Unverified. */
async function carolsUnverifiedCompletion() {
  const setup = await carolsDelegatedTicket();
  const { cronk, admin, carolBot } = setup;
  await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
  const agent = await startSession(cronk, carolBot.secret);
  await agent.post("/api/tickets/CRONK-1/claim");
  await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed the cache." });
  const completed = await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "completed") });
  if (completed.body.ticket?.verification !== "unverified") throw new Error(`Completing failed: ${JSON.stringify(completed.body)}`);
  return setup;
}

describe("Triage's unattended Unverified completions", () => {
  it("lists an Unverified completion whose Assignee is deactivated to the Users with Write in its Project, but not as unverified", async () => {
    const { admin, bob, rita, carolId } = await carolsUnverifiedCompletion();
    expect(await triageLines(admin)).toEqual([]);

    await admin.patch(`/api/users/${carolId}`, { active: false });

    const { items } = (await bob.get("/api/triage")).body;
    expect(items).toMatchObject([
      { kind: "unattended", reason: "deactivated", ticket: { key: "CRONK-1", verification: "unverified", assignee: { id: carolId } }, reports: [{ title: "Done" }] },
    ]);
    expect(await triageLines(admin)).toEqual(["unattended CRONK-1"]);
    expect(await triageLines(rita)).toEqual([]);
    expect(await triageLines(admin, "?kind=unverified")).toEqual([]);
  });

  it("lists an Unverified completion whose Assignee loses access to its Project, saying why", async () => {
    const { admin, bob, rita, carolId } = await carolsUnverifiedCompletion();
    await admin.put(`/api/projects/CRONK/members/${(await bob.get("/api/me")).body.user.id}`, { access: "write" });
    await admin.put(`/api/projects/CRONK/members/${carolId}`, { access: "write" });
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    expect(await triageLines(admin)).toEqual([]);

    await admin.delete(`/api/projects/CRONK/members/${carolId}`);

    expect((await bob.get("/api/triage")).body.items).toMatchObject([{ kind: "unattended", reason: "no_access", ticket: { key: "CRONK-1", verification: "unverified" } }]);
    expect(await triageLines(admin)).toEqual(["unattended CRONK-1"]);
    expect(await triageLines(rita)).toEqual([]);
  });

  it("drops it for everyone once someone Accepts it, and never lists a Verified completion", async () => {
    const { admin, bob, carolId } = await carolsUnverifiedCompletion();
    await admin.patch(`/api/users/${carolId}`, { active: false });
    expect(await triageLines(bob)).toEqual(["unattended CRONK-1"]);

    expect((await bob.post("/api/tickets/CRONK-1/accept")).status).toBe(200);

    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.verification).toBe("verified");
    expect(await triageLines(admin)).toEqual([]);
    expect(await triageLines(bob)).toEqual([]);
  });

  it("keeps it as an ordinary unattended Ticket once someone Reopens it, as it stays delegated to the same Assignee", async () => {
    const { admin, bob, carolId } = await carolsUnverifiedCompletion();
    await admin.patch(`/api/users/${carolId}`, { active: false });

    expect((await bob.post("/api/tickets/CRONK-1/reopen", { comment: "The cache isn't cleared on moves.", dependents: {} })).status).toBe(200);

    expect((await bob.get("/api/triage")).body.items).toMatchObject([
      { kind: "unattended", reason: "deactivated", ticket: { key: "CRONK-1", verification: null, status: { category: expect.not.stringMatching(/completed|canceled/) } } },
    ]);
  });

  it("drops it once it is reassigned to an active User with access, whose Inbox then holds it as Unverified", async () => {
    const { admin, bob, carolId } = await carolsUnverifiedCompletion();
    await admin.patch(`/api/users/${carolId}`, { active: false });
    const bobId = (await bob.get("/api/me")).body.user.id;
    expect((await bob.get("/api/inbox")).body.items).toEqual([]);

    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: bobId })).status).toBe(200);

    expect(await triageLines(admin)).toEqual([]);
    expect(await triageLines(bob)).toEqual([]);
    expect((await bob.get("/api/inbox")).body.items).toMatchObject([{ kind: "unverified", ticket: { key: "CRONK-1", verification: "unverified" }, reports: [{ title: "Done" }] }]);
  });

  it("drops it once its Assignee is reactivated, and tells Triage", async () => {
    const { admin, bob, carolId } = await carolsUnverifiedCompletion();
    await admin.patch(`/api/users/${carolId}`, { active: false });
    const stream = await bob.events("/api/inbox/events?triage=true");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch(`/api/users/${carolId}`, { active: true });
    expect(await stream.next()).toMatchObject({ event: "triage" });
    expect(await triageLines(bob)).toEqual([]);
    await admin.patch(`/api/users/${carolId}`, { active: false });
    expect(await stream.next()).toMatchObject({ event: "triage" });
    expect(await triageLines(bob)).toEqual(["unattended CRONK-1"]);
    await bob.post("/api/tickets/CRONK-1/accept");
    expect(await stream.next()).toMatchObject({ event: "triage" });
    expect(await triageLines(bob)).toEqual([]);
  });
});
