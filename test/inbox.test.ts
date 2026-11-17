import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, registerAgent, startSession, type Client } from "./harness.js";

/** The id of the first Status of `category` in Project `key`. */
const statusIn = async (client: Client, category: string, key = "CRONK") =>
  ((await client.get(`/api/projects/${key}`)).body.statuses as { id: string; category: string }[]).find((s) => s.category === category)!.id;

/** The Inbox of `client`, as `kind key` lines, in order. */
const inboxLines = async (client: Client, query = "") =>
  ((await client.get(`/api/inbox${query}`)).body.items as { kind: string; ticket: { key: string } }[]).map((i) => `${i.kind} ${i.ticket.key}`);

describe("The Inbox", () => {
  it("lists Tickets in an In Review Status the User is Assignee of, with their Reports", async () => {
    const { cronk, admin, session } = await delegatedSetup(3);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/reports", { title: "What I found", body: "It was the cache." });
    await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "in_review") });
    cronk.clock.advance(1000);
    await admin.patch("/api/tickets/CRONK-2", { statusId: await statusIn(admin, "in_review") });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    await admin.post("/api/projects/CRONK/tickets", { title: "Bob's" });
    await admin.patch("/api/tickets/CRONK-4", { assigneeId: bobId, statusId: await statusIn(admin, "in_review") });

    const inbox = await admin.get("/api/inbox");
    expect(inbox.status).toBe(200);
    expect(inbox.body.items).toMatchObject([
      { kind: "review", ticket: { key: "CRONK-1", status: { category: "in_review" } }, reports: [{ title: "What I found", ticketKey: "CRONK-1" }] },
      { kind: "review", ticket: { key: "CRONK-2" }, reports: [] },
    ]);
    expect(await inboxLines(bob)).toEqual(["review CRONK-4"]);
  });

  it("lists the open questions of the User's Agents, blocking ones first, until a User answers them", async () => {
    const { cronk, admin, adaId, session } = await delegatedSetup(3);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const asked = (await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Which cache?" })).body.activity;
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "progress", body: "Looking around." });
    cronk.clock.advance(1000);
    await admin.patch("/api/tickets/CRONK-2", { statusId: await statusIn(admin, "in_review") });
    cronk.clock.advance(1000);
    const codex = await startSession(cronk, (await registerAgent(admin, "codex")).secret);
    await admin.patch("/api/tickets/CRONK-3", { assigneeId: adaId, delegateId: (await codex.get("/api/me")).body.agent.id });
    await codex.post("/api/tickets/CRONK-3/claim");
    await codex.post("/api/tickets/CRONK-3/activities", { kind: "question", body: "May I drop the table?", blocking: true });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    const bobsAgent = await startSession(cronk, (await registerAgent(bob, "bobs-agent")).secret);
    await admin.post("/api/projects/CRONK/tickets", { title: "Bob's" });
    await admin.patch("/api/tickets/CRONK-4", { assigneeId: bobId, delegateId: (await bobsAgent.get("/api/me")).body.agent.id });
    await bobsAgent.post("/api/tickets/CRONK-4/claim");
    await bobsAgent.post("/api/tickets/CRONK-4/activities", { kind: "question", body: "Bob's question" });

    const items = (await admin.get("/api/inbox")).body.items;
    expect(items.map((i: { kind: string; ticket: { key: string } }) => `${i.kind} ${i.ticket.key}`)).toEqual([
      "question CRONK-3",
      "question CRONK-1",
      "review CRONK-2",
    ]);
    expect(items[0]).toMatchObject({
      question: { body: "May I drop the table?", blocking: true, agent: { name: "codex", owner: { name: "Ada" } }, answer: null },
      ticket: { key: "CRONK-3", title: "Ticket 3", status: { name: expect.any(String) } },
    });
    expect(await inboxLines(bob)).toEqual(["question CRONK-4"]);

    await bob.post("/api/tickets/CRONK-1/comments", { body: "The page cache.", replyToActivityId: asked.id });
    expect(await inboxLines(admin)).toEqual(["question CRONK-3", "review CRONK-2"]);
  });

  it("filters by kind, Project and Agent, each taking several values", async () => {
    const { cronk, admin, adaId, claude, session } = await delegatedSetup(2);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Which cache?" });
    await admin.patch("/api/tickets/CRONK-2", { statusId: await statusIn(admin, "in_review") });
    await admin.post("/api/projects", { name: "Docs", key: "DOCS" });
    await admin.post("/api/projects/DOCS/tickets", { title: "Write the guide" });
    const codex = await registerAgent(admin, "codex");
    await admin.patch("/api/tickets/DOCS-1", { assigneeId: adaId, delegateId: codex.agentId });
    const codexSession = await startSession(cronk, codex.secret);
    await codexSession.post("/api/tickets/DOCS-1/claim");
    await codexSession.post("/api/tickets/DOCS-1/activities", { kind: "question", body: "Which audience?" });
    await admin.patch("/api/tickets/DOCS-1", { statusId: await statusIn(admin, "in_review", "DOCS") });

    expect(await inboxLines(admin, "?kind=review")).toEqual(["review CRONK-2", "review DOCS-1"]);
    expect(await inboxLines(admin, "?kind=question&kind=review&project=docs")).toEqual(["question DOCS-1", "review DOCS-1"]);
    expect(await inboxLines(admin, `?agent=${claude.agentId}`)).toEqual(["question CRONK-1", "review CRONK-2"]);
    expect(await inboxLines(admin, `?kind=review&agent=${codex.agentId}`)).toEqual(["review DOCS-1"]);
    expect(await inboxLines(admin, `?project=CRONK&agent=${codex.agentId}`)).toEqual([]);
    expect((await admin.get("/api/inbox?kind=gossip")).status).toBe(400);
  });

  it("leaves out the questions of an Agent its Owner removed", async () => {
    const { admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Which cache?" });
    expect(await inboxLines(admin)).toEqual(["question CRONK-1"]);

    await admin.delete(`/api/agents/${claude.agentId}`);
    expect(await inboxLines(admin)).toEqual([]);
  });

  it("leaves out items in Projects the User can no longer see, and is only for Users", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: bobId, statusId: await statusIn(admin, "in_review") });
    expect(await inboxLines(bob)).toEqual(["review CRONK-1"]);

    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    expect(await inboxLines(bob)).toEqual([]);
    expect((await cronk.client(claude.secret).get("/api/inbox")).status).toBe(403);
  });
});

