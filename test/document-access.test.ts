import { describe, expect, it } from "vitest";
import { agentOf, joinAs, startInstalledCronk, type Client } from "./harness.js";

/** Every way to change a Document, each answered with the response. */
async function writes(client: Client, id: string, projectKey = "CRONK") {
  return [
    await client.post(`/api/projects/${projectKey}/documents`, { title: "New" }),
    await client.patch(`/api/documents/${id}`, { baseVersion: 1, body: "changed" }),
    await client.post(`/api/documents/${id}/versions/1/restore`, { baseVersion: 1 }),
    await client.post(`/api/documents/${id}/move`, { parentId: null }),
    await client.delete(`/api/documents/${id}?baseVersion=1`),
  ];
}

/** Every way to read a Document, each answered with the response. */
async function reads(client: Client, id: string, projectKey = "CRONK") {
  return [
    await client.get(`/api/projects/${projectKey}/documents`),
    await client.get(`/api/documents/${id}`),
    await client.get(`/api/documents/${id}/versions`),
    await client.get(`/api/documents/${id}/versions/1`),
  ];
}

async function projectDocument() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  const id: string = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "v1" })).body.document.id;
  const unchanged = async () => expect((await admin.get(`/api/documents/${id}`)).body.document).toMatchObject({ body: "v1", version: 1 });
  return { cronk, admin, id, unchanged };
}

const statuses = (responses: { status: number }[]) => responses.map((r) => r.status);

describe("Document access in a Project", () => {
  it("lets a Member with Read access read but not change Documents", async () => {
    const { cronk, admin, id, unchanged } = await projectDocument();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.put(`/api/projects/CRONK/members/${(await bob.get("/api/me")).body.user.id}`, { access: "read" });

    expect(statuses(await reads(bob, id))).toEqual([200, 200, 200, 200]);
    for (const res of await writes(bob, id)) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Read access/);
    }
    await unchanged();
  });

  it("hides the Documents of a private Project from those not in it, as if they didn't exist", async () => {
    const { cronk, admin, id, unchanged } = await projectDocument();
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    const bob = await joinAs(cronk, admin, "bob@example.com");

    expect(statuses(await reads(bob, id))).toEqual([404, 404, 404, 404]);
    expect(statuses(await writes(bob, id))).toEqual([404, 404, 404, 404, 404]);
    expect((await bob.get(`/api/documents/${id}`)).body.error).toBe("No such Document");
    await unchanged();
  });

  it("caps Agents by the Project's Agent Access: Read lets them read, None hides the Documents", async () => {
    const { cronk, admin, id, unchanged } = await projectDocument();
    const claude = await agentOf(cronk, admin, "claude-laptop");

    await admin.patch("/api/projects/CRONK", { agentAccess: "read" });
    expect(statuses(await reads(claude, id))).toEqual([200, 200, 200, 200]);
    for (const res of await writes(claude, id)) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Agent Access/);
    }

    await admin.patch("/api/projects/CRONK", { agentAccess: "none" });
    expect(statuses(await reads(claude, id))).toEqual([404, 404, 404, 404]);
    expect(statuses(await writes(claude, id))).toEqual([404, 404, 404, 404, 404]);
    await unchanged();
  });

  it("refuses every change through a read-only token, and lets a full token change Documents", async () => {
    const { cronk, admin, id, unchanged } = await projectDocument();
    const reader = await agentOf(cronk, admin, "reader", { readOnly: true });

    expect(statuses(await reads(reader, id))).toEqual([200, 200, 200, 200]);
    for (const res of await writes(reader, id)) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/read-only/);
    }
    await unchanged();

    const writer = await agentOf(cronk, admin, "writer");
    expect((await writer.patch(`/api/documents/${id}`, { baseVersion: 1, body: "v2" })).status).toBe(200);
  });
});

describe("Workspace Document access", () => {
  async function workspaceDocument() {
    const { cronk, admin } = await startInstalledCronk();
    const id: string = (await admin.post("/api/workspace/documents", { title: "Handbook", body: "v1" })).body.document.id;
    return { cronk, admin, id };
  }

  it("lets every Member read and change Workspace Documents", async () => {
    const { cronk, admin, id } = await workspaceDocument();
    const bob = await joinAs(cronk, admin, "bob@example.com");

    expect((await bob.get("/api/workspace/documents")).body.documents).toHaveLength(1);
    expect((await bob.patch(`/api/documents/${id}`, { baseVersion: 1, body: "v2" })).status).toBe(200);
    expect((await bob.post("/api/workspace/documents", { title: "Bob's" })).status).toBe(201);
  });

  it("caps Agents by the Workspace's Agent Access", async () => {
    const { cronk, admin, id } = await workspaceDocument();
    const claude = await agentOf(cronk, admin, "claude-laptop");

    await admin.patch("/api/workspace", { agentAccess: "read" });
    expect((await claude.get("/api/workspace/documents")).status).toBe(200);
    expect((await claude.get(`/api/documents/${id}`)).status).toBe(200);
    for (const res of [
      await claude.post("/api/workspace/documents", { title: "Mine" }),
      await claude.patch(`/api/documents/${id}`, { baseVersion: 1, body: "v2" }),
      await claude.delete(`/api/documents/${id}?baseVersion=1`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Workspace's Agent Access is Read/);
    }

    await admin.patch("/api/workspace", { agentAccess: "none" });
    expect((await claude.get("/api/workspace/documents")).status).toBe(403);
    expect((await claude.get(`/api/documents/${id}`)).status).toBe(403);
    expect((await admin.get(`/api/documents/${id}`)).body.document.version).toBe(1);
  });
});

describe("Deleting a Document", () => {
  it("is refused to Agents with Write, in a Project or the Workspace, and allowed to Users", async () => {
    const { cronk, admin, id, unchanged } = await projectDocument();
    const handbook: string = (await admin.post("/api/workspace/documents", { title: "Handbook", body: "v1" })).body.document.id;
    const claude = await agentOf(cronk, admin, "claude-laptop");

    for (const doc of [id, handbook]) {
      const refused = await claude.delete(`/api/documents/${doc}?baseVersion=1`);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/only a User may delete/);
      expect((await admin.get(`/api/documents/${doc}`)).status).toBe(200);
    }
    await unchanged();

    for (const doc of [id, handbook]) {
      expect((await admin.delete(`/api/documents/${doc}?baseVersion=1`)).status).toBe(204);
      expect((await admin.get(`/api/documents/${doc}`)).status).toBe(404);
    }
  });
});
