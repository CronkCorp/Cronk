import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, startInstalledCronk, type Client } from "./harness.js";

/** What mentions a Ticket, as its detail lists it: each source's kind and title. */
const mentionsIn = (detail: { mentions: { kind: string; title: string }[] }) => detail.mentions.map((m) => `${m.kind}: ${m.title}`);

/** What mentions the Ticket `key`, as `reader` reads the Ticket. */
async function mentionsOf(reader: Client, key: string): Promise<string[]> {
  const res = await reader.get(`/api/tickets/${key}`);
  expect(res.status).toBe(200);
  return mentionsIn(res.body);
}

describe("What mentions a Ticket", () => {
  it("is each Document whose Markdown names its key as the web client links it, leaving out code", async () => {
    const { admin } = await delegatedSetup(3);
    await admin.post("/api/projects/CRONK/documents", { title: "Prose", body: "Fixed in **CRONK-3**, see there." });
    await admin.post("/api/projects/CRONK/documents", { title: "Inline code", body: "Run `deploy CRONK-3` later." });
    await admin.post("/api/projects/CRONK/documents", { title: "Code block", body: "Steps:\n\n```\ncronk claim CRONK-3\n```\n" });
    await admin.post("/api/projects/CRONK/documents", { title: "Link", body: "See [the ticket](/tickets/CRONK-3)." });
    await admin.post("/api/projects/CRONK/documents", { title: "Lower case", body: "As in cronk-3 and Cronk-3." });
    await admin.post("/api/projects/CRONK/documents", { title: "Longer key", body: "CRONK-30 and XCRONK-3." });

    expect(await mentionsOf(admin, "CRONK-3")).toEqual(["document: Prose"]);
  });
});

describe("What mentions a Ticket, besides Documents", () => {
  it("is each other Ticket, Comment, Term, Decision and Activity naming its key in prose, following edits", async () => {
    const { admin, session } = await delegatedSetup(3);
    await admin.patch("/api/tickets/CRONK-2", { title: "After CRONK-1", description: "Not `CRONK-1` in code." });
    await admin.post("/api/tickets/CRONK-2/comments", { body: "Waiting on CRONK-1." });
    await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold, as CRONK-1 shows." });
    await admin.post("/api/workspace/decisions", { title: "Use Postgres", body: "Since CRONK-1 and [not this](/tickets/CRONK-1)." });
    const agent = await session();
    expect((await agent.post("/api/tickets/CRONK-3/claim")).status).toBe(200);
    expect((await agent.post("/api/tickets/CRONK-3/activities", { kind: "finding", body: "CRONK-1 must land first." })).status).toBe(201);
    expect((await agent.post("/api/tickets/CRONK-3/activities", { kind: "progress", body: "Ran `CRONK-1`." })).status).toBe(201);

    expect((await mentionsOf(admin, "CRONK-1")).sort()).toEqual([
      "activity: Ticket 3",
      "comment: After CRONK-1",
      "decision: Use Postgres",
      "term: Claim",
      "ticket: After CRONK-1",
    ]);

    await admin.patch("/api/tickets/CRONK-2", { title: "Unrelated" });
    expect((await mentionsOf(admin, "CRONK-1")).sort()).toEqual(["activity: Ticket 3", "comment: Unrelated", "decision: Use Postgres", "term: Claim"]);
  });

  it("leaves out the Ticket's own text, Comments, Activities and Reports", async () => {
    const { admin, session } = await delegatedSetup(2);
    await admin.patch("/api/tickets/CRONK-1", { title: "Do CRONK-1", description: "CRONK-1 is this." });
    await admin.post("/api/tickets/CRONK-1/comments", { body: "About CRONK-1." });
    const agent = await session();
    expect((await agent.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    expect((await agent.post("/api/tickets/CRONK-1/activities", { kind: "plan", body: "Finish CRONK-1." })).status).toBe(201);
    expect((await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "CRONK-1 is done." })).status).toBe(201);

    expect(await mentionsOf(admin, "CRONK-1")).toEqual([]);
  });
});