describe("Completing a Ticket from the Inbox", () => {
  it("takes it out of the Inbox", async () => {
    const { admin } = await delegatedSetup();
    await admin.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "in_review") });
    expect(await inboxLines(admin)).toEqual(["review CRONK-1"]);

    expect((await admin.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "completed") })).status).toBe(200);
    expect(await inboxLines(admin)).toEqual([]);
  });
});

describe("Sending a Ticket back", () => {
  it("moves it from In Review to the Project's first Started Status with a Comment, which waits for the Delegate", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed it." });
    await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "in_review") });

    const sent = await admin.post("/api/tickets/CRONK-1/send-back", { comment: "Please add a test." });
    expect(sent.status).toBe(200);
    expect(sent.body.ticket.status.id).toBe(await statusIn(admin, "started"));
    expect(sent.body.comment).toMatchObject({ body: "Please add a test.", actor: { kind: "user", name: "Ada" } });
    expect((await admin.get("/api/tickets/CRONK-1/comments")).body.comments).toMatchObject([{ body: "Please add a test.", sendBack: true }]);
    expect(await inboxLines(admin)).toEqual([]);
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toMatchObject([
      { reason: "comment", comment: { body: "Please add a test." }, ticket: { key: "CRONK-1" } },
    ]);
  });

  it("marks only its own Comment as a Send back's", async () => {
    const { admin } = await delegatedSetup();
    await admin.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "in_review") });
    const ordinary = await admin.post("/api/tickets/CRONK-1/comments", { body: "Looking now." });
    expect(ordinary.body.comment.sendBack).toBe(false);
    const sent = await admin.post("/api/tickets/CRONK-1/send-back", { comment: "Add a test." });
    expect(sent.body.comment.sendBack).toBe(true);
    const comments = (await admin.get("/api/tickets/CRONK-1/comments")).body.comments;
    expect(comments.map((c: { body: string; sendBack: boolean }) => [c.body, c.sendBack])).toEqual([
      ["Looking now.", false],
      ["Add a test.", true],
    ]);
    // Its move back is marked in the history too; an ordinary move isn't.
    const moves = (await admin.get("/api/tickets/CRONK-1/changes")).body.changes.filter((c: { change: string }) => c.change === "status");
    expect(moves.map((c: { to: { category: string }; sentBack: boolean }) => [c.to.category, c.sentBack])).toEqual([
      ["in_review", false],
      ["started", true],
    ]);
  });

  it("takes another Started Status, but refuses one in another Status Category, a Ticket not In Review, and Agents", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const reworking = (await admin.post("/api/projects/CRONK/statuses", { name: "Reworking", category: "started" })).body.status;
    await admin.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "in_review") });

    const unstarted = await admin.post("/api/tickets/CRONK-1/send-back", { comment: "No.", statusId: await statusIn(admin, "unstarted") });
    expect(unstarted.status).toBe(400);
    expect((await cronk.client(claude.secret).post("/api/tickets/CRONK-1/send-back", { comment: "No." })).status).toBe(403);
    expect((await admin.get("/api/tickets/CRONK-1/comments")).body.comments).toEqual([]);

    const sent = await admin.post("/api/tickets/CRONK-1/send-back", { comment: "Rework it.", statusId: reworking.id });
    expect(sent.body.ticket.status).toMatchObject({ name: "Reworking" });
    const again = await admin.post("/api/tickets/CRONK-1/send-back", { comment: "Twice?" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/In Review/);
  });
});

