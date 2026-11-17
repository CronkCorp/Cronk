import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, projectWithTickets, registerAgent, startInstalledCronk, startSession, type Client } from "./harness.js";

describe("What an Agent did", () => {
  it("lists its changes, Activities, Comments and saved Versions across Tickets and Documents, newest first", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const started = ((await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[]).find((s) => s.category === "started")!;
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    cronk.clock.advance(1000);
    await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Read the code" });
    cronk.clock.advance(1000);
    await agent.post("/api/tickets/CRONK-1/comments", { body: "Picking this up" });
    cronk.clock.advance(1000);
    await agent.patch("/api/tickets/CRONK-1", { statusId: started.id });
    cronk.clock.advance(1000);
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "It was the cache." })).body.report;
    cronk.clock.advance(1000);
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Thanks" });

    const res = await admin.get(`/api/agents/${claude.agentId}/record`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).not.toHaveProperty("work");
    const ticket = { key: "CRONK-1", title: "Ticket 1" };
    const inSession = { id: agent.sessionId };
    expect(res.body.record).toMatchObject([
      { kind: "version", at: "2026-01-01T09:00:04.000Z", session: inSession, projectKey: "CRONK", ticket, document: { id: report.id, title: "Findings" }, version: { number: 1 } },
      { kind: "change", at: "2026-01-01T09:00:03.000Z", session: inSession, projectKey: "CRONK", ticket, document: null, change: { change: "status", to: { id: started.id } } },
      { kind: "comment", at: "2026-01-01T09:00:02.000Z", session: inSession, projectKey: "CRONK", ticket, document: null, comment: { body: "Picking this up" } },
      { kind: "activity", at: "2026-01-01T09:00:01.000Z", session: inSession, projectKey: "CRONK", ticket, document: null, activity: { kind: "plan", body: "Read the code", blocking: false } },
    ]);
  });
});

describe("What an Agent did, as each User may see it", () => {
  it("shows its Owner only what the Owner can read now, shows an Admin everything, and hides the Agent from other Members", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const carol = await joinAs(cronk, admin, "carol@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    await projectWithTickets(admin, "CRONK", 1);
    await projectWithTickets(admin, "SECRET", 1);
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.put(`/api/projects/SECRET/members/${bobId}`, { access: "write" });
    const claude = await registerAgent(bob, "claude-laptop");
    for (const key of ["CRONK-1", "SECRET-1"]) await admin.patch(`/api/tickets/${key}`, { assigneeId: bobId, delegateId: claude.agentId });
    const agent = await startSession(cronk, claude.secret);
    for (const key of ["CRONK-1", "SECRET-1"]) {
      await agent.post(`/api/tickets/${key}/claim`);
      cronk.clock.advance(1000);
      await agent.post(`/api/tickets/${key}/activities`, { kind: "progress", body: `Working on ${key}` });
    }
    cronk.clock.advance(1000);
    await agent.post("/api/workspace/documents", { title: "Handbook", body: "Welcome" });
    const secretPlan = (await admin.post("/api/projects/SECRET/documents", { title: "Secret plan" })).body.document.id;
    cronk.clock.advance(1000);
    expect((await agent.post(`/api/tickets/CRONK-1/documents/${secretPlan}`)).status).toBe(201);

    const seen = async (who: Client) =>
      (await who.get(`/api/agents/${claude.agentId}/record`)).body.record.map(
        (e: { kind: string; ticket: { key: string } | null; document: { title: string } | null }) => `${e.kind} ${e.ticket?.key ?? e.document?.title}`,
      );
    const everything = ["change CRONK-1", "version Handbook", "activity SECRET-1", "activity CRONK-1"];
    expect(await seen(bob)).toEqual(everything);
    // Losing sight of SECRET hides its Ticket, and the link from CRONK-1 to its Document.
    await admin.delete(`/api/projects/SECRET/members/${bobId}`);
    expect(await seen(bob)).toEqual(["version Handbook", "activity CRONK-1"]);
    expect(await seen(admin)).toEqual(everything);

    expect((await carol.get(`/api/agents/${claude.agentId}/record`)).status).toBe(404);
    expect((await agent.get(`/api/agents/${claude.agentId}/record`)).status).toBe(403);
  });

  it("narrows to what it did since a time, and to at most a number of entries", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    for (const body of ["one", "two", "three"]) {
      cronk.clock.advance(60_000);
      await agent.post("/api/tickets/CRONK-1/activities", { kind: "progress", body });
    }
    const bodies = async (query: string) =>
      (await admin.get(`/api/agents/${claude.agentId}/record?${query}`)).body.record.map((e: { activity: { body: string } }) => e.activity.body);

    expect(await bodies("since=2026-01-01T09:02:00.000Z")).toEqual(["three", "two"]);
    expect(await bodies("limit=1")).toEqual(["three"]);
    expect((await admin.get(`/api/agents/${claude.agentId}/record?limit=0`)).status).toBe(400);
  });

  it("is no longer served at the old /work path", async () => {
    const { admin, claude } = await delegatedSetup();
    expect((await admin.get(`/api/agents/${claude.agentId}/work`)).status).toBe(404);
  });
});

