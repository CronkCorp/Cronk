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
    expect((await admin.get("/api/inbox?kind=suggestion")).status).toBe(400);
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
    expect((await admin.get("/api/tickets/CRONK-1/comments")).body.comments).toMatchObject([{ body: "Please add a test." }]);
    expect(await inboxLines(admin)).toEqual([]);
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toMatchObject([
      { reason: "comment", comment: { body: "Please add a test." }, ticket: { key: "CRONK-1" } },
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
