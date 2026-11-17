import { describe, expect, it } from "vitest";
import { agentOf, joinAs, startInstalledCronk, type Client } from "./harness.js";

/** What mentions a Decision, as `reader` lists it: each source's kind and title. */
async function mentionsOfDecision(reader: Client, key: string): Promise<string[]> {
  const res = await reader.get(`/api/decisions/${key}/mentions`);
  expect(res.status).toBe(200);
  return res.body.mentions.map((m: { kind: string; title: string }) => `${m.kind}: ${m.title}`);
}

/** What mentions a Term, as `reader` lists it: each source's kind and title. */
async function mentionsOfTerm(reader: Client, id: string): Promise<string[]> {
  const res = await reader.get(`/api/terms/${id}/mentions`);
  expect(res.status).toBe(200);
  return res.body.mentions.map((m: { kind: string; title: string }) => `${m.kind}: ${m.title}`).sort();
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

describe("What mentions a Decision or Term, from an Agent's work", () => {
  it("is each Activity naming the Decision's key or the Term's name, read as on its Ticket", async () => {
    const { cronk, admin } = await withDecisions();
    const claim = (await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold." })).body.term;
    await admin.post("/api/projects/CRONK/tickets", { title: "Lapse" });
    const agent = await agentOf(cronk, admin, "claude");
    const adaId = (await admin.get("/api/users")).body.users[0].id;
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: adaId, delegateId: (await admin.get("/api/agents")).body.agents[0].id });
    expect((await agent.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Lapse each Claim per CRONK-D1." })).status).toBe(201);
    expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "progress", body: "Ran `D1` and `Claim`." })).status).toBe(201);

    expect(await mentionsOfTerm(admin, claim.id)).toEqual(["activity: Lapse"]);
    const [mention] = (await admin.get("/api/decisions/CRONK-D1/mentions")).body.mentions;
    expect(mention).toMatchObject({ kind: "activity", title: "Lapse", ticketKey: "CRONK-1", projectKey: "CRONK" });
    expect(await mentionsOfDecision(admin, "D1")).toEqual([]);
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

  it("filters a Term's the same way", async () => {
    const { cronk, admin } = await withDecisions();
    const claim = (await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold." })).body.term;
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.post("/api/projects/SECRET/documents", { title: "Secret notes", body: "Each Claim." });
    await admin.post("/api/projects/CRONK/documents", { title: "Open notes", body: "Each Claim." });
    const bob = await joinAs(cronk, admin, "bob@example.com");

    expect(await mentionsOfTerm(admin, claim.id)).toEqual(["document: Open notes", "document: Secret notes"]);
    expect(await mentionsOfTerm(bob, claim.id)).toEqual(["document: Open notes"]);
    const secret = (await admin.post("/api/projects/SECRET/terms", { name: "Vault", definition: "Where secrets go." })).body.term;
    expect((await bob.get(`/api/terms/${secret.id}/mentions`)).status).toBe(404);
  });
});

describe("What mentions a Term", () => {
  it("is each text naming it with its capitalisation as a whole word, outside code and links", async () => {
    const { admin } = await withDecisions();
    const claim = (await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold on a Ticket." })).body.term;
    const session = (await admin.post("/api/workspace/terms", { name: "Agent Session", definition: "One run of an Agent; holds a Claim." })).body.term;
    await admin.post("/api/projects/CRONK/documents", { title: "Prose", body: "Each **Claim** ends with its Agent\nSession." });
    await admin.post("/api/projects/CRONK/documents", { title: "Other words", body: "A claim, CLAIM, Claims, Claimed, `Claim` and [Claim](/terms)." });
    await admin.post("/api/projects/CRONK/tickets", { title: "Lapse a Claim", description: "" });
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Every Agent Session." });

    expect(await mentionsOfTerm(admin, claim.id)).toEqual(["document: Prose", "term: Agent Session", "ticket: Lapse a Claim"]);
    expect(await mentionsOfTerm(admin, session.id)).toEqual(["comment: Lapse a Claim", "document: Prose"]);
  });

  it("counts text written before the Term, follows its renames, and goes to the Project Term overriding it in its Project", async () => {
    const { admin } = await withDecisions();
    await admin.post("/api/workspace/documents", { title: "Workspace notes", body: "A Lease ends." });
    await admin.post("/api/projects/CRONK/documents", { title: "Project notes", body: "A Lease and a Hold." });
    const lease = (await admin.post("/api/workspace/terms", { name: "Lease", definition: "A hold." })).body.term;
    expect(await mentionsOfTerm(admin, lease.id)).toEqual(["document: Project notes", "document: Workspace notes"]);

    const override = (await admin.post("/api/projects/CRONK/terms", { name: "Lease", definition: "A CRONK hold." })).body.term;
    expect(await mentionsOfTerm(admin, lease.id)).toEqual(["document: Workspace notes"]);
    expect(await mentionsOfTerm(admin, override.id)).toEqual(["document: Project notes"]);

    expect((await admin.delete(`/api/terms/${override.id}?baseVersion=1`)).status).toBe(204);
    expect(await mentionsOfTerm(admin, lease.id)).toEqual(["document: Project notes", "document: Workspace notes"]);

    expect((await admin.patch(`/api/terms/${lease.id}`, { baseVersion: 1, name: "Hold" })).status).toBe(200);
    expect(await mentionsOfTerm(admin, lease.id)).toEqual(["document: Project notes"]);
  });

  it("counts text written before the Term where Markdown escapes the punctuation in its name", async () => {
    const { admin } = await withDecisions();
    await admin.post("/api/projects/CRONK/documents", { title: "Notes", body: "Each Lease\\_Hold ends." });
    const term = (await admin.post("/api/workspace/terms", { name: "Lease_Hold", definition: "A hold." })).body.term;
    expect(await mentionsOfTerm(admin, term.id)).toEqual(["document: Notes"]);
  });
});

describe("Mentions of Decisions and Terms", () => {
  it("carry over in an import", async () => {
    const { admin: before } = await withDecisions();
    await before.post("/api/workspace/terms", { name: "Claim", definition: "A hold." });
    await before.post("/api/projects/CRONK/tickets", { title: "Lapse", description: "Each Claim, per CRONK-D1." });
    await before.post("/api/tickets/CRONK-1/comments", { body: "And D1." });
    const exported = await before.download("/api/export");

    const { admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", exported.body)).status).toBe(201);
    const claim = (await admin.get("/api/workspace/terms?name=claim")).body.terms[0];
    expect(await mentionsOfTerm(admin, claim.id)).toEqual(["ticket: Lapse"]);
    expect(await mentionsOfDecision(admin, "CRONK-D1")).toEqual(["ticket: Lapse"]);
    expect(await mentionsOfDecision(admin, "D1")).toEqual(["comment: Lapse"]);
  });

  it("are recorded for what was written before an upgrade", async () => {
    const { cronk, admin } = await withDecisions();
    const claim = (await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold; see D1." })).body.term;
    await admin.post("/api/projects/CRONK/documents", { title: "Runbook", body: "A Claim follows CRONK-D1." });

    // Mentions are recorded from today's schema once its later changes are in (0041_ticket_and_activity_mentions).
    await cronk.undoMigration("0041_ticket_and_activity_mentions", "CREATE TABLE document_ticket_mentions (document_id uuid, ticket_key text)");
    await cronk.undoMigration("0026_mentions", "DROP TABLE mentions");
    await cronk.restart();

    expect(await mentionsOfTerm(admin, claim.id)).toEqual(["document: Runbook"]);
    expect((await mentionsOfDecision(admin, "D1")).sort()).toEqual(["term: Claim"]);
  });
});
