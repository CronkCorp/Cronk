import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, startSession, type Client } from "./harness.js";

describe("Reports", () => {
  it("are written by the Claim holder as Documents of the Ticket's Project, listed on the Ticket and kept out of the page tree", async () => {
    const { admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const written = await agent.post("/api/tickets/CRONK-1/reports", { title: "What I found", body: "## Findings\n\nIt was the cache." });
    expect(written.status).toBe(201);
    expect(written.body.report).toMatchObject({
      title: "What I found",
      body: "## Findings\n\nIt was the cache.",
      version: 1,
      projectKey: "CRONK",
      parentId: null,
      ticketKey: "CRONK-1",
      createdAt: "2026-01-01T09:00:00.000Z",
    });

    const id = written.body.report.id;
    expect((await admin.get(`/api/documents/${id}`)).body.document).toMatchObject({ title: "What I found", ticketKey: "CRONK-1", version: 1 });
    expect((await admin.get(`/api/documents/${id}/versions`)).body.versions).toMatchObject([
      { number: 1, actor: { kind: "agent", id: claude.agentId, session: { id: agent.sessionId } } },
    ]);

    const listed = await admin.get("/api/tickets/CRONK-1/reports");
    expect(listed.status).toBe(200);
    expect(listed.body.reports).toMatchObject([
      { id, title: "What I found", ticketKey: "CRONK-1", agent: { id: claude.agentId, name: "claude-laptop", owner: { name: "Ada" } }, session: { id: agent.sessionId } },
    ]);
    expect((await admin.get("/api/projects/CRONK/documents")).body.documents).toEqual([]);
  });
});

describe("A Report", () => {
  it("never joins the page tree: it can't be moved into it or have Documents put under it", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "Done." })).body.report;
    const page = (await admin.post("/api/projects/CRONK/documents", { title: "Guide" })).body.document;

    const moved = await admin.post(`/api/documents/${report.id}/move`, { parentId: page.id });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toMatch(/Report/);
    expect((await admin.post("/api/projects/CRONK/documents", { title: "Child", parentId: report.id })).status).toBe(400);
    expect((await admin.post(`/api/documents/${page.id}/move`, { parentId: report.id })).status).toBe(400);
    expect((await admin.get("/api/projects/CRONK/documents")).body.documents).toMatchObject([{ id: page.id, depth: 0 }]);
  });
});

describe("An Agent's move into In Review", () => {
  const statusIn = async (admin: Client, category: string) =>
    ((await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[]).find((s) => s.category === category)!.id;

  it("is refused until the Ticket has a Report written during the current Claim, then allowed", async () => {
    const { admin, session } = await delegatedSetup();
    const inReview = await statusIn(admin, "in_review");
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const refused = await agent.patch("/api/tickets/CRONK-1", { statusId: inReview });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Write a Report on CRONK-1/);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.status.category).toBe("backlog");

    await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "Fixed the cache." });
    const moved = await agent.patch("/api/tickets/CRONK-1", { statusId: inReview });
    expect(moved.status).toBe(200);
    expect(moved.body.ticket.status.category).toBe("in_review");
  });

  it("doesn't count a Report from an earlier Claim, even one of the same Agent Session", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const inReview = await statusIn(admin, "in_review");
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/reports", { title: "First go", body: "Half done." });
    await agent.delete("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/claim");
    expect((await agent.patch("/api/tickets/CRONK-1", { statusId: inReview })).status).toBe(409);

    cronk.clock.advance(10 * 60_000);
    const later = await session();
    await later.post("/api/tickets/CRONK-1/claim");
    expect((await later.patch("/api/tickets/CRONK-1", { statusId: inReview })).status).toBe(409);
    await later.post("/api/tickets/CRONK-1/reports", { title: "Second go", body: "Done." });
    expect((await later.patch("/api/tickets/CRONK-1", { statusId: inReview })).status).toBe(200);
    expect((await admin.get("/api/tickets/CRONK-1/reports")).body.reports.map((r: { title: string }) => r.title)).toEqual(["First go", "Second go"]);
  });

  it("ends the Claim, so neither the Ticket nor its Report can change under the reviewer, and tells the Agent nothing", async () => {
    const { admin, claude, session } = await delegatedSetup(2);
    await admin.patch("/api/tickets/CRONK-2", { delegateId: null });
    const agent = await session();
    const stream = await agent.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");
    await agent.post("/api/tickets/CRONK-1/claim");
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "Fixed the cache." })).body.report;

    expect((await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "in_review") })).status).toBe(200);
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
    const edited = await agent.patch(`/api/documents/${report.id}`, { baseVersion: report.version, body: "Actually, not fixed." });
    expect(edited.status).toBe(409);
    expect(edited.body.error).toMatch(/Claim CRONK-1/);
    expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "progress", body: "One more thing" })).status).toBe(409);
    expect((await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "started") })).status).toBe(409);

    // CRONK-1 went to review, so the next thing the Agent hears of is CRONK-2.
    await admin.patch("/api/tickets/CRONK-2", { delegateId: claude.agentId });
    expect((await stream.next())?.data.ticket.key).toBe("CRONK-2");
  });

  it("is the only hand-over that needs a Report: moving into Started and releasing the Claim don't, nor does a User's move", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    expect((await agent.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "started") })).status).toBe(200);
    expect((await agent.delete("/api/tickets/CRONK-1/claim")).status).toBe(204);
    expect((await admin.patch("/api/tickets/CRONK-1", { statusId: await statusIn(admin, "in_review") })).status).toBe(200);
  });
});