describe("A Ticket's Documents and mentions", () => {
  it("list its Reports and linked Documents as its Documents, and what else names it as mentions", async () => {
    const { admin, session } = await delegatedSetup(2);
    const linked = (await admin.post("/api/projects/CRONK/documents", { title: "Linked plan", body: "For CRONK-1." })).body.document;
    await admin.post("/api/projects/CRONK/documents", { title: "Runbook", body: "After CRONK-1 ships." });
    expect((await admin.post(`/api/tickets/CRONK-1/documents/${linked.id}`)).status).toBe(201);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "Done." });
    await agent.post("/api/tickets/CRONK-2/claim");
    await agent.post("/api/tickets/CRONK-2/reports", { title: "Other findings", body: "Needs CRONK-1." });

    const detail = (await admin.get("/api/tickets/CRONK-1")).body;
    expect(detail.documents.map((d: { title: string; reason: string }) => `${d.reason}: ${d.title}`)).toEqual(["report: Findings", "linked: Linked plan"]);
    expect(mentionsIn(detail).sort()).toEqual(["document: Other findings", "document: Runbook"]);
    expect(detail.mentions.find((m: { title: string }) => m.title === "Other findings").ticketKey).toBe("CRONK-2");
  });

  it("leave out what lies in private Projects the reader isn't in, and the Workspace's when Workspace Agent Access is None", async () => {
    const { cronk, admin, session } = await delegatedSetup(1);
    await admin.post("/api/workspace/documents", { title: "Runbook", body: "After CRONK-1 ships." });
    await admin.post("/api/workspace/decisions", { title: "Ship CRONK-1 first" });
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.post("/api/projects/SECRET/tickets", { title: "Secret work", description: "About CRONK-1." });
    await admin.post("/api/tickets/SECRET-1/comments", { body: "Still CRONK-1." });
    const bob = await joinAs(cronk, admin, "bob@example.com");

    expect((await mentionsOf(admin, "CRONK-1")).sort()).toEqual(["comment: Secret work", "decision: Ship CRONK-1 first", "document: Runbook", "ticket: Secret work"]);
    expect((await mentionsOf(bob, "CRONK-1")).sort()).toEqual(["decision: Ship CRONK-1 first", "document: Runbook"]);

    await admin.patch("/api/workspace", { agentAccess: "none" });
    const agent = await session();
    expect(mentionsIn((await agent.post("/api/tickets/CRONK-1/claim")).body).sort()).toEqual(["comment: Secret work", "ticket: Secret work"]);
  });
});

describe("Mentions of Tickets", () => {
  it("count a key written before its Ticket exists, once it does", async () => {
    const { admin } = await delegatedSetup(1);
    await admin.post("/api/workspace/documents", { title: "Later", body: "Then CRONK-2." });

    await admin.post("/api/projects/CRONK/tickets", { title: "Ticket 2" });
    expect(await mentionsOf(admin, "CRONK-2")).toEqual(["document: Later"]);
  });

  it("carry over in an import, Activities and Reports included", async () => {
    const { cronk, admin: before, session } = await delegatedSetup(2);
    await before.post("/api/workspace/documents", { title: "Runbook", body: "After CRONK-1 ships." });
    cronk.clock.advance(1_000);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-2/claim");
    await agent.post("/api/tickets/CRONK-2/activities", { kind: "finding", body: "CRONK-1 first." });
    await agent.post("/api/tickets/CRONK-2/reports", { title: "Findings", body: "Needs CRONK-1 first." });
    const exported = await before.download("/api/export");

    const { admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", exported.body)).status).toBe(201);
    expect((await mentionsOf(admin, "CRONK-1")).sort()).toEqual(["activity: Ticket 2", "document: Findings", "document: Runbook"]);
  });

  it("are recorded for what was written before an upgrade, and the Documents-only index is gone", async () => {
    const { cronk, admin, session } = await delegatedSetup(2);
    await admin.post("/api/workspace/documents", { title: "Runbook", body: "After CRONK-1 ships, not `CRONK-1`." });
    await admin.post("/api/workspace/documents", { title: "Unrelated", body: "Nothing here." });
    await admin.patch("/api/tickets/CRONK-2", { description: "Needs CRONK-1." });
    await admin.post("/api/tickets/CRONK-2/comments", { body: "CRONK-1 first." });
    const claim = (await admin.post("/api/workspace/terms", { name: "Claim", definition: "A hold." })).body.term;
    await admin.post("/api/workspace/decisions", { title: "Use Postgres" });
    const agent = await session();
    await agent.post("/api/tickets/CRONK-2/claim");
    await agent.post("/api/tickets/CRONK-2/activities", { kind: "finding", body: "CRONK-1 holds a Claim, per D1." });

    await cronk.undoMigration(
      "0041_ticket_and_activity_mentions",
      `CREATE TABLE document_ticket_mentions (document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE, ticket_key text NOT NULL,
         PRIMARY KEY (document_id, ticket_key));
       DELETE FROM mentions WHERE ticket_key IS NOT NULL OR activity_id IS NOT NULL;
       ALTER TABLE mentions DROP COLUMN ticket_key, DROP COLUMN activity_id;
       ALTER TABLE mentions ADD CHECK (num_nonnulls(ticket_id, document_id, comment_id, term_id, decision_id) = 1);
       ALTER TABLE mentions ADD CHECK (num_nonnulls(decision_key, mentioned_term_id) = 1);`,
    );
    await cronk.restart();

    expect((await mentionsOf(admin, "CRONK-1")).sort()).toEqual(["activity: Ticket 2", "comment: Ticket 2", "document: Runbook", "ticket: Ticket 2"]);
    expect((await admin.get(`/api/terms/${claim.id}/mentions`)).body.mentions.map((m: { kind: string }) => m.kind)).toEqual(["activity"]);
    expect((await admin.get("/api/decisions/D1/mentions")).body.mentions.map((m: { kind: string }) => m.kind)).toEqual(["activity"]);
    expect(await cronk.undoMigration("0015_document_ticket_mentions", "DROP TABLE document_ticket_mentions").then(
      () => "dropped",
      (err: Error) => err.message,
    )).toBe('table "document_ticket_mentions" does not exist');
  });
});
