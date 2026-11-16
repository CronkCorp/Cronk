import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, projectWithTickets, registerAgent, startInstalledCronk, startSession, type Client } from "./harness.js";

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

/**
 * Bob's Agent changes CRONK-1 (an open Project), SECRET-1 (private, where Bob has Write) and a Workspace Document, and
 * uploads the chat. Carol is another Member; Ada the Admin.
 */
async function transcriptAcrossProjects() {
  const { cronk, admin } = await startInstalledCronk();
  const bob = await joinAs(cronk, admin, "bob@example.com");
  const carol = await joinAs(cronk, admin, "carol@example.com");
  const bobId = (await bob.get("/api/me")).body.user.id;
  const carolId = (await carol.get("/api/me")).body.user.id;
  await projectWithTickets(admin, "CRONK", 1);
  await projectWithTickets(admin, "SECRET", 1);
  await admin.patch("/api/projects/SECRET", { visibility: "private" });
  await admin.put(`/api/projects/SECRET/members/${bobId}`, { access: "write" });
  const claude = await registerAgent(bob, "claude-laptop");
  for (const key of ["CRONK-1", "SECRET-1"]) await admin.patch(`/api/tickets/${key}`, { assigneeId: bobId, delegateId: claude.agentId });
  const agent = await startSession(cronk, claude.secret);
  for (const key of ["CRONK-1", "SECRET-1"]) {
    await agent.post(`/api/tickets/${key}/claim`);
    await agent.post(`/api/tickets/${key}/activities`, { kind: "progress", body: `Working on ${key}` });
  }
  const handbook = (await agent.post("/api/workspace/documents", { title: "Handbook", body: "Welcome" })).body.document.id;
  const uploaded = await upload(cronk.client(claude.secret), "chat-1", chat("Do it all", agent.sessionId));
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  return { cronk, admin, bob, carol, bobId, carolId, claude, handbook, id: uploaded.body.transcript.id as string };
}

describe("Who may read a Transcript", () => {
  it("is its Owner, and whoever has Read everywhere its Sessions changed things", async () => {
    const { cronk, admin, bob, carol, carolId, handbook, id } = await transcriptAcrossProjects();
    const items = { tickets: [{ key: "CRONK-1" }, { key: "SECRET-1" }], documents: [{ id: handbook, title: "Handbook" }] };
    expect((await bob.get(`/api/transcripts/${id}`)).body.transcript).toMatchObject(items);
    expect((await admin.get(`/api/transcripts/${id}`)).body.transcript).toMatchObject(items);
    expect((await carol.get(`/api/transcripts/${id}`)).status).toBe(404);

    await admin.put(`/api/projects/SECRET/members/${carolId}`, { access: "read" });
    expect((await carol.get(`/api/transcripts/${id}`)).status).toBe(200);

    // Carol's Agent is capped as usual: by the Workspace's Agent Access for the Handbook.
    const codex = await registerAgent(carol, "codex");
    expect((await cronk.client(codex.secret).get(`/api/transcripts/${id}`)).status).toBe(200);
    await admin.patch("/api/workspace", { agentAccess: "none" });
    expect((await cronk.client(codex.secret).get(`/api/transcripts/${id}`)).status).toBe(404);
  });

  it("lets its Owner read it without Read where its Sessions changed things, leaving out what they can't read", async () => {
    const { admin, bob, bobId, id } = await transcriptAcrossProjects();
    await admin.delete(`/api/projects/SECRET/members/${bobId}`);
    const read = await bob.get(`/api/transcripts/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.transcript.tickets).toEqual([{ key: "CRONK-1", title: "Ticket 1" }]);
  });

  it("outlives its Agent's removal", async () => {
    const { bob, claude, id } = await transcriptAcrossProjects();
    expect((await bob.delete(`/api/agents/${claude.agentId}`)).status).toBe(204);
    expect((await bob.get(`/api/transcripts/${id}`)).body.transcript).toMatchObject({ agent: { id: claude.agentId, name: "claude-laptop" } });
  });
});

describe("Deleting a Transcript", () => {
  it("is for its Owner only", async () => {
    const { cronk, admin, bob, carol, claude, id } = await transcriptAcrossProjects();
    expect((await carol.delete(`/api/transcripts/${id}`)).status).toBe(404);
    const byAdmin = await admin.delete(`/api/transcripts/${id}`);
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error).toMatch(/Owner/);
    expect((await (await startSession(cronk, claude.secret)).delete(`/api/transcripts/${id}`)).status).toBe(403);

    expect((await bob.delete(`/api/transcripts/${id}`)).status).toBe(204);
    expect((await bob.get(`/api/transcripts/${id}`)).status).toBe(404);
  });
});


describe("The Transcript size limit", () => {
  it("is 10 MB unless an Admin changes it, counting every text the Transcript keeps", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    expect((await admin.get("/api/workspace")).body.transcriptMaxBytes).toBe(10 * 1024 * 1024);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "One" });
    const hook = cronk.client(claude.secret);

    const changed = await admin.patch("/api/workspace", { transcriptMaxBytes: 2000 });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.transcriptMaxBytes).toBe(2000);

    const big = chat("x".repeat(2000), agent.sessionId);
    const refused = await upload(hook, "chat-1", big);
    expect(refused.status).toBe(413);
    expect(refused.body.error).toMatch(/2000/);

    // 1200 bytes fit; a rewrite of as many more doesn't, since the old text is kept beside it.
    const first = chat("a".repeat(1100), agent.sessionId);
    expect((await upload(hook, "chat-1", first)).status).toBe(201);
    expect((await upload(hook, "chat-1", chat("b".repeat(1100), agent.sessionId))).status).toBe(413);
    expect((await upload(hook, "chat-1", first + "c".repeat(500))).status).toBe(200);
  });

  it("is set by Admins only, within bounds", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.patch("/api/workspace", { transcriptMaxBytes: 5000 })).status).toBe(403);
    expect((await admin.patch("/api/workspace", { transcriptMaxBytes: 0 })).status).toBe(400);
    expect((await admin.patch("/api/workspace", { transcriptMaxBytes: 101 * 1024 * 1024 })).status).toBe(400);
  });
});
