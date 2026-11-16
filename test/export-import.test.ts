import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { delegatedSetup, joinAs, registerAgent, startInstalledCronk, tarGz, untarGz, type Client } from "./harness.js";

/** A Markdown file's frontmatter and body. */
function markdown(text: string | undefined): { data: any; body: string } {
  const match = /^---\n([\s\S]*?)---\n/.exec(text ?? "");
  if (!match) throw new Error(`Not Markdown with frontmatter: ${text}`);
  return { data: parse(match[1]!), body: text!.slice(match[0].length) };
}

describe("exporting a Project", () => {
  it("downloads it as an archive of Markdown files with frontmatter, relations naming Ticket keys", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects/CRONK/tickets", { title: "Build it", description: "All of it." });
    await admin.post("/api/projects/CRONK/tickets", { title: "Test it" });
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: ada.id, priority: "high", labels: ["core"] });
    await admin.patch("/api/tickets/CRONK-2", { parentKey: "CRONK-1" });
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Starting." });
    const plan = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "# Plan\n\nShip." })).body.document;
    await admin.post(`/api/tickets/CRONK-1/documents/${plan.id}`);

    const res = await admin.download("/api/projects/CRONK/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="cronk-CRONK-.*\.tar\.gz"/);
    const files = await untarGz(res.body);

    expect(markdown(files["README.md"]).data.cronk).toMatchObject({ format: 1, scope: "project", versions: true });
    expect(markdown(files["projects/CRONK/project.md"]).data).toMatchObject({
      key: "CRONK",
      name: "Cronk",
      statuses: expect.arrayContaining([{ name: "Todo", category: "unstarted" }]),
    });
    const ticket = markdown(files["projects/CRONK/tickets/CRONK-1.md"]);
    expect(ticket.data).toMatchObject({ title: "Build it", status: "Backlog", priority: "high", labels: ["core"], assignee: "ada@example.com", blocks: ["CRONK-2"] });
    // Linked Documents are named by the path of their file.
    expect(ticket.data.documents).toEqual(["projects/CRONK/documents/1-plan.md"]);
    expect(ticket.body).toBe("All of it.");
    expect(markdown(files["projects/CRONK/tickets/CRONK-2.md"]).data).toMatchObject({ parent: "CRONK-1", blockedBy: ["CRONK-1"] });
    expect(markdown(files["projects/CRONK/tickets/CRONK-1.comments/1.md"])).toEqual({
      data: { at: "2026-01-01T09:00:00.000Z", by: "ada@example.com" },
      body: "Starting.",
    });
    expect(markdown(files["projects/CRONK/documents/1-plan.md"])).toMatchObject({ data: { title: "Plan", version: 1 }, body: "# Plan\n\nShip." });
    expect(markdown(files["people.md"]).data.users).toEqual([{ email: "ada@example.com", name: "Ada", role: "admin", active: true }]);
    // History names Users by email, Statuses by name and Tickets by key, keeping the names recorded at the time.
    const history = markdown(files["projects/CRONK/tickets/CRONK-1.history.md"]).data.changes;
    expect(history[0]).toMatchObject({ by: "ada@example.com", change: "created", title: "Build it", status: { name: "Backlog", current: "Backlog" } });
    expect(history).toContainEqual(expect.objectContaining({ change: "assignee", from: null, to: { id: ada.id, name: "Ada", email: "ada@example.com" } }));
    expect(history).toContainEqual(expect.objectContaining({ change: "relation added", kind: "blocks", ticket: { key: "CRONK-2", title: "Test it" } }));
    expect(history).toContainEqual(
      expect.objectContaining({ change: "document linked", document: { id: plan.id, title: "Plan", projectKey: "CRONK", path: "projects/CRONK/documents/1-plan.md" } }),
    );
    expect(markdown(files["projects/CRONK/tickets/CRONK-2.history.md"]).data.changes).toContainEqual(
      expect.objectContaining({ change: "parent", from: null, to: { key: "CRONK-1", title: "Build it" } }),
    );
  });

  it("writes an Agent in history by its id in people.md", async () => {
    const { admin, claude } = await delegatedSetup(1);
    const files = await untarGz((await admin.download("/api/projects/CRONK/export")).body);

    expect(markdown(files["people.md"]).data.agents).toMatchObject([{ id: claude.agentId, name: "claude-laptop" }]);
    expect(markdown(files["projects/CRONK/tickets/CRONK-1.history.md"]).data.changes).toContainEqual(
      expect.objectContaining({ by: "ada@example.com", change: "delegate", from: null, to: { id: claude.agentId, name: "claude-laptop" } }),
    );
  });

  it("is only for Admins", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const member = await joinAs(cronk, admin, "grace@example.com");

    expect((await member.download("/api/projects/CRONK/export")).status).toBe(403);
    expect((await member.download("/api/export")).status).toBe(403);
    expect((await admin.download("/api/projects/NOPE/export")).status).toBe(404);
  });
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Everything an Admin can read through the API about the Workspace, with ids replaced by the
 * order they first appear in, so two installations holding the same data read the same.
 */
