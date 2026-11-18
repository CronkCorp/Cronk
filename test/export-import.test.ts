import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ARTIFACT_HOST, delegatedSetup, joinAs, OWN_ORIGIN, registerAgent, startInstalledCronk, startSession, statusIn, tarGz, untarGz, type Client } from "./harness.js";

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
    await admin.upload("/api/tickets/CRONK-1/attachments?name=sign-in-flood.log", Buffer.from("429 x 50\n"), "text/plain");

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
    // Attachments are their files, with an index saying what each is.
    expect(markdown(files["projects/CRONK/tickets/CRONK-1.attachments/index.md"]).data.attachments).toEqual([
      { id: expect.any(String), file: "1-sign-in-flood.log", name: "sign-in-flood.log", contentType: "text/plain", size: 9, at: "2026-01-01T09:00:00.000Z", by: "ada@example.com" },
    ]);
    expect(files["projects/CRONK/tickets/CRONK-1.attachments/1-sign-in-flood.log"]).toBe("429 x 50\n");
    expect(markdown(files["projects/CRONK/documents/1-plan.md"])).toMatchObject({ data: { title: "Plan", version: 1 }, body: "# Plan\n\nShip." });
    expect(markdown(files["people.md"]).data.users).toEqual([{ email: "ada@example.com", name: "Ada", role: "admin", active: true, diffView: "unified" }]);
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
        // Accepting it marked it Protected; being superseded since leaves the mark.
        protected: true,
        protection: [{ protected: true, at: "2026-01-01T09:00:00.000Z", by: "ada@example.com" }],
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

describe("exporting a scope's Decisions as docs/adr", () => {
  it("downloads a Project's Decisions as the same docs/adr files the Project export writes, and nothing else", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Other", key: "OTHER" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Limits in the API", body: "Limit sign-ins.", group: "Security" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Per-email limits!", body: "Per email.", supersedes: ["CRONK-D1"] });
    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    await admin.post("/api/decisions/CRONK-D2/status", { status: "accepted" });
    await admin.post("/api/projects/OTHER/decisions", { title: "Elsewhere" });
    await admin.post("/api/workspace/decisions", { title: "Compose for installs" });

    const res = await admin.download("/api/projects/CRONK/decisions/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="cronk-CRONK-adr-2026-01-01T09-00-00.tar.gz"');
    const files = await untarGz(res.body);

    expect(Object.keys(files).sort()).toEqual(["docs/adr/0001-limits-in-the-api.md", "docs/adr/0002-per-email-limits.md"]);
    expect(markdown(files["docs/adr/0001-limits-in-the-api.md"])).toMatchObject({
      data: { key: "CRONK-D1", title: "Limits in the API", status: "superseded", group: "Security", supersededBy: "CRONK-D2" },
      body: "Limit sign-ins.",
    });
    const full = await untarGz((await admin.download("/api/projects/CRONK/export")).body);
    for (const path of Object.keys(files)) expect(files[path]).toBe(full[`projects/CRONK/${path}`]);
  });

  it("downloads the Workspace's own Decisions, none from any Project", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Limits in the API" });
    await admin.post("/api/workspace/decisions", { title: "Compose for installs", body: "v1" });
    await admin.patch("/api/decisions/D1", { baseVersion: 1, body: "Use Compose." });

    const res = await admin.download("/api/workspace/decisions/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="cronk-workspace-adr-2026-01-01T09-00-00.tar.gz"');
    const files = await untarGz(res.body);

    // Two Versions, but only the current file.
    expect(Object.keys(files)).toEqual(["docs/adr/0001-compose-for-installs.md"]);
    expect(markdown(files["docs/adr/0001-compose-for-installs.md"])).toMatchObject({ data: { key: "D1", version: 2 }, body: "Use Compose." });
    const full = await untarGz((await admin.download("/api/export")).body);
    expect(files["docs/adr/0001-compose-for-installs.md"]).toBe(full["docs/adr/0001-compose-for-installs.md"]);
  });

  it("answers an empty archive for a scope with no Decisions", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });

    for (const path of ["/api/workspace/decisions/export", "/api/projects/CRONK/decisions/export"]) {
      const res = await admin.download(path);
      expect(res.status).toBe(200);
      expect(await untarGz(res.body)).toEqual({});
    }
  });

  it("is for anyone who can read the Decisions, hiding a Project they can't see", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Limits in the API" });
    await admin.post("/api/projects/SECRET/decisions", { title: "Hush" });
    await admin.post("/api/workspace/decisions", { title: "Compose for installs" });
    const grace = await joinAs(cronk, admin, "grace@example.com");
    const claude = cronk.client((await registerAgent(grace, "claude-laptop")).secret);

    expect(Object.keys(await untarGz((await grace.download("/api/projects/CRONK/decisions/export")).body))).toEqual(["docs/adr/0001-limits-in-the-api.md"]);
    expect(Object.keys(await untarGz((await grace.download("/api/workspace/decisions/export")).body))).toEqual(["docs/adr/0001-compose-for-installs.md"]);
    expect((await claude.download("/api/workspace/decisions/export")).status).toBe(200);
    expect((await claude.download("/api/projects/CRONK/decisions/export")).status).toBe(200);
    expect((await grace.download("/api/projects/SECRET/decisions/export")).status).toBe(404);
    const stranger = cronk.client();
    expect((await stranger.download("/api/workspace/decisions/export")).status).toBe(401);
    expect((await stranger.download("/api/projects/CRONK/decisions/export")).status).toBe(401);
  });
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Everything an Admin can read through the API about the Workspace, with ids replaced by the
 * order they first appear in, so two installations holding the same data read the same.
 */
