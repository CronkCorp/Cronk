import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, startInstalledCronk } from "./harness.js";

/** The titles of the Documents a Ticket lists as linked to it, as `admin` reads the Ticket. */
async function linkedTitles(admin: { get(path: string): Promise<{ body: any }> }, key: string): Promise<string[]> {
  return (await admin.get(`/api/tickets/${key}`)).body.documents.map((d: { title: string }) => d.title);
}

describe("The Documents that mention a Ticket", () => {
  it("are those whose Markdown links its key as the web client does, leaving out code", async () => {
    const { admin } = await delegatedSetup(3);
    await admin.post("/api/projects/CRONK/documents", { title: "Prose", body: "Fixed in **CRONK-3**, see there." });
    await admin.post("/api/projects/CRONK/documents", { title: "Inline code", body: "Run `deploy CRONK-3` later." });
    await admin.post("/api/projects/CRONK/documents", { title: "Code block", body: "Steps:\n\n```\ncronk claim CRONK-3\n```\n" });
    await admin.post("/api/projects/CRONK/documents", { title: "Lower case", body: "As in cronk-3 and Cronk-3." });
    await admin.post("/api/projects/CRONK/documents", { title: "Longer key", body: "CRONK-30 and XCRONK-3." });

    expect(await linkedTitles(admin, "CRONK-3")).toEqual(["Prose"]);
  });

  it("follow the Document's current Version through edits, a section replaced, a restore and its deletion", async () => {
    const { admin } = await delegatedSetup(3);
    const id = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "## Next\n\nCRONK-3 first." })).body.document.id;
    expect(await linkedTitles(admin, "CRONK-3")).toEqual(["Plan"]);

    expect((await admin.patch(`/api/documents/${id}`, { baseVersion: 1, body: "## Next\n\nCRONK-2 first." })).status).toBe(200);
    expect(await linkedTitles(admin, "CRONK-3")).toEqual([]);
    expect(await linkedTitles(admin, "CRONK-2")).toEqual(["Plan"]);

    expect((await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 2, heading: "Next", body: "Then `CRONK-2`." })).status).toBe(200);
    expect(await linkedTitles(admin, "CRONK-2")).toEqual([]);

    expect((await admin.post(`/api/documents/${id}/versions/1/restore`, { baseVersion: 3 })).status).toBe(200);
    expect(await linkedTitles(admin, "CRONK-3")).toEqual(["Plan"]);

    expect((await admin.delete(`/api/documents/${id}?baseVersion=4`)).status).toBe(204);
    expect(await linkedTitles(admin, "CRONK-3")).toEqual([]);
  });

  it("count a key written before its Ticket exists, once it does", async () => {
    const { admin } = await delegatedSetup(1);
    await admin.post("/api/workspace/documents", { title: "Later", body: "Then CRONK-2." });

    await admin.post("/api/projects/CRONK/tickets", { title: "Ticket 2" });
    expect(await linkedTitles(admin, "CRONK-2")).toEqual(["Later"]);
  });

  it("carry over in an import, Reports included", async () => {
    const { cronk, admin: before, session } = await delegatedSetup(2);
    await before.post("/api/workspace/documents", { title: "Runbook", body: "After CRONK-1 ships." });
    cronk.clock.advance(1_000);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-2/claim");
    await agent.post("/api/tickets/CRONK-2/reports", { title: "Findings", body: "Needs CRONK-1 first." });
    const exported = await before.download("/api/export");

    const { admin } = await startInstalledCronk("Elsewhere");
    expect((await admin.upload("/api/import", exported.body)).status).toBe(201);
    expect(await linkedTitles(admin, "CRONK-1")).toEqual(["Findings", "Runbook"]);
  });

  it("leave out those of private Projects the reader isn't in, and Workspace Documents when Workspace Agent Access is None", async () => {
    const { cronk, admin, session } = await delegatedSetup(1);
    await admin.post("/api/workspace/documents", { title: "Runbook", body: "After CRONK-1 ships." });
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.post("/api/projects/SECRET/documents", { title: "Secret notes", body: "About CRONK-1." });
    const bob = await joinAs(cronk, admin, "bob@example.com");

    expect((await linkedTitles(admin, "CRONK-1")).sort()).toEqual(["Runbook", "Secret notes"]);
    expect(await linkedTitles(bob, "CRONK-1")).toEqual(["Runbook"]);

    await admin.patch("/api/workspace", { agentAccess: "none" });
    const agent = await session();
    expect((await agent.post("/api/tickets/CRONK-1/claim")).body.documents.map((d: { title: string }) => d.title)).toEqual(["Secret notes"]);
  });

  it("are found for Documents written before Cronk recorded mentions, after an upgrade", async () => {
    const { cronk, admin } = await delegatedSetup(1);
    await admin.post("/api/workspace/documents", { title: "Runbook", body: "After CRONK-1 ships, not `CRONK-1`." });
    await admin.post("/api/workspace/documents", { title: "Unrelated", body: "Nothing here." });

    await cronk.undoMigration("0015_document_ticket_mentions", "DROP TABLE document_ticket_mentions");
    await cronk.restart();

    expect(await linkedTitles(admin, "CRONK-1")).toEqual(["Runbook"]);
  });
});