async function snapshot(admin: Client): Promise<unknown> {
  const get = async (path: string) => {
    const res = await admin.get(path);
    if (res.status !== 200) throw new Error(`GET ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const document = async (id: string) => ({
    ...(await get(`/api/documents/${id}`)),
    versions: await Promise.all((await get(`/api/documents/${id}/versions`)).versions.map((v: { number: number }) => get(`/api/documents/${id}/versions/${v.number}`))),
    comments: await get(`/api/documents/${id}/comments`),
  });
  const tree = async (path: string) => {
    const { documents } = await get(path);
    return { documents, contents: await Promise.all(documents.map((d: { id: string }) => document(d.id))) };
  };
  const project = async (key: string) => {
    const { tickets } = await get(`/api/projects/${key}/tickets`);
    return {
      project: await get(`/api/projects/${key}`),
      members: await get(`/api/projects/${key}/members`),
      guidance: await get(`/api/projects/${key}/guidance`),
      guidanceVersions: await get(`/api/projects/${key}/guidance/versions`),
      documents: await tree(`/api/projects/${key}/documents`),
      tickets: await Promise.all(
        tickets.map(async (t: { key: string }) => {
          const { reports } = await get(`/api/tickets/${t.key}/reports`);
          return {
            ticket: await get(`/api/tickets/${t.key}`),
            activities: await get(`/api/tickets/${t.key}/activities`),
            comments: await get(`/api/tickets/${t.key}/comments`),
            history: await get(`/api/tickets/${t.key}/changes`),
            reports,
            reportContents: await Promise.all(reports.map((r: { id: string }) => document(r.id))),
          };
        }),
      ),
    };
  };
  const projects = [...(await get("/api/projects")).projects, ...(await get("/api/projects?archived=true")).projects];
  const raw = {
    workspace: await get("/api/workspace"),
    users: await get("/api/users"),
    agents: await get("/api/agents?all=true"),
    guidance: await get("/api/workspace/guidance"),
    guidanceVersions: await get("/api/workspace/guidance/versions"),
    documents: await tree("/api/workspace/documents"),
    projects: await Promise.all(projects.map((p: { key: string }) => project(p.key))),
  };
  const ids = new Map<string, string>();
  return JSON.parse(JSON.stringify(raw).replace(UUID, (id) => ids.get(id) ?? (ids.set(id, `#${ids.size + 1}`), `#${ids.size}`)));
}

/** A Workspace with some of everything in it, made by Ada, Grace and Ada's Agent claude-laptop. */
async function busyWorkspace() {
  const { cronk, admin, session } = await delegatedSetup(3);
  const grace = await joinAs(cronk, admin, "grace@example.com", "member", "Grace");
  const graceId = (await grace.get("/api/me")).body.user.id;
  await admin.patch("/api/workspace", { name: "Acme Labs", agentAccess: "write", silenceThresholdSeconds: 600 });
  await admin.put("/api/workspace/guidance", { baseVersion: 0, markdown: "Be kind." });
  await admin.put("/api/workspace/guidance", { baseVersion: 1, markdown: "Be kind. Be brief." });
  await admin.put("/api/projects/CRONK/guidance", { baseVersion: 0, markdown: "Run the tests." });
  await admin.patch("/api/projects/CRONK", { visibility: "private", agentAccess: "write" });
  await admin.put(`/api/projects/CRONK/members/${graceId}`, { access: "write" });
  const blocked = (await admin.post("/api/projects/CRONK/statuses", { name: "Blocked", category: "started" })).body.status;
  // History keeps the names it recorded: CRONK-3 moved into "Blocked", since renamed "Stuck", and to Grace.
  await admin.patch("/api/tickets/CRONK-3", { statusId: blocked.id, assigneeId: graceId });
  await admin.patch(`/api/projects/CRONK/statuses/${blocked.id}`, { name: "Stuck" });
  // ...and CRONK-2 through "Parked", since deleted: its id names no Status in either installation.
  const parked = (await admin.post("/api/projects/CRONK/statuses", { name: "Parked", category: "backlog" })).body.status;
  await admin.patch("/api/tickets/CRONK-2", { statusId: parked.id });
  await admin.patch("/api/tickets/CRONK-2", { statusId: blocked.id });
  expect((await admin.delete(`/api/projects/CRONK/statuses/${parked.id}`)).status).toBe(204);
  await admin.patch("/api/tickets/CRONK-2", { parentKey: "CRONK-1", priority: "urgent", labels: ["Core", "api"], description: "The *API*." });
  await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-3" });
  await admin.post("/api/tickets/CRONK-3/relations", { kind: "relates_to", ticketKey: "CRONK-2" });

  // claude-laptop works CRONK-1: asks a question Ada answers, and hands it over with a Report.
  const agent = await session();
  cronk.clock.advance(60_000);
  await agent.post("/api/tickets/CRONK-1/claim");
  await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Read, then write." });
  const question = (await agent.post("/api/tickets/CRONK-1/activities", { kind: "question", body: "Which cache?", blocking: true })).body.activity;
  cronk.clock.advance(60_000);
  const answer = (await admin.post("/api/tickets/CRONK-1/comments", { body: "The *disk* one.", replyToActivityId: question.id })).body.comment;
  await agent.post("/api/tickets/CRONK-1/comments", { body: "Thanks.", replyToCommentId: answer.id });
  const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "It was the cache." })).body.report;
  await agent.patch(`/api/documents/${report.id}`, { baseVersion: 1, body: "It was the disk cache." });
  const inReview = (await admin.get("/api/projects/CRONK")).body.statuses.find((s: { category: string }) => s.category === "in_review");
  expect((await agent.patch("/api/tickets/CRONK-1", { statusId: inReview.id })).status).toBe(200);
  await agent.delete("/api/agent-sessions/current");
  // Ada sends it back once, then puts it In Review again herself.
  await admin.post("/api/tickets/CRONK-1/send-back", { comment: "Add a test." });
  await admin.patch("/api/tickets/CRONK-1", { statusId: inReview.id });

  // Documents with Versions and Comments, in both page trees.
  cronk.clock.advance(60_000);
  const guide = (await admin.post("/api/projects/CRONK/documents", { title: "Guide", body: "# Guide\n\nStart here." })).body.document;
  await admin.post("/api/projects/CRONK/documents", { title: "Setup / Docker", body: "docker compose up", parentId: guide.id });
  await admin.post("/api/projects/CRONK/documents", { title: "Roadmap" });
  await admin.patch(`/api/documents/${guide.id}`, { baseVersion: 1, body: "# Guide\n\nStart here, then read on." });
  await admin.post(`/api/documents/${guide.id}/versions/1/restore`, { baseVersion: 2 });
  const remark = (await grace.post(`/api/documents/${guide.id}/comments`, { body: "Which here?", anchor: { passage: "Start here" } })).body.comment;
  await admin.post(`/api/documents/${guide.id}/comments`, { body: "This one.", replyToCommentId: remark.id });
  await admin.post("/api/workspace/documents", { title: "Handbook", body: "Welcome." });
  // A line of dashes, as frontmatter ends with, in a title, a body and an anchored passage.
  const notes = (await admin.post("/api/workspace/documents", { title: "Notes ---", body: "intro\n---\nmore" })).body.document;
  await admin.post(`/api/documents/${notes.id}/comments`, { body: "Rule?", anchor: { passage: "intro\n---\nmore" } });

  // A second, archived Project; a removed Agent.
  await admin.post("/api/projects", { name: "Old", key: "OLD" });
  await admin.post("/api/projects/OLD/tickets", { title: "Legacy" });
  await admin.post("/api/tickets/OLD-1/relations", { kind: "relates_to", ticketKey: "CRONK-1" });
  const legacy = (await admin.post("/api/projects/OLD/documents", { title: "Legacy notes" })).body.document;

  // Documents linked to Tickets: a Workspace Document, one nested in a page tree, another Project's, and another Ticket's Report.
  const handbook = (await admin.get("/api/workspace/documents")).body.documents.find((d: { title: string }) => d.title === "Handbook");
  const docker = (await admin.get("/api/projects/CRONK/documents")).body.documents.find((d: { title: string }) => d.title === "Setup / Docker");
  await admin.post(`/api/tickets/OLD-1/documents/${handbook.id}`);
  await admin.post(`/api/tickets/CRONK-3/documents/${docker.id}`);
  await admin.post(`/api/tickets/CRONK-3/documents/${legacy.id}`);
  await admin.post(`/api/tickets/CRONK-2/documents/${report.id}`);
  await admin.post(`/api/tickets/CRONK-2/documents/${guide.id}`);
  await admin.delete(`/api/tickets/CRONK-2/documents/${guide.id}`);
  await admin.patch("/api/projects/OLD", { archived: true });
  const gone = (await admin.post("/api/agents", { name: "old-bot" })).body.agent;
  await admin.delete(`/api/agents/${gone.id}`);
  return { cronk, admin, grace };
}

