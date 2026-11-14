import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, registerAgent, startSession, type Cronk } from "./harness.js";

describe("Work waiting for an Agent", () => {
  it("includes a Comment on a Ticket delegated to it, in the welcome of its next Agent Session only", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const posted = (await admin.post("/api/tickets/CRONK-1/comments", { body: "Please also update the docs." })).body.comment;

    const welcomed = await cronk.client(claude.secret).post("/api/agent-sessions");
    expect(welcomed.body.welcome.waitingWork).toEqual([
      { reason: "comment", comment: posted, ticket: { key: "CRONK-1", title: "Ticket 1" }, document: null },
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
  it("wakes the writer's own Agent of that name, ignoring case, and not other Owners' Agents of that name", async () => {
    const { cronk, admin } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const codex = await registerAgent(admin, "Codex");
    const bobsCodex = await registerAgent(bob, "codex");
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Design" })).body.document;

    const posted = (await admin.post(`/api/documents/${doc.id}/comments`, { body: "@codex, can you check this? cc @nobody, mail@codex.dev" })).body.comment;

    expect(await waitingWork(cronk, codex)).toEqual([{ reason: "mention", comment: posted, ticket: null, document: { id: doc.id, title: "Design" } }]);
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
      { reason: "answer", comment: answer, ticket: { key: "CRONK-1", title: "Ticket 1" }, document: null },
    ]);
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

    const pushed = { event: "waiting", data: { waiting: { reason: "comment", comment: posted, ticket: { key: "CRONK-1", title: "Ticket 1" }, document: null } } };
    expect(await first.next()).toEqual(pushed);
    expect(await second.next()).toEqual(pushed);
    await admin.post("/api/tickets/CRONK-1/comments", { body: "@codex too" });
    expect((await other.next())?.data.waiting.comment.body).toBe("@codex too");
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
