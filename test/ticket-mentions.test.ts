import { describe, expect, it } from "vitest";
import { delegatedSetup } from "./harness.js";

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
});
