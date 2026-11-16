import { describe, expect, it } from "vitest";
import { connectMcp, joinAs, registerAgent, startInstalledCronk, startSession, tarGz, type Cronk } from "./harness.js";

/** A small site to publish. */
const site = (version: number) => ({ "index.html": `<h1>Sign-in limits, take ${version}</h1>` });

/** Ada, the Admin, with the Project CRONK, and the Agent claude-laptop, whose Agent Session published "Limits" at Versions 1 and 2. */
async function setup() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  const claude = await registerAgent(admin, "claude-laptop");
  const agent = await startSession(cronk, claude.secret);
  const { artifact } = (await agent.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz(site(1)))).body;
  await agent.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1`, await tarGz(site(2)));
  return { cronk, admin, claude, agent, artifact: artifact as { id: string } };
}

describe("Comments on an Artifact", () => {
  it("record the Version being viewed, the latest one when left out, and are listed oldest first", async () => {
    const { admin, agent, artifact } = await setup();

    const onFirst = await admin.post(`/api/artifacts/${artifact.id}/comments`, { body: "Can the bars show the limit as a line?", version: 1 });
    expect(onFirst.status).toBe(201);
    expect(onFirst.body.comment).toMatchObject({
      artifactId: artifact.id,
      artifactVersion: 1,
      ticketKey: null,
      documentId: null,
      body: "Can the bars show the limit as a line?",
      actor: { kind: "user", name: "Ada" },
    });
    const reply = await agent.post(`/api/artifacts/${artifact.id}/comments`, { body: "Version 2 adds it to the legend.", replyToCommentId: onFirst.body.comment.id });
    expect(reply.status).toBe(201);
    expect(reply.body.comment).toMatchObject({ artifactVersion: 2, replyToCommentId: onFirst.body.comment.id, actor: { kind: "agent", name: "claude-laptop" } });

    const listed = await admin.get(`/api/artifacts/${artifact.id}/comments`);
    expect(listed.status).toBe(200);
    expect(listed.body.comments).toEqual([onFirst.body.comment, reply.body.comment]);
  });
});

/** The work the Agent with token `secret` finds waiting in the welcome of a new Agent Session. */
async function waitingFor(cronk: Cronk, secret: string) {
  return (await cronk.client(secret).post("/api/agent-sessions")).body.welcome.waitingWork;
}

describe("A Comment on an Artifact Version", () => {
  it("waits for the Agent that published the Version being viewed, and only that one", async () => {
    const { cronk, admin, claude, artifact } = await setup();
    const codex = await registerAgent(admin, "codex");
    await (await startSession(cronk, codex.secret)).upload(`/api/artifacts/${artifact.id}/versions?baseVersion=2`, await tarGz(site(3)));

    const onSecond = (await admin.post(`/api/artifacts/${artifact.id}/comments`, { body: "The legend wraps on mobile.", version: 2 })).body.comment;
    const onLatest = (await admin.post(`/api/artifacts/${artifact.id}/comments`, { body: "Looks fine now." })).body.comment;

    expect(await waitingFor(cronk, claude.secret)).toEqual([
      { reason: "published", comment: onSecond, ticket: null, document: null, artifact: { id: artifact.id, title: "Limits", version: 2 } },
    ]);
    expect(await waitingFor(cronk, codex.secret)).toEqual([
      { reason: "published", comment: onLatest, ticket: null, document: null, artifact: { id: artifact.id, title: "Limits", version: 3 } },
    ]);
  });

  it("doesn't wait for the publishing Agent when that Agent posted it, nor for anyone when a User published the Version", async () => {
    const { cronk, admin, claude, agent, artifact } = await setup();
    await agent.post(`/api/artifacts/${artifact.id}/comments`, { body: "Note to self: tidy the legend.", version: 1 });
    await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=2`, await tarGz(site(3)));
    await admin.post(`/api/artifacts/${artifact.id}/comments`, { body: "My own take.", version: 3 });

    expect(await waitingFor(cronk, claude.secret)).toEqual([]);
  });

  it("is named in the MCP welcome by its Artifact and Version", async () => {
    const { cronk, admin, claude, artifact } = await setup();
    await admin.post(`/api/artifacts/${artifact.id}/comments`, { body: "Can it show last hour too?", version: 1 });

    const mcp = await connectMcp(cronk, claude.secret);

    expect(mcp.client.getInstructions()).toContain(`- Artifact “Limits” (${artifact.id}), Version 1: Ada commented on a Version you published`);
  });

  it("reaches the publishing Agent's live Agent Sessions as it is posted", async () => {
    const { cronk, admin, claude, artifact } = await setup();
    const session = await startSession(cronk, claude.secret);
    const stream = await session.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");

    const posted = (await admin.post(`/api/artifacts/${artifact.id}/comments`, { body: "Can it show last hour too?", version: 2 })).body.comment;

    const event = await stream.next();
    expect(event?.event).toBe("waiting");
    expect(event?.data.waiting).toEqual({
      reason: "published",
      comment: posted,
      ticket: null,
      document: null,
      artifact: { id: artifact.id, title: "Limits", version: 2 },
    });
  });
});

