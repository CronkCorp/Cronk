import { describe, expect, it } from "vitest";
import { agentOf, delegatedSetup, joinAs, startInstalledCronk } from "./harness.js";

/** Each of a Ticket's Documents as its title and why it is listed. */
const listed = (documents: { title: string; reason: string }[]) => documents.map((d) => `${d.title} (${d.reason})`);

describe("Linking a Document to a Ticket", () => {
  it("lists it among the Ticket's Documents as linked until it is unlinked", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Ticket 1" });
    const runbook = (await admin.post("/api/workspace/documents", { title: "Runbook", body: "No key here." })).body.document.id;
    await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "Do CRONK-1 first." });

    const linked = await admin.post(`/api/tickets/cronk-1/documents/${runbook}`);
    expect(linked.status).toBe(201);
    expect(listed(linked.body.documents)).toEqual(["Runbook (linked)", "Plan (mention)"]);
    expect(listed((await admin.get("/api/tickets/CRONK-1")).body.documents)).toEqual(["Runbook (linked)", "Plan (mention)"]);

    const unlinked = await admin.delete(`/api/tickets/CRONK-1/documents/${runbook}`);
    expect(unlinked.status).toBe(200);
    expect(listed(unlinked.body.documents)).toEqual(["Plan (mention)"]);
    expect((await admin.delete(`/api/tickets/CRONK-1/documents/${runbook}`)).status).toBe(404);
  });

  it("refuses linking one of the Ticket's own Reports, which it lists already", async () => {
    const { admin, session } = await delegatedSetup(1);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "It was the cache." })).body.report.id;

    const res = await admin.post(`/api/tickets/CRONK-1/documents/${report}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Report on CRONK-1/);
    expect(listed((await admin.get("/api/tickets/CRONK-1")).body.documents)).toEqual(["Findings (report)"]);
  });

  it("shows it in the context a Claim gives an Agent", async () => {
    const { admin, session } = await delegatedSetup(1);
    const plan = (await admin.post("/api/projects/CRONK/documents", { title: "Plan" })).body.document.id;
    await admin.post(`/api/tickets/CRONK-1/documents/${plan}`);

    const claimed = await (await session()).post("/api/tickets/CRONK-1/claim");
    expect(listed(claimed.body.documents)).toEqual(["Plan (linked)"]);
  });

  it("is recorded in the Ticket's history with who linked or unlinked it, and in which Agent Session", async () => {
    const { admin, claude, session } = await delegatedSetup(1);
    const plan = (await admin.post("/api/projects/CRONK/documents", { title: "Plan" })).body.document.id;
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");

    expect((await agent.post(`/api/tickets/CRONK-1/documents/${plan}`)).status).toBe(201);
    expect((await admin.delete(`/api/tickets/CRONK-1/documents/${plan}`)).status).toBe(200);

    const { changes } = (await admin.get("/api/tickets/CRONK-1/changes")).body;
    expect(changes.slice(-2)).toMatchObject([
      {
        change: "document linked",
        document: { id: plan, title: "Plan", projectKey: "CRONK" },
        actor: { kind: "agent", id: claude.agentId, owner: { name: "Ada" }, session: { id: agent.sessionId } },
      },
      { change: "document unlinked", document: { id: plan, title: "Plan", projectKey: "CRONK" }, actor: { kind: "user", name: "Ada" } },
    ]);
  });
});

describe("Document links and access", () => {
  /** Ada with CRONK-1, a Workspace Document and a Document in the private Project SECRET she alone is in, and Bob, a Member. */
  async function setup() {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Ticket 1" });
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    const secret = (await admin.post("/api/projects/SECRET/documents", { title: "Secret notes" })).body.document.id;
    const runbook = (await admin.post("/api/workspace/documents", { title: "Runbook" })).body.document.id;
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    return { cronk, admin, bob, bobId, secret, runbook };
  }

  it("refuse linking a Document the caller can't read, as if it didn't exist", async () => {
    const { bob, secret } = await setup();
    const res = await bob.post(`/api/tickets/CRONK-1/documents/${secret}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("No such Document");
    expect((await bob.post("/api/tickets/CRONK-1/documents/00000000-0000-4000-8000-000000000000")).status).toBe(400);
    expect((await bob.post(`/api/tickets/CRONK-9/documents/${secret}`)).status).toBe(404);
  });

  it("hide a linked Document, and its links in history, from a reader who can't read it", async () => {
    const { admin, bob, secret, runbook } = await setup();
    await admin.post(`/api/tickets/CRONK-1/documents/${secret}`);
    await admin.post(`/api/tickets/CRONK-1/documents/${runbook}`);
    await admin.delete(`/api/tickets/CRONK-1/documents/${secret}`);
    await admin.post(`/api/tickets/CRONK-1/documents/${secret}`);

    expect(listed((await admin.get("/api/tickets/CRONK-1")).body.documents)).toEqual(["Runbook (linked)", "Secret notes (linked)"]);
    expect(listed((await bob.get("/api/tickets/CRONK-1")).body.documents)).toEqual(["Runbook (linked)"]);
    const titles = async (reader: typeof bob) =>
      (await reader.get("/api/tickets/CRONK-1/changes")).body.changes.filter((c: { document?: unknown }) => c.document).map((c: { change: string; document: { title: string } }) => `${c.change} ${c.document.title}`);
    expect(await titles(admin)).toEqual(["document linked Secret notes", "document linked Runbook", "document unlinked Secret notes", "document linked Secret notes"]);
    expect(await titles(bob)).toEqual(["document linked Runbook"]);
    expect((await bob.delete(`/api/tickets/CRONK-1/documents/${secret}`)).status).toBe(400);
  });

  it("need Write on the Ticket, and a token that isn't read-only", async () => {
    const { cronk, admin, bob, bobId, runbook } = await setup();
    await admin.put(`/api/projects/CRONK/members/${bobId}`, { access: "read" });
    expect((await bob.post(`/api/tickets/CRONK-1/documents/${runbook}`)).status).toBe(403);
    const reader = await agentOf(cronk, admin, "reader", { readOnly: true });
    expect((await reader.post(`/api/tickets/CRONK-1/documents/${runbook}`)).status).toBe(403);

    await admin.post(`/api/tickets/CRONK-1/documents/${runbook}`);
    expect((await bob.delete(`/api/tickets/CRONK-1/documents/${runbook}`)).status).toBe(403);
    expect((await reader.delete(`/api/tickets/CRONK-1/documents/${runbook}`)).status).toBe(403);
    expect(listed((await bob.get("/api/tickets/CRONK-1")).body.documents)).toEqual(["Runbook (linked)"]);
  });
});