describe("What a removed Agent did", () => {
  it("stays readable to its Owner, limited to what they can read, and to an Admin, and hidden from other Members", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const carol = await joinAs(cronk, admin, "carol@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    await projectWithTickets(admin, "CRONK", 1);
    await projectWithTickets(admin, "SECRET", 1);
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.put(`/api/projects/SECRET/members/${bobId}`, { access: "write" });
    const claude = await registerAgent(bob, "claude-laptop");
    for (const key of ["CRONK-1", "SECRET-1"]) await admin.patch(`/api/tickets/${key}`, { assigneeId: bobId, delegateId: claude.agentId });
    const agent = await startSession(cronk, claude.secret);
    for (const key of ["CRONK-1", "SECRET-1"]) {
      await agent.post(`/api/tickets/${key}/claim`);
      cronk.clock.advance(1000);
      await agent.post(`/api/tickets/${key}/activities`, { kind: "progress", body: `Working on ${key}` });
    }
    await admin.delete(`/api/projects/SECRET/members/${bobId}`);
    expect((await bob.delete(`/api/agents/${claude.agentId}`)).status).toBe(204);

    const seen = async (who: Client) => {
      const res = await who.get(`/api/agents/${claude.agentId}/record`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.record.map((e: { kind: string; ticket: { key: string } }) => `${e.kind} ${e.ticket.key}`);
    };
    expect(await seen(bob)).toEqual(["activity CRONK-1"]);
    expect(await seen(admin)).toEqual(["activity SECRET-1", "activity CRONK-1"]);
    expect((await carol.get(`/api/agents/${claude.agentId}/record`)).status).toBe(404);
  });

  it("is still refused by every other Agent route", async () => {
    const { admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    const token = (await admin.get(`/api/agents/${claude.agentId}/tokens`)).body.tokens[0].id;
    expect((await admin.delete(`/api/agents/${claude.agentId}`)).status).toBe(204);

    expect((await admin.patch(`/api/agents/${claude.agentId}`, { name: "again" })).status).toBe(404);
    expect((await admin.delete(`/api/agents/${claude.agentId}`)).status).toBe(404);
    expect((await admin.get(`/api/agents/${claude.agentId}/tokens`)).status).toBe(404);
    expect((await admin.post(`/api/agents/${claude.agentId}/tokens`, {})).status).toBe(404);
    expect((await admin.delete(`/api/agents/${claude.agentId}/tokens/${token}`)).status).toBe(404);
  });

  it("can no longer be made a Delegate, nor connect", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const adaId = (await admin.get("/api/me")).body.user.id;
    const claude = await registerAgent(admin, "claude-laptop");
    expect((await admin.delete(`/api/agents/${claude.agentId}`)).status).toBe(204);

    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: adaId, delegateId: claude.agentId })).status).toBe(400);
    expect((await cronk.client(claude.secret).post("/api/agent-sessions")).status).toBe(401);
  });
});
