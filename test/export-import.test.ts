import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { delegatedSetup, joinAs, registerAgent, startInstalledCronk, startSession, tarGz, untarGz, type Client } from "./harness.js";

/** A Markdown file's frontmatter and body. */
function markdown(text: string | undefined): { data: any; body: string } {
  // The closing --- starts its own line, so an indented --- inside a block scalar doesn't end the frontmatter.
  const match = /^---\n([\s\S]*?\n)?---\n/.exec(text ?? "");
  if (!match) throw new Error(`Not Markdown with frontmatter: ${text}`);
  return { data: parse(match[1] ?? ""), body: text!.slice(match[0].length) };
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

  it("writes Decisions as docs/adr/NNNN-slug.md files with frontmatter", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Limits in the API", body: "Limit sign-ins.", group: "Security" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Per-email limits!", body: "Per email.", supersedes: ["CRONK-D1"] });
    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    await admin.post("/api/decisions/CRONK-D2/status", { status: "accepted" });
    await admin.post("/api/workspace/decisions", { title: "Compose for installs", body: "Use Compose." });

    const project = await untarGz((await admin.download("/api/projects/CRONK/export")).body);
    expect(markdown(project["projects/CRONK/docs/adr/0001-limits-in-the-api.md"])).toEqual({
      data: {
        key: "CRONK-D1",
        title: "Limits in the API",
        status: "superseded",
        group: "Security",
        supersededBy: "CRONK-D2",
        version: 3,
        createdAt: "2026-01-01T09:00:00.000Z",
        createdBy: "ada@example.com",
        updatedAt: "2026-01-01T09:00:00.000Z",
        updatedBy: "ada@example.com",
      },
      body: "Limit sign-ins.",
    });
    expect(markdown(project["projects/CRONK/docs/adr/0002-per-email-limits.md"]).data).toMatchObject({ key: "CRONK-D2", status: "accepted", supersedes: ["CRONK-D1"] });
    expect(markdown(project["projects/CRONK/docs/adr/0001-limits-in-the-api.versions/2.md"]).data).toMatchObject({ status: "accepted", by: "ada@example.com" });
    expect(Object.keys(project).filter((p) => p.startsWith("docs/"))).toEqual([]);

    const workspace = await untarGz((await admin.download("/api/export")).body);
    expect(markdown(workspace["docs/adr/0001-compose-for-installs.md"])).toMatchObject({ data: { key: "D1", status: "proposed" }, body: "Use Compose." });
  });

  it("is only for Admins", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const member = await joinAs(cronk, admin, "grace@example.com");

    expect((await member.download("/api/projects/CRONK/export")).status).toBe(403);
    expect((await member.download("/api/export")).status).toBe(403);
    expect((await member.get("/api/import/renamed-ids")).status).toBe(403);
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
  const decisions = async (path: string) => {
    const { decisions: listed } = await get(path);
    return Promise.all(
      listed.map(async (d: { key: string }) => ({
        ...(await get(`/api/decisions/${d.key}`)),
        versions: await Promise.all((await get(`/api/decisions/${d.key}/versions`)).versions.map((v: { number: number }) => get(`/api/decisions/${d.key}/versions/${v.number}`))),
      })),
    );
  };
  const tree = async (path: string) => {
    const { documents } = await get(path);
    return { documents, contents: await Promise.all(documents.map((d: { id: string }) => document(d.id))) };
  };
  const terms = async (path: string) =>
    Promise.all((await get(path)).terms.map(async (t: { id: string }) => ({ term: t, versions: await get(`/api/terms/${t.id}/versions`) })));
  const project = async (key: string) => {
    const { tickets } = await get(`/api/projects/${key}/tickets`);
    return {
      project: await get(`/api/projects/${key}`),
      members: await get(`/api/projects/${key}/members`),
      guidance: await get(`/api/projects/${key}/guidance`),
      guidanceVersions: await get(`/api/projects/${key}/guidance/versions`),
      terms: await terms(`/api/projects/${key}/terms`),
      documents: await tree(`/api/projects/${key}/documents`),
      decisions: await decisions(`/api/projects/${key}/decisions`),
      tickets: await Promise.all(
        tickets.map(async (t: { key: string }) => {
          const { reports } = await get(`/api/tickets/${t.key}/reports`);
          return {
            ticket: await get(`/api/tickets/${t.key}`),
            activities: await get(`/api/tickets/${t.key}/activities`),
            comments: await get(`/api/tickets/${t.key}/comments`),
            changes: await get(`/api/tickets/${t.key}/changes`),
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
    terms: await terms("/api/workspace/terms"),
    documents: await tree("/api/workspace/documents"),
    decisions: await decisions("/api/workspace/decisions"),
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

  // Autonomous Delegation: a Project default, and CRONK-2 completed by claude-laptop on its own, still Unverified.
  await admin.patch("/api/projects/CRONK", { autonomousByDefault: true });
  await admin.patch("/api/tickets/CRONK-2", { autonomous: true });
  const autonomous = await session();
  await autonomous.post("/api/tickets/CRONK-2/claim");
  await autonomous.post("/api/tickets/CRONK-2/reports", { title: "Done", body: "Shipped the API." });
  const done = (await admin.get("/api/projects/CRONK")).body.statuses.find((s: { category: string }) => s.category === "completed");
  expect((await autonomous.patch("/api/tickets/CRONK-2", { statusId: done.id })).body.ticket.verification).toBe("unverified");
  await autonomous.delete("/api/agent-sessions/current");

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

  // Decisions in both scopes: one superseded by another Grace accepted, one rejected, one edited.
  await admin.post("/api/projects/CRONK/decisions", { title: "Limits in the API", body: "Limit sign-ins.", group: "Security" });
  await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
  await admin.post("/api/projects/CRONK/decisions", { title: "Limits in the proxy", group: "Security" });
  await admin.post("/api/decisions/CRONK-D2/status", { status: "rejected", reason: "The proxy sees no accounts." });
  await admin.post("/api/projects/CRONK/decisions", { title: "Per-email limits", supersedes: ["CRONK-D1"] });
  cronk.clock.advance(60_000);
  await grace.post("/api/decisions/CRONK-D3/status", { status: "accepted" });
  await admin.post("/api/workspace/decisions", { title: "Compose for installs", body: "v1" });
  await admin.patch("/api/decisions/D1", { baseVersion: 1, body: "v2", group: "Ops" });
  // Terms in both places, with Versions, one saved by an Agent; a Project Term overriding a Workspace Term.
  const ticketTerm = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work.", avoid: ["Issue", "task"], group: "Work" })).body.term;
  await admin.patch(`/api/terms/${ticketTerm.id}`, { baseVersion: 1, definition: "A unit of work\n---\ntracked within a *Project*." });
  await admin.post("/api/workspace/terms", { name: "Customer", definition: "A paying organization." });
  const termWriter = await session();
  const customer = (await termWriter.post("/api/projects/CRONK/terms", { name: "customer", definition: "A billing account.", avoid: ["Client"], group: "Billing" })).body.term;
  await termWriter.patch(`/api/terms/${customer.id}`, { baseVersion: 1, avoid: ["Client", "account"] });
  await termWriter.delete("/api/agent-sessions/current");

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
    expect(imported.body).toEqual({ scope: "workspace", projects: ["CRONK", "OLD"], renamedIds: [] });
    // Agents keep their ids, which the snapshot below can't tell apart.
    const agentIds = async (client: Client) => (await client.get("/api/agents?all=true")).body.agents.map((a: { id: string }) => a.id);
    expect(await agentIds(admin)).toEqual(await agentIds(before.admin));
    const comments = (await admin.get("/api/tickets/CRONK-1/comments")).body.comments;
    expect(comments.filter((c: { sendBack: boolean }) => c.sendBack).map((c: { body: string }) => c.body)).toEqual(["Add a test."]);
    const moves = (await admin.get("/api/tickets/CRONK-1/changes")).body.changes.filter((c: { sentBack?: boolean }) => c.sentBack);
    expect(moves.map((c: { to: { name: string } }) => c.to.name)).toEqual(["In Progress"]);

    // Users who weren't in the installation come in deactivated and not joined: they have no password here yet.
    const expected = JSON.parse(JSON.stringify(await snapshot(before.admin)), (_key, value) =>
      value?.email === "grace@example.com" ? { ...value, active: false, joined: false } : value,
    );
    expect(await snapshot(admin)).toEqual(expected);
    // Decision numbers carry on where the export left off.
    expect((await admin.post("/api/projects/CRONK/decisions", { title: "Next" })).body.decision.key).toBe("CRONK-D4");
    expect((await admin.post("/api/workspace/decisions", { title: "Next" })).body.decision.key).toBe("D2");
  });
});

describe("importing a Project export", () => {
  it("adds the Project, matching Users by email and Agents by Owner and name", async () => {
    const before = await busyWorkspace();
    const exported = await before.admin.download("/api/projects/CRONK/export");
    const [exportedLaptop] = (await before.admin.get("/api/agents?all=true")).body.agents;

    const { cronk, admin } = await startInstalledCronk("Elsewhere");
    const grace = await joinAs(cronk, admin, "grace@example.com", "member", "Grace");
    const laptop = (await admin.post("/api/agents", { name: "claude-laptop" })).body.agent;
    await admin.post("/api/projects", { name: "Other", key: "OTHER" });

    const imported = await admin.upload("/api/import", exported.body);
    expect(imported.status).toBe(201);
    // The claude-laptop found here has another id than the export's, so the import keeps which became which.
    expect(imported.body).toEqual({
      scope: "project",
      projects: ["CRONK"],
      renamedIds: [{ kind: "agent", from: exportedLaptop.id, to: laptop.id, at: "2026-01-01T09:00:00.000Z" }],
    });
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

describe("Agent and Agent Session ids across an import", () => {
  /** A Project where the since removed old-bot commented on CRONK-1, then claude-laptop retitled it, each in an Agent Session. */
  async function agentWork() {
    const { cronk, admin, claude, session } = await delegatedSetup(1);
    const old = await registerAgent(admin, "old-bot");
    await admin.patch("/api/tickets/CRONK-1", { delegateId: old.agentId });
    const oldSession = await startSession(cronk, old.secret);
    expect((await oldSession.post("/api/tickets/CRONK-1/comments", { body: "Looking." })).status).toBe(201);
    await oldSession.delete("/api/agent-sessions/current");
    await admin.patch("/api/tickets/CRONK-1", { delegateId: claude.agentId });
    await admin.delete(`/api/agents/${old.agentId}`);
    cronk.clock.advance(60_000);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    expect((await agent.patch("/api/tickets/CRONK-1", { title: "Built" })).status).toBe(200);
    return { cronk, admin, claudeId: claude.agentId, oldId: old.agentId, oldSessionId: oldSession.sessionId, sessionId: agent.sessionId };
  }

  /** Who made the last change to `key`: the Agent's id and its Agent Session's. */
  async function lastChangeBy(admin: Client, key: string): Promise<{ agent: string; session: string }> {
    const { actor } = (await admin.get(`/api/tickets/${key}/changes`)).body.changes.at(-1);
    return { agent: actor.id, session: actor.session?.id };
  }

  it("are kept when the installation has none of them", async () => {
    const { admin: before, claudeId, sessionId } = await agentWork();
    const exported = await before.download("/api/projects/CRONK/export");

    const { admin } = await startInstalledCronk("Elsewhere");
    const imported = await admin.upload("/api/import", exported.body);
    expect(imported.status).toBe(201);
    expect(await lastChangeBy(admin, "CRONK-1")).toEqual({ agent: claudeId, session: sessionId });
    expect(imported.body.renamedIds).toEqual([]);
    expect((await admin.get("/api/import/renamed-ids")).body.renamedIds).toEqual([]);
  });

  it("are new when taken, as importing the same export twice finds them, and the import keeps which became which", async () => {
    const { admin: before, claudeId, oldId, oldSessionId, sessionId } = await agentWork();
    const files = await untarGz((await before.download("/api/projects/CRONK/export")).body);
    // The same export again, under a key the Workspace doesn't have yet.
    const copy = await tarGz(Object.fromEntries(Object.entries(files).map(([path, text]) => [path.replaceAll("CRONK", "COPY"), text.replaceAll("CRONK", "COPY")])));

    const { cronk, admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", await tarGz(files))).status).toBe(201);
    cronk.clock.advance(60_000);
    const again = await admin.upload("/api/import", copy);
    expect(again.status).toBe(201);

    // claude-laptop is found by Owner and name, so it is the same Agent; the removed old-bot and both Agent Sessions come in again under new ids.
    const copied = await lastChangeBy(admin, "COPY-1");
    expect(copied.agent).toBe(claudeId);
    expect(copied.session).not.toBe(sessionId);
    const { renamedIds } = again.body;
    expect(renamedIds).toEqual([
      { kind: "agent", from: oldId, to: expect.any(String), at: "2026-01-01T09:01:00.000Z" },
      { kind: "agentSession", from: oldSessionId, to: expect.any(String), at: "2026-01-01T09:01:00.000Z" },
      { kind: "agentSession", from: sessionId, to: copied.session, at: "2026-01-01T09:01:00.000Z" },
    ]);
    expect(renamedIds[0].to).not.toBe(oldId);
    expect(renamedIds[1].to).not.toBe(oldSessionId);
    // The copied Comment is old-bot's under its new ids.
    const [looking] = (await admin.get("/api/tickets/COPY-1/comments")).body.comments;
    expect(looking.actor).toMatchObject({ id: renamedIds[0].to, session: { id: renamedIds[1].to } });
    expect((await admin.get("/api/import/renamed-ids")).body.renamedIds).toEqual(renamedIds);
    // An export edited by hand may name an Agent Session by an id Cronk can't hold; it gets a new one, kept as well.
    const edited = await tarGz(Object.fromEntries(Object.entries(files).map(([path, text]) => [path.replaceAll("CRONK", "HAND"), text.replaceAll("CRONK", "HAND").replaceAll(sessionId, "my-session")])));
    const byHand = await admin.upload("/api/import", edited);
    expect(byHand.status).toBe(201);
    expect(byHand.body.renamedIds).toContainEqual(expect.objectContaining({ kind: "agentSession", from: "my-session", to: (await lastChangeBy(admin, "HAND-1")).session }));
    // The first import's Project still names the ids it kept.
    expect(await lastChangeBy(admin, "CRONK-1")).toEqual({ agent: claudeId, session: sessionId });
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

describe("Terms in an export", () => {
  it("are written as GLOSSARY.md per place, and beside it a terms.md holding them whole", async () => {
    const { admin } = await busyWorkspace();
    const files = await untarGz((await admin.download("/api/export")).body);

    expect(files["GLOSSARY.md"]).toBe(
      "# Acme Labs glossary\n\n" +
        "**Customer**:\nA paying organization.\n\n" +
        "## Work\n\n" +
        "**Ticket**:\nA unit of work\n---\ntracked within a *Project*.\n_Avoid_: Issue, task\n",
    );
    expect(files["projects/CRONK/GLOSSARY.md"]).toBe(
      "# CRONK glossary\n\nWithin CRONK, these Terms replace the Workspace's of the same name.\n\n" +
        "## Billing\n\n" +
        "**customer**:\nA billing account.\n_Avoid_: Client, account\n",
    );
    const { data } = markdown(files["projects/CRONK/terms.md"]);
    expect(data.terms).toEqual([
      expect.objectContaining({
        name: "customer",
        definition: "A billing account.",
        avoid: ["Client", "account"],
        group: "Billing",
        version: 2,
        versions: [expect.objectContaining({ number: 1, avoid: ["Client"] }), expect.objectContaining({ number: 2, avoid: ["Client", "account"] })],
      }),
    ]);
  });

  it("downloads a place's GLOSSARY.md on its own", async () => {
    const { admin } = await busyWorkspace();

    const res = await admin.download("/api/projects/CRONK/terms/glossary");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/markdown/);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="GLOSSARY.md"');
    expect(res.body.toString()).toBe((await untarGz((await admin.download("/api/export")).body))["projects/CRONK/GLOSSARY.md"]);
    expect((await admin.download("/api/workspace/terms/glossary")).body.toString()).toMatch(/^# Acme Labs glossary/);
  });

  it("without Versions import each Term at a single Version holding what it says now", async () => {
    const before = await busyWorkspace();
    const exported = await before.admin.download("/api/export?versions=false");

    const { admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", exported.body)).status).toBe(201);
    const [customer] = (await admin.get("/api/projects/CRONK/terms?name=customer")).body.terms;
    expect(customer).toMatchObject({ avoid: ["Client", "account"], version: 1 });
    expect((await admin.get(`/api/terms/${customer.id}/versions`)).body.versions).toMatchObject([
      { number: 1, avoid: ["Client", "account"], actor: { kind: "agent", name: "claude-laptop" } },
    ]);
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

    const cronkTerms = "projects/CRONK/terms.md";
    const sameName = await admin.upload("/api/import", await edited(cronkTerms, (d) => d.terms.push({ ...d.terms[0], name: "CUSTOMER" })));
    expect(sameName.status).toBe(400);
    expect(sameName.body.error).toMatch(/CRONK\/terms\.md terms\[1\] has the name CUSTOMER, which another Term there has/);

    const missingVersion = await admin.upload("/api/import", await edited(cronkTerms, (d) => d.terms[0].versions.shift()));
    expect(missingVersion.status).toBe(400);
    expect(missingVersion.body.error).toMatch(/CRONK\/terms\.md terms\[0\] versions must be numbered 1, 2, 3/);

    const disagrees = await admin.upload("/api/import", await edited(cronkTerms, (d) => (d.terms[0].definition = "Something else.")));
    expect(disagrees.status).toBe(400);
    expect(disagrees.body.error).toMatch(/CRONK\/terms\.md terms\[0\] must say what its Version 2 says/);

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

  it("can't be given a password reset link, even once reactivated: they join by invitation", async () => {
    const { admin, imported } = await importedGrace();
    expect((await admin.post(`/api/users/${imported.id}/password-reset`)).status).toBe(409);
    await admin.patch(`/api/users/${imported.id}`, { active: true });
    const refused = await admin.post(`/api/users/${imported.id}/password-reset`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/invite them/);
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

describe("a change Cronk made itself", () => {
  it("is exported as by no one and imported as Cronk's again", async () => {
    const { cronk, admin, adaId } = await delegatedSetup(1);
    await cronk.undoMigration("0018_assign_delegated_tickets", "UPDATE tickets SET assignee_id = NULL");
    await cronk.restart();
    const exported = await admin.download("/api/projects/CRONK/export");
    const history = markdown((await untarGz(exported.body))["projects/CRONK/tickets/CRONK-1.history.md"]).data.changes;
    expect(history.at(-1)).toMatchObject({ by: null, change: "assignee", from: null, to: { id: adaId, name: "Ada" } });

    const elsewhere = await startInstalledCronk("Elsewhere");
    expect((await elsewhere.admin.upload("/api/import", exported.body)).status).toBe(201);
    const { changes } = (await elsewhere.admin.get("/api/tickets/CRONK-1/changes")).body;
    expect(changes.at(-1)).toMatchObject({ actor: { kind: "system" }, change: "assignee", from: null, to: { name: "Ada" } });
  });
});

describe("a delegated Ticket without an Assignee in an export", () => {
  it("is imported assigned to its Delegate's Owner, recorded as a Change by Cronk itself", async () => {
    const { admin } = await delegatedSetup(1);
    const files = await untarGz((await admin.download("/api/projects/CRONK/export")).body);
    // As an export from before delegating always assigned someone could hold.
    const path = "projects/CRONK/tickets/CRONK-1.md";
    const { data, body } = markdown(files[path]);
    data.assignee = null;
    files[path] = `---\n${stringify(data)}---\n${body}`;

    const elsewhere = await startInstalledCronk("Elsewhere");
    expect((await elsewhere.admin.upload("/api/import", await tarGz(files))).status).toBe(201);
    const ada = { id: (await elsewhere.admin.get("/api/me")).body.user.id, name: "Ada" };
    const { ticket } = (await elsewhere.admin.get("/api/tickets/CRONK-1")).body;
    expect(ticket.assignee).toEqual(ada);
    expect(ticket.delegate).toMatchObject({ name: "claude-laptop" });
    const { changes } = (await elsewhere.admin.get("/api/tickets/CRONK-1/changes")).body;
    expect(changes.at(-1)).toMatchObject({ actor: { kind: "system" }, change: "assignee", from: null, to: ada });
  });
});
