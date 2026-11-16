import { describe, expect, it } from "vitest";
import { delegatedSetup, registerAgent, startSession, type Client } from "./harness.js";

/** A chat in the turn convention, as a client's hook converts it, in which the Agent saw `sessionIds` in its tool results. */
const chat = (ask: string, ...sessionIds: string[]) =>
  `## User\n\n${ask}\n\n## Assistant\n\n${sessionIds.map((id) => "```tool-result\nAgent Session " + id + "\nOK\n```\n").join("\n")}\nDone.\n`;

/** Uploads `markdown` as the chat `chatId` with the Agent token `client` holds, as a client's hook does. */
const upload = (client: Client, chatId: string, markdown: string) =>
  client.upload(`/api/transcripts/by-chat/${encodeURIComponent(chatId)}`, Buffer.from(markdown), "text/markdown", "PUT");

describe("Uploading a Transcript", () => {
  it("links the uploading Agent's Sessions it names and what they changed, for the Owner to read", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Read the code" });
    const hook = cronk.client(claude.secret);

    const uploaded = await upload(hook, "chat-1", chat("Fix CRONK-1", agent.sessionId));
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const id = uploaded.body.transcript.id;

    const read = await admin.get(`/api/transcripts/${id}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.transcript).toMatchObject({
      id,
      chatId: "chat-1",
      agent: { id: claude.agentId, name: "claude-laptop" },
      markdown: chat("Fix CRONK-1", agent.sessionId),
      earlier: [],
      sessions: [{ id: agent.sessionId }],
      tickets: [{ key: "CRONK-1", title: "Ticket 1" }],
      documents: [],
    });
  });

  it("refuses a chat naming none of the uploading Agent's Sessions that changed anything", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const idle = await session();
    const hook = cronk.client(claude.secret);
    // Another Agent's Session that changed something doesn't count for this one.
    const other = await registerAgent(admin, "codex");
    await admin.patch("/api/tickets/CRONK-1", { delegateId: other.agentId });
    const codex = await startSession(cronk, other.secret);
    expect((await codex.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    await codex.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Mine" });

    for (const markdown of [chat("Hello"), chat("Hello", idle.sessionId), chat("Hello", codex.sessionId)]) {
      const refused = await upload(hook, "chat-1", markdown);
      expect(refused.status, markdown).toBe(422);
      expect(refused.body.error).toMatch(/changed anything/);
    }
    expect((await upload(cronk.client(other.secret), "chat-1", chat("Hello", codex.sessionId))).status).toBe(201);
  });

  it("takes only an Agent's token that isn't read-only", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const owner = (await admin.get("/api/agents")).body.agents[0];
    const readOnly = await admin.post(`/api/agents/${owner.id}/tokens`, { readOnly: true });
    const markdown = chat("Hi", agent.sessionId);

    const byReadOnly = await upload(cronk.client(readOnly.body.secret), "chat-1", markdown);
    expect(byReadOnly.status).toBe(403);
    expect(byReadOnly.body.error).toMatch(/read-only/);
    const byUser = await upload(admin, "chat-1", markdown);
    expect(byUser.status).toBe(403);
    expect(byUser.body.error).toMatch(/Only an Agent/);
  });
});

describe("Uploading the same chat again", () => {
  it("replaces the text when the new one continues it, and adds the Sessions it names", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup(2);
    const first = await session();
    await first.post("/api/tickets/CRONK-1/claim");
    await first.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "One" });
    const hook = cronk.client(claude.secret);
    const before = chat("Fix CRONK-1", first.sessionId);
    const created = await upload(hook, "chat-1", before);
    expect(created.status).toBe(201);

    cronk.clock.advance(60_000);
    const second = await session();
    await second.post("/api/tickets/CRONK-2/claim");
    await second.post("/api/tickets/CRONK-2/comments", { body: "On it" });
    // The client converts the whole chat again; only the new turns name the second Session.
    const after = `${before}\n## User\n\nNow CRONK-2\n\n## Assistant\n\nAgent Session ${second.sessionId}\n`;
    const replaced = await upload(hook, "chat-1", after);
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body.transcript.id).toBe(created.body.transcript.id);

    const read = (await admin.get(`/api/transcripts/${created.body.transcript.id}`)).body.transcript;
    expect(read).toMatchObject({ markdown: after, earlier: [], sessions: [{ id: first.sessionId }, { id: second.sessionId }] });
    expect(read.tickets.map((t: { key: string }) => t.key)).toEqual(["CRONK-1", "CRONK-2"]);
  });

  it("keeps the old text as well when the new one doesn't continue it, and never shrinks to an older upload", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "One" });
    const hook = cronk.client(claude.secret);
    const long = chat("Fix CRONK-1", agent.sessionId) + "\n## User\n\nThanks\n";
    const id = (await upload(hook, "chat-1", long)).body.transcript.id;

    // An upload the stored text already continues, as a late retry of an older one, changes nothing.
    expect((await upload(hook, "chat-1", chat("Fix CRONK-1", agent.sessionId))).status).toBe(200);
    expect((await admin.get(`/api/transcripts/${id}`)).body.transcript).toMatchObject({ markdown: long, earlier: [] });

    // A rewritten chat, as after the client compacted it, no longer starts with the stored text.
    const compacted = `## User\n\nSummary of the chat so far\n\n## Assistant\n\nOK\n`;
    const kept = await upload(hook, "chat-1", compacted);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect((await admin.get(`/api/transcripts/${id}`)).body.transcript).toMatchObject({
      markdown: compacted,
      earlier: [long],
      sessions: [{ id: agent.sessionId }],
      tickets: [{ key: "CRONK-1" }],
    });
  });

  it("keeps one Transcript per Agent and chat id", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "One" });
    const hook = cronk.client(claude.secret);
    const one = await upload(hook, "chat-1", chat("A", agent.sessionId));
    const two = await upload(hook, "chat/2 with spaces", chat("B", agent.sessionId));
    expect([one.status, two.status]).toEqual([201, 201]);
    expect(two.body.transcript).toMatchObject({ chatId: "chat/2 with spaces" });
    expect(two.body.transcript.id).not.toBe(one.body.transcript.id);
    expect((await admin.get(`/api/transcripts/${one.body.transcript.id}`)).body.transcript.markdown).toBe(chat("A", agent.sessionId));
  });
});
