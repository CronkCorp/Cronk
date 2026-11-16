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
