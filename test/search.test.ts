import { describe, expect, it } from "vitest";
import { agentOf, delegatedSetup, joinAs, registerAgent, startInstalledCronk, startSession, type Client } from "./harness.js";

describe("Searching", () => {
  it("finds a Ticket by a word in its description, with an excerpt around the match", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Fix sign-in", description: "The session cookie expires too early after a restart." });
    await admin.post("/api/projects/CRONK/tickets", { title: "Unrelated", description: "Nothing to see here." });

    const found = await admin.get("/api/search?q=cookie");
    expect(found.status).toBe(200);
    expect(found.body.results).toEqual([
      expect.objectContaining({ kind: "ticket", title: "Fix sign-in", projectKey: "CRONK", ticketKey: "CRONK-1", documentId: null }),
    ]);
    expect(found.body.results[0].excerpt).toContain("session cookie expires");
  });

  it("finds a Ticket by its key, in any case, first", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Fix sign-in" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Follow-up", description: "After CRONK-1 ships." });

    const found = (await admin.get("/api/search?q=cronk-1")).body.results;
    expect(found[0]).toMatchObject({ kind: "ticket", ticketKey: "CRONK-1", title: "Fix sign-in" });
    expect((await admin.get("/api/search?q=CRONK-1&kind=document")).body.results).toEqual([]);
  });

  it("finds Documents of a Project and of the Workspace by words in their body, matching other forms of the word", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const plan = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "We deploy on Fridays." })).body.document.id;
    const handbook = (await admin.post("/api/workspace/documents", { title: "Handbook", body: "How deployments work here." })).body.document.id;

    const found = await admin.get("/api/search?q=deploying");
    expect(found.body.results).toHaveLength(2);
    expect(found.body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "document", title: "Plan", projectKey: "CRONK", ticketKey: null, documentId: plan, excerpt: "We deploy on Fridays." }),
        expect.objectContaining({ kind: "document", title: "Handbook", projectKey: null, ticketKey: null, documentId: handbook }),
      ]),
    );
  });

  it("finds Reports and Comments, naming the Ticket or Document they are on", async () => {
    const { admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "The flaky test was a race in the scheduler." })).body.report.id;
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Could the scheduler drop jobs too?" });
    const plan = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "Nothing yet." })).body.document.id;
    await admin.post(`/api/documents/${plan}/comments`, { body: "Mention the scheduler here." });

    const found = (await admin.get("/api/search?q=scheduler")).body.results;
    expect(found).toHaveLength(3);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "report", title: "Findings", projectKey: "CRONK", ticketKey: "CRONK-1", documentId: report }),
        expect.objectContaining({ kind: "comment", title: "Ticket 1", projectKey: "CRONK", ticketKey: "CRONK-1", documentId: null, excerpt: "Could the scheduler drop jobs too?" }),
        expect.objectContaining({ kind: "comment", title: "Plan", projectKey: "CRONK", ticketKey: null, documentId: plan }),
      ]),
    );
  });

  it("finds Terms of a Project and of the Workspace by a word in their name, with their definition as the excerpt", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const ticket = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work tracked within a Project." })).body.term.id;
    const label = (await admin.post("/api/projects/CRONK/terms", { name: "Ticket label", definition: "Groups related work." })).body.term.id;

    const found = (await admin.get("/api/search?q=tickets&kind=term")).body.results;
    expect(found).toHaveLength(2);
    expect(found).toEqual(
      expect.arrayContaining([
        { kind: "term", title: "Ticket", excerpt: "A unit of work tracked within a Project.", projectKey: null, ticketKey: null, documentId: null, termId: ticket, decisionKey: null },
        { kind: "term", title: "Ticket label", excerpt: "Groups related work.", projectKey: "CRONK", ticketKey: null, documentId: null, termId: label, decisionKey: null },
      ]),
    );
  });

  it("finds a Term by a word in its definition and by one of its words to avoid", async () => {
    const { admin } = await startInstalledCronk();
    const term = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work tracked within a Project.", avoid: ["Issue", "chore"] })).body
      .term.id;
    const asResult = { kind: "term", title: "Ticket", excerpt: "A unit of work tracked within a Project.", projectKey: null, ticketKey: null, documentId: null, termId: term, decisionKey: null };

    expect((await admin.get("/api/search?q=tracking")).body.results).toEqual([asResult]);
    expect((await admin.get("/api/search?q=issues")).body.results).toEqual([asResult]);
    expect((await admin.get("/api/search?q=chore&kind=term")).body.results).toEqual([asResult]);
    expect((await admin.get("/api/search?q=chore&kind=document")).body.results).toEqual([]);
  });

  it("finds Decisions of a Project and of the Workspace by words in their title and body, in any status, with their key and an excerpt of the body", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Postgres for storage", body: "We keep everything in one database." });
    await admin.post("/api/decisions/CRONK-D1/status", { status: "rejected", reason: "Not after all." });
    await admin.post("/api/workspace/decisions", { title: "Self-hosted only", body: "Runs on our own servers and Postgres." });
    await admin.post("/api/workspace/documents", { title: "Postgres notes", body: "Tuning the pool." });
    const asResult = (title: string, excerpt: string, projectKey: string | null, decisionKey: string) => ({
      kind: "decision",
      title,
      excerpt,
      projectKey,
      ticketKey: null,
      documentId: null,
      termId: null,
      decisionKey,
    });
    const rejected = asResult("Postgres for storage", "We keep everything in one database.", "CRONK", "CRONK-D1");
    const workspace = asResult("Self-hosted only", "Runs on our own servers and Postgres.", null, "D1");

    const byTitleOrBody = (await admin.get("/api/search?q=postgres&kind=decision")).body.results;
    expect(byTitleOrBody).toHaveLength(2);
    expect(byTitleOrBody).toEqual(expect.arrayContaining([rejected, workspace]));
    expect((await admin.get("/api/search?q=server")).body.results).toEqual([workspace]);
    expect((await admin.get("/api/search?q=databases")).body.results).toEqual([rejected]);
    expect((await admin.get("/api/search?q=database&kind=document")).body.results).toEqual([]);
  });

  it("finds a Decision by its key, in any case, first", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Postgres for storage" });
    await admin.post("/api/projects/CRONK/decisions", { title: "Search in Postgres", body: "Builds on CRONK-D1. CRONK-D1 keeps it all in one place, as D1 does." });
    await admin.post("/api/workspace/decisions", { title: "Self-hosted only", body: "See CRONK-D1." });
    await admin.post("/api/projects/CRONK/tickets", { title: "Follow CRONK-D1", description: "As CRONK-D1 and D1 say." });
    const keys = async (q: string) => ((await admin.get(`/api/search?q=${q}`)).body.results as { decisionKey: string | null }[]).map((r) => r.decisionKey);

    expect((await keys("cronk-d1"))[0]).toBe("CRONK-D1");
    expect((await keys("%20d1%20"))[0]).toBe("D1");
    expect(await keys("CRONK-D9")).toEqual([]);
    expect((await admin.get("/api/search?q=CRONK-D1&kind=term")).body.results).toEqual([]);
  });

  it("narrows to the kinds and Projects asked for, refusing a Project the caller can't see", async () => {
    const { admin } = await startInstalledCronk();
    for (const key of ["CRONK", "OPS"]) {
      await admin.post("/api/projects", { name: key, key });
      await admin.post(`/api/projects/${key}/tickets`, { title: `${key} backup ticket` });
      await admin.post(`/api/projects/${key}/documents`, { title: `${key} backup notes` });
      await admin.post(`/api/tickets/${key}-1/comments`, { body: "Run the backup nightly." });
    }
    await admin.post("/api/workspace/documents", { title: "Backup policy" });
    await admin.post("/api/projects/OPS/terms", { name: "Backup", definition: "A copy kept elsewhere." });
    await admin.post("/api/workspace/terms", { name: "Restore", definition: "Bringing a backup back." });
    await admin.post("/api/projects/OPS/decisions", { title: "Nightly backups" });
    const found = async (filters: string) =>
      ((await admin.get(`/api/search?q=backup${filters}`)).body.results as { kind: string; projectKey: string | null }[])
        .map((r) => `${r.kind} ${r.projectKey}`)
        .sort();

    expect(await found("&kind=ticket&kind=comment")).toEqual(["comment CRONK", "comment OPS", "ticket CRONK", "ticket OPS"]);
    expect(await found("&project=ops")).toEqual(["comment OPS", "decision OPS", "document OPS", "term OPS", "ticket OPS"]);
    expect(await found("&kind=term")).toEqual(["term OPS", "term null"]);
    expect(await found("&kind=decision")).toEqual(["decision OPS"]);
    expect(await found("&project=OPS&kind=document")).toEqual(["document OPS"]);
    expect(await found("&kind=ticket")).toEqual(["ticket CRONK", "ticket OPS"]);
    expect(await found("&kind=document")).toEqual(["document CRONK", "document OPS", "document null"]);

    const unknown = await admin.get("/api/search?q=backup&project=NOPE");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("No such Project");
    expect((await admin.get("/api/search?q=backup&kind=page")).status).toBe(400);
  });
});

