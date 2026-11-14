import { describe, expect, it } from "vitest";
import { joinAs, startInstalledCronk, tarGz } from "./harness.js";

/** A page tree as `title` (depth by indentation), for comparing arrangements at a glance. */
const outline = (documents: { title: string; depth: number }[]) => documents.map((d) => `${"  ".repeat(d.depth)}${d.title}`);

describe("importing a folder of Markdown files", () => {
  it("creates a Document per file in a page tree mirroring the folders", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/documents", { title: "Already here" });
    const folder = await tarGz({
      "docs/handbook/README.md": "# Handbook\n\nWelcome aboard.",
      "docs/handbook/setup.md": "---\ntitle: Setting up\ntags: [ops]\n---\nInstall it.\n",
      "docs/handbook/style.md": "No heading here.",
      "docs/notes/2-later.md": "# Later",
      "docs/notes/10-much-later.md": "# Much later",
      "docs/logo.png": "not markdown",
    });

    const res = await admin.upload("/api/projects/CRONK/documents/import", folder);
    expect(res.status).toBe(201);
    expect(outline(res.body.documents)).toEqual(["Handbook", "  Setting up", "  style", "notes", "  Later", "  Much later"]);

    const tree = (await admin.get("/api/projects/CRONK/documents")).body.documents;
    expect(outline(tree)).toEqual(["Already here", "Handbook", "  Setting up", "  style", "notes", "  Later", "  Much later"]);
    const byTitle = (title: string) => tree.find((d: { title: string }) => d.title === title).id;
    expect((await admin.get(`/api/documents/${byTitle("Handbook")}`)).body.document).toMatchObject({ body: "# Handbook\n\nWelcome aboard.", version: 1 });
    expect((await admin.get(`/api/documents/${byTitle("Setting up")}`)).body.document.body).toBe("Install it.\n");
    expect((await admin.get(`/api/documents/${byTitle("notes")}`)).body.document.body).toBe("");
  });

  it("imports into the Workspace's page tree too", async () => {
    const { admin } = await startInstalledCronk();

    const res = await admin.upload("/api/workspace/documents/import", await tarGz({ "Guide.md": "Read me" }));
    expect(res.status).toBe(201);
    expect(outline((await admin.get("/api/workspace/documents")).body.documents)).toEqual(["Guide"]);
  });

  it("is refused without Write in the Project, and for something that isn't an archive", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    const member = await joinAs(cronk, admin, "grace@example.com");
    const grace = (await admin.get("/api/users")).body.users.find((u: { email: string }) => u.email === "grace@example.com");
    await admin.put(`/api/projects/CRONK/members/${grace.id}`, { access: "read" });

    expect((await member.upload("/api/projects/CRONK/documents/import", await tarGz({ "a.md": "A" }))).status).toBe(403);
    const garbage = await admin.upload("/api/projects/CRONK/documents/import", Buffer.from("this is not a tarball"));
    expect(garbage.status).toBe(400);
    expect(outline((await admin.get("/api/projects/CRONK/documents")).body.documents)).toEqual([]);
  });
});
