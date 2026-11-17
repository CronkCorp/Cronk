import { describe, expect, it } from "vitest";
import { agentOf, delegatedSetup, joinAs, registerAgent, startInstalledCronk, startSession, tarGz, untarGz, type EventStream } from "./harness.js";

describe("A Project's live updates", () => {
  it("tell its watchers which Ticket changed when one is edited", async () => {
    const { admin } = await delegatedSetup(2);
    const stream = await admin.events("/api/projects/CRONK/events");
    expect(stream.status).toBe(200);
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/tickets/CRONK-2", { title: "Renamed" });
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-2" } });
  });

  it("tell which Tickets lost their Delegate when its Agent is removed", async () => {
    const { admin, claude } = await delegatedSetup(2);
    await admin.patch("/api/tickets/CRONK-2", { delegateId: null });
    const board = await admin.events("/api/projects/CRONK/events");
    const page = await admin.events("/api/tickets/CRONK-1/events");
    expect((await board.next())?.event).toBe("ready");
    expect((await page.next())?.event).toBe("ready");

    await admin.delete(`/api/agents/${claude.agentId}`);
    await admin.patch("/api/tickets/CRONK-2", { title: "Marker" });
    expect(await board.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });
    expect(await board.next()).toEqual({ event: "changed", data: { ticket: "CRONK-2" } });
    expect(await page.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });
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

  it("tell which Tickets changed when their Claims lapse because the Agents' Owner is deactivated", async () => {
    const { cronk, admin } = await delegatedSetup(2);
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId: string = (await bob.get("/api/me")).body.user.id;
    const first = await registerAgent(bob, "bob-laptop");
    const second = await registerAgent(bob, "bob-desktop");
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: bobId, delegateId: first.agentId });
    await admin.patch("/api/tickets/CRONK-2", { assigneeId: bobId, delegateId: second.agentId });
    expect((await (await startSession(cronk, first.secret)).post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    expect((await (await startSession(cronk, second.secret)).post("/api/tickets/CRONK-2/claim")).status).toBe(200);
    const project = await admin.events("/api/projects/CRONK/events");
    const ticket = await admin.events("/api/tickets/CRONK-1/events");
    expect((await project.next())?.event).toBe("ready");
    expect((await ticket.next())?.event).toBe("ready");

    expect((await admin.patch(`/api/users/${bobId}`, { active: false })).status).toBe(200);
    const changed = [await project.next(), await project.next()].map((e) => e?.data.ticket).sort();
    expect(changed).toEqual(["CRONK-1", "CRONK-2"]);
    expect(await ticket.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });
  });

  it("don't tell again of a Claim that had lapsed before its Agent's Owner was deactivated", async () => {
    const { cronk, admin } = await delegatedSetup(2);
    const threshold = (await admin.get("/api/workspace")).body.silenceThresholdSeconds;
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId: string = (await bob.get("/api/me")).body.user.id;
    const laptop = await registerAgent(bob, "bob-laptop");
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: bobId, delegateId: laptop.agentId });
    expect((await (await startSession(cronk, laptop.secret)).post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");
    cronk.clock.advance(threshold * 1000 + 1);
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });

    expect((await admin.patch(`/api/users/${bobId}`, { active: false })).status).toBe(200);
    await admin.patch("/api/tickets/CRONK-2", { title: "After" });
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

  it("push a Send back's Comment marked as one", async () => {
    const { admin } = await delegatedSetup(1);
    const inReview = (await admin.get("/api/projects/CRONK")).body.statuses.find((s: any) => s.category === "in_review").id;
    await admin.patch("/api/tickets/CRONK-1", { statusId: inReview });
    const stream = await admin.events("/api/tickets/CRONK-1/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.post("/api/tickets/CRONK-1/send-back", { comment: "Add a test." });
    let pushed = await stream.next();
    while (pushed && pushed.event !== "comment") pushed = await stream.next();
    expect(pushed?.data.comment).toMatchObject({ body: "Add a test.", sendBack: true });
  });

  it("tell its watchers and its Project's when a Document is linked to it or unlinked from it", async () => {
    const { admin } = await delegatedSetup(1);
    const planId = (await admin.post("/api/projects/CRONK/documents", { title: "Plan" })).body.document.id;
    const ticket = await admin.events("/api/tickets/CRONK-1/events");
    const project = await admin.events("/api/projects/CRONK/events");
    expect((await ticket.next())?.event).toBe("ready");
    expect((await project.next())?.event).toBe("ready");
    const changed = { event: "changed", data: { ticket: "CRONK-1" } };

    await admin.post(`/api/tickets/CRONK-1/documents/${planId}`);
    expect(await ticket.next()).toEqual(changed);
    expect(await project.next()).toEqual(changed);
    await admin.delete(`/api/tickets/CRONK-1/documents/${planId}`);
    expect(await ticket.next()).toEqual(changed);
    expect(await project.next()).toEqual(changed);
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

/** The notice a Terms stream sends whenever a Term there may have changed. */
const CHANGED = { event: "changed", data: {} };

/** Long enough for an event already published to have arrived. */
const QUIET_MS = 500;

/** Expects no further event on `stream` for a while. */
const expectQuiet = (stream: EventStream) => expect(stream.next(QUIET_MS)).rejects.toThrow("No server-sent event came in time");

describe("The Workspace's Terms' live updates", () => {
  it("tell their watchers when a Workspace Term is created, saved, (un)protected or deleted", async () => {
    const { admin } = await startInstalledCronk();
    const stream = await admin.events("/api/workspace/terms/events");
    expect(stream.status).toBe(200);
    expect((await stream.next())?.event).toBe("ready");

    const term = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." })).body.term;
    expect(await stream.next()).toEqual(CHANGED);
    await admin.patch(`/api/terms/${term.id}`, { baseVersion: 1, definition: "A unit of tracked work." });
    expect(await stream.next()).toEqual(CHANGED);
    await admin.post(`/api/terms/${term.id}/protection`, { protected: true });
    expect(await stream.next()).toEqual(CHANGED);
    await admin.post(`/api/terms/${term.id}/protection`, { protected: false });
    expect(await stream.next()).toEqual(CHANGED);
    expect((await admin.delete(`/api/terms/${term.id}?baseVersion=2`)).status).toBe(204);
    expect(await stream.next()).toEqual(CHANGED);
  });

  it("tell nothing of a write that is refused or rolls back", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ticket = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." })).body.term;
    await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold on a Ticket." });
    await admin.post(`/api/terms/${ticket.id}/protection`, { protected: true });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    const stream = await admin.events("/api/workspace/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    expect((await admin.post("/api/workspace/terms", { name: "ticket", definition: "Again." })).status).toBe(409);
    expect((await admin.patch(`/api/terms/${ticket.id}`, { baseVersion: 1, name: "Claim" })).status).toBe(409);
    expect((await admin.patch(`/api/terms/${ticket.id}`, { baseVersion: 7, definition: "Stale." })).status).toBe(409);
    expect((await admin.delete(`/api/terms/${ticket.id}?baseVersion=7`)).status).toBe(409);
    expect((await claude.patch(`/api/terms/${ticket.id}`, { baseVersion: 1, definition: "Protected." })).status).toBe(403);
    expect((await claude.post(`/api/terms/${ticket.id}/protection`, { protected: false })).status).toBe(403);

    await admin.patch(`/api/terms/${ticket.id}`, { baseVersion: 1, definition: "A unit of tracked work." });
    expect(await stream.next()).toEqual(CHANGED);
    await expectQuiet(stream);
  });

  it("tell their watchers when a Project Term changes, as it may override a Workspace Term", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const stream = await admin.events("/api/workspace/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    const term = (await admin.post("/api/projects/CRONK/terms", { name: "Ticket", definition: "A unit of work." })).body.term;
    expect(await stream.next()).toEqual(CHANGED);
    expect((await admin.delete(`/api/terms/${term.id}?baseVersion=1`)).status).toBe(204);
    expect(await stream.next()).toEqual(CHANGED);
  });

  it("tell nothing of a Project's Terms to a watcher who can't see the Project", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const stream = await bob.events("/api/workspace/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.post("/api/projects/CRONK/terms", { name: "Secret", definition: "Only for Cronk." });
    await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." });
    expect(await stream.next()).toEqual(CHANGED);
    await expectQuiet(stream);
  });

  it("are refused to whoever can't read the Workspace, and end once the watcher no longer can", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await agentOf(cronk, admin, "claude-laptop");
    const stream = await claude.events("/api/workspace/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/workspace", { agentAccess: "none" });
    expect((await claude.events("/api/workspace/terms/events")).status).toBe(403);
    await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." });
    expect(await stream.next()).toBeNull();
  });
});

describe("A Project's Terms' live updates", () => {
  it("tell their watchers when one of its Terms, or a Workspace Term, is created, saved, (un)protected or deleted", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const stream = await admin.events("/api/projects/CRONK/terms/events");
    expect(stream.status).toBe(200);
    expect((await stream.next())?.event).toBe("ready");

    const own = (await admin.post("/api/projects/CRONK/terms", { name: "Ticket", definition: "A unit of work." })).body.term;
    expect(await stream.next()).toEqual(CHANGED);
    await admin.patch(`/api/terms/${own.id}`, { baseVersion: 1, definition: "A unit of tracked work." });
    expect(await stream.next()).toEqual(CHANGED);
    await admin.post(`/api/terms/${own.id}/protection`, { protected: true });
    expect(await stream.next()).toEqual(CHANGED);
    expect((await admin.delete(`/api/terms/${own.id}?baseVersion=2`)).status).toBe(204);
    expect(await stream.next()).toEqual(CHANGED);

    const shared = (await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold on a Ticket." })).body.term;
    expect(await stream.next()).toEqual(CHANGED);
    await admin.patch(`/api/terms/${shared.id}`, { baseVersion: 1, definition: "An Agent Session's hold on a Ticket." });
    expect(await stream.next()).toEqual(CHANGED);
  });

  it("tell nothing of another Project's Terms", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Website", key: "SITE" });
    const stream = await admin.events("/api/projects/CRONK/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.post("/api/projects/SITE/terms", { name: "Page", definition: "A web page." });
    await admin.post("/api/projects/CRONK/terms", { name: "Ticket", definition: "A unit of work." });
    expect(await stream.next()).toEqual(CHANGED);
    await expectQuiet(stream);
  });

  it("tell of Workspace Terms only a watcher who can read the Workspace", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.patch("/api/workspace", { agentAccess: "none" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    const stream = await claude.events("/api/projects/CRONK/terms/events");
    expect(stream.status).toBe(200);
    expect((await stream.next())?.event).toBe("ready");

    await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold on a Ticket." });
    await admin.post("/api/projects/CRONK/terms", { name: "Ticket", definition: "A unit of work." });
    expect(await stream.next()).toEqual(CHANGED);
    await expectQuiet(stream);
  });

  it("are refused to whoever can't see the Project, and end once the watcher no longer can", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const stream = await bob.events("/api/projects/CRONK/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    expect((await bob.events("/api/projects/CRONK/terms/events")).status).toBe(404);
    await admin.post("/api/projects/CRONK/terms", { name: "Ticket", definition: "A unit of work." });
    expect(await stream.next()).toBeNull();
  });

  it("end once the watcher can no longer read the Workspace whose Terms they hear of", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    const stream = await claude.events("/api/projects/CRONK/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/workspace", { agentAccess: "none" });
    await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold on a Ticket." });
    expect(await stream.next()).toBeNull();
  });

  it("tell their watchers, and the Workspace's, when a Suggestion on one of its Terms is accepted", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const term = (await admin.post("/api/projects/CRONK/terms", { name: "Claim", definition: "A hold." })).body.term;
    await admin.post(`/api/terms/${term.id}/protection`, { protected: true });
    await admin.post("/api/projects/CRONK/tickets", { title: "Word it better" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await claude.post("/api/tickets/CRONK-1/claim");
    const made = await claude.post("/api/suggestions", { item: { kind: "term", id: term.id }, baseVersion: 1, content: { definition: "A temporary hold." }, reasoning: "Say it ends." });
    expect(made.status).toBe(201);
    const project = await admin.events("/api/projects/CRONK/terms/events");
    const workspace = await admin.events("/api/workspace/terms/events");
    expect((await project.next())?.event).toBe("ready");
    expect((await workspace.next())?.event).toBe("ready");

    expect((await admin.post(`/api/suggestions/${made.body.suggestion.id}/accept`)).status).toBe(200);
    expect(await project.next()).toEqual(CHANGED);
    expect(await workspace.next()).toEqual(CHANGED);
  });

  it("tell their watchers, and the Workspace's, when a Suggestion on one of its Terms is made or rejected, so its count shows", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const term = (await admin.post("/api/projects/CRONK/terms", { name: "Claim", definition: "A hold." })).body.term;
    await admin.post(`/api/terms/${term.id}/protection`, { protected: true });
    await admin.post("/api/projects/CRONK/tickets", { title: "Word it better" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await claude.post("/api/tickets/CRONK-1/claim");
    const project = await admin.events("/api/projects/CRONK/terms/events");
    const workspace = await admin.events("/api/workspace/terms/events");
    expect((await project.next())?.event).toBe("ready");
    expect((await workspace.next())?.event).toBe("ready");

    const made = await claude.post("/api/suggestions", { item: { kind: "term", id: term.id }, baseVersion: 1, content: { definition: "A temporary hold." }, reasoning: "Say it ends." });
    expect(made.status).toBe(201);
    expect(await project.next()).toEqual(CHANGED);
    expect(await workspace.next()).toEqual(CHANGED);

    expect((await admin.post(`/api/suggestions/${made.body.suggestion.id}/reject`, { reason: "It doesn't." })).status).toBe(200);
    expect(await project.next()).toEqual(CHANGED);
    expect(await workspace.next()).toEqual(CHANGED);
  });

  it("tell nothing of a Suggestion on a Document", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { document } = (await admin.post("/api/projects/CRONK/documents", { title: "Limits", body: "Five." })).body;
    await admin.post(`/api/documents/${document.id}/protection`, { protected: true });
    await admin.post("/api/projects/CRONK/tickets", { title: "Word it better" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await claude.post("/api/tickets/CRONK-1/claim");
    const project = await admin.events("/api/projects/CRONK/terms/events");
    expect((await project.next())?.event).toBe("ready");

    const made = await claude.post("/api/suggestions", { item: { kind: "document", id: document.id }, baseVersion: 1, content: { body: "Six." }, reasoning: "More." });
    expect(made.status).toBe(201);
    await expectQuiet(project);
  });
});

describe("A Decision's live updates", () => {
  it("tell its watchers of each new Version: who saved which", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Use Postgres", body: "v1" });
    const bob = await joinAs(cronk, admin, "bob@example.com", "member", "Bob");
    const stream = await admin.events("/api/decisions/CRONK-D1/events");
    expect(stream.status).toBe(200);
    expect((await stream.next())?.event).toBe("ready");

    expect((await bob.patch("/api/decisions/CRONK-D1", { baseVersion: 1, body: "v2" })).status).toBe(200);
    expect(await stream.next()).toEqual({ event: "version", data: { version: 2, by: expect.objectContaining({ kind: "user", name: "Bob" }) } });
  });

  it("tell of the new Version a change of status makes", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Use Postgres" });
    const stream = await admin.events("/api/decisions/CRONK-D1/events");
    expect((await stream.next())?.event).toBe("ready");

    expect((await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" })).status).toBe(200);
    expect(await stream.next()).toEqual({ event: "version", data: { version: 2, by: expect.objectContaining({ kind: "user", name: "Ada" }) } });
  });

  it("tell of the new Version that marks a Decision superseded, on its own stream only", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Use MySQL" });
    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Use Postgres", supersedes: ["CRONK-D1"] });
    const older = await admin.events("/api/decisions/CRONK-D1/events");
    const newer = await admin.events("/api/decisions/CRONK-D2/events");
    expect((await older.next())?.event).toBe("ready");
    expect((await newer.next())?.event).toBe("ready");

    expect((await admin.post("/api/decisions/CRONK-D2/status", { status: "accepted" })).status).toBe(200);
    expect(await older.next()).toEqual({ event: "version", data: { version: 3, by: expect.objectContaining({ name: "Ada" }) } });
    expect(await newer.next()).toEqual({ event: "version", data: { version: 2, by: expect.objectContaining({ name: "Ada" }) } });
    await expectQuiet(older);
    await expectQuiet(newer);
  });

  it("tell of the new Version an accepted Suggestion makes", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Use Postgres", body: "v1" });
    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Word it better" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await claude.post("/api/tickets/CRONK-1/claim");
    const made = await claude.post("/api/suggestions", { item: { kind: "decision", key: "CRONK-D1" }, baseVersion: 2, content: { body: "v3" }, reasoning: "Clearer." });
    expect(made.status).toBe(201);
    const stream = await admin.events("/api/decisions/CRONK-D1/events");
    expect((await stream.next())?.event).toBe("ready");

    expect((await admin.post(`/api/suggestions/${made.body.suggestion.id}/accept`)).status).toBe(200);
    expect(await stream.next()).toEqual({ event: "version", data: { version: 3, by: expect.objectContaining({ kind: "agent", name: "claude-laptop" }) } });
  });

  it("tell nothing of a write that is refused or rolls back", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Use MySQL" });
    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Use Postgres", supersedes: ["CRONK-D1"] });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    const older = await admin.events("/api/decisions/CRONK-D1/events");
    const newer = await admin.events("/api/decisions/CRONK-D2/events");
    expect((await older.next())?.event).toBe("ready");
    expect((await newer.next())?.event).toBe("ready");

    expect((await admin.patch("/api/decisions/CRONK-D2", { baseVersion: 7, body: "Stale." })).status).toBe(409);
    expect((await claude.post("/api/decisions/CRONK-D2/status", { status: "accepted" })).status).toBe(403);
    expect((await admin.post("/api/decisions/CRONK-D2/status", { status: "superseded" })).status).toBe(400);
    expect((await admin.post("/api/decisions/CRONK-D2/status", { status: "rejected" })).status).toBe(400);
    // Accepting saves both Decisions' new Versions, then fails marking the accepted one Protected, as on a database blip.
    let accepting!: Promise<{ status: number }>;
    await cronk.interruptQueriesOn("protection_markings", async () => {
      accepting = admin.post("/api/decisions/CRONK-D2/status", { status: "accepted" });
    });
    expect((await accepting).status).toBe(500);
    expect((await admin.get("/api/decisions/CRONK-D2")).body.decision.version).toBe(1);

    expect((await admin.post("/api/decisions/CRONK-D2/status", { status: "accepted" })).status).toBe(200);
    expect(await older.next()).toEqual({ event: "version", data: { version: 3, by: expect.objectContaining({ name: "Ada" }) } });
    expect(await newer.next()).toEqual({ event: "version", data: { version: 2, by: expect.objectContaining({ name: "Ada" }) } });
    await expectQuiet(older);
    await expectQuiet(newer);
  });

  it("are refused to whoever can't see the Decision, and end once the watcher no longer can", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Secret", key: "SECRET", visibility: "private" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Use Postgres" });
    await admin.post("/api/projects/SECRET/decisions", { title: "Hidden" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.events("/api/decisions/SECRET-D1/events")).status).toBe(404);
    const stream = await bob.events("/api/decisions/CRONK-D1/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    await admin.patch("/api/decisions/CRONK-D1", { baseVersion: 1, body: "Secret." });
    expect(await stream.next()).toBeNull();
  });
});

describe("Terms' live updates after an import", () => {
  /** An export of the Project CRONK holding a Term "Ticket", made in another installation. */
  async function projectExport(visibility: "public" | "private" = "public"): Promise<Buffer> {
    const { admin } = await startInstalledCronk("Elsewhere");
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    if (visibility === "private") await admin.patch("/api/projects/CRONK", { visibility });
    await admin.post("/api/projects/CRONK/terms", { name: "Ticket", definition: "A unit of Cronk work." });
    return (await admin.download("/api/projects/CRONK/export")).body;
  }

  it("tell the Workspace's watchers once a Project import gives it Terms that override a Workspace Term", async () => {
    const exported = await projectExport();
    const { admin } = await startInstalledCronk();
    await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." });
    const stream = await admin.events("/api/workspace/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    expect((await admin.upload("/api/import", exported)).status).toBe(201);
    expect(await stream.next()).toEqual(CHANGED);
  });

  it("tell nothing of a Project import to a watcher who can't see the new Project", async () => {
    const exported = await projectExport("private");
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const stream = await bob.events("/api/workspace/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    expect((await admin.upload("/api/import", exported)).status).toBe(201);
    expect((await bob.get("/api/projects/CRONK")).status).toBe(404);
    await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold on a Ticket." });
    expect(await stream.next()).toEqual(CHANGED);
    await expectQuiet(stream);
  });

  it("tell the Workspace's watchers once a Workspace import gives it Terms", async () => {
    const before = await startInstalledCronk("Elsewhere");
    await before.admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." });
    const exported = (await before.admin.download("/api/export")).body;
    const { admin } = await startInstalledCronk();
    const stream = await admin.events("/api/workspace/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    expect((await admin.upload("/api/import", exported)).status).toBe(201);
    expect(await stream.next()).toEqual(CHANGED);
  });

  it("tell nothing of an import that is refused, even once it has written Terms", async () => {
    const before = await startInstalledCronk("Elsewhere");
    await before.admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await before.admin.post("/api/projects/CRONK/terms", { name: "Ticket", definition: "A unit of Cronk work." });
    await before.admin.post("/api/projects/CRONK/tickets", { title: "Ship it" });
    const files = await untarGz((await before.admin.download("/api/projects/CRONK/export")).body);
    // Tickets are imported after Terms, so a Ticket's history Cronk can't take rolls back Terms already written.
    const broken = { ...files, "projects/CRONK/tickets/CRONK-1.history.md": "---\nchanges:\n  - { at: 2026-01-01T09:00:00Z, by: ada@example.com, change: renamed }\n---\n" };
    const { admin } = await startInstalledCronk();
    const stream = await admin.events("/api/workspace/terms/events");
    expect((await stream.next())?.event).toBe("ready");

    const refused = await admin.upload("/api/import", await tarGz(broken));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/CRONK-1\.history\.md/);
    await expectQuiet(stream);
  });
});
