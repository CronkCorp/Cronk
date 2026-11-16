import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, registerAgent, startSession, type Cronk } from "./harness.js";

describe("Work waiting for an Agent", () => {
  it("includes a Comment on a Ticket delegated to it, in the welcome of its next Agent Session only", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const posted = (await admin.post("/api/tickets/CRONK-1/comments", { body: "Please also update the docs." })).body.comment;

    const welcomed = await cronk.client(claude.secret).post("/api/agent-sessions");
    expect(welcomed.body.welcome.waitingWork).toEqual([
      { reason: "comment", comment: posted, ticket: { key: "CRONK-1", title: "Ticket 1" }, document: null, artifact: null },
    ]);
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toEqual([]);
    await session();
  });

  it("leaves out Comments the Agent posted itself, and Comments on Tickets not delegated to it", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup(2);
    await admin.patch("/api/tickets/CRONK-2", { delegateId: null });
    await (await session()).post("/api/tickets/CRONK-1/comments", { body: "Starting on this." });
    await admin.post("/api/tickets/CRONK-2/comments", { body: "Not for an Agent." });

    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toEqual([]);
  });
});

describe("An @mention of an Agent", () => {
  it("waits for the writer's own Agent of that name, ignoring case, and not other Owners' Agents of that name", async () => {
    const { cronk, admin } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const codex = await registerAgent(admin, "Codex");
    const bobsCodex = await registerAgent(bob, "codex");
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Design" })).body.document;

    const posted = (await admin.post(`/api/documents/${doc.id}/comments`, { body: "@codex, can you check this? cc @nobody, mail@codex.dev" })).body.comment;

    expect(await waitingWork(cronk, codex)).toEqual([{ reason: "mention", comment: posted, ticket: null, document: { id: doc.id, title: "Design" }, artifact: null }]);
    expect(await waitingWork(cronk, bobsCodex)).toEqual([]);
  });

  it("falls back to other Owners' Agents of that name when the writer has none", async () => {
    const { cronk, admin } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const carol = await joinAs(cronk, admin, "carol@example.com");
    const bobsCodex = await registerAgent(bob, "codex");
    const carolsCodex = await registerAgent(carol, "codex");

    await admin.post("/api/tickets/CRONK-1/comments", { body: "@codex, look." });

    expect(await mentionedIn(cronk, bobsCodex)).toEqual(["@codex, look."]);
    expect(await mentionedIn(cronk, carolsCodex)).toEqual(["@codex, look."]);
  });

  it("from an Agent, means its Owner's other Agents first, and other Owners' Agents of its own name", async () => {
    const { cronk, admin } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const codex = await startSession(cronk, (await registerAgent(admin, "codex")).secret);
    const bobsCodex = await registerAgent(bob, "codex");

    await codex.post("/api/tickets/CRONK-1/comments", { body: "@codex, can you review?" });

    expect(await mentionedIn(cronk, bobsCodex)).toEqual(["@codex, can you review?"]);
  });

  it("picks another Owner's Agent with @owner/name, the Owner by name ignoring case", async () => {
    const { cronk, admin } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const codex = await registerAgent(admin, "codex");
    const bobsCodex = await registerAgent(bob, "codex");

    await admin.post("/api/tickets/CRONK-1/comments", { body: "@Bob/codex, look." });

    expect(await mentionedIn(cronk, bobsCodex)).toEqual(["@Bob/codex, look."]);
    expect(await mentionedIn(cronk, codex)).toEqual([]);
  });

  it("takes names that contain spaces in quotes, for the Agent and for its Owner", async () => {
    const { cronk, admin } = await delegatedSetup();
    const laptop = await registerAgent(admin, "claude laptop");
    const bob = await joinAs(cronk, admin, "bob@example.com", "member", "Bob Smith");
    const bobsDesktop = await registerAgent(bob, "claude desktop");

    await admin.post("/api/tickets/CRONK-1/comments", { body: `@"Claude Laptop" and @"bob smith"/"claude desktop", look.` });

    expect(await mentionedIn(cronk, laptop)).toHaveLength(1);
    expect(await mentionedIn(cronk, bobsDesktop)).toHaveLength(1);
  });

  it("takes bare names in any script, and mentions that start a line after a hard break", async () => {
    const { cronk, admin } = await delegatedSetup();
    const zoe = await joinAs(cronk, admin, "zoe@example.com", "member", "Zoë");
    const zoesCodex = await registerAgent(zoe, "codex");
    const zoesHelper = await registerAgent(zoe, "hëlper");

    await admin.post("/api/tickets/CRONK-1/comments", { body: "Thanks  \n@zoë/codex" });
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Thanks\\\n@hëlper" });

    expect(await mentionedIn(cronk, zoesCodex)).toEqual(["Thanks  \n@zoë/codex"]);
    expect(await mentionedIn(cronk, zoesHelper)).toEqual(["Thanks\\\n@hëlper"]);
  });

  it("doesn't count mentions inside code spans, code blocks or block quotes", async () => {
    const { cronk, admin } = await delegatedSetup();
    const codex = await registerAgent(admin, "codex");

    for (const body of [
      "Run `@codex review` later.",
      "```\n@codex review\n```",
      "~~~sh\nnotify @codex\n~~~",
      "Example:\n\n    @codex review",
      "> @codex said this was fine.",
      "> quoting\n> - @codex in a list",
    ]) {
      await admin.post("/api/tickets/CRONK-1/comments", { body });
    }
    await admin.post("/api/tickets/CRONK-1/comments", { body: "> quoted\n\nBut **@codex**, look." });

    expect(await mentionedIn(cronk, codex)).toEqual(["> quoted\n\nBut **@codex**, look."]);
  });

  it("leaves out Agents that can't see where it was posted", async () => {
    const { cronk, admin } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobsCodex = await registerAgent(bob, "codex");
    await admin.patch("/api/projects/CRONK", { visibility: "private" });

    await admin.post("/api/tickets/CRONK-1/comments", { body: "@codex, look." });

    expect((await cronk.client(bobsCodex.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toEqual([]);
  });
});

/** The work waiting for `agent`, from the welcome of a new Agent Session. */
async function waitingWork(cronk: Cronk, agent: { secret: string }) {
  return (await cronk.client(agent.secret).post("/api/agent-sessions")).body.welcome.waitingWork;
}

/** The bodies of the Comments waiting for `agent` because they @mention it. */
async function mentionedIn(cronk: Cronk, agent: { secret: string }): Promise<string[]> {
  return (await waitingWork(cronk, agent)).filter((w: { reason: string }) => w.reason === "mention").map((w: { comment: { body: string } }) => w.comment.body);
}

describe("An answer to an Agent's question", () => {
  it("waits for the Agent that asked, as an answer", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const question = (await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Which one?", blocking: true })).body.activity;

    const answer = (await admin.post("/api/tickets/CRONK-1/comments", { body: "The first.", replyToActivityId: question.id })).body.comment;

    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toEqual([
      { reason: "answer", comment: answer, ticket: { key: "CRONK-1", title: "Ticket 1" }, document: null, artifact: null },
    ]);
  });

  it("reaches the Agent Session that asked, pushed on its open events stream, when it comes after the silence threshold", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const stream = await agent.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");
    const question = (await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Which one?", blocking: true })).body.activity;

    // 8 minutes pass, each four of them ending in the stream's heartbeat.
    for (let i = 0; i < 2; i++) {
      cronk.clock.advance(4 * 60_000);
      await cronk.heartbeat();
    }
    const answer = (await admin.post("/api/tickets/CRONK-1/comments", { body: "The first.", replyToActivityId: question.id })).body.comment;

    expect(await stream.next()).toMatchObject({ event: "waiting", data: { waiting: { reason: "answer", comment: answer, ticket: { key: "CRONK-1" } } } });
    expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "progress", body: "Going with the first." })).status).toBe(201);
  });

  it("is only the reply that answered it; later replies wait as Comments on the delegated Ticket", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const question = (await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Which one?" })).body.activity;
    await admin.post("/api/tickets/CRONK-1/comments", { body: "The first.", replyToActivityId: question.id });
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Or the second.", replyToActivityId: question.id });

    const waiting = (await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork;
    expect(waiting.map((w: { reason: string }) => w.reason)).toEqual(["answer", "comment"]);
  });
});