describe("The Inbox's live updates", () => {
  it("tell the User whenever their Inbox may have changed, so they can fetch it again", async () => {
    const { cronk, admin, session } = await delegatedSetup(3);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const stream = await admin.events("/api/inbox/events");
    expect(stream.status).toBe(200);
    expect((await stream.next())?.event).toBe("ready");

    const asked = (await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Which cache?" })).body.activity;
    expect(await stream.next()).toMatchObject({ event: "changed" });
    await admin.post("/api/tickets/CRONK-1/comments", { body: "The page cache.", replyToActivityId: asked.id });
    expect(await stream.next()).toMatchObject({ event: "changed" });
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed it." });
    expect(await stream.next()).toMatchObject({ event: "changed" });
    await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "in_review") });
    expect(await stream.next()).toMatchObject({ event: "changed" });
    await admin.post("/api/tickets/CRONK-1/send-back", { comment: "Add a test." });
    expect(await stream.next()).toMatchObject({ event: "changed" });

    // A Ticket leaving the User's hands changes their Inbox too.
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobsStream = await bob.events("/api/inbox/events");
    expect((await bobsStream.next())?.event).toBe("ready");
    await admin.patch("/api/tickets/CRONK-2", { assigneeId: (await bob.get("/api/me")).body.user.id });
    expect(await stream.next()).toMatchObject({ event: "changed" });
    expect(await bobsStream.next()).toMatchObject({ event: "changed" });
  });

  it("tell the User when their Agent is removed, and when removing a Status moves their Tickets", async () => {
    const { admin, claude } = await delegatedSetup();
    const checking = (await admin.post("/api/projects/CRONK/statuses", { name: "Checking", category: "in_review" })).body.status;
    await admin.patch("/api/tickets/CRONK-1", { statusId: checking.id });
    const stream = await admin.events("/api/inbox/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.delete(`/api/projects/CRONK/statuses/${checking.id}?moveTo=${await statusIn(admin, "started")}`);
    expect(await stream.next()).toMatchObject({ event: "changed" });
    await admin.delete(`/api/agents/${claude.agentId}`);
    expect(await stream.next()).toMatchObject({ event: "changed" });
  });

  it("tell a User when their access to a Project changes", async () => {
    const { cronk, admin } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    const stream = await bob.events("/api/inbox/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.put(`/api/projects/CRONK/members/${bobId}`, { access: "read" });
    expect(await stream.next()).toMatchObject({ event: "changed" });
    await admin.delete(`/api/projects/CRONK/members/${bobId}`);
    expect(await stream.next()).toMatchObject({ event: "changed" });
    await admin.patch(`/api/users/${bobId}`, { role: "admin" });
    expect(await stream.next()).toMatchObject({ event: "changed" });
    await admin.patch(`/api/users/${bobId}`, { role: "member" });
    expect(await stream.next()).toMatchObject({ event: "changed" });
  });

  it("tell the Users with items in a Project when it becomes private or open", async () => {
    const { cronk, admin } = await delegatedSetup(2);
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: (await bob.get("/api/me")).body.user.id, statusId: await statusIn(admin, "in_review") });
    const carol = await joinAs(cronk, admin, "carol@example.com");
    const carolsAgent = await startSession(cronk, (await registerAgent(carol, "carols-agent")).secret);
    await admin.patch("/api/tickets/CRONK-2", { assigneeId: (await carol.get("/api/me")).body.user.id, delegateId: (await carolsAgent.get("/api/me")).body.agent.id });
    await carolsAgent.post("/api/tickets/CRONK-2/claim");
    await carolsAgent.post("/api/tickets/CRONK-2/activities", { kind: "question", body: "Which cache?" });
    const bobsStream = await bob.events("/api/inbox/events");
    const carolsStream = await carol.events("/api/inbox/events");
    expect((await bobsStream.next())?.event).toBe("ready");
    expect((await carolsStream.next())?.event).toBe("ready");

    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    expect(await bobsStream.next()).toMatchObject({ event: "changed" });
    expect(await carolsStream.next()).toMatchObject({ event: "changed" });
    expect(await inboxLines(bob)).toEqual([]);
    await admin.patch("/api/projects/CRONK", { visibility: "open" });
    expect(await bobsStream.next()).toMatchObject({ event: "changed" });
    expect(await carolsStream.next()).toMatchObject({ event: "changed" });
    expect(await inboxLines(bob)).toEqual(["review CRONK-1"]);
  });

  it("tell the Users with items on Tickets in a Status when it is renamed", async () => {
    const { cronk, admin, session } = await delegatedSetup(2);
    const checking = (await admin.post("/api/projects/CRONK/statuses", { name: "Checking", category: "in_review" })).body.status;
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: (await bob.get("/api/me")).body.user.id, statusId: checking.id });
    const stream = await bob.events("/api/inbox/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch(`/api/projects/CRONK/statuses/${checking.id}`, { name: "Verifying" });
    expect(await stream.next()).toMatchObject({ event: "changed" });

    // A question's item shows its Ticket's Status too.
    const agent = await session();
    await agent.post("/api/tickets/CRONK-2/claim");
    await agent.post("/api/tickets/CRONK-2/activities", { kind: "question", body: "Which cache?" });
    const adasStream = await admin.events("/api/inbox/events");
    expect((await adasStream.next())?.event).toBe("ready");
    const { status } = (await admin.get("/api/tickets/CRONK-2")).body.ticket;
    await admin.patch(`/api/projects/CRONK/statuses/${status.id}`, { name: "Underway" });
    expect(await adasStream.next()).toMatchObject({ event: "changed" });
  });

  it("tell a Ticket's Assignee when a User edits, restores or deletes its Report", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "## Cause\n\nThe cache." })).body.report;
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: (await bob.get("/api/me")).body.user.id });
    const stream = await bob.events("/api/inbox/events");
    expect((await stream.next())?.event).toBe("ready");

    expect((await admin.patch(`/api/documents/${report.id}`, { baseVersion: 1, title: "What I found" })).status).toBe(200);
    expect(await stream.next()).toMatchObject({ event: "changed" });
    expect((await admin.post(`/api/documents/${report.id}/replace-section`, { baseVersion: 2, heading: "Cause", body: "The page cache." })).status).toBe(200);
    expect(await stream.next()).toMatchObject({ event: "changed" });
    expect((await admin.post(`/api/documents/${report.id}/versions/1/restore`, { baseVersion: 3 })).status).toBe(200);
    expect(await stream.next()).toMatchObject({ event: "changed" });
    expect((await admin.delete(`/api/documents/${report.id}?baseVersion=4`)).status).toBe(204);
    expect(await stream.next()).toMatchObject({ event: "changed" });
  });

  it("are only for Users", async () => {
    const { cronk, claude } = await delegatedSetup();
    expect((await cronk.client(claude.secret).events("/api/inbox/events")).status).toBe(403);
  });
});

