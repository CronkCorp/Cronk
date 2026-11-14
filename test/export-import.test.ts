import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { joinAs, startInstalledCronk, untarGz } from "./harness.js";

/** A Markdown file's frontmatter and body. */
function markdown(text: string | undefined): { data: any; body: string } {
  const match = /^---\n([\s\S]*?)---\n/.exec(text ?? "");
  if (!match) throw new Error(`Not Markdown with frontmatter: ${text}`);
  return { data: parse(match[1]!), body: text!.slice(match[0].length) };
}

describe("exporting a Project", () => {
  it("downloads it as an archive of Markdown files with frontmatter, relations naming Ticket keys", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const ada = (await admin.get("/api/me")).body.user;
    await admin.post("/api/projects/CRONK/tickets", { title: "Build it", description: "All of it." });
    await admin.post("/api/projects/CRONK/tickets", { title: "Test it" });
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: ada.id, priority: "high", labels: ["core"] });
    await admin.patch("/api/tickets/CRONK-2", { parentKey: "CRONK-1" });
    await admin.post("/api/tickets/CRONK-1/relations", { kind: "blocks", ticketKey: "CRONK-2" });
    await admin.post("/api/tickets/CRONK-1/comments", { body: "Starting." });
    await admin.post("/api/projects/CRONK/documents", { title: "Plan", body: "# Plan\n\nShip." });

    const res = await admin.download("/api/projects/CRONK/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="cronk-CRONK-.*\.tar\.gz"/);
    const files = await untarGz(res.body);

    expect(markdown(files["README.md"]).data.cronk).toMatchObject({ format: 1, scope: "project", versions: false });
    expect(markdown(files["projects/CRONK/project.md"]).data).toMatchObject({
      key: "CRONK",
      name: "Cronk",
      statuses: expect.arrayContaining([{ name: "Todo", category: "unstarted" }]),
    });
    const ticket = markdown(files["projects/CRONK/tickets/CRONK-1.md"]);
    expect(ticket.data).toMatchObject({ title: "Build it", status: "Backlog", priority: "high", labels: ["core"], assignee: "ada@example.com", blocks: ["CRONK-2"] });
    expect(ticket.body).toBe("All of it.");
    expect(markdown(files["projects/CRONK/tickets/CRONK-2.md"]).data).toMatchObject({ parent: "CRONK-1", blockedBy: ["CRONK-1"] });
    expect(markdown(files["projects/CRONK/tickets/CRONK-1.comments/1.md"])).toEqual({
      data: { at: "2026-01-01T09:00:00.000Z", by: "ada@example.com" },
      body: "Starting.",
    });
    expect(markdown(files["projects/CRONK/documents/1-plan.md"])).toMatchObject({ data: { title: "Plan", version: 1 }, body: "# Plan\n\nShip." });
    expect(markdown(files["people.md"]).data.users).toEqual([{ email: "ada@example.com", name: "Ada", role: "admin", active: true }]);
  });

  it("is only for Admins", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const member = await joinAs(cronk, admin, "grace@example.com");

    expect((await member.download("/api/projects/CRONK/export")).status).toBe(403);
    expect((await member.download("/api/export")).status).toBe(403);
    expect((await admin.download("/api/projects/NOPE/export")).status).toBe(404);
  });
});
