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

  it("with the plain error shape for an invalid request or an unknown Document", async () => {
    const { admin, id } = await documentWith(plan);
    const invalid = await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 1, heading: "Setup" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/body/);
    const unknown = await admin.post("/api/documents/00000000-0000-4000-8000-000000000000/replace-section", { baseVersion: 1, heading: "Setup", body: "x" });
    expect(unknown).toEqual({ status: 404, body: { error: "No such Document" } });
  });

  it("when the new body would end the section early or leave a code block open", async () => {
    const { admin, id } = await documentWith(plan);
    const replace = (body: string) => admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 1, heading: "Setup", body });

    const sibling = await replace("Moved.\n\n## Elsewhere\n\nMore.");
    expect(sibling.status).toBe(400);
    expect(sibling.body.error).toMatch(/## Elsewhere/);
    expect((await replace("```sh\nnpm install")).body.error).toMatch(/code block/);
    expect((await replace("Install.\n\n### Podman\n\nOr podman.")).status).toBe(200);
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
  it("are found by heading text that itself starts with #", async () => {
    const { admin, id } = await documentWith("## #1 priority\n\nOld.\n");

    const res = await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 1, heading: "#1 priority", body: "New." });

    expect(res.status).toBe(200);
    expect(res.body.document.body).toBe("## #1 priority\n\nNew.\n");
  });

  it("ignore lines inside fenced code blocks that look like headings", async () => {
    const body = "## Script\n\n```sh\n# Setup\necho hi\n```\n\n## Setup\n\nOld.\n";
    const { admin, id } = await documentWith(body);

    const res = await admin.post(`/api/documents/${id}/replace-section`, { baseVersion: 1, heading: "Setup", body: "New." });

    expect(res.status).toBe(200);
    expect(res.body.document.body).toBe("## Script\n\n```sh\n# Setup\necho hi\n```\n\n## Setup\n\nNew.\n");
  });
});

/** A Document at Version 1, then `theirs` saved as Version 2 by someone else. */
async function editedUnderneath(base: string, theirs: string) {
  const setup = await documentWith(base);
  await setup.admin.patch(`/api/documents/${setup.id}`, { baseVersion: 1, body: theirs });
  return setup;
}

