import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, OWN_ORIGIN, startInstalledCronk, tarGz } from "./harness.js";

/** Ada, the Admin, with the Project CRONK and an Artifact published to it at Version 1. */
async function setup() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  const { artifact } = (await admin.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz({ "index.html": "<h1>Limits</h1>" }))).body;
  return { cronk, admin, artifact };
}

describe("Embedding an Artifact in a Document", () => {
  it("embeds an Artifact whose address stands alone on a line, and leaves one inside a sentence as a link", async () => {
    const { admin, artifact } = await setup();
    const body = `Here is the dashboard:\n${artifact.url}\n\nThe latest is always at ${artifact.url} too.`;

    const created = await admin.post("/api/projects/CRONK/documents", { title: "Limits", body });
    expect(created.status).toBe(201);
    expect(created.body.document.embeds).toEqual([{ artifactId: artifact.id, version: null }]);

    const got = await admin.get(`/api/documents/${created.body.document.id}`);
    expect(got.body.document.embeds).toEqual([{ artifactId: artifact.id, version: null }]);
  });

  it("keeps an embed of an address naming a Version on that Version after later publishes", async () => {
    const { admin, artifact } = await setup();
    const created = await admin.post("/api/projects/CRONK/documents", { title: "Limits", body: `Evidence:\n\n${artifact.versionUrl}` });
    expect(created.body.document.embeds).toEqual([{ artifactId: artifact.id, version: 1 }]);

    expect((await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1`, await tarGz({ "index.html": "<h1>Limits v2</h1>" }))).status).toBe(201);

    const got = await admin.get(`/api/documents/${created.body.document.id}`);
    expect(got.body.document.embeds).toEqual([{ artifactId: artifact.id, version: 1 }]);
  });

  it("embeds an address in angle brackets too, but not one behind link text, in code, naming no Artifact or a Version it lacks", async () => {
    const { admin, artifact } = await setup();
    const unknown = `${OWN_ORIGIN}/artifacts/00000000-0000-4000-8000-000000000000`;
    const body = [
      `<${artifact.url}>`,
      "",
      `[The dashboard](${artifact.url})`,
      "",
      "```",
      artifact.url,
      "```",
      "",
      unknown,
      "",
      `${OWN_ORIGIN}/artifacts/${artifact.id}?version=9`,
    ].join("\n");

    const created = await admin.post("/api/projects/CRONK/documents", { title: "Limits", body });
    expect(created.body.document.embeds).toEqual([{ artifactId: artifact.id, version: null }]);
  });
});

describe("Embedding an Artifact in a Document's Versions", () => {
  it("answers what each Version's body embeds", async () => {
    const { admin, artifact } = await setup();
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Limits", body: artifact.versionUrl })).body.document;
    expect((await admin.patch(`/api/documents/${doc.id}`, { baseVersion: 1, body: "No dashboard any more." })).body.document.embeds).toEqual([]);

    expect((await admin.get(`/api/documents/${doc.id}/versions/1`)).body.version.embeds).toEqual([{ artifactId: artifact.id, version: 1 }]);
    expect((await admin.get(`/api/documents/${doc.id}/versions/2`)).body.version.embeds).toEqual([]);
  });
});

describe("Embedding an Artifact in a Comment", () => {
  it("answers what a Comment on a Ticket or a Document embeds, when posted and when listed", async () => {
    const { admin, artifact } = await setup();
    await admin.post("/api/projects/CRONK/tickets", { title: "Show the limits" });
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Limits", body: "Limits." })).body.document;

    const onTicket = await admin.post("/api/tickets/CRONK-1/comments", { body: `Have a look:\n${artifact.versionUrl}` });
    expect(onTicket.status).toBe(201);
    expect(onTicket.body.comment.embeds).toEqual([{ artifactId: artifact.id, version: 1 }]);
    const onDocument = await admin.post(`/api/documents/${doc.id}/comments`, { body: `See ${artifact.url} for the rest.` });
    expect(onDocument.body.comment.embeds).toEqual([]);

    expect((await admin.get("/api/tickets/CRONK-1/comments")).body.comments[0].embeds).toEqual([{ artifactId: artifact.id, version: 1 }]);
    expect((await admin.get(`/api/documents/${doc.id}/comments`)).body.comments[0].embeds).toEqual([]);
  });
});

describe("Where an Artifact is embedded", () => {
  it("lists the Documents, Reports and Comments embedding it, newest first, with the Version each names, as they change", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const artifact = (await agent.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz({ "index.html": "<h1>Limits</h1>" }))).body.artifact;

    expect((await admin.get(`/api/artifacts/${artifact.id}/embedded-in`)).body.embeddedIn).toEqual([]);

    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Limits notes", body: artifact.url })).body.document;
    cronk.clock.advance(1000);
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "What I built", body: `## Evidence\n\n${artifact.versionUrl}` })).body.report;
    cronk.clock.advance(1000);
    const comment = (await admin.post("/api/tickets/CRONK-1/comments", { body: `Looks right:\n${artifact.versionUrl}` })).body.comment;

    const listed = await admin.get(`/api/artifacts/${artifact.id}/embedded-in`);
    expect(listed.status).toBe(200);
    expect(listed.body.embeddedIn).toEqual([
      expect.objectContaining({ kind: "comment", id: comment.id, title: "Ticket 1", ticketKey: "CRONK-1", projectKey: "CRONK", version: 1 }),
      expect.objectContaining({ kind: "report", id: report.id, title: "What I built", ticketKey: "CRONK-1", projectKey: "CRONK", version: 1 }),
      expect.objectContaining({ kind: "document", id: doc.id, title: "Limits notes", ticketKey: null, projectKey: "CRONK", version: null }),
    ]);

    cronk.clock.advance(1000);
    await admin.patch(`/api/documents/${doc.id}`, { baseVersion: 1, body: "Moved elsewhere." });
    const after = await admin.get(`/api/artifacts/${artifact.id}/embedded-in`);
    expect(after.body.embeddedIn.map((e: { id: string }) => e.id)).toEqual([comment.id, report.id]);
  });

  it("leaves out places the reader can't read", async () => {
    const { cronk, admin, artifact } = await setup();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.post("/api/projects/SECRET/documents", { title: "Hidden", body: artifact.url });
    await admin.post("/api/projects/CRONK/documents", { title: "Open", body: artifact.url });

    expect((await bob.get(`/api/artifacts/${artifact.id}/embedded-in`)).body.embeddedIn.map((e: { title: string }) => e.title)).toEqual(["Open"]);
    expect((await admin.get(`/api/artifacts/${artifact.id}/embedded-in`)).body.embeddedIn).toHaveLength(2);
  });
});