describe("Search access", () => {
  /**
   * A Ticket, a Document, a Report, a Term, a Decision and Comments in SECRET, and a Workspace Document with a Comment, a Workspace Term
   * and a Workspace Decision, all about the comet.
   */
  async function cometEverywhere() {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.post("/api/projects/SECRET/tickets", { title: "Comet ticket", description: "Track the comet." });
    await admin.post("/api/tickets/SECRET-1/comments", { body: "The comet is close." });
    const doc = (await admin.post("/api/projects/SECRET/documents", { title: "Comet notes", body: "Comet sightings." })).body.document.id;
    await admin.post(`/api/documents/${doc}/comments`, { body: "Another comet." });
    const adaId = (await admin.get("/api/users")).body.users[0].id;
    const reporter = await registerAgent(admin, "reporter");
    await admin.patch("/api/tickets/SECRET-1", { assigneeId: adaId, delegateId: reporter.agentId });
    const reporting = await startSession(cronk, reporter.secret);
    await reporting.post("/api/tickets/SECRET-1/claim");
    expect((await reporting.post("/api/tickets/SECRET-1/reports", { title: "Comet report", body: "The comet passed." })).status).toBe(201);
    await admin.post(`/api/documents/${(await admin.get("/api/tickets/SECRET-1/reports")).body.reports[0].id}/comments`, { body: "Comet report reviewed." });
    const handbook = (await admin.post("/api/workspace/documents", { title: "Handbook", body: "On the comet." })).body.document.id;
    await admin.post(`/api/documents/${handbook}/comments`, { body: "Comet again." });
    await admin.post("/api/projects/SECRET/terms", { name: "Comet", definition: "What we track." });
    await admin.post("/api/workspace/terms", { name: "Tail", definition: "What a comet trails.", avoid: ["coma"] });
    await admin.post("/api/projects/SECRET/decisions", { title: "Watch the comet nightly" });
    await admin.post("/api/workspace/decisions", { title: "Telescopes", body: "Point them at the comet." });
    return { cronk, admin };
  }
  const places = async (client: Client) =>
    ((await client.get("/api/search?q=comet&limit=100")).body.results as { kind: string; projectKey: string | null }[])
      .map((r) => `${r.kind} ${r.projectKey}`)
      .sort();
  const everything = [
    "comment SECRET",
    "comment SECRET",
    "comment SECRET",
    "comment null",
    "decision SECRET",
    "decision null",
    "document SECRET",
    "document null",
    "report SECRET",
    "term SECRET",
    "term null",
    "ticket SECRET",
  ];
  const workspaceOnly = ["comment null", "decision null", "document null", "term null"];

  it("leaves out a private Project's Tickets, Documents, Reports, Comments, Terms and Decisions for Members not in it", async () => {
    const { cronk, admin } = await cometEverywhere();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect(await places(bob)).toEqual(everything);

    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    expect(await places(admin)).toEqual(everything);
    expect(await places(bob)).toEqual(workspaceOnly);
    expect((await bob.get("/api/search?q=comet&project=SECRET")).status).toBe(404);
  });

  it("caps an Agent by Agent Access and by what its Owner may read", async () => {
    const { cronk, admin } = await cometEverywhere();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobsAgent = await agentOf(cronk, bob, "bobs-agent");
    expect(await places(bobsAgent)).toEqual(everything);

    await admin.patch("/api/projects/SECRET", { agentAccess: "read" });
    expect(await places(bobsAgent)).toEqual(everything);
    await admin.patch("/api/projects/SECRET", { agentAccess: "none" });
    expect(await places(bobsAgent)).toEqual(workspaceOnly);
    expect(await places(bob)).toEqual(everything);

    await admin.patch("/api/workspace", { agentAccess: "none" });
    expect(await places(bobsAgent)).toEqual([]);

    await admin.patch("/api/projects/SECRET", { agentAccess: "write", visibility: "private" });
    expect(await places(bobsAgent)).toEqual([]);
    expect(await places(await agentOf(cronk, admin, "adas-agent"))).toEqual(everything.filter((p) => !p.endsWith("null")));
  });

  it("keeps finding an archived Project's content for those who may read it, and only for them", async () => {
    const { cronk, admin } = await cometEverywhere();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.patch("/api/projects/SECRET", { archived: true });
    expect(await places(bob)).toEqual(everything);

    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    expect(await places(bob)).toEqual(workspaceOnly);
  });
});