describe("An Artifact's live updates", () => {
  it("push each new Comment to those watching the Artifact", async () => {
    const { admin, agent, artifact } = await setup();
    const stream = await admin.events(`/api/artifacts/${artifact.id}/events`);
    expect((await stream.next())?.event).toBe("ready");

    const posted = (await agent.post(`/api/artifacts/${artifact.id}/comments`, { body: "Published the threshold line." })).body.comment;

    expect(await stream.next()).toMatchObject({ event: "comment", data: { comment: posted } });
  });

  it("are refused to whoever can't read the Artifact", async () => {
    const { cronk, admin, artifact } = await setup();
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    const bob = await joinAs(cronk, admin, "bob@example.com");

    expect((await bob.events(`/api/artifacts/${artifact.id}/events`)).status).toBe(404);
  });
});

describe("The comments MCP tool", () => {
  it("lists and posts Comments on an Artifact, on the Version the Agent names", async () => {
    const { cronk, admin, artifact } = await setup();
    const codex = await registerAgent(admin, "codex");
    const mcp = await connectMcp(cronk, codex.secret);
    const call = async (args: Record<string, unknown>) => {
      const result = (await mcp.client.callTool({ name: "comments", arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: !!result.isError, body: result.isError ? result.content[1]!.text : JSON.parse(result.content[1]!.text) };
    };

    const posted = await call({ action: "post", artifactId: artifact.id, version: 1, body: "Version 1 had the clearer legend." });
    expect(posted.isError).toBe(false);
    expect(posted.body.comment).toMatchObject({ artifactId: artifact.id, artifactVersion: 1, actor: { kind: "agent", name: "codex" } });

    expect((await call({ action: "list", artifactId: artifact.id })).body).toEqual((await admin.get(`/api/artifacts/${artifact.id}/comments`)).body);
    expect(await call({ action: "list", key: "CRONK-1", artifactId: artifact.id })).toEqual({
      isError: true,
      body: "The list action needs one of key, documentId or artifactId",
    });
  });
});

describe("A Comment on an Artifact that names a Decision", () => {
  it("is listed among what mentions the Decision, with its Artifact's title and id", async () => {
    const { admin, artifact } = await setup();
    await admin.post("/api/projects/CRONK/decisions", { title: "Sign-in limits per IP" });

    const posted = (await admin.post(`/api/artifacts/${artifact.id}/comments`, { body: "This follows CRONK-D1." })).body.comment;

    const { mentions } = (await admin.get("/api/decisions/CRONK-D1/mentions")).body;
    expect(mentions).toEqual([expect.objectContaining({ kind: "comment", id: posted.id, title: "Limits", projectKey: "CRONK", ticketKey: null, documentId: null, artifactId: artifact.id })]);
  });
});
