import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { delegatedSetup, joinAs, startInstalledCronk, untarGz, type Client } from "./harness.js";

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
    await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "# Plan\n\nShip." });

    const res = await admin.download("/api/projects/CRONK/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="cronk-CRONK-.*\.tar\.gz"/);
    const files = await untarGz(res.body);

    expect(markdown(files["README.md"]).data.cronk).toMatchObject({ format: 1, scope: "project", versions: false });
    expect(markdown(files["projects/CRONK/project.md"]).data).toMatchObject({
      key: "CRONK",
      name: "Cronk",
      statuses: expect.arrayContaining([{ name: "Todo", category: "unstarted" }]),
    });
    const ticket = markdown(files["projects/CRONK/tickets/CRONK-1.md"]);
    expect(ticket.data).toMatchObject({ title: "Build it", status: "Backlog", priority: "high", labels: ["core"], assignee: "ada@example.com", blocks: ["CRONK-2"] });
    expect(ticket.body).toBe("All of it.");
    expect(markdown(files["projects/CRONK/tickets/CRONK-2.md"]).data).toMatchObject({ parent: "CRONK-1", blockedBy: ["CRONK-1"] });
    expect(markdown(files["projects/CRONK/tickets/CRONK-1.comments/1.md"])).toEqual({
      data: { at: "2026-01-01T09:00:00.000Z", by: "ada@example.com" },
      body: "Starting.",
    });
    expect(markdown(files["projects/CRONK/documents/1-plan.md"])).toMatchObject({ data: { title: "Plan", version: 1 }, body: "# Plan\n\nShip." });
    expect(markdown(files["people.md"]).data.users).toEqual([{ email: "ada@example.com", name: "Ada", role: "admin", active: true }]);
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
  await admin.post("/api/projects/CRONK/statuses", { name: "Blocked", category: "started" });
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

  // A second, archived Project; a removed Agent.
  await admin.post("/api/projects", { name: "Old", key: "OLD" });
  await admin.post("/api/projects/OLD/tickets", { title: "Legacy" });
  await admin.post("/api/tickets/OLD-1/relations", { kind: "relates_to", ticketKey: "CRONK-1" });
  await admin.patch("/api/projects/OLD", { archived: true });
  const gone = (await admin.post("/api/agents", { name: "old-bot" })).body.agent;
  await admin.delete(`/api/agents/${gone.id}`);
  return { cronk, admin, grace };
}

describe("importing an export", () => {
  it("recreates the same data in a fresh installation, Versions and all", async () => {
    const before = await busyWorkspace();
    const exported = await before.admin.download("/api/export?versions=true");
    expect(exported.status).toBe(200);

    const { admin } = await startInstalledCronk("Elsewhere");
    const imported = await admin.upload("/api/import", exported.body);
    expect(imported.status).toBe(201);
    expect(imported.body).toEqual({ scope: "workspace", projects: ["CRONK", "OLD"] });

    // Users who weren't in the installation come in deactivated: they have no password here yet.
    const expected = JSON.parse(JSON.stringify(await snapshot(before.admin)), (_key, value) =>
      value?.email === "grace@example.com" ? { ...value, active: false } : value,
    );
    expect(await snapshot(admin)).toEqual(expected);
  });
});
