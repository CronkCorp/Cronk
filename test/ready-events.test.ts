import { describe, expect, it } from "vitest";
import { delegatedSetup, projectWithTickets, registerAgent, startInstalledCronk, startSession } from "./harness.js";

/** The `ticketReady` event telling an Agent that `key` became Ready for it. */
const readyEvent = (key: string) => ({ event: "ticketReady", data: { ticket: expect.objectContaining({ key }) } });

/** Ada with the Project CRONK of `tickets` Tickets assigned to her, and her Agent claude-laptop, not yet delegated anything. */
async function undelegatedSetup(tickets = 1) {
  const { cronk, admin } = await startInstalledCronk();
  await projectWithTickets(admin, "CRONK", tickets);
  const claude = await registerAgent(admin, "claude-laptop");
  const adaId = (await admin.get("/api/users")).body.users[0].id;
  for (let i = 1; i <= tickets; i++) await admin.patch(`/api/tickets/CRONK-${i}`, { assigneeId: adaId });
  return { cronk, admin, claude };
}

describe("An Agent Session's event stream", () => {
  it("tells the Agent when a Ticket is delegated to it", async () => {
    const { cronk, admin, claude } = await undelegatedSetup();
    const agent = await startSession(cronk, claude.secret);
    const stream = await agent.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/tickets/CRONK-1", { delegateId: claude.agentId });
    expect(await stream.next()).toEqual({
      event: "ticketReady",
      data: { ticket: { key: "CRONK-1", title: "Ticket 1", priority: "none", status: expect.objectContaining({ name: "Backlog", category: "backlog" }) } },
    });
  });

  it("tells the Agent when a Ticket of its is unblocked, and not when a Ready one changes", async () => {
    const { admin, session } = await delegatedSetup(3);
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-3" });
    const agent = await session();
    const stream = await agent.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");
    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses;
    const completed = statuses.find((s: any) => s.category === "completed").id;

    await admin.patch("/api/tickets/CRONK-1", { title: "Still Ready" });
    await admin.delete("/api/tickets/CRONK-1/relations/blocks/CRONK-2");
    expect(await stream.next()).toEqual(readyEvent("CRONK-2"));
    await admin.patch("/api/tickets/CRONK-1", { statusId: completed });
    expect(await stream.next()).toEqual(readyEvent("CRONK-3"));
  });

  it("tells the Agent when a Claim on its Ticket is released, ends with its Agent Session, or lapses", async () => {
    const { cronk, admin, session } = await delegatedSetup(3);
    const threshold = (await admin.get("/api/workspace")).body.silenceThresholdSeconds * 1000;
    const holder = await session();
    for (const key of ["CRONK-1", "CRONK-2"]) await holder.post(`/api/tickets/${key}/claim`);
    const watcher = await session();
    const stream = await watcher.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");

    await holder.delete("/api/tickets/CRONK-1/claim");
    expect(await stream.next()).toEqual(readyEvent("CRONK-1"));
    await holder.delete("/api/agent-sessions/current");
    expect(await stream.next()).toEqual(readyEvent("CRONK-2"));

    const silent = await session();
    await silent.post("/api/tickets/CRONK-3/claim");
    cronk.clock.advance(threshold - 1000);
    await watcher.get("/api/agent-sessions/current");
    cronk.clock.advance(2000);
    expect(await stream.next()).toEqual(readyEvent("CRONK-3"));
  });

  it("tells the Agent of a Sub-Ticket split off one of its Tickets", async () => {
    const { admin, session } = await delegatedSetup(1);
    const agent = await session();
    const stream = await agent.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.post("/api/tickets/CRONK-1/sub-tickets", { title: "Part" });
    expect(await stream.next()).toEqual(readyEvent("CRONK-2"));
  });

  it("tells the Agent of its Tickets that a removed Status moves back into unfinished work", async () => {
    const { admin, session } = await delegatedSetup(1);
    const shelved = (await admin.post("/api/projects/CRONK/statuses", { name: "Shelved", category: "canceled" })).body.status;
    await admin.patch("/api/tickets/CRONK-1", { statusId: shelved.id });
    const agent = await session();
    const stream = await agent.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");

    const backlog = (await admin.get("/api/projects/CRONK")).body.statuses[0].id;
    expect((await admin.delete(`/api/projects/CRONK/statuses/${shelved.id}?moveTo=${backlog}`)).status).toBe(204);
    expect(await stream.next()).toEqual(readyEvent("CRONK-1"));
  });

  it("leaves a read-only token's Agent Sessions out, as they can't Claim anything", async () => {
    const { cronk, admin, claude } = await undelegatedSetup();
    const readOnly = await startSession(cronk, (await admin.post(`/api/agents/${claude.agentId}/tokens`, { readOnly: true })).body.secret);
    const stream = await readOnly.events("/api/agent-sessions/current/events");
    expect((await stream.next())?.event).toBe("ready");

    await admin.patch("/api/tickets/CRONK-1", { delegateId: claude.agentId });
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Over to you." });
    expect((await stream.next())?.event).toBe("waiting");
  });
});
