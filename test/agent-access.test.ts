import { describe, expect, it } from "vitest";
import { agentOf, joinAs, startInstalledCronk, startSession } from "./harness.js";

const keysOf = (res: { body: { projects: { key: string }[] } }) => res.body.projects.map((p) => p.key);

describe("Project Agent Access", () => {
  it("is Write by default and can be set to None, Read or Write by a User with Write in the Project", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await bob.post("/api/projects", { name: "Cronk", key: "CRONK" });
    expect((await bob.get("/api/projects/CRONK")).body.project.agentAccess).toBe("write");

    const set = await bob.patch("/api/projects/CRONK", { agentAccess: "read" });
    expect(set.status).toBe(200);
    expect(set.body.project.agentAccess).toBe("read");
    expect((await admin.get("/api/projects/CRONK")).body.project.agentAccess).toBe("read");
  });

  it("caps an Agent at Read: it reads the Project but is refused every write", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Existing" });
    await admin.patch("/api/projects/CRONK", { agentAccess: "read" });
    const claude = await agentOf(cronk, admin, "claude-laptop");

    expect((await claude.get("/api/projects/CRONK")).body.project).toMatchObject({ key: "CRONK", access: "read" });
    expect((await claude.get("/api/projects")).body.projects).toEqual([expect.objectContaining({ key: "CRONK", access: "read" })]);
    expect((await claude.get("/api/tickets/CRONK-1")).body.ticket.title).toBe("Existing");
    for (const res of [
      await claude.post("/api/projects/CRONK/tickets", { title: "New" }),
      await claude.patch("/api/tickets/CRONK-1", { title: "Edited" }),
      await claude.patch("/api/projects/CRONK", { name: "Renamed" }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Agent Access/);
    }
  });

  it("hides the Project from Agents when None", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Other", key: "OTHER" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Existing" });
    await admin.patch("/api/projects/CRONK", { agentAccess: "none" });
    const claude = await agentOf(cronk, admin, "claude-laptop");

    expect(keysOf(await claude.get("/api/projects"))).toEqual(["OTHER"]);
    for (const res of [
      await claude.get("/api/projects/CRONK"),
      await claude.get("/api/projects/CRONK/tickets"),
      await claude.get("/api/tickets/CRONK-1"),
      await claude.get("/api/tickets/CRONK-1/changes"),
      await claude.post("/api/projects/CRONK/tickets", { title: "New" }),
    ]) {
      expect(res.status).toBe(404);
    }
  });

  it("can't be changed by an Agent or by a Member with Read access", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.put(`/api/projects/CRONK/members/${(await bob.get("/api/me")).body.user.id}`, { access: "read" });
    const claude = await agentOf(cronk, admin, "claude-laptop");

    expect((await claude.patch("/api/projects/CRONK", { agentAccess: "none" })).status).toBe(403);
    expect((await bob.patch("/api/projects/CRONK", { agentAccess: "none" })).status).toBe(403);
    expect((await admin.get("/api/projects/CRONK")).body.project.agentAccess).toBe("write");
  });
});

describe("an Agent's access", () => {
  it("never exceeds its Owner's: Read where the Owner has Read, nothing where the Owner has nothing", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Existing" });
    await admin.put(`/api/projects/CRONK/members/${bobId}`, { access: "read" });
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    const claude = await agentOf(cronk, bob, "claude-laptop");

    expect((await claude.get("/api/projects")).body.projects).toEqual([expect.objectContaining({ key: "CRONK", access: "read" })]);
    expect((await claude.get("/api/tickets/CRONK-1")).status).toBe(200);
    const refused = await claude.patch("/api/tickets/CRONK-1", { title: "Edited" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Owner has Read access/);
    expect((await claude.get("/api/projects/SECRET")).status).toBe(404);
    expect((await claude.post("/api/projects/SECRET/tickets", { title: "Sneaky" })).status).toBe(404);
  });

  it("is Read at most through a read-only token, while a full token of the same Agent writes", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const reader = await agentOf(cronk, admin, "claude-laptop", { readOnly: true });

    expect((await reader.get("/api/projects/CRONK")).body.project.access).toBe("read");
    for (const res of [
      await reader.post("/api/projects/CRONK/tickets", { title: "New" }),
      await reader.patch("/api/projects/CRONK", { name: "Renamed" }),
      await reader.post("/api/projects", { name: "Mine", key: "MINE" }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/read-only/);
    }

    await admin.post("/api/projects/CRONK/tickets", { title: "One" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Two" });
    for (const res of [
      await reader.patch("/api/tickets/CRONK-1", { priority: "high", labels: ["bug"] }),
      await reader.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" }),
      await reader.post("/api/projects/CRONK/statuses", { name: "In QA", category: "started" }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/read-only/);
    }
    expect((await reader.get("/api/tickets/CRONK-1")).body.ticket.priority).toBe("none");
    expect((await reader.get("/api/projects/CRONK")).body.statuses.map((st: { name: string }) => st.name)).not.toContain("In QA");

    const agentId = (await reader.get("/api/me")).body.agent.id;
    const writer = await startSession(cronk, (await admin.post(`/api/agents/${agentId}/tokens`, {})).body.secret);
    expect((await writer.post("/api/projects/CRONK/tickets", { title: "New" })).status).toBe(201);
  });
});

describe("Workspace Agent Access", () => {
  it("is Write by default and only an Admin can change it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.get("/api/workspace")).body.agentAccess).toBe("write");
    expect((await bob.patch("/api/workspace", { agentAccess: "read" })).status).toBe(403);
    const set = await admin.patch("/api/workspace", { agentAccess: "read" });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ name: "Acme", agentAccess: "read" });
    expect((await bob.get("/api/workspace")).body.agentAccess).toBe("read");
  });

  it("caps what Agents do outside any Project", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await agentOf(cronk, admin, "claude-laptop");

    await admin.patch("/api/workspace", { agentAccess: "read" });
    expect((await claude.get("/api/workspace")).status).toBe(200);
    expect((await claude.get("/api/users")).status).toBe(200);
    const refused = await claude.post("/api/projects", { name: "Mine", key: "MINE" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Workspace's Agent Access is Read/);

    await admin.patch("/api/workspace", { agentAccess: "none" });
    for (const res of [await claude.get("/api/workspace"), await claude.get("/api/users"), await claude.post("/api/projects", { name: "Mine", key: "MINE" })]) {
      expect(res.status).toBe(403);
    }
    // Projects have their own Agent Access, so their work goes on.
    expect((await claude.post("/api/projects/CRONK/tickets", { title: "Still fine" })).status).toBe(201);
  });
});
