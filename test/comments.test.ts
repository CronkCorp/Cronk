import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs } from "./harness.js";

describe("Comments on a Ticket", () => {
  it("are posted by Users and Agents and listed oldest first, with replies naming the Comment they answer", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();

    const posted = await admin.post("/api/tickets/CRONK-1/comments", { body: "What about **caching**?" });
    expect(posted.status).toBe(201);
    cronk.clock.advance(60_000);
    const reply = await agent.post("/api/tickets/CRONK-1/comments", { body: "Caching is out of scope.", replyToCommentId: posted.body.comment.id });
    expect(reply.status).toBe(201);

    const listed = await admin.get("/api/tickets/CRONK-1/comments");
    expect(listed.status).toBe(200);
    expect(listed.body.comments).toMatchObject([
      {
        id: posted.body.comment.id,
        ticketKey: "CRONK-1",
        documentId: null,
        body: "What about **caching**?",
        replyToCommentId: null,
        replyToActivityId: null,
        at: "2026-01-01T09:00:00.000Z",
        actor: { kind: "user", name: "Ada" },
      },
      {
        body: "Caching is out of scope.",
        replyToCommentId: posted.body.comment.id,
        at: "2026-01-01T09:01:00.000Z",
        actor: { kind: "agent", id: claude.agentId, name: "claude-laptop", owner: { name: "Ada" }, session: { id: agent.sessionId } },
      },
    ]);
    expect(listed.body.comments[0]).toEqual(posted.body.comment);
  });
});

describe("Posting a Comment", () => {
  it("needs Write where it is posted, and is listed only to those who can see it", async () => {
    const { cronk, admin, claude } = await delegatedSetup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await admin.get("/api/users")).body.users.find((u: { name: string }) => u.name === "bob").id;
    await admin.put(`/api/projects/CRONK/members/${bobId}`, { access: "read" });
    const readOnly = cronk.client((await admin.post(`/api/agents/${claude.agentId}/tokens`, { readOnly: true })).body.secret);

    expect((await bob.post("/api/tickets/CRONK-1/comments", { body: "Hi" })).status).toBe(403);
    expect((await readOnly.post("/api/tickets/CRONK-1/comments", { body: "Hi" })).status).toBe(403);
    expect((await bob.get("/api/tickets/CRONK-1/comments")).status).toBe(200);

    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    await admin.delete(`/api/projects/CRONK/members/${bobId}`);
    expect((await bob.get("/api/tickets/CRONK-1/comments")).status).toBe(404);
    expect((await bob.post("/api/tickets/CRONK-1/comments", { body: "Hi" })).status).toBe(404);
  });

  it("refuses a blank body, and a reply to a Comment that isn't on the same Ticket", async () => {
    const { admin } = await delegatedSetup(2);
    const elsewhere = await admin.post("/api/tickets/CRONK-2/comments", { body: "On the other Ticket" });

    expect((await admin.post("/api/tickets/CRONK-1/comments", { body: "  " })).status).toBe(400);
    const refused = await admin.post("/api/tickets/CRONK-1/comments", { body: "Reply", replyToCommentId: elsewhere.body.comment.id });
    expect(refused.status).toBe(400);
    expect((await admin.get("/api/tickets/CRONK-1/comments")).body.comments).toEqual([]);
  });
});

describe("Replying to an Activity", () => {
  it("answers a question, which is marked answered by the first reply from anyone but the Agent that asked", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const question = (await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Postgres or SQLite?", blocking: true })).body.activity;
    const plan = (await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Write the schema" })).body.activity;

    await agent.post("/api/tickets/CRONK-1/comments", { body: "Still waiting on this.", replyToActivityId: question.id });
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Good plan.", replyToActivityId: plan.id });
    expect((await admin.get("/api/tickets/CRONK-1/activities")).body.activities.map((a: { answer: unknown }) => a.answer)).toEqual([null, null]);

    cronk.clock.advance(60_000);
    const answer = await admin.post("/api/tickets/CRONK-1/comments", { body: "Postgres.", replyToActivityId: question.id });
    expect(answer.status).toBe(201);
    expect(answer.body.comment.replyToActivityId).toBe(question.id);
    cronk.clock.advance(60_000);
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Version 17, to be exact.", replyToActivityId: question.id });

    const [asked, planned] = (await admin.get("/api/tickets/CRONK-1/activities")).body.activities;
    expect(asked.answer).toEqual({ commentId: answer.body.comment.id, at: "2026-01-01T09:01:00.000Z" });
    expect(planned.answer).toBeNull();
  });

  it("is refused for an Activity on another Ticket", async () => {
    const { admin, session } = await delegatedSetup(2);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-2/claim");
    const question = (await agent.post("/api/tickets/CRONK-2/activities", { kind: "question", body: "Which one?" })).body.activity;

    const refused = await admin.post("/api/tickets/CRONK-1/comments", { body: "This one.", replyToActivityId: question.id });
    expect(refused.status).toBe(400);
    expect((await admin.get("/api/tickets/CRONK-2/activities")).body.activities[0].answer).toBeNull();
  });
});
