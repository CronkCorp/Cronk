import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { delegatedSetup, joinAs, projectWithTickets, registerAgent, startInstalledCronk, startSession, tarGz, untarGz, type Client } from "./harness.js";

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
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
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

  it("links the Terms its Sessions saved, which alone are enough to keep it", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    const term = await agent.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." });
    expect(term.status, JSON.stringify(term.body)).toBe(201);

    const uploaded = await upload(cronk.client(claude.secret), "chat-1", chat("Define Ticket", agent.sessionId));
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    const read = (await admin.get(`/api/transcripts/${uploaded.body.transcript.id}`)).body.transcript;
    expect(read).toMatchObject({ tickets: [], documents: [], terms: [{ id: term.body.term.id, name: "Ticket" }] });
  });

  it("links the Decisions its Sessions proposed or refined, which alone are enough to keep it", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    expect((await agent.post("/api/workspace/decisions", { title: "Compose for installs" })).status).toBe(201);
    await agent.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions" });
    const refiner = await session();
    await refiner.patch("/api/decisions/CRONK-D1", { baseVersion: 1, body: "Refined." });

    const uploaded = await upload(cronk.client(claude.secret), "chat-1", chat("Record what we chose", agent.sessionId));
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    const read = (await admin.get(`/api/transcripts/${uploaded.body.transcript.id}`)).body.transcript;
    expect(read).toMatchObject({ tickets: [], documents: [], terms: [], decisions: [{ key: "D1", title: "Compose for installs" }, { key: "CRONK-D1", title: "Markdown for Decisions" }] });
    const refined = await upload(cronk.client(claude.secret), "chat-2", chat("Refine it", refiner.sessionId));
    expect(refined.status, JSON.stringify(refined.body)).toBe(200);
    expect((await admin.get(`/api/transcripts/${refined.body.transcript.id}`)).body.transcript.decisions).toEqual([{ key: "CRONK-D1", title: "Markdown for Decisions", turn: null }]);
  });

  it("links the Ticket its Sessions attached a file to, which alone is enough to keep it", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const attached = await agent.upload("/api/tickets/CRONK-1/attachments?name=log.txt", Buffer.from("boom"), "text/plain");
    expect(attached.status, JSON.stringify(attached.body)).toBe(201);

    const uploaded = await upload(cronk.client(claude.secret), "chat-1", chat("Attach the log", agent.sessionId));
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    expect((await admin.get(`/api/transcripts/${uploaded.body.transcript.id}`)).body.transcript.tickets).toEqual([{ key: "CRONK-1", title: "Ticket 1", turn: null }]);
  });

  it("links the Artifact its Session published, which alone is enough to keep it", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    const published = await agent.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz({ "index.html": "<h1>Limits</h1>" }));
    expect(published.status, JSON.stringify(published.body)).toBe(201);

    const uploaded = await upload(cronk.client(claude.secret), "chat-1", chat("Publish the limits", agent.sessionId));
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    const read = (await admin.get(`/api/transcripts/${uploaded.body.transcript.id}`)).body.transcript;
    expect(read).toMatchObject({ tickets: [], documents: [], artifacts: [{ id: published.body.artifact.id, title: "Limits" }] });
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
    expect((await upload(cronk.client(other.secret), "chat-1", chat("Hello", codex.sessionId))).status).toBe(200);
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

/** Sample secrets of each kind Cronk scrubs, made up but shaped like the real thing, with what each becomes. */
const SECRETS = {
  github: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  githubPat: "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRS",
  gitlab: "glpat-" + "aB3dE5fG7hI9jK1lM3nO",
  anthropic: "sk-ant-api03-" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv",
  openai: "sk-proj-" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv",
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  slack: "xoxb-" + "1234567890-0987654321-AbCdEfGhIjKlMnOp",
  stripe: "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  google: "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
  npm: "npm_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  jwt: "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
};