describe("Writing a Report", () => {
  it("is refused to anyone but the Agent Session holding the Ticket's Claim", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const holder = await session();
    const other = await session();
    const report = { title: "Findings", body: "Done." };

    expect((await holder.post("/api/tickets/CRONK-1/reports", report)).status).toBe(409);
    await holder.post("/api/tickets/CRONK-1/claim");
    const refused = await other.post("/api/tickets/CRONK-1/reports", report);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Claim CRONK-1/);
    expect((await cronk.client(claude.secret).post("/api/tickets/CRONK-1/reports", report)).status).toBe(400);
    expect((await admin.post("/api/tickets/CRONK-1/reports", report)).status).toBe(400);
    const readOnly = (await admin.post(`/api/agents/${claude.agentId}/tokens`, { readOnly: true })).body.secret;
    expect((await (await startSession(cronk, readOnly)).post("/api/tickets/CRONK-1/reports", report)).status).toBe(403);
    expect((await holder.post("/api/tickets/CRONK-1/reports", { title: " ", body: "Done." })).status).toBe(400);

    expect((await admin.get("/api/tickets/CRONK-1/reports")).body.reports).toEqual([]);
  });
});

describe("A Project's Reports", () => {
  it("lists every Report on the Project's Tickets, newest first, to those who can see the Project", async () => {
    const { cronk, admin, session } = await delegatedSetup(2);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-2/claim");
    await agent.post("/api/tickets/CRONK-1/reports", { title: "First", body: "One." });
    cronk.clock.advance(60_000);
    await agent.post("/api/tickets/CRONK-2/reports", { title: "Second", body: "Two." });
    await admin.post("/api/projects", { name: "Other", key: "OTHER" });

    const listed = await admin.get("/api/projects/CRONK/reports");
    expect(listed.status).toBe(200);
    expect(listed.body.reports).toMatchObject([
      { title: "Second", ticketKey: "CRONK-2", ticketTitle: "Ticket 2", createdAt: "2026-01-01T09:01:00.000Z" },
      { title: "First", ticketKey: "CRONK-1", ticketTitle: "Ticket 1", createdAt: "2026-01-01T09:00:00.000Z" },
    ]);
    expect((await admin.get("/api/projects/OTHER/reports")).body.reports).toEqual([]);

    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.get("/api/projects/CRONK/reports")).body.reports).toHaveLength(2);
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    expect((await bob.get("/api/projects/CRONK/reports")).status).toBe(404);
    expect((await bob.get("/api/tickets/CRONK-1/reports")).status).toBe(404);
  });
});

describe("A Ticket's live updates", () => {
  it("push each new Report on the Ticket to those watching it", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const stream = await admin.events("/api/tickets/CRONK-1/events");
    expect((await stream.next())?.event).toBe("ready");

    await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "Done." });

    const [listed] = (await admin.get("/api/tickets/CRONK-1/reports")).body.reports;
    expect(await stream.next()).toEqual({ event: "report", data: { report: listed } });
  });
});

