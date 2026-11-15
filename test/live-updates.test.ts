import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, startSession } from "./harness.js";

describe("A Project's live updates", () => {
  it("tell its watchers which Ticket changed when one is edited", async () => {
    const { admin } = await delegatedSetup(2);
    const stream = await admin.events("/api/projects/CRONK/events");
    expect(stream.status).toBe(200);
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/tickets/CRONK-2", { title: "Renamed" });
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-2" } });
  });

  it("end once the watcher can no longer see the Project", async () => {
    const { cronk, admin } = await delegatedSetup(1);
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const stream = await bob.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    await admin.patch("/api/tickets/CRONK-1", { title: "Secret" });
    expect(await stream.next()).toBeNull();
  });

  it("are refused to whoever can't see the Project", async () => {
    const { cronk, admin } = await delegatedSetup(1);
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.events("/api/projects/CRONK/events")).status).toBe(404);
  });

  it("tell which Tickets changed when a Ticket or a Sub-Ticket is created", async () => {
    const { admin } = await delegatedSetup(1);
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.post("/api/projects/CRONK/tickets", { title: "New" });
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-2" } });
    await admin.post("/api/tickets/CRONK-1/sub-tickets", { title: "Part" });
    const changed = [await stream.next(), await stream.next()].map((e) => e?.data.ticket);
    expect(changed.sort()).toEqual(["CRONK-1", "CRONK-3"]);
  });

  it("tell which Tickets changed when a relation between them is added or removed", async () => {
    const { admin } = await delegatedSetup(2);
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");
    const changed = async () => [await stream.next(), await stream.next()].map((e) => e?.data.ticket).sort();

    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    expect(await changed()).toEqual(["CRONK-1", "CRONK-2"]);
    await admin.delete("/api/tickets/CRONK-1/relations/blocks/CRONK-2");
    expect(await changed()).toEqual(["CRONK-1", "CRONK-2"]);
  });

  it("tell which Tickets changed when a Ticket moves under another parent", async () => {
    const { admin } = await delegatedSetup(3);
    await admin.patch("/api/tickets/CRONK-3", { parentKey: "CRONK-1" });
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/tickets/CRONK-3", { parentKey: "CRONK-2" });
    const changed = [await stream.next(), await stream.next(), await stream.next()].map((e) => e?.data.ticket).sort();
    expect(changed).toEqual(["CRONK-1", "CRONK-2", "CRONK-3"]);
  });

  it("tell which Ticket changed when an Agent Session Claims or releases it", async () => {
    const { admin, session } = await delegatedSetup(2);
    const agent = await session();
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");

    await agent.post("/api/tickets/CRONK-2/claim");
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-2" } });
    await agent.delete("/api/tickets/CRONK-2/claim");
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-2" } });
    await agent.post("/api/agent-sessions/current/next");
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });
    await agent.delete("/api/agent-sessions/current");
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });
  });

  it("tell which Ticket changed when its Claim ends with its Agent's token or the Agent itself", async () => {
    const { cronk, admin, claude, session } = await delegatedSetup(2);
    await (await session()).post("/api/tickets/CRONK-1/claim");
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.delete(`/api/agents/${claude.agentId}/tokens/${claude.tokenId}`);
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });

    const secret = (await admin.post(`/api/agents/${claude.agentId}/tokens`, { readOnly: false })).body.secret;
    await (await startSession(cronk, secret)).post("/api/tickets/CRONK-2/claim");
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-2" } });
    await admin.delete(`/api/agents/${claude.agentId}`);
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-2" } });
  });

  it("tell which Ticket changed when its Claim lapses", async () => {
    const { cronk, admin, session } = await delegatedSetup(1);
    const threshold = (await admin.get("/api/workspace")).body.silenceThresholdSeconds;
    await (await session()).post("/api/tickets/CRONK-1/claim");
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");

    cronk.clock.advance(threshold * 1000 + 1);
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
  });

  it("tell which Ticket changed when its Claim lapses because the Workspace's silence threshold was lowered", async () => {
    const { cronk, admin, session } = await delegatedSetup(1);
    await (await session()).post("/api/tickets/CRONK-1/claim");
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");

    cronk.clock.advance(120_000);
    // Long enough for the server to have looked for lapsed Claims since the clock moved.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await admin.patch("/api/workspace", { silenceThresholdSeconds: 60 })).status).toBe(200);
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });
  });

  it("tell their watchers when the Project's Statuses change, and which Tickets a removed Status moved", async () => {
    const { admin } = await delegatedSetup(1);
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");
    const statusesChanged = { event: "changed", data: { ticket: null } };

    const checking = (await admin.post("/api/projects/CRONK/statuses", { name: "Checking", category: "in_review" })).body.status;
    expect(await stream.next()).toEqual(statusesChanged);
    await admin.patch(`/api/projects/CRONK/statuses/${checking.id}`, { name: "Verifying", position: 0 });
    expect(await stream.next()).toEqual(statusesChanged);
    await admin.patch("/api/tickets/CRONK-1", { statusId: checking.id });
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });
    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses;
    await admin.delete(`/api/projects/CRONK/statuses/${checking.id}?moveTo=${statuses.at(-1).id}`);
    expect([await stream.next(), await stream.next()]).toEqual(expect.arrayContaining([statusesChanged, { event: "changed", data: { ticket: "CRONK-1" } }]));
  });

  it("tell which Ticket changed when it is sent back from review", async () => {
    const { admin } = await delegatedSetup(1);
    const inReview = (await admin.get("/api/projects/CRONK")).body.statuses.find((s: any) => s.category === "in_review").id;
    await admin.patch("/api/tickets/CRONK-1", { statusId: inReview });
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.post("/api/tickets/CRONK-1/send-back", { comment: "Add a test." });
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });
  });

  it("tell which Tickets changed when finishing a Ticket unblocks them", async () => {
    const { admin } = await delegatedSetup(2);
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    const completed = (await admin.get("/api/projects/CRONK")).body.statuses.find((s: any) => s.category === "completed").id;
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/tickets/CRONK-1", { statusId: completed });
    const changed = [await stream.next(), await stream.next()].map((e) => e?.data.ticket).sort();
    expect(changed).toEqual(["CRONK-1", "CRONK-2"]);
  });
});

