import { describe, expect, it } from "vitest";
import { joinAs, projectWithTickets, registerAgent, startInstalledCronk } from "./harness.js";

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
