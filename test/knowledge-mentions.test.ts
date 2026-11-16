import { describe, expect, it } from "vitest";
import { agentOf, joinAs, startInstalledCronk, type Client } from "./harness.js";

/** What mentions a Decision, as `reader` lists it: each source's kind and title. */
async function mentionsOfDecision(reader: Client, key: string): Promise<string[]> {
  const res = await reader.get(`/api/decisions/${key}/mentions`);
  expect(res.status).toBe(200);
  return res.body.mentions.map((m: { kind: string; title: string }) => `${m.kind}: ${m.title}`);
}

/** Ada with the Project CRONK, a Workspace Decision D1 and a Project Decision CRONK-D1. */
async function withDecisions() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  await admin.post("/api/workspace/decisions", { title: "Use Postgres" });
  await admin.post("/api/projects/CRONK/decisions", { title: "Claims lapse" });
  return { cronk, admin };
}

describe("What mentions a Decision", () => {
  it("is each Document whose Markdown names its key outside code and links", async () => {
    const { admin } = await withDecisions();
    await admin.post("/api/projects/CRONK/documents", { title: "Prose", body: "Follows **CRONK-D1** and D1." });
    await admin.post("/api/projects/CRONK/documents", { title: "Code", body: "Run `CRONK-D1` and\n\n```\nD1\n```\n" });
    await admin.post("/api/projects/CRONK/documents", { title: "Lower case", body: "As in cronk-d1 and d1, or CRONK-D10 and XD1." });
    await admin.post("/api/workspace/documents", { title: "Workspace", body: "See [the record](/decisions/D1) and D1." });

    expect(await mentionsOfDecision(admin, "CRONK-D1")).toEqual(["document: Prose"]);
    expect((await mentionsOfDecision(admin, "D1")).sort()).toEqual(["document: Prose", "document: Workspace"]);
  });
});

describe("What mentions a Decision, besides Documents", () => {
  it("is each Ticket, Comment, Term and other Decision naming its key, following edits", async () => {
    const { admin } = await withDecisions();
    await admin.post("/api/projects/CRONK/tickets", { title: "Per CRONK-D1", description: "" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Lapse", description: "As D1 says." });
    await admin.post("/api/tickets/CRONK-2/comments", { body: "Checked against CRONK-D1." });
    await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold on a Ticket; see D1." });
    await admin.post("/api/projects/CRONK/decisions", { title: "Builds on D1", body: "Refines CRONK-D1, unlike CRONK-D2 itself." });

    expect((await mentionsOfDecision(admin, "CRONK-D1")).sort()).toEqual(["comment: Lapse", "decision: Builds on D1", "ticket: Per CRONK-D1"]);
    expect((await mentionsOfDecision(admin, "D1")).sort()).toEqual(["decision: Builds on D1", "term: Claim", "ticket: Lapse"]);
    expect(await mentionsOfDecision(admin, "CRONK-D2")).toEqual([]);

    await admin.patch("/api/tickets/CRONK-1", { title: "Per nothing" });
    await admin.patch("/api/decisions/CRONK-D2", { baseVersion: 1, body: "Stands alone." });
    expect((await mentionsOfDecision(admin, "CRONK-D1")).sort()).toEqual(["comment: Lapse"]);
  });
});

describe("What mentions a Decision or Term, as the reader lists it", () => {
  it("leaves out what lies in private Projects they aren't in, and the Workspace's when an Agent can't read it", async () => {
    const { cronk, admin } = await withDecisions();
    await admin.post("/api/workspace/documents", { title: "Runbook", body: "After CRONK-D1." });
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.post("/api/projects/SECRET/tickets", { title: "Secret work", description: "About CRONK-D1." });
    await admin.post("/api/tickets/SECRET-1/comments", { body: "Still CRONK-D1." });
    const bob = await joinAs(cronk, admin, "bob@example.com");

    expect((await mentionsOfDecision(admin, "CRONK-D1")).sort()).toEqual(["comment: Secret work", "document: Runbook", "ticket: Secret work"]);
    expect(await mentionsOfDecision(bob, "CRONK-D1")).toEqual(["document: Runbook"]);

    const agent = await agentOf(cronk, admin, "claude");
    await admin.patch("/api/workspace", { agentAccess: "none" });
    expect((await mentionsOfDecision(agent, "CRONK-D1")).sort()).toEqual(["comment: Secret work", "ticket: Secret work"]);
    expect((await agent.get("/api/decisions/D1/mentions")).status).toBe(403);
    expect((await bob.get("/api/decisions/SECRET-D1/mentions")).status).toBe(404);
  });
});