/** A chat in which the Agent saw, and repeated, secrets of every kind, as well as an Agent token of Cronk's own. */
const leakyChat = (cronkToken: string, sessionId: string) =>
  chat("Fix CRONK-1", sessionId) +
  "\n## User\n\nHere are the keys:\n\n" +
  Object.values(SECRETS).map((secret) => `- ${secret}\n`).join("") +
  `- Cronk: ${cronkToken}\n\n` +
  "```sh\ncurl -H \"Authorization: Bearer abc.def-123\" -H 'authorization: Basic dXNlcjpwYXNz' $CRONK/api/me\n```\n\n" +
  "```json\n{ \"Authorization\": \"token s3cr3t-v4lue\" }\n```\n\n" +
  "```\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAMwAAAAtzc2gtZWQyNTUxOQ\n-----END OPENSSH PRIVATE KEY-----\n```\n";

describe("Scrubbing secrets on upload", () => {
  it("replaces every known secret pattern before the text is stored, so no reader sees one", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Read the code" });

    const uploaded = await upload(cronk.client(claude.secret), "chat-1", leakyChat(claude.secret, agent.sessionId));
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    const read = (await admin.get(`/api/transcripts/${uploaded.body.transcript.id}`)).body.transcript;

    for (const secret of [...Object.values(SECRETS), claude.secret, "abc.def-123", "dXNlcjpwYXNz", "s3cr3t-v4lue", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"]) {
      expect(read.markdown).not.toContain(secret);
      expect(uploaded.body.transcript.markdown).not.toContain(secret);
    }
    // What each was stays readable, and so do the Agent Session ids that link it.
    expect(read.markdown).toContain("- [scrubbed: GitHub token]\n");
    expect(read.markdown).toContain("- [scrubbed: AWS access key]\n");
    expect(read.markdown).toContain("- Cronk: [scrubbed: token]\n");
    expect(read.markdown).toContain(`curl -H "Authorization: Bearer [scrubbed]" -H 'authorization: Basic [scrubbed]' $CRONK/api/me`);
    expect(read.markdown).toContain('{ "Authorization": "token [scrubbed]" }');
    expect(read.markdown).toContain("```\n[scrubbed: private key]\n```");
    expect(read.markdown).toContain(chat("Fix CRONK-1", agent.sessionId));
    expect(read.sessions).toEqual([{ id: agent.sessionId }]);
  });

  it("scrubs the same text the same way every time, so a re-upload still continues the stored text", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Read the code" });
    const hook = cronk.client(claude.secret);
    const before = leakyChat(claude.secret, agent.sessionId);
    const id = (await upload(hook, "chat-1", before)).body.transcript.id;
    const first = (await admin.get(`/api/transcripts/${id}`)).body.transcript.markdown;

    const after = `${before}\n## Assistant\n\nRotate ${SECRETS.github} now.\n`;
    expect((await upload(hook, "chat-1", after)).status).toBe(200);
    const read = (await admin.get(`/api/transcripts/${id}`)).body.transcript;
    expect(read.earlier).toEqual([]);
    expect(read.markdown).toBe(`${first}\n## Assistant\n\nRotate [scrubbed: GitHub token] now.\n`);
  });

  it("leaves shell variables, bare schemes and what it already scrubbed as they are", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Read the code" });
    const untouched =
      chat("Fix CRONK-1", agent.sessionId) +
      '\ncurl -H "Authorization: Bearer $TOKEN" -H "Authorization: Basic ${CREDS}"\n' +
      "Authorization: Bearer [scrubbed]\n{ \"authorization\": \"Bearer [scrubbed]\" }\nSend Authorization: Bearer\nthen the token.\n";
    const uploaded = await upload(cronk.client(claude.secret), "chat-1", untouched);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    expect((await admin.get(`/api/transcripts/${uploaded.body.transcript.id}`)).body.transcript.markdown).toBe(untouched);
  });

  it("counts the scrubbed text against the Workspace's limit", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Read the code" });
    await admin.patch("/api/workspace", { transcriptMaxBytes: 1024 });
    // Over the limit as sent: refused before anything is read, even though the scrubbed text would fit.
    const key = "-----BEGIN RSA PRIVATE KEY-----\n" + "A".repeat(2000) + "\n-----END RSA PRIVATE KEY-----\n";
    expect((await upload(cronk.client(claude.secret), "chat-1", chat("Hi", agent.sessionId) + key)).status).toBe(413);
    const small = chat("Hi", agent.sessionId) + "-----BEGIN RSA PRIVATE KEY-----\n" + "A".repeat(500) + "\n-----END RSA PRIVATE KEY-----\n";
    const kept = await upload(cronk.client(claude.secret), "chat-1", small);
    expect(kept.status).toBe(200);
    // A rewrite keeps both texts, which only fit together because the keys in them are scrubbed.
    const rewrite = chat("Again", agent.sessionId) + "-----BEGIN RSA PRIVATE KEY-----\n" + "B".repeat(500) + "\n-----END RSA PRIVATE KEY-----\n";
    expect((await upload(cronk.client(claude.secret), "chat-1", rewrite)).status).toBe(200);
    expect((await admin.get(`/api/transcripts/${kept.body.transcript.id}`)).body.transcript.earlier).toHaveLength(1);
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
    expect(created.status).toBe(200);

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

  it("changes nothing for a late retry of a text it already keeps", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "One" });
    const hook = cronk.client(claude.secret);
    const first = chat("First", agent.sessionId);
    const rewritten = chat("Rewritten", agent.sessionId);
    const id = (await upload(hook, "chat-1", first)).body.transcript.id;
    await upload(hook, "chat-1", rewritten);

    expect((await upload(hook, "chat-1", first)).status).toBe(200);
    expect((await admin.get(`/api/transcripts/${id}`)).body.transcript).toMatchObject({ markdown: rewritten, earlier: [first] });
  });

  it("keeps one Transcript per Agent and chat id", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "One" });
    const hook = cronk.client(claude.secret);
    const one = await upload(hook, "chat-1", chat("A", agent.sessionId));
    const two = await upload(hook, "chat/2 with spaces", chat("B", agent.sessionId));
    expect([one.status, two.status]).toEqual([200, 200]);
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
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
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
    expect(read.body.transcript.tickets).toEqual([{ key: "CRONK-1", title: "Ticket 1", turn: null }]);
  });

  it("outlives its Agent's removal", async () => {
    const { bob, claude, id } = await transcriptAcrossProjects();
    expect((await bob.delete(`/api/agents/${claude.agentId}`)).status).toBe(204);
    expect((await bob.get(`/api/transcripts/${id}`)).body.transcript).toMatchObject({ agent: { id: claude.agentId, name: "claude-laptop" } });
  });
});

