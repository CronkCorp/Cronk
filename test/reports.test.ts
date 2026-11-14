import { describe, expect, it } from "vitest";
import { delegatedSetup, startSession, type Client } from "./harness.js";

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
