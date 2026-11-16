import { describe, expect, it } from "vitest";
import { registerAgent, startInstalledCronk, startSession } from "./harness.js";

describe("Ticket history", () => {
  it("records every change with the Actor who made it and when", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const { statuses } = (await admin.get("/api/projects/CRONK")).body;
    const [backlog, todo] = statuses;

    await admin.post("/api/projects/CRONK/tickets", { title: "Add login", description: "v1" });
    cronk.clock.advance(60_000);
    await admin.patch("/api/tickets/CRONK-1", { title: "Add sign-in", description: "v2" });
    cronk.clock.advance(60_000);
    await admin.patch("/api/tickets/CRONK-1", { statusId: todo.id });

    const history = await admin.get("/api/tickets/CRONK-1/history");
    expect(history.status).toBe(200);
    const actor = { kind: "user", id: ada.id, name: "Ada" };
    expect(history.body.changes).toEqual([
      { at: "2026-01-01T09:00:00.000Z", actor, change: "created", title: "Add login", description: "v1", status: backlog },
      { at: "2026-01-01T09:01:00.000Z", actor, change: "title", from: "Add login", to: "Add sign-in" },
      { at: "2026-01-01T09:01:00.000Z", actor, change: "description", from: "v1", to: "v2" },
      { at: "2026-01-01T09:02:00.000Z", actor, change: "status", from: backlog, to: todo, sentBack: false },
    ]);
  });

  it("leaves out edits that change nothing", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const [backlog] = (await admin.get("/api/projects/CRONK")).body.statuses;
    await admin.post("/api/projects/CRONK/tickets", { title: "Same" });

    await admin.patch("/api/tickets/CRONK-1", { title: " Same ", description: "", statusId: backlog.id });

    const { changes } = (await admin.get("/api/tickets/CRONK-1/history")).body;
    expect(changes.map((c: { change: string }) => c.change)).toEqual(["created"]);
  });

  it("records changes an Agent makes as that Agent's, with its Owner, even after it is removed", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await registerAgent(admin, "claude-laptop");
    const agent = await startSession(cronk, claude.secret);

    await agent.post("/api/projects/CRONK/tickets", { title: "Found a bug" });
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: ada.id, delegateId: claude.agentId });
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.patch("/api/tickets/CRONK-1", { title: "Fix the bug" });
    await admin.delete(`/api/agents/${claude.agentId}`);

    const { changes } = (await admin.get("/api/tickets/CRONK-1/history")).body;
    const actor = { kind: "agent", id: claude.agentId, name: "claude-laptop", owner: { id: ada.id, name: "Ada" }, session: { id: agent.sessionId } };
    expect(changes.filter((c: { actor: { kind: string } }) => c.actor.kind === "agent")).toEqual([
      expect.objectContaining({ actor, change: "created" }),
      expect.objectContaining({ actor, change: "title", from: "Found a bug", to: "Fix the bug" }),
    ]);
  });

  it("records the Agent Session an Agent's change was made in", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await registerAgent(admin, "claude-laptop");

    expect((await cronk.client(claude.secret).post("/api/projects/CRONK/tickets", { title: "Add login" })).status).toBe(201);
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: ada.id, delegateId: claude.agentId });
    const inSession = await startSession(cronk, claude.secret);
    await inSession.post("/api/tickets/CRONK-1/claim");
    expect((await inSession.patch("/api/tickets/CRONK-1", { title: "Add sign-in" })).status).toBe(200);

    const { changes } = (await admin.get("/api/tickets/CRONK-1/history")).body;
    const byAgent = changes.filter((c: { actor: { kind: string } }) => c.actor.kind === "agent");
    expect(byAgent.map((c: { actor: { session: unknown } }) => c.actor.session)).toEqual([null, { id: inSession.sessionId }]);
  });

  it("refuses a change in an Agent Session that has ended or isn't the Agent's", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Add login" });
    const claude = await registerAgent(admin, "claude-laptop");
    const codex = await registerAgent(admin, "codex");
    const session = (await cronk.client(claude.secret).post("/api/agent-sessions")).body.session;

    const asCodex = cronk.client(codex.secret, { "cronk-agent-session": session.id });
    expect((await asCodex.patch("/api/tickets/CRONK-1", { title: "Taken" })).status).toBe(410);
    const inSession = cronk.client(claude.secret, { "cronk-agent-session": session.id });
    expect((await inSession.delete("/api/agent-sessions/current")).status).toBe(204);
    expect((await inSession.patch("/api/tickets/CRONK-1", { title: "Taken" })).status).toBe(410);
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.title).toBe("Add login");
  });
});