describe("merging an edit with the current Version", () => {
  it("combines edits to different sections without a conflict", async () => {
    const { admin, id } = await editedUnderneath(plan, plan.replace("Run it.", "Run it daily."));

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, title: "Plan", body: plan.replace("Use compose.", "Use podman.") });

    expect(res.status).toBe(200);
    expect(res.body.merge).toMatchObject({
      onto: { number: 2, body: plan.replace("Run it.", "Run it daily.") },
      conflicts: 0,
      title: "Plan",
      titleConflict: null,
      body: plan.replace("Use compose.", "Use podman.").replace("Run it.", "Run it daily."),
    });
    expect((await admin.get(`/api/documents/${id}`)).body.document.version).toBe(2);
  });

  it("reports a section both edits changed differently as a conflict, with the base's, mine and theirs", async () => {
    const { admin, id } = await editedUnderneath(plan, plan.replace("Run it.", "Run it daily."));

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: plan.replace("Run it.", "Run it weekly.").replace("Intro line.", "Intro.") });

    const { merge } = res.body;
    expect(merge).toMatchObject({ conflicts: 1, body: null, title: "Plan" });
    expect(merge.sections).toEqual([
      { heading: null, text: "Intro.\n\n", conflict: null },
      { heading: "## Setup", text: "## Setup\n\nInstall it.\n\n", conflict: null },
      { heading: "### Docker", text: "### Docker\n\nUse compose.\n\n", conflict: null },
      {
        heading: "## Usage",
        text: null,
        conflict: {
          base: "## Usage\n\nRun it.\n",
          mine: "## Usage\n\nRun it weekly.\n",
          theirs: "## Usage\n\nRun it daily.\n",
          both: "## Usage\n\nRun it weekly.\n\nRun it daily.\n",
        },
      },
    ]);
  });

  it("keeps sections either edit added and drops those one removed and the other left alone", async () => {
    const base = "## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n";
    const { admin, id } = await editedUnderneath(base, "## A\n\na\n\n## New\n\nnew\n\n## B\n\nb\n\n## C\n\nc\n");

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: "## A\n\na\n\n## C\n\nc\n\n## Last\n\nlast" });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## A\n\na\n\n## New\n\nnew\n\n## C\n\nc\n\n## Last\n\nlast" });
  });

  it("ends the merged body with a single line break when the section that now ends it had one after it", async () => {
    const base = "## A\n\na\n\n## B\n\nb\n";
    const { admin, id } = await editedUnderneath(base, "## A\n\na changed\n\n## B\n\nb\n");

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: "## A\n\na\n" });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## A\n\na changed\n" });
  });

  it("reports a section one edit removed and the other changed as a conflict", async () => {
    const base = "## A\n\na\n\n## B\n\nb\n";
    const { admin, id } = await editedUnderneath(base, "## A\n\na\n\n## B\n\nb changed\n");

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: "## A\n\na\n" });

    expect(res.body.merge.sections[1]).toEqual({ heading: "## B", text: null, conflict: { base: "## B\n\nb\n", mine: null, theirs: "## B\n\nb changed\n", both: "## B\n\nb changed\n" } });
  });

  it("reports a title both edits changed differently as a conflict", async () => {
    const { admin, id } = await documentWith("Body.");
    await admin.patch(`/api/documents/${id}`, { baseVersion: 1, title: "Their plan" });

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, title: "My plan", body: "Body." });

    expect(res.body.merge).toMatchObject({ conflicts: 1, title: null, titleConflict: { base: "Plan", mine: "My plan", theirs: "Their plan", both: "My plan Their plan" }, body: "Body." });
  });

  it("reports the whole body as one conflict when both edits rearranged the sections differently", async () => {
    const base = "## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n";
    const theirs = "## B\n\nb\n\n## A\n\na\n\n## C\n\nc\n";
    const mine = "## A\n\na\n\n## C\n\nc\n\n## B\n\nb\n";
    const { admin, id } = await editedUnderneath(base, theirs);

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: mine });

    expect(res.body.merge).toMatchObject({ conflicts: 1, sections: [{ heading: null, text: null, conflict: { base, mine, theirs } }] });
  });

  it("combines a section inserted with a repeated heading and an edit to a later section with that heading", async () => {
    const base = "## Notes\n\na\n\n## Notes\n\nb\n";
    const { admin, id } = await editedUnderneath(base, "## Notes\n\na\n\n## Notes\n\nb changed\n");

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: `## Notes\n\nfirst\n\n${base}` });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## Notes\n\nfirst\n\n## Notes\n\na\n\n## Notes\n\nb changed\n" });
  });

  it("pairs a repeated heading with the base section whose content it kept, not merely with the most sections of that heading", async () => {
    const base = "## Notes\n\na\n\n## Notes\n\nb\n";
    const { admin, id } = await editedUnderneath(base, "## Notes\n\na changed\n\n## Notes\n\nb\n");

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: "## Notes\n\nfirst\n\n## Notes\n\na\n" });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## Notes\n\nfirst\n\n## Notes\n\na changed\n" });
  });

  it("pairs empty sections under a repeated heading with the empty sections they were", async () => {
    const base = "## Notes\n\n## Notes\n";
    const { admin, id } = await editedUnderneath(base, "## Notes\n\n## Notes\n\nfilled\n");

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: `## Notes\n\nfirst\n\n${base}` });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## Notes\n\nfirst\n\n## Notes\n\n## Notes\n\nfilled\n" });
  });

  it("combines a renamed heading with an edit to that section's content", async () => {
    const base = "## Setup\n\nInstall it.\nThen run it.\n\n## Usage\n\nUse it.\n";
    const { admin, id } = await editedUnderneath(base, base.replace("Install it.", "Download it."));

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: base.replace("## Setup", "## Install") });

    expect(res.body.merge).toMatchObject({
      conflicts: 0,
      body: "## Install\n\nDownload it.\nThen run it.\n\n## Usage\n\nUse it.\n",
    });
    expect(res.body.merge.sections.map((s: { heading: string }) => s.heading)).toEqual(["## Install", "## Usage"]);
  });

  it("combines a renamed and moved section with an edit to its content", async () => {
    const base = "## Setup\n\nInstall it.\nThen run it.\n\n## Usage\n\nUse it.\n";
    const { admin, id } = await editedUnderneath(base, base.replace("Install it.", "Download it."));

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: "## Usage\n\nUse it.\n\n## Install\n\nInstall it.\nThen run it.\n" });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## Usage\n\nUse it.\n\n## Install\n\nDownload it.\nThen run it.\n" });
  });

  it("pairs a moved section with the renamed section most alike it, not the first one alike enough", async () => {
    const base = "## X\n\n1\n2\n3\n4\n\n## U\n\nu\n";
    const { admin, id } = await editedUnderneath(base, base.replace("4", "four"));

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: "## U\n\nu\n\n## P\n\n1\n2\n3\nnew\n\n## Q\n\n1\n2\n3\n4\n" });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## U\n\nu\n\n## P\n\n1\n2\n3\nnew\n\n## Q\n\n1\n2\n3\nfour\n" });
  });

  it("combines a renamed empty section with content added to it", async () => {
    const base = "## Intro\n\nHi.\n\n## Setup\n\n## Usage\n\nUse it.\n";
    const { admin, id } = await editedUnderneath(base, base.replace("## Setup\n", "## Setup\n\nInstall it.\n"));

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: base.replace("## Setup", "## Install") });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## Intro\n\nHi.\n\n## Install\n\nInstall it.\n\n## Usage\n\nUse it.\n" });
  });

  it("keeps the new empty section, not a rename, when one edit replaced an empty section and the other removed it", async () => {
    const base = "## A\n\na\n\n## Old\n\n## B\n\nb\n";
    const { admin, id } = await editedUnderneath(base, "## A\n\na\n\n## B\n\nb\n");

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: base.replace("## Old", "## Notes") });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## A\n\na\n\n## Notes\n\n## B\n\nb\n" });
  });

  it("keeps both empty sections when both edits replaced an empty section with different ones", async () => {
    const base = "## A\n\na\n\n## Old\n\n## B\n\nb\n";
    const { admin, id } = await editedUnderneath(base, base.replace("## Old", "## Theirs"));

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: base.replace("## Old", "## Mine") });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## A\n\na\n\n## Mine\n\n## Theirs\n\n## B\n\nb\n" });
  });

  it("does not pair sections as a rename when their content shares only a line many sections have", async () => {
    const base = "## A\n\n- [ ] TODO\nalpha\n\n## B\n\n- [ ] TODO\nbeta\n\n## C\n\n- [ ] TODO\ngamma\n";
    const { admin, id } = await editedUnderneath(base, "## A\n\n- [ ] TODO\nalpha\n\n## C\n\n- [ ] TODO\ngamma\n");

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: base.replace("## B\n\n- [ ] TODO\nbeta", "## D\n\n- [ ] TODO\ndelta") });

    expect(res.body.merge).toMatchObject({ conflicts: 0, body: "## A\n\n- [ ] TODO\nalpha\n\n## D\n\n- [ ] TODO\ndelta\n\n## C\n\n- [ ] TODO\ngamma\n" });
  });

  it("still pairs a renamed section by a line only one other section shares", async () => {
    const base = "## Setup\n\nInstall it.\nThen run it.\n\n## Usage\n\nThen run it.\n";
    const { admin, id } = await editedUnderneath(base, "## Usage\n\nThen run it.\n");

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: base.replace("## Setup\n\nInstall it.", "## Install\n\nInstall it now.") });

    expect(res.body.merge).toMatchObject({ conflicts: 1, body: null });
    expect(res.body.merge.sections[0].conflict).toMatchObject({ mine: "## Install\n\nInstall it now.\nThen run it.\n\n", theirs: null });
  });

  it("reports a section both edits renamed differently as a conflict", async () => {
    const base = "## Setup\n\nInstall it.\n";
    const { admin, id } = await editedUnderneath(base, "## Install\n\nInstall it.\n");

    const res = await admin.post(`/api/documents/${id}/merge`, { baseVersion: 1, body: "## Getting started\n\nInstall it.\n" });

    expect(res.body.merge).toMatchObject({ conflicts: 1, body: null });
    expect(res.body.merge.sections[0].conflict).toMatchObject({ base, mine: "## Getting started\n\nInstall it.\n", theirs: "## Install\n\nInstall it.\n" });
  });

  it("refuses a base Version the Document never had", async () => {
    const { admin, id } = await documentWith(plan);
    expect((await admin.post(`/api/documents/${id}/merge`, { baseVersion: 5, body: "x" })).status).toBe(404);
  });
});

