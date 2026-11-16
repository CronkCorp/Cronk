import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, projectWithTickets, registerAgent, startInstalledCronk } from "./harness.js";

/** The id of the User named `name`, as `client` sees the Workspace's Users. */
async function userId(client: { get: (path: string) => Promise<{ body: any }> }, name: string): Promise<string> {
  const { users } = (await client.get("/api/users")).body;
  return users.find((u: { name: string }) => u.name === name).id;
}

describe("Ticket Delegate", () => {
  it("can be one of the Assignee's own Agents, and is recorded in the history", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const claude = await registerAgent(admin, "claude-laptop");
    const adaId = await userId(admin, "Ada");
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.delegate).toBeNull();

    const delegated = await admin.patch("/api/tickets/CRONK-1", { assigneeId: adaId, delegateId: claude.agentId });
    expect(delegated.status).toBe(200);
    expect(delegated.body.ticket.delegate).toEqual({ id: claude.agentId, name: "claude-laptop" });

    const cleared = await admin.patch("/api/tickets/CRONK-1", { delegateId: null });
    expect(cleared.body.ticket.delegate).toBeNull();
    const { changes } = (await admin.get("/api/tickets/CRONK-1/history")).body;
    expect(changes.slice(1)).toMatchObject([
      { change: "assignee" },
      { change: "delegate", from: null, to: { id: claude.agentId, name: "claude-laptop" } },
      { change: "delegate", from: { id: claude.agentId, name: "claude-laptop" }, to: null },
    ]);
  });

  it("is refused without an Assignee, or when the Agent isn't the Assignee's", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await projectWithTickets(admin, "CRONK", 1);
    const bobsAgent = await registerAgent(bob, "bob-bot");
    const adasAgent = await registerAgent(admin, "claude-laptop");

    expect((await admin.patch("/api/tickets/CRONK-1", { delegateId: adasAgent.agentId })).status).toBe(400);
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: await userId(admin, "Ada") });
    const foreign = await admin.patch("/api/tickets/CRONK-1", { delegateId: bobsAgent.agentId });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toMatch(/Assignee's own Agents/);
    expect((await admin.patch("/api/tickets/CRONK-1", { delegateId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.delegate).toBeNull();
  });

  it("is cleared when the Assignee changes to someone who doesn't own it, and kept otherwise", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await joinAs(cronk, admin, "bob@example.com");
    await projectWithTickets(admin, "CRONK", 1);
    const claude = await registerAgent(admin, "claude-laptop");
    const adaId = await userId(admin, "Ada");
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: adaId, delegateId: claude.agentId });

    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: adaId, title: "Renamed" })).body.ticket.delegate).not.toBeNull();
    const reassigned = await admin.patch("/api/tickets/CRONK-1", { assigneeId: await userId(admin, "bob") });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.ticket.delegate).toBeNull();
    const unassigned = await admin.patch("/api/tickets/CRONK-1", { assigneeId: adaId, delegateId: claude.agentId });
    expect(unassigned.body.ticket.delegate).not.toBeNull();
    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: null })).body.ticket.delegate).toBeNull();
  });

  it("and the Assignee are set only by Users, never by Agents", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const claude = await registerAgent(admin, "claude-laptop");
    const asAgent = cronk.client(claude.secret);
    const adaId = await userId(admin, "Ada");

    expect((await asAgent.patch("/api/tickets/CRONK-1", { assigneeId: adaId })).status).toBe(403);
    expect((await asAgent.patch("/api/tickets/CRONK-1", { delegateId: claude.agentId })).status).toBe(403);
  });
});

describe("Ticket Delegate, further", () => {
  it("is cleared when its Agent is removed, recorded as a change by whoever removed it", async () => {
    const { admin, claude } = await delegatedSetup(2);
    expect((await admin.delete(`/api/agents/${claude.agentId}`)).status).toBe(204);

    for (const key of ["CRONK-1", "CRONK-2"]) {
      expect((await admin.get(`/api/tickets/${key}`)).body.ticket.delegate).toBeNull();
      const { changes } = (await admin.get(`/api/tickets/${key}/history`)).body;
      expect(changes.at(-1)).toMatchObject({
        actor: { kind: "user", name: "Ada" },
        change: "delegate",
        from: { id: claude.agentId, name: "claude-laptop" },
        to: null,
      });
      expect(changes.at(-2)).toMatchObject({ change: "delegate", to: { id: claude.agentId } });
    }
  });

  it("is cleared on finished and archived-Project Tickets too when its Agent is removed, leaving other Agents' Delegations alone", async () => {
    const { cronk, admin, claude, adaId } = await delegatedSetup(3);
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const otherOfAdas = await registerAgent(admin, "claude-desktop");
    const bobsAgent = await registerAgent(bob, "bob-bot");
    const statuses = (await admin.get("/api/projects/CRONK")).body.statuses as { id: string; category: string }[];
    await admin.patch("/api/tickets/CRONK-1", { statusId: statuses.find((s) => s.category === "completed")!.id });
    await admin.patch("/api/tickets/CRONK-2", { delegateId: otherOfAdas.agentId });
    await admin.patch("/api/tickets/CRONK-3", { assigneeId: await userId(admin, "bob"), delegateId: bobsAgent.agentId });
    await projectWithTickets(admin, "OLD", 1);
    await admin.patch("/api/tickets/OLD-1", { assigneeId: adaId, delegateId: claude.agentId });
    await admin.patch("/api/projects/OLD", { archived: true });
    const historyLength = async (key: string) => (await admin.get(`/api/tickets/${key}/history`)).body.changes.length;
    const before = { "CRONK-2": await historyLength("CRONK-2"), "CRONK-3": await historyLength("CRONK-3") };

    await admin.delete(`/api/agents/${claude.agentId}`);

    for (const key of ["CRONK-1", "OLD-1"]) {
      expect((await admin.get(`/api/tickets/${key}`)).body.ticket.delegate).toBeNull();
      expect((await admin.get(`/api/tickets/${key}/history`)).body.changes.at(-1)).toMatchObject({ change: "delegate", to: null });
    }
    expect((await admin.get("/api/tickets/CRONK-2")).body.ticket.delegate).toEqual({ id: otherOfAdas.agentId, name: "claude-desktop" });
    expect((await admin.get("/api/tickets/CRONK-3")).body.ticket.delegate).toEqual({ id: bobsAgent.agentId, name: "bob-bot" });
    for (const [key, length] of Object.entries(before)) expect(await historyLength(key)).toBe(length);
  });

  it("stays, with the Agent, when clearing it fails partway through the removal", async () => {
    const { cronk, admin, claude } = await delegatedSetup(1);
    let removal!: Promise<{ status: number }>;
    // Recording the cleared Delegate fails, as on a database blip.
    await cronk.interruptQueriesOn("ticket_changes", async () => {
      removal = admin.delete(`/api/agents/${claude.agentId}`);
    });
    expect((await removal).status).toBe(500);

    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.delegate).toEqual({ id: claude.agentId, name: "claude-laptop" });
    expect((await admin.get("/api/agents")).body.agents.map((a: { id: string }) => a.id)).toContain(claude.agentId);
    expect((await cronk.client(claude.secret).get("/api/tickets/CRONK-1")).status).toBe(200);
  });

  it("refuses an Agent as Assignee", async () => {
    const { admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const claude = await registerAgent(admin, "claude-laptop");
    expect((await admin.patch("/api/tickets/CRONK-1", { assigneeId: claude.agentId })).status).toBe(400);
  });
});