describe("Deleting a Report", () => {
  it("is refused to Agents, even the Claim holder, leaving the Ticket untouched, and allowed to Users", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "Done." })).body.report;
    const ticket = (await admin.get("/api/tickets/CRONK-1")).body;

    const refused = await agent.delete(`/api/documents/${report.id}?baseVersion=1`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Only a User can delete a Document, not an Agent");
    expect((await admin.get("/api/tickets/CRONK-1/reports")).body.reports).toHaveLength(1);
    expect((await admin.get("/api/tickets/CRONK-1")).body).toEqual(ticket);
    expect((await agent.patch("/api/tickets/CRONK-1", { title: "Still editable" })).status).toBe(200);

    expect((await admin.delete(`/api/documents/${report.id}?baseVersion=1`)).status).toBe(204);
    expect((await admin.get("/api/tickets/CRONK-1/reports")).body.reports).toEqual([]);
  });
});

describe("Editing a Report", () => {
  it("is refused to an Agent unless it calls from the Agent Session holding the Ticket's live Claim", async () => {
    const { cronk, claude, session } = await delegatedSetup();
    const holder = await session();
    const other = await session();
    await holder.post("/api/tickets/CRONK-1/claim");
    const report = (await holder.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "Done." })).body.report;
    const path = `/api/documents/${report.id}`;

    const refused = await other.patch(path, { baseVersion: 1, body: "Rewritten." });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Claim CRONK-1/);
    expect((await cronk.client(claude.secret).patch(path, { baseVersion: 1, body: "Rewritten." })).status).toBe(409);

    const edited = await holder.patch(path, { baseVersion: 1, body: "Done, and tested." });
    expect(edited.status).toBe(200);
    expect(edited.body.document).toMatchObject({ version: 2, body: "Done, and tested." });

    await holder.delete("/api/tickets/CRONK-1/claim");
    expect((await holder.patch(path, { baseVersion: 2, body: "Rewritten." })).status).toBe(409);
  });
});

describe("Replacing a section of or restoring a Report", () => {
  it("is refused to an Agent outside the Ticket's Claim and allowed within it", async () => {
    const { session } = await delegatedSetup();
    const holder = await session();
    const other = await session();
    await holder.post("/api/tickets/CRONK-1/claim");
    const report = (await holder.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "## Cause\n\nThe cache.\n" })).body.report;
    const path = `/api/documents/${report.id}`;
    await holder.patch(path, { baseVersion: 1, body: "## Cause\n\nThe network.\n" });

    const section = { baseVersion: 2, heading: "Cause", body: "Nothing." };
    const refusedSection = await other.post(`${path}/replace-section`, section);
    expect(refusedSection.status).toBe(409);
    expect(refusedSection.body.error).toMatch(/Claim CRONK-1/);
    const refusedRestore = await other.post(`${path}/versions/1/restore`, { baseVersion: 2 });
    expect(refusedRestore.status).toBe(409);
    expect(refusedRestore.body.error).toMatch(/Claim CRONK-1/);
    expect((await holder.get(path)).body.document).toMatchObject({ version: 2, body: "## Cause\n\nThe network.\n" });

    expect((await holder.post(`${path}/versions/1/restore`, { baseVersion: 2 })).body.document).toMatchObject({ version: 3, body: "## Cause\n\nThe cache.\n" });
    expect((await holder.post(`${path}/replace-section`, { ...section, baseVersion: 3 })).body.document).toMatchObject({ version: 4, body: "## Cause\n\nNothing.\n" });
  });
});

describe("A User changing a Report", () => {
  it("edits and restores a Report like any Document, without a Claim", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "## Cause\n\nThe cache.\n" })).body.report;
    await agent.delete("/api/tickets/CRONK-1/claim");
    const path = `/api/documents/${report.id}`;

    expect((await admin.patch(path, { baseVersion: 1, body: "## Cause\n\n[redacted]\n" })).status).toBe(200);
    expect((await admin.post(`${path}/replace-section`, { baseVersion: 2, heading: "Cause", body: "The network." })).status).toBe(200);
    const restored = await admin.post(`${path}/versions/1/restore`, { baseVersion: 3 });
    expect(restored.status).toBe(200);
    expect(restored.body.document).toMatchObject({ version: 4, body: "## Cause\n\nThe cache.\n", ticketKey: "CRONK-1" });
  });
});