describe("importing an export", () => {
  it("recreates the same data in a fresh installation, Versions and all", async () => {
    const before = await busyWorkspace();
    const exported = await before.admin.download("/api/export");
    expect(exported.status).toBe(200);

    const { admin } = await startInstalledCronk("Elsewhere");
    const imported = await admin.upload("/api/import", exported.body);
    expect(imported.status).toBe(201);
    expect(imported.body).toEqual({ scope: "workspace", projects: ["CRONK", "OLD"] });
    const comments = (await admin.get("/api/tickets/CRONK-1/comments")).body.comments;
    expect(comments.filter((c: { sendBack: boolean }) => c.sendBack).map((c: { body: string }) => c.body)).toEqual(["Add a test."]);
    const moves = (await admin.get("/api/tickets/CRONK-1/changes")).body.changes.filter((c: { sentBack?: boolean }) => c.sentBack);
    expect(moves.map((c: { to: { name: string } }) => c.to.name)).toEqual(["In Progress"]);

    // Users who weren't in the installation come in deactivated and not joined: they have no password here yet.
    const expected = JSON.parse(JSON.stringify(await snapshot(before.admin)), (_key, value) =>
      value?.email === "grace@example.com" ? { ...value, active: false, joined: false } : value,
    );
    expect(await snapshot(admin)).toEqual(expected);
  });
});