describe("A Ticket's live updates", () => {
  it("tell its watchers when its fields, Claim or Sub-Tickets change", async () => {
    const { admin, session } = await delegatedSetup(2);
    const stream = await admin.events("/api/tickets/CRONK-1/events");
    expect((await stream.next())?.event).toBe("ready");
    const changed = { event: "changed", data: { ticket: "CRONK-1" } };

    await admin.patch("/api/tickets/CRONK-2", { title: "Someone else" });
    await admin.patch("/api/tickets/CRONK-1", { priority: "high" });
    expect(await stream.next()).toEqual(changed);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    expect(await stream.next()).toEqual(changed);
    await agent.post("/api/tickets/CRONK-1/sub-tickets", { title: "Part" });
    expect(await stream.next()).toEqual(changed);
  });
});

describe("A Document's live updates", () => {
  it("tell its watchers of each new Comment and each new Version", async () => {
    const { admin } = await delegatedSetup(0);
    await admin.post("/api/projects", { name: "Docs", key: "DOCS" });
    const { id } = (await admin.post("/api/projects/DOCS/documents", { title: "Plan", body: "## Goal\n\nv1" })).body.document;
    const stream = await admin.events(`/api/documents/${id}/events`);
    expect(stream.status).toBe(200);
    expect((await stream.next())?.event).toBe("ready");

    const comment = (await admin.post(`/api/documents/${id}/comments`, { body: "Looks good." })).body.comment;
    expect(await stream.next()).toEqual({ event: "comment", data: { comment } });
    await admin.patch(`/api/documents/${id}`, { baseVersion: 1, body: "## Goal\n\nv2" });
    expect(await stream.next()).toEqual({ event: "version", data: { version: 2 } });
    await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 2, heading: "Goal", body: "v3" });
    expect(await stream.next()).toEqual({ event: "version", data: { version: 3 } });
    await admin.post(`/api/documents/${id}/versions/1/restore`, { baseVersion: 3 });
    expect(await stream.next()).toEqual({ event: "version", data: { version: 4 } });
  });

  it("end once the watcher can no longer see the Document", async () => {
    const { cronk, admin } = await delegatedSetup(0);
    await admin.post("/api/projects", { name: "Docs", key: "DOCS" });
    const { id } = (await admin.post("/api/projects/DOCS/documents", { title: "Plan", body: "v1" })).body.document;
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const stream = await bob.events(`/api/documents/${id}/events`);
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/projects/DOCS", { visibility: "private" });
    await admin.post(`/api/documents/${id}/comments`, { body: "Secret." });
    expect(await stream.next()).toBeNull();
  });

  it("end once the Document is deleted", async () => {
    const { admin } = await delegatedSetup(0);
    await admin.post("/api/projects", { name: "Docs", key: "DOCS" });
    const { id } = (await admin.post("/api/projects/DOCS/documents", { title: "Plan", body: "v1" })).body.document;
    const stream = await admin.events(`/api/documents/${id}/events`);
    expect((await stream.next())?.event).toBe("ready");

    expect((await admin.delete(`/api/documents/${id}?baseVersion=1`)).status).toBe(204);
    expect(await stream.next()).toBeNull();
  });
});
