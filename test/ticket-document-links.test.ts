import { describe, expect, it } from "vitest";
import { startInstalledCronk } from "./harness.js";

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
});