describe("Taking waiting work", () => {
  it("is left to a full token: a read-only token's welcome lists the work but leaves it waiting", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const readOnly = (await admin.post(`/api/agents/${claude.agentId}/tokens`, { readOnly: true })).body.secret;
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Please also update the docs." });

    expect((await cronk.client(readOnly).post("/api/agent-sessions")).body.welcome.waitingWork).toHaveLength(1);
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toHaveLength(1);
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toEqual([]);
  });

  it("leaves work the Agent can't see right now waiting until it can again", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Please also update the docs." });
    await admin.patch("/api/projects/CRONK", { agentAccess: "none" });
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toEqual([]);

    await admin.patch("/api/projects/CRONK", { agentAccess: "write" });
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toHaveLength(1);
  });
});

describe("An Agent Session's live updates", () => {
  it("push work as it starts waiting for the Agent, to each of its connected Sessions, and only its own", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const codex = await startSession(cronk, (await registerAgent(admin, "codex")).secret);
    const first = await (await session()).events("/api/agent-sessions/current/events");
    const second = await (await session()).events("/api/agent-sessions/current/events");
    const other = await codex.events("/api/agent-sessions/current/events");
    for (const stream of [first, second, other]) expect((await stream.next())?.event).toBe("ready");

    const posted = (await admin.post("/api/tickets/CRONK-1/comments", { body: "Please also update the docs." })).body.comment;

    const pushed = { event: "waiting", id: expect.stringMatching(/^\d+$/), data: { waiting: { reason: "comment", comment: posted, ticket: { key: "CRONK-1", title: "Ticket 1" }, document: null, artifact: null } } };
    expect(await first.next()).toEqual(pushed);
    expect(await second.next()).toEqual(pushed);
    await admin.post("/api/tickets/CRONK-1/comments", { body: "@codex too" });
    expect((await other.next())?.data.waiting.comment.body).toBe("@codex too");
  });

  it("replay the work that started waiting while the stream was closed, before `ready`, when reopened from the last event's id", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    const stream = await agent.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Seen live." });
    const live = await stream.next();
    stream.close();

    const missed = (await admin.post("/api/tickets/CRONK-1/comments", { body: "Missed." })).body.comment;
    const reopened = await agent.events("/api/agent-sessions/current/events", { "last-event-id": live!.id! });

    const replayed = await reopened.next();
    expect(replayed).toMatchObject({ event: "waiting", data: { waiting: { reason: "comment", comment: missed, ticket: { key: "CRONK-1" } } } });
    expect(replayed?.id).toEqual(expect.any(String));
    expect((await reopened.next())?.event).toBe("ready");
  });

  it("replay, from `ready`'s id, what was missed by a stream that never got an event, but not what a welcome has since taken", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    const stream = await agent.events("/api/agent-sessions/current/events");
    const ready = await stream.next();
    stream.close();

    await admin.post("/api/tickets/CRONK-1/comments", { body: "Taken by a welcome." });
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).body.welcome.waitingWork).toHaveLength(1);
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Still waiting." });
    const reopened = await agent.events("/api/agent-sessions/current/events", { "last-event-id": ready!.id! });

    expect((await reopened.next())?.data.waiting.comment.body).toBe("Still waiting.");
    expect((await reopened.next())?.event).toBe("ready");
  });

  it("replay, from the furthest id seen, work whose post committed after a later post for the same Agent was pushed", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const codex = await registerAgent(admin, "codex");
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Design" })).body.document;
    const agent = await session();
    const stream = await agent.events("/api/agent-sessions/current/events");
    const seen = [(await stream.next())!];

    // The first post starts waiting for claude, then is held before it can wait for codex.
    const held = await cronk.holdRow("agents", codex.agentId);
    const first = admin.post(`/api/documents/${doc.id}/comments`, { body: "@claude-laptop @codex, first." });
    await held.waiters(1);
    const second = admin.post("/api/tickets/CRONK-1/comments", { body: "Second." });
    // The second post waits for the first to commit; if it overtook it instead, its event is the furthest id seen.
    if ((await Promise.race([second.then(() => "posted"), held.waiters(2)])) === "posted") seen.push((await stream.next())!);
    stream.close();
    await held.release();
    await Promise.all([first, second]);

    const reopened = await agent.events("/api/agent-sessions/current/events", { "last-event-id": seen.at(-1)!.id! });
    for (let event = await reopened.next(); event?.event === "waiting"; event = await reopened.next()) seen.push(event);
    expect(seen.filter((e) => e.event === "waiting").map((e) => e.data.waiting.comment.body).sort()).toEqual(["@claude-laptop @codex, first.", "Second."]);
  });

  it("replay, from `ready`'s id, work whose post was still uncommitted when the stream opened", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const codex = await registerAgent(admin, "codex");
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Design" })).body.document;
    const agent = await session();

    const held = await cronk.holdRow("agents", codex.agentId);
    const first = admin.post(`/api/documents/${doc.id}/comments`, { body: "@claude-laptop @codex, first." });
    await held.waiters(1);
    const second = admin.post("/api/tickets/CRONK-1/comments", { body: "Second." });
    await Promise.race([second, held.waiters(2)]);
    const stream = await agent.events("/api/agent-sessions/current/events");
    const ready = await stream.next();
    stream.close();
    await held.release();
    await Promise.all([first, second]);

    const reopened = await agent.events("/api/agent-sessions/current/events", { "last-event-id": ready!.id! });
    const replayed = [];
    for (let event = await reopened.next(); event?.event === "waiting"; event = await reopened.next()) replayed.push(event.data.waiting.comment.body);
    expect(replayed.sort()).toEqual(["@claude-laptop @codex, first.", "Second."]);
  });

  it("send, before `ready`, work pushed while a reopened stream was still catching up, and replay what follows from `ready`'s id", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const doc = (await admin.post("/api/workspace/documents", { title: "Notes" })).body.document;
    const agent = await session();
    const first = await agent.events("/api/agent-sessions/current/events");
    const opened = await first.next();
    first.close();
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Missed." });

    // Checking whether the Agent may still see the missed work's Project waits, so the catch-up stalls there.
    const held = await cronk.holdTable("project_members");
    const reopening = agent.events("/api/agent-sessions/current/events", { "last-event-id": opened!.id! });
    await held.waiters(1);
    // Meanwhile a post on a Workspace Document, which doesn't wait, commits and is pushed.
    expect((await admin.post(`/api/documents/${doc.id}/comments`, { body: "@claude-laptop, during the catch-up." })).status).toBe(201);
    await held.release();
    const reopened = await reopening;

    const sent = [];
    for (let event = await reopened.next(); event; event = await reopened.next()) {
      sent.push(event);
      if (event.event === "ready") break;
    }
    expect(sent.map((e) => e.data.waiting?.comment.body ?? e.event)).toEqual(["Missed.", "@claude-laptop, during the catch-up.", "ready"]);
    reopened.close();

    await admin.post("/api/tickets/CRONK-1/comments", { body: "After ready." });
    const again = await agent.events("/api/agent-sessions/current/events", { "last-event-id": sent.at(-1)!.id! });
    expect((await again.next())?.data.waiting.comment.body).toBe("After ready.");
    expect((await again.next())?.event).toBe("ready");
  });

  it("replay, from `ready`'s id, work whose post committed before the stream opened but was pushed only after `ready`", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const agent = await session();

    const held = cronk.holdPushes();
    expect((await admin.post("/api/tickets/CRONK-1/comments", { body: "Committed, not yet pushed." })).status).toBe(201);
    const stream = await agent.events("/api/agent-sessions/current/events");
    const ready = await stream.next();
    expect(ready?.event).toBe("ready");
    stream.close();
    held.release();

    const reopened = await agent.events("/api/agent-sessions/current/events", { "last-event-id": ready!.id! });
    expect((await reopened.next())?.data.waiting?.comment.body).toBe("Committed, not yet pushed.");
    expect((await reopened.next())?.event).toBe("ready");
  });

  it("don't hold `ready`'s id back for work whose post rolled back", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const codex = await registerAgent(admin, "codex");
    const agent = await session();

    // The post takes claude-laptop's position, then waits to take codex's, and fails there.
    const held = await cronk.holdRow("agents", codex.agentId);
    const failing = admin.post("/api/tickets/CRONK-1/comments", { body: "@claude-laptop @codex, rolled back." });
    await held.waiters(1);
    // Fails the post's waiting query as on a database blip; the table named is incidental, as nothing else waits.
    await cronk.interruptQueriesOn("schema_migrations", async () => {});
    expect((await failing).status).toBe(500);
    await held.release();
    expect((await admin.post("/api/tickets/CRONK-1/comments", { body: "Later." })).status).toBe(201);

    const stream = await agent.events("/api/agent-sessions/current/events");
    const ready = await stream.next();
    stream.close();
    const reopened = await agent.events("/api/agent-sessions/current/events", { "last-event-id": ready!.id! });
    expect((await reopened.next())?.event).toBe("ready");
  });

  it("push work for one Agent while a post for another Agent is still uncommitted", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const codex = await registerAgent(admin, "codex");
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Design" })).body.document;
    const stream = await (await session()).events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");

    const held = await cronk.holdRow("agents", codex.agentId);
    const forCodex = admin.post(`/api/documents/${doc.id}/comments`, { body: "@codex, held." });
    await held.waiters(1);
    expect((await admin.post("/api/tickets/CRONK-1/comments", { body: "Not held." })).status).toBe(201);
    expect((await stream.next())?.data.waiting.comment.body).toBe("Not held.");
    await held.release();
    expect((await forCodex).status).toBe(201);
  });

  it("push work for Agents that two concurrent posts name in opposite orders", async () => {
    const { cronk, admin } = await delegatedSetup();
    const codex = await registerAgent(admin, "codex");
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Design" })).body.document;

    const held = await cronk.holdRow("agents", codex.agentId);
    // The first post starts waiting for codex and is held there; the second then starts waiting for claude.
    const first = admin.post(`/api/documents/${doc.id}/comments`, { body: "@codex @claude-laptop, first." });
    await held.waiters(1);
    const second = admin.post(`/api/documents/${doc.id}/comments`, { body: "@claude-laptop @codex, second." });
    await held.waiters(2);
    await held.release();

    expect((await first).status).toBe(201);
    expect((await second).status).toBe(201);
    expect((await mentionedIn(cronk, codex)).sort()).toEqual(["@claude-laptop @codex, second.", "@codex @claude-laptop, first."]);
  });

  it("replay none of an Agent's work to another Agent", async () => {
    const { cronk, admin } = await delegatedSetup();
    const codex = await startSession(cronk, (await registerAgent(admin, "codex")).secret);
    await admin.post("/api/tickets/CRONK-1/comments", { body: "For claude only." });

    const others = await codex.events("/api/agent-sessions/current/events", { "last-event-id": "0" });
    expect((await others.next())?.event).toBe("ready");
  });

  it("replay nothing once the Agent's token is revoked or its Session has ended", async () => {
    const { admin, claude, session } = await delegatedSetup();
    const ended = await session();
    const ready = await (await ended.events("/api/agent-sessions/current/events")).next();
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Missed." });

    await ended.delete("/api/agent-sessions/current");
    expect((await ended.events("/api/agent-sessions/current/events", { "last-event-id": ready!.id! })).status).toBe(410);
    const revoked = await session();
    await admin.delete(`/api/agents/${claude.agentId}/tokens/${claude.tokenId}`);
    expect((await revoked.events("/api/agent-sessions/current/events", { "last-event-id": ready!.id! })).status).toBe(401);
  });

  it("are refused outside an Agent Session, and end once the Session does", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    expect((await admin.events("/api/agent-sessions/current/events")).status).toBe(400);
    expect((await cronk.client(claude.secret).events("/api/agent-sessions/current/events")).status).toBe(400);

    const agent = await session();
    const stream = await agent.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");
    await agent.delete("/api/agent-sessions/current");
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Anyone there?" });
    expect(await stream.next()).toBeNull();
  });
});