describe("importing a Project export", () => {
  it("adds the Project, matching Users by email and Agents by Owner and name", async () => {
    const before = await busyWorkspace();
    const exported = await before.admin.download("/api/projects/CRONK/export");

    const { cronk, admin } = await startInstalledCronk("Elsewhere");
    const grace = await joinAs(cronk, admin, "grace@example.com", "member", "Grace");
    const laptop = (await admin.post("/api/agents", { name: "claude-laptop" })).body.agent;
    await admin.post("/api/projects", { name: "Other", key: "OTHER" });

    const imported = await admin.upload("/api/import", exported.body);
    expect(imported.status).toBe(201);
    expect(imported.body).toEqual({ scope: "project", projects: ["CRONK"] });
    expect((await admin.get("/api/users")).body.users.map((u: { email: string; active: boolean }) => [u.email, u.active])).toEqual([
      ["ada@example.com", true],
      ["grace@example.com", true],
    ]);
    expect((await admin.get("/api/agents?all=true")).body.agents.map((a: { id: string }) => a.id)).toEqual([laptop.id]);
    const ticket = (await admin.get("/api/tickets/CRONK-1")).body.ticket;
    expect(ticket).toMatchObject({ title: "Ticket 1", status: { category: "in_review" }, delegate: { id: laptop.id } });
    // The relation to OLD-1 is left out: OLD isn't in the export.
    expect((await admin.get("/api/tickets/CRONK-1")).body.relations).toMatchObject({ blocks: [{ key: "CRONK-3" }], relatesTo: [] });
    // So is the link to OLD's Document; the one to CRONK's own stays.
    const linked = (await admin.get("/api/tickets/CRONK-3")).body.documents;
    expect(linked.map((d: { title: string; reason: string }) => [d.title, d.reason])).toEqual([["Setup / Docker", "linked"]]);
    expect((await grace.get("/api/projects/CRONK/members")).status).toBe(200);
    // Tickets go on numbering where they left off.
    expect((await admin.post("/api/projects/CRONK/tickets", { title: "Next" })).body.ticket.key).toBe("CRONK-4");
  });

  it("keeps the names history recorded for Users, Agents and Tickets the export leaves out", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Other", key: "OTHER" });
    await admin.post("/api/projects/OTHER/tickets", { title: "Elsewhere" });
    const bob = await joinAs(cronk, admin, "bob@example.com", "member", "Bob");
    const bobId = (await bob.get("/api/me")).body.user.id;
    const helper = await registerAgent(admin, "helper");
    const adaId = (await admin.get("/api/me")).body.user.id;
    await admin.post("/api/projects/CRONK/tickets", { title: "Build it" });
    // Bob and helper had the Ticket once; neither is named anywhere else in a CRONK export.
    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: bobId })).status).toBe(200);
    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: adaId, delegateId: helper.agentId })).status).toBe(200);
    expect((await admin.patch("/api/tickets/CRONK-1", { delegateId: null })).status).toBe(200);
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "relates_to", ticketKey: "OTHER-1" });
    const notes = (await admin.post("/api/projects/OTHER/documents", { title: "Other notes" })).body.document;
    await admin.post(`/api/tickets/CRONK-1/documents/${notes.id}`);
    const exported = await admin.download("/api/projects/CRONK/export");
    expect(markdown((await untarGz(exported.body))["people.md"]).data.users.map((u: { email: string }) => u.email)).toEqual(["ada@example.com"]);

    const elsewhere = await startInstalledCronk("Elsewhere");
    await elsewhere.admin.post("/api/projects", { name: "Other", key: "OTHER" });
    await elsewhere.admin.post("/api/projects/OTHER/tickets", { title: "Not that one" });
    expect((await elsewhere.admin.upload("/api/import", exported.body)).status).toBe(201);

    const { changes } = (await elsewhere.admin.get("/api/tickets/CRONK-1/changes")).body;
    expect(changes).toContainEqual(expect.objectContaining({ change: "assignee", from: null, to: { id: bobId, name: "Bob" } }));
    expect(changes).toContainEqual(expect.objectContaining({ change: "assignee", from: { id: bobId, name: "Bob" }, to: { id: expect.any(String), name: "Ada" } }));
    expect(changes).toContainEqual(expect.objectContaining({ change: "delegate", from: { id: helper.agentId, name: "helper" }, to: null }));
    expect(changes).toContainEqual(expect.objectContaining({ change: "relation added", kind: "relates_to", ticket: { key: "OTHER-1", title: "Elsewhere" } }));
    expect(changes).toContainEqual(
      expect.objectContaining({ change: "document linked", document: { id: notes.id, title: "Other notes", projectKey: "OTHER" } }),
    );
    expect((await elsewhere.admin.get("/api/users")).body.users).toHaveLength(1);
  });

  it("is refused when the key is taken, and a Workspace export is refused once the Workspace holds anything", async () => {
    const before = await busyWorkspace();
    const project = (await before.admin.download("/api/projects/CRONK/export")).body;
    const workspace = (await before.admin.download("/api/export")).body;

    const { admin } = await startInstalledCronk("Elsewhere");
    await admin.post("/api/projects", { name: "Mine", key: "CRONK" });
    const taken = await admin.upload("/api/import", project);
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatch(/CRONK/);
    const full = await admin.upload("/api/import", workspace);
    expect(full.status).toBe(409);
    expect((await admin.get("/api/tickets/CRONK-1")).status).toBe(404);
    expect((await admin.get("/api/users")).body.users).toHaveLength(1);
  });

  it("is only for Admins, and only for Cronk exports", async () => {
    const before = await busyWorkspace();
    const project = (await before.admin.download("/api/projects/CRONK/export")).body;

    const { cronk, admin } = await startInstalledCronk("Elsewhere");
    const member = await joinAs(cronk, admin, "grace@example.com");
    expect((await member.upload("/api/import", project)).status).toBe(403);
    const plain = await admin.upload("/api/import", await tarGz({ "notes/a.md": "# A" }));
    expect(plain.status).toBe(400);
    expect(plain.body.error).toMatch(/isn't a Cronk export/);
  });
});

