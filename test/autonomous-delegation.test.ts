import { describe, expect, it } from "vitest";
import { delegatedSetup } from "./harness.js";

describe("Autonomous Delegation", () => {
  it("is off on a Ticket until a User turns it on, recorded as a Change", async () => {
    const { admin } = await delegatedSetup();
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.autonomous).toBe(false);

    const on = await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    expect(on.status).toBe(200);
    expect(on.body.ticket.autonomous).toBe(true);
    const off = await admin.patch("/api/tickets/CRONK-1", { autonomous: false });
    expect(off.body.ticket.autonomous).toBe(false);

    const { changes } = (await admin.get("/api/tickets/CRONK-1/changes")).body;
    expect(changes.slice(-2)).toMatchObject([
      { actor: { kind: "user", name: "Ada" }, change: "autonomous", from: false, to: true },
      { actor: { kind: "user", name: "Ada" }, change: "autonomous", from: true, to: false },
    ]);
  });

  it("is set only by Users, never by Agents, not even the Delegate holding the Claim", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const refused = await agent.patch("/api/tickets/CRONK-1", { autonomous: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Only a User/);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.autonomous).toBe(false);
  });
});

describe("Autonomous Delegation on Sub-Tickets", () => {
  it("is inherited by Sub-Tickets created later, including those the Agent splits off", async () => {
    const { admin, session } = await delegatedSetup();
    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    const split = await agent.post("/api/tickets/CRONK-1/sub-tickets", { title: "First half" });
    expect(split.status).toBe(201);
    expect(split.body.ticket.autonomous).toBe(true);
    const byUser = await admin.post(`/api/tickets/${split.body.ticket.key}/sub-tickets`, { title: "A quarter" });
    expect(byUser.body.ticket.autonomous).toBe(true);
  });

  it("follows the parent when a User turns it on or off, all the way down", async () => {
    const { admin } = await delegatedSetup();
    const child = (await admin.post("/api/tickets/CRONK-1/sub-tickets", { title: "Child" })).body.ticket.key;
    const grandchild = (await admin.post(`/api/tickets/${child}/sub-tickets`, { title: "Grandchild" })).body.ticket.key;
    expect((await admin.get(`/api/tickets/${grandchild}`)).body.ticket.autonomous).toBe(false);

    await admin.patch("/api/tickets/CRONK-1", { autonomous: true });
    expect((await admin.get(`/api/tickets/${child}`)).body.ticket.autonomous).toBe(true);
    expect((await admin.get(`/api/tickets/${grandchild}`)).body.ticket.autonomous).toBe(true);
    expect((await admin.get(`/api/tickets/${grandchild}/changes`)).body.changes.at(-1)).toMatchObject({
      actor: { kind: "user", name: "Ada" },
      change: "autonomous",
      from: false,
      to: true,
    });

    await admin.patch("/api/tickets/CRONK-1", { autonomous: false });
    expect((await admin.get(`/api/tickets/${grandchild}`)).body.ticket.autonomous).toBe(false);
  });
});

describe("A Project's Autonomous Delegation default", () => {
  it("is off until a User turns it on, and only Users change it", async () => {
    const { admin, session } = await delegatedSetup();
    expect((await admin.get("/api/projects/CRONK")).body.project.autonomousByDefault).toBe(false);

    const on = await admin.patch("/api/projects/CRONK", { autonomousByDefault: true });
    expect(on.status).toBe(200);
    expect(on.body.project.autonomousByDefault).toBe(true);
    expect((await admin.get("/api/projects/CRONK")).body.project.autonomousByDefault).toBe(true);

    const agent = await session();
    const refused = await agent.patch("/api/projects/CRONK", { autonomousByDefault: false });
    expect(refused.status).toBe(403);
    expect((await admin.get("/api/projects/CRONK")).body.project.autonomousByDefault).toBe(true);
  });

  it("pre-fills Autonomous Delegation when a User delegates a Ticket, unless the User says otherwise", async () => {
    const { admin, claude } = await delegatedSetup(3);
    await admin.patch("/api/projects/CRONK", { autonomousByDefault: true });
    // Already delegated: changing the default doesn't touch existing Delegations.
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.autonomous).toBe(false);

    for (const key of ["CRONK-1", "CRONK-2", "CRONK-3"]) await admin.patch(`/api/tickets/${key}`, { delegateId: null });
    expect((await admin.patch("/api/tickets/CRONK-1", { delegateId: claude.agentId })).body.ticket.autonomous).toBe(true);
    expect((await admin.patch("/api/tickets/CRONK-2", { delegateId: claude.agentId, autonomous: false })).body.ticket.autonomous).toBe(false);

    await admin.patch("/api/projects/CRONK", { autonomousByDefault: false });
    await admin.patch("/api/tickets/CRONK-3", { autonomous: true });
    expect((await admin.patch("/api/tickets/CRONK-3", { delegateId: claude.agentId })).body.ticket.autonomous).toBe(false);
  });
});
