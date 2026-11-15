import { describe, expect, it } from "vitest";
import { agentOf, joinAs, projectWithTickets, registerAgent, startInstalledCronk, startSession } from "./harness.js";

describe("Agents", () => {
  it("lets a User register, rename and remove their own Agents", async () => {
    const { admin } = await startInstalledCronk();

    const created = await admin.post("/api/agents", { name: "claude-laptop" });
    expect(created.status).toBe(201);
    expect(created.body.agent).toMatchObject({ name: "claude-laptop", owner: { name: "Ada" } });
    await admin.post("/api/agents", { name: "codex-ci" });
    const id = created.body.agent.id;

    const renamed = await admin.patch(`/api/agents/${id}`, { name: "claude-desktop" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.agent.name).toBe("claude-desktop");
    expect((await admin.get("/api/agents")).body.agents.map((a: { name: string }) => a.name)).toEqual(["claude-desktop", "codex-ci"]);

    expect((await admin.delete(`/api/agents/${id}`)).status).toBe(204);
    expect((await admin.get("/api/agents")).body.agents.map((a: { name: string }) => a.name)).toEqual(["codex-ci"]);
  });

  it("lets Admins see every User's Agents, but only the Owner change one", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const cy = await joinAs(cronk, admin, "cy@example.com");
    const bobs = (await bob.post("/api/agents", { name: "claude-laptop" })).body.agent;
    await admin.post("/api/agents", { name: "claude-laptop" });

    expect((await bob.get("/api/agents")).body.agents).toEqual([expect.objectContaining({ name: "claude-laptop", owner: expect.objectContaining({ name: "bob" }) })]);
    const all = await admin.get("/api/agents?all=true");
    expect(all.body.agents.map((a: { owner: { name: string } }) => a.owner.name)).toEqual(["Ada", "bob"]);
    expect((await cy.get("/api/agents?all=true")).status).toBe(403);

    expect((await admin.patch(`/api/agents/${bobs.id}`, { name: "mine" })).status).toBe(403);
    expect((await admin.delete(`/api/agents/${bobs.id}`)).status).toBe(403);
    expect((await cy.patch(`/api/agents/${bobs.id}`, { name: "mine" })).status).toBe(404);
    expect((await cy.delete(`/api/agents/${bobs.id}`)).status).toBe(404);
    expect((await bob.get("/api/agents")).body.agents[0].name).toBe("claude-laptop");
  });

  it("refuses a second Agent with the same name for the same Owner", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/agents", { name: "claude-laptop" });
    const other = (await admin.post("/api/agents", { name: "codex" })).body.agent;
    expect((await admin.post("/api/agents", { name: "Claude-Laptop" })).status).toBe(409);
    expect((await admin.patch(`/api/agents/${other.id}`, { name: "claude-laptop" })).status).toBe(409);
  });
});

describe("Agent tokens", () => {
  it("are issued full or read-only, act as the Agent, and are refused as soon as they are revoked", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const agent = (await admin.post("/api/agents", { name: "claude-laptop" })).body.agent;

    const issued = await admin.post(`/api/agents/${agent.id}/tokens`, { readOnly: true });
    expect(issued.status).toBe(201);
    expect(issued.body.token).toMatchObject({ readOnly: true });
    cronk.clock.advance(1000);
    await admin.post(`/api/agents/${agent.id}/tokens`, {});
    expect((await admin.get(`/api/agents/${agent.id}/tokens`)).body.tokens.map((t: { readOnly: boolean }) => t.readOnly)).toEqual([true, false]);

    const claude = cronk.client(issued.body.secret);
    const me = await claude.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ agent: { name: "claude-laptop", owner: { name: "Ada" } }, readOnly: true });
    expect((await claude.get("/api/projects")).body.projects).toEqual([expect.objectContaining({ key: "CRONK" })]);

    expect((await admin.delete(`/api/agents/${agent.id}/tokens/${issued.body.token.id}`)).status).toBe(204);
    expect((await claude.get("/api/projects")).status).toBe(401);
    expect((await admin.get(`/api/agents/${agent.id}/tokens`)).body.tokens).toHaveLength(1);
  });

  it("are refused once their Agent is removed", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const agent = (await admin.post("/api/agents", { name: "claude-laptop" })).body.agent;
    const claude = cronk.client((await admin.post(`/api/agents/${agent.id}/tokens`, {})).body.secret);
    expect((await claude.get("/api/me")).status).toBe(200);
    await admin.delete(`/api/agents/${agent.id}`);
    expect((await claude.get("/api/me")).status).toBe(401);
  });

  it("are refused when unknown", async () => {
    const { cronk } = await startInstalledCronk();
    expect((await cronk.client("not-a-token").get("/api/projects")).status).toBe(401);
  });
});

describe("Agents and their Owner", () => {
  it("stop working while their Owner is deactivated", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    const claude = await agentOf(cronk, bob, "claude-laptop");
    expect((await claude.get("/api/projects")).status).toBe(200);

    await admin.patch(`/api/users/${bobId}`, { active: false });
    expect((await claude.get("/api/projects")).status).toBe(401);
    expect((await claude.get("/api/me")).status).toBe(401);

    await admin.patch(`/api/users/${bobId}`, { active: true });
    expect((await claude.get("/api/projects")).status).toBe(200);
  });

  it("lose their Agent Sessions and Claims when their Owner is deactivated, so a crashed laptop can't hold work", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    await projectWithTickets(admin, "CRONK", 1);
    const claude = await registerAgent(bob, "claude-laptop");
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: bobId, delegateId: claude.agentId });
    const session = await startSession(cronk, claude.secret);
    await session.post("/api/tickets/CRONK-1/claim");

    await admin.patch(`/api/users/${bobId}`, { active: false });
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
    const listed = (await admin.get("/api/agents?all=true")).body.agents.find((a: { id: string }) => a.id === claude.agentId);
    expect(listed.sessions).toEqual([]);

    await admin.patch(`/api/users/${bobId}`, { active: true });
    expect((await session.get("/api/projects")).status).toBe(410);
    expect((await (await startSession(cronk, claude.secret)).post("/api/tickets/CRONK-1/claim")).status).toBe(200);
  });

  it("can't manage Agents or do what only Admins can, even for an Admin", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    const agentId = (await claude.get("/api/me")).body.agent.id;

    for (const res of [
      await claude.get("/api/agents"),
      await claude.post("/api/agents", { name: "spawned" }),
      await claude.post(`/api/agents/${agentId}/tokens`, {}),
      await claude.post("/api/invitations", { email: "eve@example.com" }),
      await claude.patch(`/api/users/${bobId}`, { role: "admin" }),
      await claude.patch("/api/workspace", { name: "Taken" }),
      await claude.patch("/api/projects/CRONK", { visibility: "private" }),
      await claude.put(`/api/projects/CRONK/members/${bobId}`, { access: "read" }),
    ]) {
      expect(res.status).toBe(403);
    }
    expect((await admin.get("/api/projects/CRONK")).body.project.visibility).toBe("open");
  });
});
