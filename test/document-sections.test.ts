import { describe, expect, it } from "vitest";
import { startInstalledCronk } from "./harness.js";

const plan = ["Intro line.", "", "## Setup", "", "Install it.", "", "### Docker", "", "Use compose.", "", "## Usage", "", "Run it.", ""].join("\n");

async function documentWith(body: string) {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  const { id } = (await admin.post("/api/projects/CRONK/documents", { title: "Plan", body })).body.document;
  return { cronk, admin, id: id as string };
}

describe("replacing a section of a Document", () => {
  it("replaces what sits under the heading, down to the next heading of the same or a higher level, as a new Version", async () => {
    const { admin, id } = await documentWith(plan);

    const res = await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 1, heading: "Setup", body: "Download it.\n" });

    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({ version: 2, title: "Plan" });
    expect(res.body.document.body).toBe(["Intro line.", "", "## Setup", "", "Download it.", "", "## Usage", "", "Run it.", ""].join("\n"));
    expect((await admin.get(`/api/documents/${id}/versions/2`)).body.version.body).toBe(res.body.document.body);
  });
});

describe("replacing a section is refused", () => {
  it("when the Document has no section with that heading, listing the headings it has", async () => {
    const { admin, id } = await documentWith(plan);

    const res = await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 1, heading: "Install", body: "x" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no section headed “Install”/);
    expect(res.body.headings).toEqual(["## Setup", "### Docker", "## Usage"]);
    expect((await admin.get(`/api/documents/${id}`)).body.document.version).toBe(1);
  });

  it("when several sections have that heading, unless its level picks one", async () => {
    const { admin, id } = await documentWith("# Notes\n\nTop.\n\n## Notes\n\nInner.\n");

    const ambiguous = await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 1, heading: "Notes", body: "x" });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toMatch(/2 sections/);
    expect(ambiguous.body.headings).toEqual(["# Notes", "## Notes"]);

    const picked = await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 1, heading: "## Notes", body: "Changed." });
    expect(picked.status).toBe(200);
    expect(picked.body.document.body).toBe("# Notes\n\nTop.\n\n## Notes\n\nChanged.\n");
  });

  it("when based on an outdated Version, returning the current Version", async () => {
    const { admin, id } = await documentWith(plan);
    await admin.patch(`/api/documents/${id}`, { baseVersion: 1, body: `${plan}\nMore.\n` });

    const stale = await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 1, heading: "Setup", body: "x" });

    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/Version 2/);
    expect(stale.body.current).toMatchObject({ number: 2, body: `${plan}\nMore.\n` });
  });
});

describe("sections", () => {
  it("ignore lines inside fenced code blocks that look like headings", async () => {
    const body = "## Script\n\n```sh\n# Setup\necho hi\n```\n\n## Setup\n\nOld.\n";
    const { admin, id } = await documentWith(body);

    const res = await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 1, heading: "Setup", body: "New." });

    expect(res.status).toBe(200);
    expect(res.body.document.body).toBe("## Script\n\n```sh\n# Setup\necho hi\n```\n\n## Setup\n\nNew.\n");
  });
});