async function everythingAdminReads(admin: Client): Promise<unknown> {
  const get = async (path: string) => {
    const res = await admin.get(path);
    if (res.status !== 200) throw new Error(`GET ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const attachments = async (path: string) =>
    Promise.all(
      (await get(path)).attachments.map(async (a: { id: string }) => ({ ...a, file: (await admin.download(`/api/attachments/${a.id}/file`)).body.toString("base64") })),
    );
  const document = async (id: string) => ({
    ...(await get(`/api/documents/${id}`)),
    protection: await get(`/api/documents/${id}/protection`),
    versions: await Promise.all((await get(`/api/documents/${id}/versions`)).versions.map((v: { number: number }) => get(`/api/documents/${id}/versions/${v.number}`))),
    comments: await get(`/api/documents/${id}/comments`),
    attachments: await attachments(`/api/documents/${id}/attachments`),
  });
  const decisions = async (path: string) => {
    const { decisions: listed } = await get(path);
    return Promise.all(
      listed.map(async (d: { key: string }) => ({
        ...(await get(`/api/decisions/${d.key}`)),
        protection: await get(`/api/decisions/${d.key}/protection`),
        versions: await Promise.all((await get(`/api/decisions/${d.key}/versions`)).versions.map((v: { number: number }) => get(`/api/decisions/${d.key}/versions/${v.number}`))),
      })),
    );
  };
  const tree = async (path: string) => {
    const { documents } = await get(path);
    return { documents, contents: await Promise.all(documents.map((d: { id: string }) => document(d.id))) };
  };
  const terms = async (path: string) =>
    Promise.all((await get(path)).terms.map(async (t: { id: string }) => ({ term: t, versions: await get(`/api/terms/${t.id}/versions`), protection: await get(`/api/terms/${t.id}/protection`) })));
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
      artifacts: await artifacts(`/api/projects/${key}/artifacts`),
      tickets: await Promise.all(
        tickets.map(async (t: { key: string }) => {
          const { reports } = await get(`/api/tickets/${t.key}/reports`);
          return {
            ticket: await get(`/api/tickets/${t.key}`),
            activities: await get(`/api/tickets/${t.key}/activities`),
            comments: await get(`/api/tickets/${t.key}/comments`),
            changes: await get(`/api/tickets/${t.key}/changes`),
            attachments: await attachments(`/api/tickets/${t.key}/attachments`),
            reports,
            reportContents: await Promise.all(reports.map((r: { id: string }) => document(r.id))),
          };
        }),
      ),
    };
  };
  // An Artifact, its Versions and the files each serves; frame addresses are signed per installation, so only their files count.
  const artifacts = async (path: string) =>
    Promise.all(
      (await get(path)).artifacts.map(async (a: { id: string }) => {
        const { frameUrl: _latest, ...artifact } = (await get(`/api/artifacts/${a.id}`)).artifact;
        const versions = await Promise.all(
          artifact.versions.map(async (v: { number: number }) => {
            const { frameUrl, ...version } = (await get(`/api/artifacts/${a.id}/versions/${v.number}`)).version;
            const served = await Promise.all(
              version.files.map(async (f: { path: string }) => (await admin.download(`${new URL(frameUrl).pathname}${f.path}`, { host: ARTIFACT_HOST })).body.toString("base64")),
            );
            return { version, served };
          }),
        );
        const { comments } = await get(`/api/artifacts/${a.id}/comments`);
        return { artifact, versions, protection: await get(`/api/artifacts/${a.id}/protection`), comments, attachments: await attachments(`/api/artifacts/${a.id}/attachments`) };
      }),
    );
  const projects = [...(await get("/api/projects")).projects, ...(await get("/api/projects?archived=true")).projects];
  const raw = {
    workspace: await get("/api/workspace"),
    storage: await get("/api/workspace/storage"),
    users: await get("/api/users"),
    agents: await get("/api/agents?all=true"),
    guidance: await get("/api/workspace/guidance"),
    guidanceVersions: await get("/api/workspace/guidance/versions"),
    terms: await terms("/api/workspace/terms"),
    documents: await tree("/api/workspace/documents"),
    decisions: await decisions("/api/workspace/decisions"),
    artifacts: await artifacts("/api/workspace/artifacts"),
    projects: await Promise.all(projects.map((p: { key: string }) => project(p.key))),
    inbox: await get("/api/inbox"),
  };
  const ids = new Map<string, string>();
  return JSON.parse(JSON.stringify(raw).replace(UUID, (id) => ids.get(id) ?? (ids.set(id, `#${ids.size + 1}`), `#${ids.size}`)));
}

/**
 * The options of a test built on `busyWorkspace`. Making it takes some 150 requests, a few seconds alone but several
 * times that while the full suite runs on a slower machine, past the default 30 s (#335).
 */
const BUSY_WORKSPACE_TEST = { timeout: 120_000 };

/** A Workspace with some of everything in it, made by Ada, Grace and Ada's Agent claude-laptop. */
async function busyWorkspace() {
  const { cronk, admin, session, claude } = await delegatedSetup(3);
  const grace = await joinAs(cronk, admin, "grace@example.com", "member", "Grace");
  const graceId = (await grace.get("/api/me")).body.user.id;
  await admin.patch("/api/workspace", { name: "Acme Labs", agentAccess: "write", silenceThresholdSeconds: 600, attachmentMaxBytes: 5 * 1024 * 1024, artifactMaxBytes: 30 * 1024 * 1024, artifactMaxFiles: 800, artifactAllowedOrigins: ["https://esm.sh"] });
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
  // An Artifact the Agent published from CRONK-1, then Ada's second Version of it, with a binary file; she marks it Protected.
  const prototype = (await agent.upload("/api/projects/CRONK/artifacts?title=Cache%20prototype", await tarGz({ "index.html": "<p>v1</p>", "img/chart.png": "\u0089PNG" }))).body.artifact;
  // Ada's declares an extra origin; then she turns extra origins off for the Workspace.
  const extraOrigins = encodeURIComponent(JSON.stringify([{ origin: "https://cdn.plot.ly", uses: ["scripts", "connect"], reason: "Plotly draws it" }]));
  await admin.upload(`/api/artifacts/${prototype.id}/versions?baseVersion=1&title=Cache%20dashboard&extraOrigins=${extraOrigins}`, await tarGz({ "index.html": "<p>v2</p>", "data.json": "[1,2]" }));
  await admin.post(`/api/artifacts/${prototype.id}/protection`, { protected: true });
  // Ada comments on its first Version, with a file, and the Agent replies on the second.
  const onPrototype = (await admin.post(`/api/artifacts/${prototype.id}/comments`, { body: "The chart needs a legend.", version: 1 })).body.comment;
  await admin.upload(`/api/comments/${onPrototype.id}/attachments?name=legend.txt`, Buffer.from("legend"), "text/plain");
  await agent.post(`/api/artifacts/${prototype.id}/comments`, { body: "Version 2 has one.", replyToCommentId: onPrototype.id, version: 2 });
  await admin.patch("/api/workspace", { artifactExtraOriginsAllowed: false });
  // Attachments: the Agent's binary screenshot, and two of Ada's, one named as a hidden file would be.
  await agent.upload("/api/tickets/CRONK-1/attachments?name=proxy-ip.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]), "image/png");
  await admin.upload("/api/tickets/CRONK-1/attachments?name=.env.example", Buffer.from("A=1"), "text/plain");
  await admin.upload("/api/tickets/CRONK-2/attachments?name=notes.md", Buffer.from("---\ntitle: not a Ticket\n---\n"), "text/markdown");
  // ...and on the Report, on Ada's answer, and on the Agent's own Comment.
  // Each a minute apart: Attachments list in the order attached, which an import, going item by item, can't keep for ties.
  cronk.clock.advance(60_000);
  await agent.upload(`/api/documents/${report.id}/attachments?name=trace.log`, Buffer.from("cache miss"), "text/plain");
  cronk.clock.advance(60_000);
  await admin.upload(`/api/comments/${answer.id}/attachments?name=disk.png`, Buffer.from([0x89, 0x50, 0x01]), "image/png");
  await agent.patch(`/api/documents/${report.id}`, { baseVersion: 1, body: "It was the disk cache." });
  const inReview = await statusIn(admin, "in_review");
  expect((await agent.patch("/api/tickets/CRONK-1", { statusId: inReview })).status).toBe(200);
  await agent.delete("/api/agent-sessions/current");
  // Ada sends it back once, then puts it In Review again herself.
  await admin.post("/api/tickets/CRONK-1/send-back", { comment: "Add a test." });
  await admin.patch("/api/tickets/CRONK-1", { statusId: inReview });

  // Autonomous Delegation: a Project default, and CRONK-2 completed by claude-laptop on its own, still Unverified.
  await admin.patch("/api/projects/CRONK", { autonomousByDefault: true });
  await admin.patch("/api/tickets/CRONK-2", { autonomous: true });
  const autonomous = await session();
  await autonomous.post("/api/tickets/CRONK-2/claim");
  // It proposes a Decision from CRONK-2 on the way, which its Report lists.
  await autonomous.post("/api/projects/CRONK/decisions", { title: "Version the API", body: "Under /v1." });
  await autonomous.post("/api/tickets/CRONK-2/reports", { title: "Done", body: "Shipped the API." });
  const done = await statusIn(admin, "completed");
  expect((await autonomous.patch("/api/tickets/CRONK-2", { statusId: done })).body.ticket.verification).toBe("unverified");
  // A minute later, Ada Reopens it once and claude-laptop completes it again; the minute keeps its two Reports in order.
  cronk.clock.advance(60_000);
  await admin.post("/api/tickets/CRONK-2/reopen", { comment: "Version it.", dependents: {} });
  await autonomous.post("/api/tickets/CRONK-2/claim");
  await autonomous.post("/api/tickets/CRONK-2/reports", { title: "Done again", body: "Versioned." });
  expect((await autonomous.patch("/api/tickets/CRONK-2", { statusId: done })).body.ticket.verification).toBe("unverified");
  await autonomous.delete("/api/agent-sessions/current");

  // Documents with Versions and Comments, in both page trees, in the same minute.
  const guide = (await admin.post("/api/projects/CRONK/documents", { title: "Guide", body: "# Guide\n\nStart here." })).body.document;
  await admin.post("/api/projects/CRONK/documents", { title: "Setup / Docker", body: "docker compose up", parentId: guide.id });
  await admin.post("/api/projects/CRONK/documents", { title: "Roadmap" });
  await admin.patch(`/api/documents/${guide.id}`, { baseVersion: 1, body: "# Guide\n\nStart here, then read on." });
  await admin.post(`/api/documents/${guide.id}/versions/1/restore`, { baseVersion: 2 });
  const remark = (await grace.post(`/api/documents/${guide.id}/comments`, { body: "Which here?", anchor: { passage: "Start here" } })).body.comment;
  const reply = (await admin.post(`/api/documents/${guide.id}/comments`, { body: "This one.", replyToCommentId: remark.id })).body.comment;
  // Attachments on a Document, kept across its Versions, and on a Comment on it.
  await admin.upload(`/api/documents/${guide.id}/attachments?name=map.png`, Buffer.from([0x89, 0x50, 0x02]), "image/png");
  cronk.clock.advance(60_000);
  await admin.upload(`/api/comments/${reply.id}/attachments?name=here.png`, Buffer.from([0x89, 0x50, 0x03]), "image/png");
  await admin.post("/api/workspace/documents", { title: "Handbook", body: "Welcome." });
  await admin.upload("/api/workspace/artifacts?title=Team%20board", await tarGz({ "index.html": "<p>team</p>" }));
  // A line of dashes, as frontmatter ends with, in a title, a body and an anchored passage.
  const notes = (await admin.post("/api/workspace/documents", { title: "Notes ---", body: "intro\n---\nmore" })).body.document;
  await admin.post(`/api/documents/${notes.id}/comments`, { body: "Rule?", anchor: { passage: "intro\n---\nmore" } });

  // Decisions in both scopes: one superseded by another Grace accepted, one rejected, one edited; CRONK-D1 is claude-laptop's, above.
  await admin.post("/api/projects/CRONK/decisions", { title: "Limits in the API", body: "Limit sign-ins.", group: "Security" });
  await admin.post("/api/decisions/CRONK-D2/status", { status: "accepted" });
  await admin.post("/api/projects/CRONK/decisions", { title: "Limits in the proxy", group: "Security" });
  await admin.post("/api/decisions/CRONK-D3/status", { status: "rejected", reason: "The proxy sees no accounts." });
  await admin.post("/api/projects/CRONK/decisions", { title: "Per-email limits", supersedes: ["CRONK-D2"] });
  cronk.clock.advance(60_000);
  await grace.post("/api/decisions/CRONK-D4/status", { status: "accepted" });
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
  // Protected marks: Grace's on the Guide branch, a Term marked and unmarked, a Term marked, and an accepted Decision unmarked.
  cronk.clock.advance(60_000);
  await grace.post(`/api/documents/${guide.id}/protection`, { protected: true });
  await admin.post(`/api/terms/${customer.id}/protection`, { protected: true });
  await admin.post(`/api/terms/${customer.id}/protection`, { protected: false });
  await admin.post(`/api/terms/${ticketTerm.id}/protection`, { protected: true });
  await admin.post("/api/decisions/CRONK-D2/protection", { protected: false });

  // Suggestions by claude-laptop while it holds CRONK-4's Claim: on the Guide, accepted as is; on the Ticket Term, accepted with Ada's
  // edits; on CRONK-D4, from CRONK-4, rejected; and open ones on the Workspace's Guidance, in Triage, and CRONK's, which Ada reviews.
  await admin.post("/api/projects/CRONK/tickets", { title: "Tidy the docs" });
  await admin.patch("/api/tickets/CRONK-4", { assigneeId: (await admin.get("/api/me")).body.user.id, delegateId: claude.agentId });
  const suggester = await session();
  expect((await suggester.post("/api/tickets/CRONK-4/claim")).status).toBe(200);
  const suggest = async (item: object, baseVersion: number, content: object) => {
    const made = await suggester.post("/api/suggestions", { item, baseVersion, content, reasoning: "Clearer, *I think*." });
    expect(made.status).toBe(201);
    return made.body.suggestion.id as string;
  };
  const suggestions = [
    await suggest({ kind: "document", id: guide.id }, 3, { body: "# Guide\n\nStart here.\n---\nThen read on." }),
    await suggest({ kind: "term", id: ticketTerm.id }, 2, { avoid: ["Issue"] }),
    await suggest({ kind: "decision", key: "CRONK-D4" }, 2, { title: "Per-email sign-in limits", group: "Security" }),
    await suggest({ kind: "guidance" }, 2, { markdown: "Be kind and brief." }),
    await suggest({ kind: "guidance", project: "CRONK" }, 1, { markdown: "Run the tests first." }),
  ];
  cronk.clock.advance(60_000);
  await admin.post(`/api/suggestions/${suggestions[0]}/accept`);
  await admin.post(`/api/suggestions/${suggestions[1]}/accept`, { content: { avoid: ["Issue", "job"] } });
  await grace.post(`/api/suggestions/${suggestions[2]}/reject`, { reason: "Keep the title." });
  // Discovered Tickets it files from CRONK-4, which its Report lists: CRONK-5 waits in Ada's Inbox, blocking CRONK-3; CRONK-6 she keeps in Backlog.
  await suggester.post("/api/projects/CRONK/tickets", { title: "Dead links in the docs", blocks: [{ ticketKey: "CRONK-3", reason: "Its docs link to the dead pages." }] });
  await suggester.post("/api/projects/CRONK/tickets", { title: "Docs build is slow" });
  await suggester.post("/api/tickets/CRONK-4/reports", { title: "Tidied", body: "Found two more." });
  await admin.post("/api/tickets/CRONK-6/keep");
  await suggester.delete("/api/agent-sessions/current");

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
  return { cronk, admin, grace, suggestions };
}

describe("importing an export", () => {
  it("recreates the same data in a fresh installation, Versions and all", BUSY_WORKSPACE_TEST, async () => {
    const before = await busyWorkspace();
    const exported = await before.admin.download("/api/export");
    expect(exported.status).toBe(200);

    const { admin } = await startInstalledCronk("Elsewhere");
    const imported = await admin.upload("/api/import", exported.body);
    expect(imported.status).toBe(201);
    expect(imported.body).toEqual({ scope: "workspace", projects: ["CRONK", "OLD"], renamedIds: [] });
    // Agents keep their ids, which the comparison below can't tell apart.
    const agentIds = async (client: Client) => (await client.get("/api/agents?all=true")).body.agents.map((a: { id: string }) => a.id);
    expect(await agentIds(admin)).toEqual(await agentIds(before.admin));
    const comments = (await admin.get("/api/tickets/CRONK-1/comments")).body.comments;
    expect(comments.filter((c: { sendBack: boolean }) => c.sendBack).map((c: { body: string }) => c.body)).toEqual(["Add a test."]);
    const moves = (await admin.get("/api/tickets/CRONK-1/changes")).body.changes.filter((c: { sentBack?: boolean }) => c.sentBack);
    expect(moves.map((c: { to: { name: string } }) => c.to.name)).toEqual(["In Progress"]);
    const reopenings = (await admin.get("/api/tickets/CRONK-2/changes")).body.changes.filter((c: { reopened?: boolean }) => c.reopened);
    expect(reopenings.map((c: { from: { name: string }; to: { name: string } }) => [c.from.name, c.to.name])).toEqual([["Done", "In Progress"]]);

    // Users who weren't in the installation come in deactivated and not joined: they have no password here yet.
    const expected = JSON.parse(JSON.stringify(await everythingAdminReads(before.admin)), (_key, value) =>
      value?.email === "grace@example.com" ? { ...value, active: false, joined: false } : value,
    );
    expect(await everythingAdminReads(admin)).toEqual(expected);
    // Suggestions keep their ids, as Agents may have noted them, and all they hold.
    const own = ({ id, baseVersion, base, content, reasoning, at, sourceTicket, state, outdated, acceptedWithEdits, resultVersion, decidedAt, reason, item, reviewer }: any) => ({
      ...{ id, baseVersion, base, content, reasoning, at, sourceTicket, state, outdated, acceptedWithEdits, resultVersion, decidedAt, reason },
      item: { kind: item.kind, key: item.key, title: item.title, projectKey: item.projectKey, version: item.version },
      reviewer: reviewer?.name ?? null,
    });
    for (const id of before.suggestions) {
      const read = async (client: Client) => own((await client.get(`/api/suggestions/${id}`)).body.suggestion);
      expect(await read(admin)).toEqual(await read(before.admin));
    }
    // Decision numbers carry on where the export left off.
    expect((await admin.post("/api/projects/CRONK/decisions", { title: "Next" })).body.decision.key).toBe("CRONK-D5");
    expect((await admin.post("/api/workspace/decisions", { title: "Next" })).body.decision.key).toBe("D2");
  });
});

describe("importing a Project export", () => {
  it("adds the Project, matching Users by email and Agents by Owner and name", BUSY_WORKSPACE_TEST, async () => {
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
    expect((await admin.post("/api/projects/CRONK/tickets", { title: "Next" })).body.ticket.key).toBe("CRONK-7");
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

  it("is refused when the key is taken, and a Workspace export is refused once the Workspace holds anything", BUSY_WORKSPACE_TEST, async () => {
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

  it("is only for Admins, and only for Cronk exports", BUSY_WORKSPACE_TEST, async () => {
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
  it("is refused when a change in it isn't one Cronk records", BUSY_WORKSPACE_TEST, async () => {
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
  it("imports each Document and Report at a single Version holding what it says now, by whoever first wrote it", BUSY_WORKSPACE_TEST, async () => {
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

describe("Discovered Tickets in an export", () => {
  it("carry their Discovered marker in their frontmatter: the Agent and Agent Session that filed them, their source, whether kept and why they block", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/projects/CRONK/tickets", { title: "Found" });
    await admin.post("/api/tickets/CRONK-2/keep");
    const elsewhere = await startSession(cronk, claude.secret);
    await elsewhere.post("/api/projects/CRONK/tickets", { title: "Found later", blocks: [{ ticketKey: "CRONK-1", reason: "Same cache." }] });

    const files = await untarGz((await admin.download("/api/projects/CRONK/export")).body);

    expect(markdown(files["projects/CRONK/tickets/CRONK-2.md"]).data.discovered).toEqual({
      agent: claude.agentId,
      session: agent.sessionId,
      sourceTicket: "CRONK-1",
      sourceClaim: expect.any(String),
      kept: true,
    });
    expect(markdown(files["projects/CRONK/tickets/CRONK-3.md"]).data).toMatchObject({
      discovered: { agent: claude.agentId, session: elsewhere.sessionId, blockReasons: { "CRONK-1": "Same cache." } },
      blocks: ["CRONK-1"],
    });
    expect(markdown(files["projects/CRONK/tickets/CRONK-1.md"]).data.discovered).toBeUndefined();
  });

  it("keep a source in another Project by its own key, with its Claim, and are imported without it when the archive lacks it", async () => {
    const { admin, session } = await delegatedSetup();
    await admin.post("/api/projects", { name: "Ops", key: "OPS" });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/projects/OPS/tickets", { title: "Deploy is flaky" });
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Done", body: "Fixed." });

    const workspace = await admin.download("/api/export");
    expect(markdown((await untarGz(workspace.body))["projects/OPS/tickets/OPS-1.md"]).data.discovered).toMatchObject({ sourceTicket: "CRONK-1", sourceClaim: expect.any(String) });
    const { admin: elsewhere } = await startInstalledCronk("Elsewhere");
    expect((await elsewhere.upload("/api/import", workspace.body)).status).toBe(201);
    expect((await elsewhere.get("/api/tickets/OPS-1")).body.ticket.discovered.sourceTicket).toEqual({ key: "CRONK-1", title: "Ticket 1" });
    // The Claim came along too, so the Report written in it still lists the Ticket.
    expect((await elsewhere.get("/api/tickets/CRONK-1/reports")).body.reports[0].discovered.map((t: { key: string }) => t.key)).toEqual(["OPS-1"]);

    const project = await admin.download("/api/projects/OPS/export");
    const { admin: another } = await startInstalledCronk("Another");
    expect((await another.upload("/api/import", project.body)).status).toBe(201);
    expect((await another.get("/api/tickets/OPS-1")).body.ticket.discovered).toMatchObject({ agent: { name: "claude-laptop" }, sourceTicket: null });
  });
});

describe("Terms in an export", () => {
  it("are written as GLOSSARY.md per place, and beside it a terms.md holding them whole", BUSY_WORKSPACE_TEST, async () => {
    const { admin } = await busyWorkspace();
    const files = await untarGz((await admin.download("/api/export")).body);

    expect(files["GLOSSARY.md"]).toBe(
      "# Acme Labs glossary\n\n" +
        "**Customer**:\nA paying organization.\n\n" +
        "## Work\n\n" +
        "**Ticket**:\nA unit of work\n---\ntracked within a *Project*.\n_Avoid_: Issue, job\n",
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

  it("downloads a place's GLOSSARY.md on its own", BUSY_WORKSPACE_TEST, async () => {
    const { admin } = await busyWorkspace();

    const res = await admin.download("/api/projects/CRONK/terms/glossary");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/markdown/);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="GLOSSARY.md"');
    expect(res.body.toString()).toBe((await untarGz((await admin.download("/api/export")).body))["projects/CRONK/GLOSSARY.md"]);
    expect((await admin.download("/api/workspace/terms/glossary")).body.toString()).toMatch(/^# Acme Labs glossary/);
  });

  it("without Versions import each Term at a single Version holding what it says now", BUSY_WORKSPACE_TEST, async () => {
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

describe("Suggestions in an export", () => {
  it("are written in the frontmatter of the items they belong to", BUSY_WORKSPACE_TEST, async () => {
    const { admin, suggestions } = await busyWorkspace();
    const files = await untarGz((await admin.download("/api/export")).body);

    const guide = markdown(files[Object.keys(files).find((path) => /projects\/CRONK\/documents\/\d+-guide\.md$/.test(path))!]).data;
    expect(guide.suggestions).toEqual([
      {
        id: suggestions[0],
        baseVersion: 3,
        content: { title: "Guide", body: "# Guide\n\nStart here.\n---\nThen read on." },
        reasoning: "Clearer, *I think*.",
        at: expect.any(String),
        by: { agent: expect.any(String), session: expect.any(String) },
        sourceTicket: "CRONK-4",
        state: "accepted",
        acceptedWithEdits: false,
        resultVersion: 4,
        decidedAt: expect.any(String),
        decidedBy: "ada@example.com",
      },
    ]);
    const rejected = markdown(files[Object.keys(files).find((path) => path.startsWith("projects/CRONK/docs/adr/0004-"))!]).data;
    expect(rejected.suggestions).toMatchObject([{ id: suggestions[2], state: "rejected", reason: "Keep the title.", decidedBy: "grace@example.com" }]);
    expect(markdown(files["guidance.md"]).data.suggestions).toMatchObject([{ id: suggestions[3], state: "open" }]);
    expect(markdown(files["terms.md"]).data.terms.find((t: { name: string }) => t.name === "Ticket").suggestions).toMatchObject([{ state: "accepted", acceptedWithEdits: true }]);
  });
});

describe("a Suggestion on Guidance nobody has written", () => {
  it("is exported with that Guidance at Version 0, and imported leaving it unwritten", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const agent = await startSession(cronk, (await registerAgent(admin, "claude-laptop")).secret);
    const made = await agent.post("/api/suggestions", { item: { kind: "guidance" }, baseVersion: 0, content: { markdown: "Be kind." }, reasoning: "A start." });
    const exported = await admin.download("/api/export");
    expect(markdown((await untarGz(exported.body))["guidance.md"])).toMatchObject({ data: { version: 0 }, body: "" });

    const { admin: elsewhere } = await startInstalledCronk("Elsewhere");
    expect((await elsewhere.upload("/api/import", exported.body)).status).toBe(201);
    expect((await elsewhere.get("/api/workspace/guidance")).body.guidance).toEqual({ markdown: "", version: 0 });
    expect((await elsewhere.get(`/api/suggestions/${made.body.suggestion.id}`)).body.suggestion).toMatchObject({ state: "open", baseVersion: 0, content: { markdown: "Be kind." } });
  });
});

describe("Suggestions of new Documents in an export", () => {
  it("are written under the Document they go under until accepted, then with the Document they created, and imported as they were", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const guide = (await admin.post("/api/projects/CRONK/documents", { title: "Guide", body: "Start here." })).body.document;
    await admin.post(`/api/documents/${guide.id}/protection`, { protected: true });
    const agent = await startSession(cronk, (await registerAgent(admin, "claude-laptop")).secret);
    const suggest = async (title: string) => {
      cronk.clock.advance(60_000);
      const content = { title, body: `About ${title}.` };
      return (await agent.post("/api/suggestions", { item: { kind: "document", parentId: guide.id }, baseVersion: 0, content, reasoning: "Missing." })).body.suggestion.id as string;
    };
    const [accepted, rejected, open] = [await suggest("Setup"), await suggest("Deploys"), await suggest("Backups")];
    await admin.post(`/api/suggestions/${accepted}/accept`);
    await admin.post(`/api/suggestions/${rejected}/reject`, { reason: "Not yet." });

    const exported = await admin.download("/api/export");
    const files = await untarGz(exported.body);
    const pathOf = (pattern: RegExp) => Object.keys(files).find((path) => pattern.test(path))!;
    const guideData = markdown(files[pathOf(/projects\/CRONK\/documents\/\d+-guide\.md$/)]).data;
    expect(guideData.suggestions).toBeUndefined();
    expect(guideData.suggestedDocuments).toMatchObject([
      { id: rejected, baseVersion: 0, content: { title: "Deploys", body: "About Deploys." }, state: "rejected", reason: "Not yet." },
      { id: open, baseVersion: 0, content: { title: "Backups", body: "About Backups." }, state: "open" },
    ]);
    expect(markdown(files[pathOf(/guide\/\d+-setup\.md$/)]).data.suggestions).toMatchObject([{ id: accepted, baseVersion: 0, state: "accepted", resultVersion: 1 }]);

    const { admin: elsewhere } = await startInstalledCronk("Elsewhere");
    expect((await elsewhere.upload("/api/import", exported.body)).status).toBe(201);
    const newGuide = (await elsewhere.get("/api/projects/CRONK/documents")).body.documents[0];
    for (const id of [accepted, rejected, open]) {
      const [before, after] = [(await admin.get(`/api/suggestions/${id}`)).body.suggestion, (await elsewhere.get(`/api/suggestions/${id}`)).body.suggestion];
      expect(after).toMatchObject({ state: before.state, baseVersion: 0, base: { title: "", body: "" }, content: before.content, parent: { id: newGuide.id, title: "Guide" } });
      expect(after.item).toMatchObject({ title: before.item.title, version: before.item.version, protected: true });
    }
    expect((await elsewhere.post(`/api/suggestions/${open}/accept`)).body.suggestion).toMatchObject({ state: "accepted", item: { title: "Backups", version: 1 } });
  });

  it("is refused on import when it claims to be accepted without its Document, or to start from a Version", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const guide = (await admin.post("/api/projects/CRONK/documents", { title: "Guide", body: "Start here." })).body.document;
    await admin.post(`/api/documents/${guide.id}/protection`, { protected: true });
    const agent = await startSession(cronk, (await registerAgent(admin, "claude-laptop")).secret);
    await agent.post("/api/suggestions", { item: { kind: "document", parentId: guide.id }, baseVersion: 0, content: { title: "Setup" }, reasoning: "Missing." });
    const files = await untarGz((await admin.download("/api/export")).body);
    const path = Object.keys(files).find((p) => /\d+-guide\.md$/.test(p))!;
    const tampered = (change: (entry: Record<string, unknown>) => void) => {
      const { data, body } = markdown(files[path]!);
      change(data.suggestedDocuments[0]);
      return tarGz({ ...files, [path]: `---\n${stringify(data)}---\n${body}` });
    };

    for (const [change, error] of [
      [(e: Record<string, unknown>) => Object.assign(e, { state: "accepted", acceptedWithEdits: false, resultVersion: 1, decidedAt: e.at, decidedBy: "ada@example.com" }), /is accepted, so it belongs with the Document it created/],
      [(e: Record<string, unknown>) => Object.assign(e, { baseVersion: 1 }), /baseVersion must be 0/],
    ] as const) {
      const { admin: elsewhere } = await startInstalledCronk("Elsewhere");
      const refused = await elsewhere.upload("/api/import", await tampered(change));
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(error);
    }
  });
});

describe("Protected marks in an export", () => {
  it("are written in the frontmatter of the items they belong to, with who marked and unmarked them", BUSY_WORKSPACE_TEST, async () => {
    const { admin } = await busyWorkspace();
    const files = await untarGz((await admin.download("/api/export")).body);
    const ada = "ada@example.com";

    const guide = markdown(files[Object.keys(files).find((path) => /projects\/CRONK\/documents\/\d+-guide\.md$/.test(path))!]).data;
    expect(guide).toMatchObject({ protected: true, protection: [{ protected: true, at: "2026-01-01T09:08:00.000Z", by: "grace@example.com" }] });
    const docker = markdown(files[Object.keys(files).find((path) => /guide\/\d+-setup-docker\.md$/.test(path))!]).data;
    expect(docker).toMatchObject({ protected: false });
    expect(docker.protection).toBeUndefined();
    const [customer] = markdown(files["projects/CRONK/terms.md"]).data.terms;
    expect(customer).toMatchObject({ protected: false, protection: [{ protected: true, by: ada }, { protected: false, by: ada }] });
    const accepted = markdown(files[Object.keys(files).find((path) => path.startsWith("projects/CRONK/docs/adr/0004-"))!]).data;
    expect(accepted).toMatchObject({ protected: true, protection: [{ protected: true, at: "2026-01-01T09:07:00.000Z", by: "grace@example.com" }] });
  });

  it("leave an accepted Decision Protected when an older export, from before them, says nothing of them", BUSY_WORKSPACE_TEST, async () => {
    const before = await busyWorkspace();
    const files = await untarGz((await before.admin.download("/api/projects/CRONK/export")).body);
    for (const path of Object.keys(files).filter((p) => p.includes("/docs/adr/") && !p.includes(".versions/"))) {
      files[path] = files[path]!.replace(/^protected: .*\n/m, "").replace(/^protection:\n(  .*\n)*/m, "");
    }
    expect(files["projects/CRONK/docs/adr/0004-per-email-limits.md"]).not.toMatch(/protect/);

    const { admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", await tarGz(files))).status).toBe(201);
    const statuses = (await admin.get("/api/projects/CRONK/decisions")).body.decisions.map((d: { key: string; status: string; protected: boolean }) => [d.key, d.status, d.protected]);
    expect(statuses).toEqual([
      ["CRONK-D4", "accepted", true],
      ["CRONK-D3", "rejected", false],
      ["CRONK-D2", "superseded", false],
      ["CRONK-D1", "proposed", false],
    ]);
  });
});

describe("an export taken apart and archived again", () => {
  it("imports with its folder around it, as `tar czf` of the extracted folder makes", BUSY_WORKSPACE_TEST, async () => {
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

/** An export's files archived again with one Markdown file's frontmatter edited, and the file renamed if asked. */
function editedExport(files: Record<string, string>, path: string, edit: (data: any) => void, rename?: string) {
  const { data, body } = markdown(files[path]);
  edit(data);
  const copy = { ...files };
  delete copy[path];
  copy[rename ?? path] = `---\n${stringify(data)}---\n${body}`;
  return tarGz(copy);
}

describe("an export edited by hand", () => {
  it("is refused when it says what Cronk can't hold, naming the file", BUSY_WORKSPACE_TEST, async () => {
    const before = await busyWorkspace();
    const files = await untarGz((await before.admin.download("/api/export")).body);
    const edited = (path: string, edit: (data: any) => void, rename?: string) => editedExport(files, path, edit, rename);
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

    const vague = await admin.upload("/api/import", await edited(cronkTerms, (d) => (d.terms[0].protected = "yes")));
    expect(vague.status).toBe(400);
    expect(vague.body.error).toMatch(/CRONK\/terms\.md terms\[0\] protected must be true or false/);

    expect((await admin.get("/api/projects")).body.projects).toEqual([]);
  });
});

describe("Diff views in an export", () => {
  /** A Workspace where Ada sees Diffs side by side and Grace unified, exported. */
  async function exportedViews() {
    const { cronk, admin } = await startInstalledCronk();
    const grace = await joinAs(cronk, admin, "grace@example.com", "member", "Grace");
    const ben = await joinAs(cronk, admin, "ben@example.com", "member", "Ben");
    await admin.patch("/api/me", { diffView: "split" });
    await ben.patch("/api/me", { diffView: "split" });
    expect((await grace.get("/api/me")).body.user.diffView).toBe("unified");
    return untarGz((await admin.download("/api/export")).body);
  }
  const views = async (admin: Client) =>
    (await admin.get("/api/users")).body.users.map((u: { email: string; diffView: string }) => [u.email, u.diffView]);

  it("are written in people.md, and a User the import creates takes theirs while one already here keeps their own", async () => {
    const files = await exportedViews();
    expect(markdown(files["people.md"]).data.users.map((u: { email: string; diffView: string }) => [u.email, u.diffView])).toEqual([
      ["ada@example.com", "split"],
      ["ben@example.com", "split"],
      ["grace@example.com", "unified"],
    ]);

    const { admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", await tarGz(files))).status).toBe(201);
    expect(await views(admin)).toEqual([
      ["ada@example.com", "unified"],
      ["ben@example.com", "split"],
      ["grace@example.com", "unified"],
    ]);
  });

  it("are unified for each User an export without them creates, and refused when not one Cronk knows", async () => {
    const files = await exportedViews();
    const { admin } = await startInstalledCronk("Elsewhere");
    const odd = await admin.upload("/api/import", await editedExport(files, "people.md", (d) => (d.users[1].diffView = "sideways")));
    expect(odd.status).toBe(400);
    expect(odd.body.error).toMatch(/people\.md users\[1\]\.diffView/);

    const older = await editedExport(files, "people.md", (d) => d.users.forEach((u: { diffView?: string }) => delete u.diffView));
    expect((await admin.upload("/api/import", older)).status).toBe(201);
    expect(await views(admin)).toEqual([
      ["ada@example.com", "unified"],
      ["ben@example.com", "unified"],
      ["grace@example.com", "unified"],
    ]);
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
    expect(accepted.body.user).toEqual({ id: imported.id, email: "grace@example.com", name: "Grace H", role: "member", active: true, joined: true, diffView: "unified" });

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

describe("Attachments in an export", () => {
  it("are beside the Document or Comment they are on, as a Ticket's are", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const guide = (await admin.post("/api/projects/CRONK/documents", { title: "Guide" })).body.document;
    await admin.upload(`/api/documents/${guide.id}/attachments?name=map.png`, Buffer.from([0x89, 0x50]), "image/png");
    const comment = (await admin.post(`/api/documents/${guide.id}/comments`, { body: "Here." })).body.comment;
    await admin.upload(`/api/comments/${comment.id}/attachments?name=here.txt`, Buffer.from("here"), "text/plain");

    const files = await untarGz((await admin.download("/api/projects/CRONK/export")).body);
    expect(markdown(files["projects/CRONK/documents/1-guide.attachments/index.md"]).data.attachments).toMatchObject([{ file: "1-map.png", name: "map.png" }]);
    expect(files["projects/CRONK/documents/1-guide.comments/1.attachments/1-here.txt"]).toBe("here");
  });

  it("keep their ids, so links to their files still work after the move", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Build it" });
    const id = (await admin.upload("/api/tickets/CRONK-1/attachments?name=proxy-ip.png", Buffer.from([0x89, 0x50]), "image/png")).body.attachment.id;
    const exported = await admin.download("/api/export");

    const elsewhere = (await startInstalledCronk("Elsewhere")).admin;
    expect((await elsewhere.upload("/api/import", exported.body)).status).toBe(201);
    const file = await elsewhere.download(`/api/attachments/${id}/file`);
    expect(file.status).toBe(200);
    expect([...file.body]).toEqual([0x89, 0x50]);
  });

  it("of Comments are exported in a fixed number of queries, however many Comments there are", async () => {
    const { cronk, admin } = await startInstalledCronk("Acme", { lapseCheckMs: 3_600_000 });
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Build it" });
    const first = (await admin.post("/api/tickets/CRONK-1/comments", { body: "Comment 1" })).body.comment;
    await admin.upload(`/api/comments/${first.id}/attachments?name=1.txt`, Buffer.from("1"), "text/plain");
    const exporting = async () => ({
      workspace: await cronk.queries(() => admin.download("/api/export")),
      project: await cronk.queries(() => admin.download("/api/projects/CRONK/export")),
    });
    const withOne = await exporting();

    // Comments 2, 4 and 6 have a file each; 3 and 5 have none.
    const withFile = new Set([2, 4, 6]);
    for (let i = 2; i <= 6; i++) {
      const comment = (await admin.post("/api/tickets/CRONK-1/comments", { body: `Comment ${i}` })).body.comment;
      if (withFile.has(i)) await admin.upload(`/api/comments/${comment.id}/attachments?name=${i}.txt`, Buffer.from(`${i}`), "text/plain");
    }
    const files = await untarGz((await admin.download("/api/projects/CRONK/export")).body);
    expect(files["projects/CRONK/tickets/CRONK-1.comments/4.attachments/1-4.txt"]).toBe("4");
    expect(files["projects/CRONK/tickets/CRONK-1.comments/5.attachments/index.md"]).toBeUndefined();

    expect(await exporting()).toEqual(withOne);
  });
});

describe("Attachment Changes in an export", () => {
  /** A Ticket's `attachment added` and `attachment removed` Changes, as the file and its id. */
  const attachmentChanges = async (admin: Client, key: string) =>
    (await admin.get(`/api/tickets/${key}/changes`)).body.changes
      .filter((c: { change: string }) => c.change.startsWith("attachment"))
      .map((c: { change: string; attachment: { id: string; name: string; contentType: string; size: number }; actor: { name: string } }) => ({
        change: c.change,
        attachment: c.attachment,
        by: c.actor.name,
      }));

  it("keep attaching and deleting, a deleted file as its record only, and follow a file the import gave a new id", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Build it" });
    const kept = (await admin.upload("/api/tickets/CRONK-1/attachments?name=sign-in-flood.log", Buffer.from("429 x 50\n"), "text/plain")).body.attachment.id;
    const gone = (await admin.upload("/api/tickets/CRONK-1/attachments?name=proxy-ip.png", Buffer.from([0x89, 0x50]), "image/png")).body.attachment.id;
    await admin.delete(`/api/attachments/${gone}`);
    const before = await attachmentChanges(admin, "CRONK-1");
    expect(before).toEqual([
      { change: "attachment added", attachment: { id: kept, name: "sign-in-flood.log", contentType: "text/plain", size: 9 }, by: "Ada" },
      { change: "attachment added", attachment: { id: gone, name: "proxy-ip.png", contentType: "image/png", size: 2 }, by: "Ada" },
      { change: "attachment removed", attachment: { id: gone, name: "proxy-ip.png", contentType: "image/png", size: 2 }, by: "Ada" },
    ]);
    const files = await untarGz((await admin.download("/api/projects/CRONK/export")).body);
    expect(Object.keys(files).filter((path) => path.includes("proxy-ip"))).toEqual([]);

    const elsewhere = (await startInstalledCronk("Elsewhere")).admin;
    expect((await elsewhere.upload("/api/import", await tarGz(files))).status).toBe(201);
    expect(await attachmentChanges(elsewhere, "CRONK-1")).toEqual(before);
    expect((await elsewhere.get("/api/tickets/CRONK-1/attachments")).body.attachments.map((a: { id: string }) => a.id)).toEqual([kept]);

    // The same export again under another key: the kept file's id is taken now, so it gets a new one, and its Change follows it.
    const copy = await tarGz(Object.fromEntries(Object.entries(files).map(([path, text]) => [path.replaceAll("CRONK", "COPY"), text.replaceAll("CRONK", "COPY")])));
    expect((await elsewhere.upload("/api/import", copy)).status).toBe(201);
    const [copied] = (await elsewhere.get("/api/tickets/COPY-1/attachments")).body.attachments;
    expect(copied.id).not.toBe(kept);
    expect((await attachmentChanges(elsewhere, "COPY-1")).map((c: { attachment: { id: string } }) => c.attachment.id)).toEqual([copied.id, gone, gone]);
  });
});

describe("Artifacts in an export", () => {
  it("keep their ids and Version numbers, so links to them still work after the move, with only the latest Version unless asked for all", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { artifact } = (await admin.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz({ "index.html": "<p>v1</p>" }))).body;
    await admin.post(`/api/artifacts/${artifact.id}/comments`, { body: "Too dark.", version: 1 });
    await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1`, await tarGz({ "index.html": "<p>v2</p>" }));
    await admin.post(`/api/artifacts/${artifact.id}/comments`, { body: "Better.", version: 2 });

    const files = await untarGz((await admin.download("/api/export?versions=false")).body);
    expect(markdown(files["projects/CRONK/artifacts/1-limits.md"]).data).toMatchObject({ id: artifact.id, title: "Limits", version: 2, versions: [{ number: 2 }] });
    expect(files["projects/CRONK/artifacts/1-limits/2/index.html"]).toBe("<p>v2</p>");

    const elsewhere = (await startInstalledCronk("Elsewhere")).admin;
    expect((await elsewhere.upload("/api/import", (await admin.download("/api/export?versions=false")).body)).status).toBe(201);
    const moved = (await elsewhere.get(`/api/artifacts/${artifact.id}`)).body.artifact;
    expect(moved).toMatchObject({ version: 2, url: `${OWN_ORIGIN}/artifacts/${artifact.id}` });
    expect(moved.versions.map((v: { number: number }) => v.number)).toEqual([2]);
    // A Comment on a Version the export left out comes along on the oldest Version it holds after it.
    expect((await elsewhere.get(`/api/artifacts/${artifact.id}/comments`)).body.comments).toEqual([
      expect.objectContaining({ body: "Too dark.", artifactVersion: 2 }),
      expect.objectContaining({ body: "Better.", artifactVersion: 2 }),
    ]);
    const page = await elsewhere.download(`${new URL(moved.frameUrl).pathname}index.html`, { host: ARTIFACT_HOST });
    expect(page.body.toString()).toBe("<p>v2</p>");
  });
});

describe("Importing Artifacts", () => {
  it("refuses an Artifact Version without index.html, as publishing it would be", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz({ "index.html": "<p>v1</p>", "app.js": "1" }));
    const files = await untarGz((await admin.download("/api/projects/CRONK/export")).body);
    const edited = Object.fromEntries(
      Object.entries(files)
        .filter(([path]) => path !== "projects/CRONK/artifacts/1-limits/1/index.html")
        .map(([path, text]) => {
          if (!path.endsWith("1-limits.md")) return [path, text];
          const { data } = markdown(text);
          data.versions[0].files = data.versions[0].files.filter((f: { path: string }) => f.path !== "index.html");
          return [path, `---\n${stringify(data)}---\n`];
        }),
    );

    const elsewhere = (await startInstalledCronk("Elsewhere")).admin;
    const res = await elsewhere.upload("/api/import", await tarGz(edited));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/index\.html/);
  });
});

describe("the Workspace's settings in an export", () => {
  /** A Workspace export from a fresh installation, with `workspace.md` edited. */
  async function exportWith(edit: (data: any) => void) {
    const { admin } = await startInstalledCronk("Acme");
    return editedExport(await untarGz((await admin.download("/api/export")).body), "workspace.md", edit);
  }

  it("are refused on import outside the bounds the API allows, naming the setting and its range", async () => {
    const { admin } = await startInstalledCronk("Elsewhere");

    const tooQuiet = await admin.upload("/api/import", await exportWith((d) => (d.silenceThresholdSeconds = 59)));
    expect(tooQuiet.status).toBe(400);
    expect(tooQuiet.body.error).toMatch(/workspace\.md silenceThresholdSeconds must be from 60 to 86400/);

    const tooSmall = await admin.upload("/api/import", await exportWith((d) => (d.attachmentMaxBytes = 1024 * 1024 - 1)));
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.body.error).toMatch(/workspace\.md attachmentMaxBytes must be from 1048576 to 10737418240/);

    expect((await admin.get("/api/workspace")).body.silenceThresholdSeconds).toBe(300);
  });

  it("left out of workspace.md, as in an export from before them, keep the Workspace's own values", async () => {
    const { admin } = await startInstalledCronk("Elsewhere");
    await admin.patch("/api/workspace", { silenceThresholdSeconds: 120, artifactMaxFiles: 50 });

    const imported = await admin.upload("/api/import", await exportWith((d) => {
      delete d.silenceThresholdSeconds;
      delete d.artifactMaxFiles;
      d.attachmentMaxBytes = 2 * 1024 * 1024;
    }));
    expect(imported.status).toBe(201);

    const workspace = (await admin.get("/api/workspace")).body;
    expect(workspace).toMatchObject({ name: "Acme", silenceThresholdSeconds: 120, artifactMaxFiles: 50, attachmentMaxBytes: 2 * 1024 * 1024 });
  });
});

describe("a block from a Discovered Ticket a User finished undelegated, in an export from before finishing ended it", () => {
  it("is imported ended, recorded as a Change by Cronk itself, so the Ticket it blocked stays Ready once the Discovered Ticket is moved back", async () => {
    const { admin, session } = await delegatedSetup(1);
    const agent = await session();
    await agent.post("/api/projects/CRONK/tickets", { title: "Migration leaves orphans", blocks: [{ ticketKey: "CRONK-1", reason: "Builds on it." }] });
    await admin.patch("/api/tickets/CRONK-2", { statusId: await statusIn(admin, "completed") });
    const files = await untarGz((await admin.download("/api/projects/CRONK/export")).body);
    // As exported before finishing ended it: the finished CRONK-2 still blocks CRONK-1.
    const exported = editedExport(files, "projects/CRONK/tickets/CRONK-2.md", (data) => {
      data.discovered.blockReasons = { "CRONK-1": "Builds on it." };
      data.blocks = ["CRONK-1"];
    });

    const elsewhere = await startInstalledCronk("Elsewhere");
    expect((await elsewhere.admin.upload("/api/import", await exported)).status).toBe(201);
    await elsewhere.admin.patch("/api/tickets/CRONK-2", { statusId: await statusIn(elsewhere.admin, "backlog") });

    expect((await elsewhere.admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toEqual([]);
    const { changes } = (await elsewhere.admin.get("/api/tickets/CRONK-1/changes")).body;
    expect(changes.at(-1)).toMatchObject({ actor: { kind: "system" }, change: "relation removed", kind: "blocked_by", ticket: { key: "CRONK-2" } });
  });
});

/**
 * An export of a Discovered Ticket the Agent that filed it once finished undelegated, and moved back to Backlog, as its
 * history records: no route lets an Agent make that finish, so only an export can say it happened.
 */
async function exportFinishedByItsAgent() {
  const { admin, claude, session } = await delegatedSetup(1);
  const agent = await session();
  await agent.post("/api/projects/CRONK/tickets", { title: "Migration leaves orphans", blocks: [{ ticketKey: "CRONK-1", reason: "Builds on it." }] });
  const files = await untarGz((await admin.download("/api/projects/CRONK/export")).body);
  const path = "projects/CRONK/tickets/CRONK-2.history.md";
  const { changes } = markdown(files[path]).data;
  const backlog = { id: await statusIn(admin, "backlog"), name: "Backlog", category: "backlog", current: "Backlog" };
  const completed = { id: await statusIn(admin, "completed"), name: "Done", category: "completed", current: "Done" };
  const by = { agent: claude.agentId, session: agent.sessionId };
  const finishedAndBack = [
    { at: "2099-01-01T09:00:00.000Z", by, change: "status", from: backlog, to: completed },
    { at: "2099-01-01T09:01:00.000Z", by, change: "status", from: completed, to: backlog },
  ];
  return tarGz({ ...files, [path]: `---\n${stringify({ changes: [...changes, ...finishedAndBack] })}---\n` });
}

describe("a Discovered Ticket its Agent finished undelegated, in an export", () => {
  it("is imported still blocking what the Agent blocked from it: only a User's finish vets it", async () => {
    const elsewhere = await startInstalledCronk("Elsewhere");
    expect((await elsewhere.admin.upload("/api/import", await exportFinishedByItsAgent())).status).toBe(201);

    expect((await elsewhere.admin.get("/api/tickets/CRONK-1")).body.relations.blockedBy).toMatchObject([{ key: "CRONK-2", block: { reason: "Builds on it." } }]);
  });

  it("is imported still the Agent's to change without a Claim: only a User's finish ends that", async () => {
    const elsewhere = await startInstalledCronk("Elsewhere");
    expect((await elsewhere.admin.upload("/api/import", await exportFinishedByItsAgent())).status).toBe(201);
    const [claude] = (await elsewhere.admin.get("/api/agents")).body.agents;
    const agent = await startSession(elsewhere.cronk, (await elsewhere.admin.post(`/api/agents/${claude.id}/tokens`, {})).body.secret);

    const changed = await agent.patch("/api/tickets/CRONK-2", { title: "Migration leaves orphaned rows" });

    expect(changed.status).toBe(200);
    expect(changed.body.ticket.title).toBe("Migration leaves orphaned rows");
  });

  it("is imported still waiting for a User in the Inbox: only a User's finish settles it", async () => {
    const elsewhere = await startInstalledCronk("Elsewhere");
    expect((await elsewhere.admin.upload("/api/import", await exportFinishedByItsAgent())).status).toBe(201);

    const ticket = (await elsewhere.admin.get("/api/tickets/CRONK-2")).body.ticket;
    expect(ticket.discovered.everFinished).toBe(false);
    expect((await elsewhere.admin.get("/api/inbox?kind=discovered")).body.items).toMatchObject([{ ticket: { key: "CRONK-2" }, blocks: [{ key: "CRONK-1" }] }]);
  });
});