describe("Embeds across an export and import", () => {
  it("are recorded again for what an import brings in", async () => {
    const { admin, artifact } = await setup();
    await admin.post("/api/projects/CRONK/documents", { title: "Limits", body: artifact.versionUrl });

    const elsewhere = (await startInstalledCronk("Elsewhere")).admin;
    expect((await elsewhere.upload("/api/import", (await admin.download("/api/export")).body)).status).toBe(201);

    const embeddedIn = (await elsewhere.get(`/api/artifacts/${artifact.id}/embedded-in`)).body.embeddedIn;
    expect(embeddedIn).toEqual([expect.objectContaining({ kind: "document", title: "Limits", version: 1 })]);
    expect((await elsewhere.get(`/api/documents/${embeddedIn[0].id}`)).body.document.embeds).toEqual([{ artifactId: artifact.id, version: 1 }]);
  });
});

describe("Upgrading an installation", () => {
  it("records what existing Documents and Comments embed", async () => {
    const { cronk, admin, artifact } = await setup();
    await admin.post("/api/projects/CRONK/tickets", { title: "Show the limits" });
    await admin.post("/api/projects/CRONK/documents", { title: "Limits", body: artifact.url });
    cronk.clock.advance(1000);
    await admin.post("/api/tickets/CRONK-1/comments", { body: artifact.versionUrl });

    await cronk.undoMigration("0032_artifact_embeds", "DROP TABLE artifact_embeds");
    await cronk.restart();

    const embeddedIn = (await admin.get(`/api/artifacts/${artifact.id}/embedded-in`)).body.embeddedIn;
    expect(embeddedIn.map((e: { kind: string; version: number | null }) => [e.kind, e.version])).toEqual([
      ["comment", 1],
      ["document", null],
    ]);
  });
});