describe("a Ticket's history in an export", () => {
  it("is refused when a change in it isn't one Cronk records", async () => {
    const before = await busyWorkspace();
    const files = await untarGz((await before.admin.download("/api/projects/CRONK/export")).body);
    const path = "projects/CRONK/tickets/CRONK-1.history.md";
    const { changes } = markdown(files[path]).data;

    const { admin } = await startInstalledCronk("Elsewhere");
    for (const broken of [
      { at: "2026-01-01T09:00:00Z", by: "ada@example.com", change: "relation added", kind: "blocks" },
      { at: "2026-01-01T09:00:00Z", by: "ada@example.com", change: "priority", from: "none", to: "soon" },
      { at: "2026-01-01T09:00:00Z", by: "ada@example.com", change: "assignee", from: null, to: "ada@example.com" },
      { at: "2026-01-01T09:00:00Z", by: "ada@example.com", change: "renamed", from: "a", to: "b" },
    ]) {
      const edited = { ...files, [path]: `---\n${stringify({ changes: [...changes, broken] })}---\n` };
      const imported = await admin.upload("/api/import", await tarGz(edited));
      expect(imported.status).toBe(400);
      expect(imported.body.error).toMatch(/CRONK-1\.history\.md changes\[\d+\]/);
    }
    expect((await admin.get("/api/tickets/CRONK-1")).status).toBe(404);
  });
});