describe("Redacting a Transcript by hand", () => {
  it("replaces every occurrence of a passage in every text, for its Owner only", async () => {
    const { cronk, admin, bob, carol, claude, id } = await transcriptAcrossProjects();
    const hook = cronk.client(claude.secret);
    const sessionId = (await bob.get(`/api/transcripts/${id}`)).body.transcript.sessions[0].id;
    const first = chat("Do it all", sessionId);
    // A rewrite keeps the first text as an earlier one; both hold the passage.
    const rewritten = chat("My address is 12 Elm Street, as I said: 12 Elm Street", sessionId);
    await upload(hook, "chat-1", first + "\nI live at 12 Elm Street.\n");
    await upload(hook, "chat-1", rewritten);
    const redaction = { passage: "12 Elm Street" };

    expect((await carol.post(`/api/transcripts/${id}/redactions`, redaction)).status).toBe(404);
    const byAdmin = await admin.post(`/api/transcripts/${id}/redactions`, redaction);
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error).toMatch(/Owner/);
    expect((await (await startSession(cronk, claude.secret)).post(`/api/transcripts/${id}/redactions`, redaction)).status).toBe(403);

    const redacted = await bob.post(`/api/transcripts/${id}/redactions`, redaction);
    expect(redacted.status, JSON.stringify(redacted.body)).toBe(200);
    const read = (await admin.get(`/api/transcripts/${id}`)).body.transcript;
    expect(read.markdown).toBe(chat("My address is [redacted], as I said: [redacted]", sessionId));
    expect(read.earlier).toEqual([first + "\nI live at [redacted].\n"]);
    expect(redacted.body.transcript.markdown).toBe(read.markdown);
  });

  it("keeps the redactions in later uploads of the chat, continuing or not", async () => {
    const { cronk, admin, bob, claude, id } = await transcriptAcrossProjects();
    const hook = cronk.client(claude.secret);
    const sessionId = (await bob.get(`/api/transcripts/${id}`)).body.transcript.sessions[0].id;
    const before = chat("Do it all", sessionId) + "\nThe door code is 4711-ALPHA.\n";
    await upload(hook, "chat-1", before);
    expect((await bob.post(`/api/transcripts/${id}/redactions`, { passage: "4711-ALPHA" })).status).toBe(200);
    expect((await bob.post(`/api/transcripts/${id}/redactions`, { passage: "door code" })).status).toBe(200);

    // The client uploads the whole chat again, the passages and all, with a new turn repeating one.
    const continued = `${before}\n## Assistant\n\nNoted: 4711-ALPHA.\n`;
    expect((await upload(hook, "chat-1", continued)).status).toBe(200);
    let read = (await admin.get(`/api/transcripts/${id}`)).body.transcript;
    expect(read.earlier).toEqual([]);
    expect(read.markdown).toBe(chat("Do it all", sessionId) + "\nThe [redacted] is [redacted].\n\n## Assistant\n\nNoted: [redacted].\n");

    // A rewrite is kept beside it, redacted too.
    const compacted = chat("Summary: the door code is 4711-ALPHA", sessionId);
    expect((await upload(hook, "chat-1", compacted)).status).toBe(200);
    read = (await admin.get(`/api/transcripts/${id}`)).body.transcript;
    expect(read.markdown).toBe(chat("Summary: the [redacted] is [redacted]", sessionId));
    expect(read.earlier).toHaveLength(1);
    // A late retry of the first upload changes nothing.
    expect((await upload(hook, "chat-1", before)).status).toBe(200);
    expect((await admin.get(`/api/transcripts/${id}`)).body.transcript).toMatchObject({ markdown: read.markdown, earlier: read.earlier });
  });

  it("refuses a passage the Transcript doesn't hold", async () => {
    const { bob, id } = await transcriptAcrossProjects();
    const refused = await bob.post(`/api/transcripts/${id}/redactions`, { passage: "nowhere in it" });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/doesn't hold/);
    expect((await bob.post(`/api/transcripts/${id}/redactions`, { passage: "" })).status).toBe(400);
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
    expect((await upload(hook, "chat-1", first)).status).toBe(200);
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

/** A file of an export: its frontmatter and body. */
function exported(text: string | undefined): { data: any; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text ?? "");
  if (!m) throw new Error(`Not a Markdown file with frontmatter: ${text}`);
  return { data: parse(m[1]!), body: m[2]! };
}

describe("Exporting and importing Transcripts", () => {
  it("writes each as Markdown with frontmatter in the Workspace export, and the import restores it linked to the same work", async () => {
    const before = await transcriptAcrossProjects();
    const hook = before.cronk.client(before.claude.secret);
    const sessionId = (await before.bob.get(`/api/transcripts/${before.id}`)).body.transcript.sessions[0].id;
    // A rewrite keeps the first text as an earlier one.
    const rewritten = chat("Summary", sessionId);
    expect((await upload(hook, "chat-1", rewritten)).status).toBe(200);
    await before.admin.patch("/api/workspace", { transcriptMaxBytes: 5_000_000 });
    const original = (await before.admin.get(`/api/transcripts/${before.id}`)).body.transcript;

    const archive = await before.admin.download("/api/export");
    const files = await untarGz(archive.body);
    const file = exported(files["transcripts/1.md"]);
    expect(file.data).toEqual({
      agent: before.claude.agentId,
      chatId: "chat-1",
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
      sessions: [sessionId],
      tickets: ["CRONK-1", "SECRET-1"],
      documents: ["documents/1-handbook.md"],
      terms: [],
      decisions: [],
    });
    expect(file.body).toBe(rewritten);
    expect(files["transcripts/1.earlier/1.md"]).toBe(chat("Do it all", sessionId));
    expect(exported(files["people.md"]).data.sessions.map((s: { id: string }) => s.id)).toContain(sessionId);
    expect(exported(files["workspace.md"]).data.transcriptMaxBytes).toBe(5_000_000);
    // A Project export holds none.
    const project = await untarGz((await before.admin.download("/api/projects/CRONK/export")).body);
    expect(Object.keys(project).filter((p) => p.includes("transcripts"))).toEqual([]);

    const { admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", archive.body)).status).toBe(201);
    expect((await admin.get("/api/workspace")).body.transcriptMaxBytes).toBe(5_000_000);
    const listed = (await admin.get("/api/transcripts")).body.transcripts;
    expect(listed).toHaveLength(1);
    const restored = (await admin.get(`/api/transcripts/${listed[0].id}`)).body.transcript;
    const handbook = (await admin.get("/api/workspace/documents")).body.documents.find((d: { title: string }) => d.title === "Handbook");
    expect(restored).toEqual({
      ...original,
      id: listed[0].id,
      // The import keeps the Agent's and its Session's ids; only the Owner, a User, is new here.
      agent: { ...original.agent, owner: { id: expect.any(String), name: "bob" } },
      documents: [{ id: handbook.id, title: "Handbook", turn: null }],
    });
  });

  it("writes the texts as redacted, with what finds the passages again, so the import keeps redacting them", async () => {
    const before = await transcriptAcrossProjects();
    const sessionId = (await before.bob.get(`/api/transcripts/${before.id}`)).body.transcript.sessions[0].id;
    const hook = before.cronk.client(before.claude.secret);
    await upload(hook, "chat-1", chat("Do it all", sessionId) + "\nCall me on 555-0199.\n");
    await upload(hook, "chat-1", chat("Again, call 555-0199", sessionId));
    expect((await before.bob.post(`/api/transcripts/${before.id}/redactions`, { passage: "555-0199" })).status).toBe(200);

    const archive = await before.admin.download("/api/export");
    const files = await untarGz(archive.body);
    const file = exported(files["transcripts/1.md"]);
    expect(file.body).toBe(chat("Again, call [redacted]", sessionId));
    expect(files["transcripts/1.earlier/1.md"]).toBe(chat("Do it all", sessionId) + "\nCall me on [redacted].\n");
    expect(JSON.stringify(files)).not.toContain("555-0199");
    expect(file.data.redactions).toEqual([{ length: 8, fingerprint: expect.any(Number), digest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);

    const { admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", archive.body)).status).toBe(201);
    const again = await untarGz((await admin.download("/api/export")).body);
    expect(exported(again["transcripts/1.md"]).data.redactions).toEqual(file.data.redactions);
  });

  it("scrubs texts an import brings that still hold secrets, as from an export made before scrubbing", async () => {
    const before = await transcriptAcrossProjects();
    const archive = await untarGz((await before.admin.download("/api/export")).body);
    const file = exported(archive["transcripts/1.md"]);
    archive["transcripts/1.md"] = archive["transcripts/1.md"]! + `\nMy token: ${SECRETS.github}\n`;

    const { admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", await tarGz(archive))).status).toBe(201);
    const listed = (await admin.get("/api/transcripts")).body.transcripts;
    const restored = (await admin.get(`/api/transcripts/${listed[0].id}`)).body.transcript;
    expect(restored.markdown).toBe(`${file.body}\nMy token: [scrubbed: GitHub token]\n`);
  });
});

describe("Listing Transcripts", () => {
  it("lists those the caller may read, newest first, without their text", async () => {
    const { cronk, bob, carol, claude, id } = await transcriptAcrossProjects();
    const agent = await startSession(cronk, claude.secret);
    await agent.post("/api/tickets/CRONK-1/comments", { body: "More" });
    cronk.clock.advance(1000);
    const second = (await upload(cronk.client(claude.secret), "chat-2", chat("Only CRONK", agent.sessionId))).body.transcript.id;

    const mine = (await bob.get("/api/transcripts")).body.transcripts;
    expect(mine.map((t: { id: string }) => t.id)).toEqual([second, id]);
    expect(mine[0]).not.toHaveProperty("markdown");
    expect(mine[0]).not.toHaveProperty("title");
    expect(mine[0]).toMatchObject({ chatId: "chat-2", tickets: [{ key: "CRONK-1" }] });
    expect((await carol.get("/api/transcripts")).body.transcripts.map((t: { id: string }) => t.id)).toEqual([second]);
  });
});

describe("Linking a chat written before an import", () => {
  it("also finds the Agent's Sessions an import gave new ids, by the ids they had in the export", async () => {
    // claude-laptop's Session changed CRONK-1 in one installation; old-bot's changed it too.
    const before = await delegatedSetup();
    const session = await before.session();
    await session.post("/api/tickets/CRONK-1/claim");
    await session.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Mine" });
    await session.delete("/api/agent-sessions/current");
    const bot = await registerAgent(before.admin, "old-bot");
    await before.admin.patch("/api/tickets/CRONK-1", { delegateId: bot.agentId });
    const botSession = await startSession(before.cronk, bot.secret);
    await botSession.post("/api/tickets/CRONK-1/claim");
    await botSession.post("/api/tickets/CRONK-1/comments", { body: "Not yours" });
    const files = await untarGz((await before.admin.download("/api/projects/CRONK/export")).body);
    const renamed = (key: string, from: string, to = from) =>
      tarGz(Object.fromEntries(Object.entries(files).map(([path, text]) => [path.replaceAll("CRONK", key), text.replaceAll("CRONK", key).replaceAll(from, to)])));

    // Elsewhere, Ada's claude-laptop already exists, so the import matches it. The export goes in three times: the
    // Sessions keep their ids the first time, get new ones the second, and the third time one was edited by hand.
    const { cronk, admin } = await startInstalledCronk("Elsewhere");
    const claude = await registerAgent(admin, "claude-laptop");
    for (const archive of [await tarGz(files), await renamed("COPY", "CRONK"), await renamed("HAND", session.sessionId, "my-session")]) {
      expect((await admin.upload("/api/import", archive)).status).toBe(201);
    }
    const sessionOf = async (key: string) =>
      (await admin.get(`/api/tickets/${key}/activities`)).body.activities[0].session.id as string;
    const hook = cronk.client(claude.secret);

    const uploaded = await upload(hook, "chat-1", chat("Fix CRONK-1", session.sessionId, botSession.sessionId));
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    const copy = await sessionOf("COPY-1");
    expect(copy).not.toBe(session.sessionId);
    expect(uploaded.body.transcript.sessions.map((s: { id: string }) => s.id).sort()).toEqual([session.sessionId, copy].sort());
    expect(uploaded.body.transcript.tickets.map((t: { key: string }) => t.key)).toEqual(["COPY-1", "CRONK-1"]);

    // An id edited by hand is matched as written, as a whole word.
    const byHand = await upload(hook, "chat-2", "## Assistant\n\nAgent Session my-session\n");
    expect(byHand.status, JSON.stringify(byHand.body)).toBe(200);
    expect(byHand.body.transcript.tickets.map((t: { key: string }) => t.key)).toEqual(["HAND-1"]);
    expect((await upload(hook, "chat-3", "## Assistant\n\nnot-my-session-at-all\n")).status).toBe(422);
  });
});

describe("Where a Transcript's items first appear", () => {
  it("gives each item the turn where its key or id first appears, and none when no turn names it", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup(2);
    const agent = await session();
    for (const key of ["CRONK-1", "CRONK-2"]) {
      await agent.post(`/api/tickets/${key}/claim`);
      await agent.post(`/api/tickets/${key}/activities`, { kind: "plan", body: "Go" });
    }
    const doc = (await agent.post("/api/projects/CRONK/documents", { title: "Notes", body: "Kept." })).body.document.id;
    const term = (await agent.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." })).body.term.id;
    const decided = await agent.post("/api/projects/CRONK/decisions", { title: "Retry migrations", ticket: "CRONK-1" });
    expect(decided.status, JSON.stringify(decided.body)).toBe(201);
    const markdown = [
      "## User\n\nThe migration test is flaky.\n",
      "## Assistant\n\n```tool-result\nAgent Session " + agent.sessionId + "\n```\n",
      // A heading inside a fenced block isn't a turn.
      "## User\n\nLook at cronk-1, and this:\n\n````\n## Assistant\n\nCRONK-D1\n````\n",
      "## Assistant\n\nSaved " + doc.toUpperCase() + " and recorded CRONK-D1; CRONK-12 is another Ticket.\n",
    ].join("\n");

    const uploaded = await upload(cronk.client(claude.secret), "chat-1", markdown);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    const read = (await admin.get(`/api/transcripts/${uploaded.body.transcript.id}`)).body.transcript;
    expect(read).toMatchObject({
      tickets: [
        { key: "CRONK-1", turn: 3 },
        { key: "CRONK-2", turn: null },
      ],
      documents: [{ id: doc, turn: 4 }],
      terms: [{ id: term, turn: null }],
      decisions: [{ key: "CRONK-D1", turn: 3 }],
    });
  });
});

describe("From Transcript links", () => {
  it("list, on each item, the Transcripts its changes came from with the turn where it first appears", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Go" });
    const doc = (await agent.post("/api/projects/CRONK/documents", { title: "Notes", body: "Kept." })).body.document.id;
    const term = (await agent.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." })).body.term.id;
    expect((await agent.post("/api/projects/CRONK/decisions", { title: "Retry migrations", ticket: "CRONK-1" })).status).toBe(201);
    const hook = cronk.client(claude.secret);
    const named = (
      await upload(hook, "chat-1", `## User\n\nFix CRONK-1\n\n## Assistant\n\nAgent Session ${agent.sessionId}\n\n## Assistant\n\nSaved ${doc}, ${term} and CRONK-D1\n`)
    ).body.transcript.id;
    cronk.clock.advance(1000);
    const unnamed = (await upload(hook, "chat-2", chat("Carry on", agent.sessionId))).body.transcript.id;

    const links = async (path: string) => {
      const res = await admin.get(path);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.transcripts.map((t: { id: string; turn: number | null }) => [t.id, t.turn]);
    };
    expect(await links("/api/tickets/CRONK-1/transcripts")).toEqual([[unnamed, null], [named, 1]]);
    expect(await links(`/api/documents/${doc}/transcripts`)).toEqual([[unnamed, null], [named, 3]]);
    expect(await links(`/api/terms/${term}/transcripts`)).toEqual([[unnamed, null], [named, 3]]);
    expect(await links("/api/decisions/CRONK-D1/transcripts")).toEqual([[unnamed, null], [named, 3]]);
    const [link] = (await admin.get("/api/tickets/CRONK-1/transcripts")).body.transcripts;
    expect(link).toEqual({ id: unnamed, agent: { id: claude.agentId, name: "claude-laptop" }, turn: null, updatedAt: expect.any(String) });
    expect((await admin.get("/api/tickets/CRONK-2/transcripts")).status).toBe(404);
  });

  it("leave out the Transcripts the caller may not read, and answer only for items they can read", async () => {
    const { admin, carol, carolId, id } = await transcriptAcrossProjects();
    expect((await admin.get("/api/tickets/CRONK-1/transcripts")).body.transcripts.map((t: { id: string }) => t.id)).toEqual([id]);
    // Carol reads CRONK-1 but not SECRET, where the same Transcript's Sessions changed things too.
    const carols = await carol.get("/api/tickets/CRONK-1/transcripts");
    expect(carols.status).toBe(200);
    expect(carols.body.transcripts).toEqual([]);
    expect((await carol.get("/api/tickets/SECRET-1/transcripts")).status).toBe(404);
    await admin.put(`/api/projects/SECRET/members/${carolId}`, { access: "read" });
    expect((await carol.get("/api/tickets/CRONK-1/transcripts")).body.transcripts.map((t: { id: string }) => t.id)).toEqual([id]);
  });
});

describe("Context on claim", () => {
  it("lists the Transcripts the Ticket came from, without their text", async () => {
    const { cronk, claude, session } = await delegatedSetup();
    const first = await session();
    await first.post("/api/tickets/CRONK-1/claim");
    await first.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Started" });
    await first.delete("/api/tickets/CRONK-1/claim");
    const id = (await upload(cronk.client(claude.secret), "chat-1", chat("Start on CRONK-1", first.sessionId))).body.transcript.id;

    const claimed = await (await session()).post("/api/tickets/CRONK-1/claim");
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.transcripts).toEqual([
      { id, agent: { id: claude.agentId, name: "claude-laptop" }, turn: 1, updatedAt: expect.any(String) },
    ]);
    // Nothing of the chat, not even its first line.
    expect(JSON.stringify(claimed.body)).not.toMatch(/tool-result|Start on/);
  });
});

describe("Searching Transcripts", () => {
  it("finds them as their own kind, below everything else, pointing at the best matching turn", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Go" });
    await admin.post("/api/workspace/documents", { title: "Rollback", body: "We rollback by hand." });
    const markdown =
      `## User\n\nThe deploy failed.\n\n## Assistant\n\nAgent Session ${agent.sessionId}\n\n` +
      "## User\n\nRollback the rollback, then rollback again: rollback, rollback, rollback.\n\n## Assistant\n\nRolled back.\n";
    const id = (await upload(cronk.client(claude.secret), "chat-1", markdown)).body.transcript.id;

    const found = await admin.get("/api/search?q=rollback");
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.results.map((r: { kind: string }) => r.kind)).toEqual(["document", "transcript"]);
    const [, hit] = found.body.results;
    expect(hit).toMatchObject({ kind: "transcript", title: "The deploy failed.", projectKey: null, transcriptId: id, turn: 3, protected: null });
    expect(hit.excerpt).toMatch(/^Rollback the rollback/);
    expect(found.body.results[0]).toMatchObject({ transcriptId: null, turn: null });

    expect((await admin.get("/api/search?q=rollback&kind=transcript")).body.results.map((r: { kind: string }) => r.kind)).toEqual(["transcript"]);
    expect((await admin.get("/api/search?q=rollback&kind=document")).body.results.map((r: { kind: string }) => r.kind)).toEqual(["document"]);
    // Only the latest text is searched.
    await upload(cronk.client(claude.secret), "chat-1", `## Assistant\n\nAgent Session ${agent.sessionId} started over.\n`);
    expect((await admin.get("/api/search?q=rollback&kind=transcript")).body.results).toEqual([]);
    expect((await admin.get("/api/search?q=started&kind=transcript")).body.results).toMatchObject([{ transcriptId: id, turn: 1 }]);
  });

  it("finds only those the caller may read, and narrowed to Projects, those whose Sessions changed things there", async () => {
    const { cronk, admin, bob, carol, carolId, claude, id } = await transcriptAcrossProjects();
    const ids = async (client: Client, filters = "") =>
      ((await client.get(`/api/search?q=done&kind=transcript${filters}`)).body.results as { transcriptId: string }[]).map((r) => r.transcriptId);
    expect(await ids(bob)).toEqual([id]);
    expect(await ids(admin)).toEqual([id]);
    expect(await ids(carol)).toEqual([]);
    await admin.put(`/api/projects/SECRET/members/${carolId}`, { access: "read" });
    expect(await ids(carol)).toEqual([id]);
    expect(await ids(cronk.client(claude.secret))).toEqual([id]);

    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    expect(await ids(admin, "&project=SECRET")).toEqual([id]);
    expect(await ids(admin, "&project=OPS")).toEqual([]);
  });

  it("finds what a hand redaction left, never the passage", async () => {
    const { bob, id } = await transcriptAcrossProjects();
    expect((await bob.get("/api/search?q=done&kind=transcript")).body.results).toHaveLength(1);
    expect((await bob.post(`/api/transcripts/${id}/redactions`, { passage: "Done" })).status).toBe(200);
    expect((await bob.get("/api/search?q=done&kind=transcript")).body.results).toEqual([]);
    expect((await bob.get("/api/search?q=redacted&kind=transcript")).body.results).toHaveLength(1);
  });
});

describe("Upgrading an installation", () => {
  it("makes the Transcripts it already holds searchable", async () => {
    const { cronk, bob, id } = await transcriptAcrossProjects();
    await cronk.undoMigration("0042_transcript_turns", "DROP TABLE transcript_turns");
    await cronk.restart();
    expect((await bob.get("/api/search?q=done&kind=transcript")).body.results).toMatchObject([{ transcriptId: id, turn: 2 }]);
  });
});
