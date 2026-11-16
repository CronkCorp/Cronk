import { describe, expect, it } from "vitest";
import { agentOf, startInstalledCronk } from "./harness.js";

describe("an Agent proposing a Decision", () => {
  it("records it as proposed, by the Agent in its Agent Session", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await agentOf(cronk, admin, "claude-laptop");

    const proposed = await claude.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions", body: "We keep them as Markdown." });

    expect(proposed.status).toBe(201);
    expect(proposed.body.decision).toMatchObject({
      key: "CRONK-D1",
      status: "proposed",
      proposedBy: { kind: "agent", name: "claude-laptop", session: { id: claude.sessionId } },
    });
    expect((await claude.post("/api/workspace/decisions", { title: "Compose for installs" })).body.decision).toMatchObject({ key: "D1", status: "proposed" });
  });
});

describe("an Agent refining a proposed Decision", () => {
  it("saves new Versions while it is proposed, and is refused once a User has changed its status", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await claude.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions", body: "v1" });

    const refined = await claude.patch("/api/decisions/CRONK-D1", { baseVersion: 1, body: "v2" });
    expect(refined.status).toBe(200);
    expect(refined.body.decision).toMatchObject({ body: "v2", version: 2, status: "proposed" });
    expect((await admin.get("/api/decisions/CRONK-D1/versions/2")).body.version.actor).toMatchObject({ kind: "agent", name: "claude-laptop" });

    await admin.post("/api/decisions/CRONK-D1/status", { status: "accepted" });
    const refused = await claude.patch("/api/decisions/CRONK-D1", { baseVersion: 3, body: "v3" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/proposed/);
    expect((await admin.get("/api/decisions/CRONK-D1")).body.decision).toMatchObject({ body: "v2", version: 3, status: "accepted" });
  });
});

describe("rejecting a Decision", () => {
  it("needs a reason, which the Decision and its Version keep", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const claude = await agentOf(cronk, admin, "claude-laptop");
    await claude.post("/api/projects/CRONK/decisions", { title: "Markdown for Decisions" });

    for (const reason of [undefined, "   "]) {
      const refused = await admin.post("/api/decisions/CRONK-D1/status", { status: "rejected", ...(reason === undefined ? {} : { reason }) });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/reason/);
    }
    const rejected = await admin.post("/api/decisions/CRONK-D1/status", { status: "rejected", reason: "  We already store them in Postgres.  " });

    expect(rejected.status).toBe(200);
    expect(rejected.body.decision).toMatchObject({ status: "rejected", version: 2, statusReason: "We already store them in Postgres." });
    expect((await admin.get("/api/decisions/CRONK-D1/versions/2")).body.version).toMatchObject({ status: "rejected", statusReason: "We already store them in Postgres." });
    // Taken up again, it no longer carries the reason it was rejected for; its history does.
    expect((await admin.post("/api/decisions/CRONK-D1/status", { status: "proposed" })).body.decision.statusReason).toBeNull();
    expect((await admin.get("/api/decisions/CRONK-D1/versions/1")).body.version.statusReason).toBeNull();
  });
});