describe("an export without Versions", () => {
  it("imports each Document and Report at a single Version holding what it says now, by whoever first wrote it", async () => {
    const before = await busyWorkspace();
    const exported = await before.admin.download("/api/export?versions=false");
    const files = await untarGz(exported.body);
    expect(Object.keys(files).filter((path) => path.includes(".versions/"))).toEqual([]);

    const { admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", exported.body)).status).toBe(201);
    const [report] = (await admin.get("/api/tickets/CRONK-1/reports")).body.reports;
    expect(report).toMatchObject({ title: "Findings", version: 1, agent: { name: "claude-laptop", owner: { name: "Ada" } } });
    expect((await admin.get(`/api/documents/${report.id}`)).body.document.body).toBe("It was the disk cache.");
    const guide = (await admin.get("/api/projects/CRONK/documents")).body.documents.find((d: { title: string }) => d.title === "Guide");
    expect((await admin.get(`/api/documents/${guide.id}/versions`)).body.versions).toMatchObject([{ number: 1, title: "Guide" }]);
    expect((await admin.get(`/api/documents/${guide.id}/comments`)).body.comments[0]).toMatchObject({
      body: "Which here?",
      anchor: { passage: "Start here", version: 1, inCurrentVersion: true },
    });
    expect((await admin.get("/api/workspace/guidance")).body.guidance).toEqual({ markdown: "Be kind. Be brief.", version: 1 });
  });
});

describe("an export taken apart and archived again", () => {
  it("imports with its folder around it, as `tar czf` of the extracted folder makes", async () => {
    const before = await busyWorkspace();
    const files = await untarGz((await before.admin.download("/api/projects/CRONK/export")).body);
    files["projects/CRONK/tickets/CRONK-2.md"] = files["projects/CRONK/tickets/CRONK-2.md"]!.replace("title: Ticket 2", "title: Edited by hand");
    const wrapped = await tarGz(Object.fromEntries(Object.entries(files).map(([path, text]) => [`cronk-export/${path}`, text])));

    const { admin } = await startInstalledCronk("Elsewhere");
    const imported = await admin.upload("/api/import", wrapped);
    expect(imported.status).toBe(201);
    expect((await admin.get("/api/tickets/CRONK-2")).body.ticket.title).toBe("Edited by hand");
  });
});

describe("an export edited by hand", () => {
  it("is refused when it says what Cronk can't hold, naming the file", async () => {
    const before = await busyWorkspace();
    const files = await untarGz((await before.admin.download("/api/export")).body);
    const edited = async (path: string, edit: (data: any) => void, rename?: string) => {
      const { data, body } = markdown(files[path]);
      edit(data);
      const copy = { ...files };
      delete copy[path];
      copy[rename ?? path] = `---\n${stringify(data)}---\n${body}`;
      return tarGz(copy);
    };
    const { admin } = await startInstalledCronk("Elsewhere");

    const answeredPlan = await admin.upload("/api/import", await edited("projects/CRONK/tickets/CRONK-1.activities/1.md", (d) => (d.answer = 1)));
    expect(answeredPlan.status).toBe(400);
    expect(answeredPlan.body.error).toMatch(/CRONK-1\.activities\/1\.md answer is only for a question/);

    const gap = await admin.upload("/api/import", await edited("guidance.versions/2.md", () => {}, "guidance.versions/3.md"));
    expect(gap.status).toBe(400);
    expect(gap.body.error).toMatch(/guidance\.versions\/3\.md must follow Version 2/);

    const unknown = await admin.upload("/api/import", await edited("projects/CRONK/tickets/CRONK-3.md", (d) => d.documents.push("documents/9-gone.md")));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/CRONK-3\.md documents names documents\/9-gone\.md, which isn't a Document or Report in the export/);

    const twice = await admin.upload("/api/import", await edited("projects/CRONK/project.md", (d) => d.members.push(d.members[0])));
    expect(twice.status).toBe(400);
    expect(twice.body.error).toMatch(/project\.md lists .* as a member twice/);

    expect((await admin.get("/api/projects")).body.projects).toEqual([]);
  });
});

describe("a User an import brought in", () => {
  /** A fresh installation holding an import of a Workspace where Grace was assigned CRONK-1. */
  async function importedGrace() {
    const { cronk: before, admin: beforeAdmin } = await startInstalledCronk();
    const grace = await joinAs(before, beforeAdmin, "grace@example.com", "member", "Grace");
    const graceId = (await grace.get("/api/me")).body.user.id;
    await beforeAdmin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await beforeAdmin.post("/api/projects/CRONK/tickets", { title: "Grace's job" });
    await beforeAdmin.patch("/api/tickets/CRONK-1", { assigneeId: graceId });
    const exported = await beforeAdmin.download("/api/export");

    const { cronk, admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", exported.body)).status).toBe(201);
    const imported = (await admin.get("/api/users")).body.users.find((u: { email: string }) => u.email === "grace@example.com");
    return { cronk, admin, imported };
  }

  it("can be invited, and accepting sets their password, reactivates them and keeps their id and history", async () => {
    const { cronk, admin, imported } = await importedGrace();
    expect(imported).toMatchObject({ name: "Grace", active: false, joined: false });

    const invited = await admin.post("/api/invitations", { email: "grace@example.com" });
    expect(invited.status).toBe(201);
    const accepted = await cronk.client().post(`/api/invitations/by-token/${invited.body.token}/accept`, { name: "Grace H", password: "graces password" });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user).toEqual({ id: imported.id, email: "grace@example.com", name: "Grace H", role: "member", active: true, joined: true });

    const grace = cronk.client();
    expect((await grace.post("/api/sign-in", { email: "grace@example.com", password: "graces password" })).status).toBe(200);
    expect((await grace.get(`/api/projects/CRONK/tickets?assignee=${imported.id}`)).body.tickets.map((t: { key: string }) => t.key)).toEqual(["CRONK-1"]);
  });

  it("can't be invited again once they have a password, so no invitation can take their account", async () => {
    const { cronk, admin } = await importedGrace();
    const first = (await admin.post("/api/invitations", { email: "grace@example.com" })).body.token;
    const replaced = (await admin.post("/api/invitations", { email: "GRACE@example.com" })).body.token;
    expect((await cronk.client().post(`/api/invitations/by-token/${first}/accept`, { name: "Eve", password: "eves password" })).status).toBe(404);
    expect((await cronk.client().post(`/api/invitations/by-token/${replaced}/accept`, { name: "Grace", password: "graces password" })).status).toBe(201);

    const again = await admin.post("/api/invitations", { email: "grace@example.com" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already a User/);
    expect((await cronk.client().post("/api/sign-in", { email: "grace@example.com", password: "graces password" })).status).toBe(200);
  });
});