describe("A waiting Discovered Ticket's Inbox item, live", () => {
  /**
   * Bob, the Assignee of a Discovered Ticket waiting for him that pauses CRONK-1, and his Inbox stream with Triage. CRONK-1
   * stays Ada's, so only the block reaches Bob. `before` runs first, as the block stops CRONK-1's Agent claiming it.
   */
  async function waitingOn(before?: (admin: Client, agent: Client) => Promise<unknown>) {
    const setup = await delegatedSetup();
    const { cronk, admin, session } = setup;
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const agent = await session();
    await before?.(admin, agent);
    const discovered = (await agent.post("/api/projects/CRONK/tickets", { title: "Migration leaves orphans", blocks: [{ ticketKey: "CRONK-1", reason: "Same migration." }] }))
      .body.ticket.key as string;
    await admin.patch(`/api/tickets/${discovered}`, { assigneeId: (await bob.get("/api/me")).body.user.id });
    const stream = await bob.events("/api/inbox/events?triage=true");
    expect((await stream.next())?.event).toBe("ready");
    /** Expects Bob's Inbox to be told it changed, then Triage. */
    const toldBob = async () => {
      expect(await stream.next()).toMatchObject({ event: "changed" });
      expect(await stream.next()).toMatchObject({ event: "triage" });
    };
    return { ...setup, bob, agent, discovered, stream, toldBob };
  }

  it("tells its Assignee when a Ticket it pauses is renamed or moves to another Status", async () => {
    const { admin, toldBob } = await waitingOn();

    await admin.patch("/api/tickets/CRONK-1", { title: "Clean up the cache" });
    await toldBob();
    await admin.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "completed") });
    await toldBob();
  });

  it("tells its Assignee when the Status of a Ticket it pauses is renamed, or removed and its Tickets moved", async () => {
    const { admin, toldBob } = await waitingOn();
    const checking = (await admin.post("/api/projects/CRONK/statuses", { name: "Checking", category: "started" })).body.status;
    await admin.patch("/api/tickets/CRONK-1", { statusId: checking.id });
    await toldBob();

    await admin.patch(`/api/projects/CRONK/statuses/${checking.id}`, { name: "Verifying" });
    await toldBob();
    await admin.delete(`/api/projects/CRONK/statuses/${checking.id}?moveTo=${await statusIn(admin, "completed")}`);
    await toldBob();
  });

  it("tells its Assignee when a Ticket it pauses in another Project becomes private or open", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    await admin.post("/api/projects/OPS/tickets", { title: "Deploy" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Migration leaves orphans", blocks: [{ ticketKey: "OPS-1", reason: "Same migration." }] });
    await admin.patch("/api/tickets/CRONK-2", { assigneeId: (await bob.get("/api/me")).body.user.id });
    const stream = await bob.events("/api/inbox/events?triage=true");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/projects/OPS", { visibility: "private" });
    expect(await stream.next()).toMatchObject({ event: "changed" });
    expect(await stream.next()).toMatchObject({ event: "triage" });
    expect((await bob.get("/api/inbox?kind=discovered")).body.items).toMatchObject([{ ticket: { key: "CRONK-2" }, blocks: [] }]);
    await admin.patch("/api/projects/OPS", { visibility: "open" });
    expect(await stream.next()).toMatchObject({ event: "changed" });
    expect(await stream.next()).toMatchObject({ event: "triage" });
    expect((await bob.get("/api/inbox?kind=discovered")).body.items).toMatchObject([{ ticket: { key: "CRONK-2" }, blocks: [{ key: "OPS-1" }] }]);
  });

  it("tells its Assignee when a Ticket it pauses is Reopened", async () => {
    const { admin, toldBob } = await waitingOn(async (admin, agent) => {
      await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
      await agent.post("/api/tickets/CRONK-1/claim");
      await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed the cache." });
      expect((await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "completed") })).body.ticket).toMatchObject({ verification: "unverified" });
    });

    expect((await admin.post("/api/tickets/CRONK-1/reopen", { comment: "The cache isn't cleared on moves.", dependents: {} })).status).toBe(200);
    await toldBob();
  });

  it("leaves its Assignee alone once it no longer waits, and when a Ticket it pauses changes only its description", async () => {
    const { admin, discovered, stream, toldBob } = await waitingOn();

    await admin.patch("/api/tickets/CRONK-1", { description: "The page cache." });
    expect(await stream.next()).toMatchObject({ event: "triage" });
    await admin.post(`/api/tickets/${discovered}/keep`);
    await toldBob();
    await admin.patch("/api/tickets/CRONK-1", { title: "Clean up the cache" });
    expect(await stream.next()).toMatchObject({ event: "triage" });
  });

  it("are listed with the Tickets they pause in a fixed number of queries, however many there are", async () => {
    const { cronk, admin, session } = await delegatedSetup(3);
    const agent = await session();
    /** Files a Discovered Ticket blocking `keys`, which waits in Triage instead of the Inbox when `unassigned`. */
    const discover = async (title: string, keys: string[], { unassigned = false } = {}) => {
      const blocks = keys.map((ticketKey) => ({ ticketKey, reason: "Same migration." }));
      const { key } = (await agent.post("/api/projects/CRONK/tickets", { title, blocks })).body.ticket;
      if (unassigned) await admin.patch(`/api/tickets/${key}`, { assigneeId: null });
    };
    const relationQueries = async () => ({
      inbox: await cronk.queriesOn("ticket_relations", () => admin.get("/api/inbox?kind=discovered")),
      triage: await cronk.queriesOn("ticket_relations", () => admin.get("/api/triage?kind=discovered")),
    });
    await discover("Migration leaves orphans", ["CRONK-2", "CRONK-1"]);
    await discover("Cache is stale", ["CRONK-2"], { unassigned: true });
    const withOne = await relationQueries();

    await discover("Docs are stale", ["CRONK-3"]);
    await discover("Logs are noisy", []);
    await discover("Tests are slow", ["CRONK-1", "CRONK-3"], { unassigned: true });
    await discover("Builds are slow", ["CRONK-3"], { unassigned: true });

    expect(await relationQueries()).toEqual(withOne);
    const lines = async (path: string) =>
      ((await admin.get(path)).body.items as { ticket: { key: string }; blocks: { key: string }[] }[]).map((i) => [i.ticket.key, i.blocks.map((b) => b.key)]);
    expect(await lines("/api/inbox?kind=discovered")).toEqual([
      ["CRONK-4", ["CRONK-1", "CRONK-2"]],
      ["CRONK-6", ["CRONK-3"]],
      ["CRONK-7", []],
    ]);
    expect(await lines("/api/triage?kind=discovered")).toEqual([
      ["CRONK-5", ["CRONK-2"]],
      ["CRONK-8", ["CRONK-1", "CRONK-3"]],
      ["CRONK-9", ["CRONK-3"]],
    ]);
  });
});
