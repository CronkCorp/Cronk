import { describe, expect, it } from "vitest";
import { ARTIFACT_HOST, delegatedSetup, joinAs, OWN_ORIGIN, startInstalledCronk, tarGz, type Client } from "./harness.js";

/** Ada, the Admin, with the Project CRONK holding CRONK-1. */
async function setup() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  await admin.post("/api/projects/CRONK/tickets", { title: "Show the sign-in limits" });
  return { cronk, admin };
}

/** A small site: a page that loads its stylesheet. */
const site = { "index.html": '<link rel="stylesheet" href="style.css"><h1>Sign-in limits</h1>', "style.css": "h1 { color: teal }" };

describe("Publishing an Artifact", () => {
  it("publishes a folder with index.html as Version 1, at an address for the latest Version and one for that Version", async () => {
    const { admin } = await setup();

    const res = await admin.upload(`/api/projects/CRONK/artifacts?title=${encodeURIComponent("Sign-in limits")}`, await tarGz(site));
    expect(res.status).toBe(201);
    const { artifact } = res.body;
    expect(artifact).toMatchObject({
      title: "Sign-in limits",
      projectKey: "CRONK",
      version: 1,
      protected: false,
      url: `${OWN_ORIGIN}/artifacts/${artifact.id}`,
      versionUrl: `${OWN_ORIGIN}/artifacts/${artifact.id}?version=1`,
      publishedBy: { kind: "user", name: "Ada" },
    });

    const got = await admin.get(`/api/artifacts/${artifact.id}`);
    expect(got.status).toBe(200);
    expect(got.body.artifact).toMatchObject({ id: artifact.id, title: "Sign-in limits", version: 1 });
    expect(got.body.artifact.versions).toEqual([
      expect.objectContaining({ number: 1, fileCount: 2, size: Buffer.byteLength(site["index.html"]) + Buffer.byteLength(site["style.css"]), actor: expect.objectContaining({ name: "Ada" }) }),
    ]);

    const listed = await admin.get("/api/projects/CRONK/artifacts");
    expect(listed.status).toBe(200);
    expect(listed.body.artifacts.map((a: { id: string }) => a.id)).toEqual([artifact.id]);
  });
});

/** Ada with `site` published to CRONK; answers the Artifact as published. */
async function published() {
  const { cronk, admin } = await setup();
  const { artifact } = (await admin.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz(site))).body;
  return { cronk, admin, artifact };
}

/** Fetches `path` within the frame address `frameUrl` as a browser frame would: from the Artifact hostname, sending whatever cookies `client` holds. */
function fromArtifactHost(client: Client, frameUrl: string, path = "") {
  const url = new URL(frameUrl);
  expect(url.host).toBe(ARTIFACT_HOST);
  return client.download(`${url.pathname}${path}`, { host: ARTIFACT_HOST });
}

describe("Serving an Artifact", () => {
  it("serves its files on the Artifact hostname at the frame address Cronk hands out, under the default content policy", async () => {
    const { admin, artifact } = await published();
    const { frameUrl } = (await admin.get(`/api/artifacts/${artifact.id}`)).body.artifact;

    const page = await fromArtifactHost(admin, frameUrl);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.body.toString()).toBe(site["index.html"]);
    const policy = String(page.headers["content-security-policy"]);
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toMatch(/script-src [^;]*https:\/\/cdnjs\.cloudflare\.com[^;]*https:\/\/cdn\.jsdelivr\.net[^;]*https:\/\/unpkg\.com/);
    expect(policy).toMatch(/style-src [^;]*https:\/\/fonts\.googleapis\.com/);
    expect(policy).toMatch(/sandbox allow-scripts/);
    expect(policy).not.toMatch(/allow-same-origin/);

    const style = await fromArtifactHost(admin, frameUrl, "style.css");
    expect(style.status).toBe(200);
    expect(style.headers["content-type"]).toMatch(/^text\/css/);
    expect(style.body.toString()).toBe(site["style.css"]);
    expect((await fromArtifactHost(admin, frameUrl, "missing.js")).status).toBe(404);
  });

  it("serves nothing of Cronk's on the Artifact hostname, whatever cookie comes along, and no Artifact on Cronk's own", async () => {
    const { cronk, admin, artifact } = await published();
    const { frameUrl } = (await admin.get(`/api/artifacts/${artifact.id}`)).body.artifact;

    // Ada's sign-in cookie reaching the Artifact hostname opens nothing there.
    expect((await admin.download("/api/workspace", { host: ARTIFACT_HOST })).status).toBe(404);
    expect((await admin.download(`/api/artifacts/${artifact.id}`, { host: ARTIFACT_HOST })).status).toBe(404);
    expect((await admin.download("/", { host: ARTIFACT_HOST })).status).toBe(404);
    // The frame address alone opens the Artifact, as in a frame that sends no cookie.
    expect((await fromArtifactHost(cronk.client(), frameUrl)).status).toBe(200);
    // Cronk's own hostname doesn't serve Artifacts, so their code never runs on its origin.
    expect((await admin.download(new URL(frameUrl).pathname)).status).toBe(404);
  });

  it("refuses a frame address Cronk didn't sign, or one that has expired", async () => {
    const { cronk, admin, artifact } = await published();
    const { frameUrl } = (await admin.get(`/api/artifacts/${artifact.id}`)).body.artifact;

    const forged = frameUrl.replace(/\.(\d+)\.([^./]+)\/$/, (_: string, expires: string, signature: string) => `.${Number(expires) + 3600}.${signature}/`);
    expect((await fromArtifactHost(admin, forged)).status).toBe(404);

    cronk.clock.advance(11 * 60 * 60 * 1000);
    expect((await fromArtifactHost(admin, frameUrl)).status).toBe(200);
    cronk.clock.advance(2 * 60 * 60 * 1000);
    expect((await fromArtifactHost(admin, frameUrl)).status).toBe(404);
  });
});

describe("Versions of an Artifact", () => {
  it("publishes the whole folder again as the next Version, which the Artifact's address then shows, keeping earlier Versions as they were", async () => {
    const { admin, artifact } = await published();
    const next = { "index.html": "<h1>Sign-in limits, per IP</h1>" };

    const res = await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1&title=${encodeURIComponent("Limits per IP")}`, await tarGz(next));
    expect(res.status).toBe(201);
    expect(res.body.artifact).toMatchObject({ id: artifact.id, version: 2, title: "Limits per IP", versionUrl: `${OWN_ORIGIN}/artifacts/${artifact.id}?version=2` });

    const got = (await admin.get(`/api/artifacts/${artifact.id}`)).body.artifact;
    expect(got.versions.map((v: { number: number; title: string }) => [v.number, v.title])).toEqual([
      [2, "Limits per IP"],
      [1, "Limits"],
    ]);
    expect((await fromArtifactHost(admin, got.frameUrl)).body.toString()).toBe(next["index.html"]);
    // The whole folder is the Version: what the new one left out isn't carried over.
    expect((await fromArtifactHost(admin, got.frameUrl, "style.css")).status).toBe(404);

    const first = await admin.get(`/api/artifacts/${artifact.id}/versions/1`);
    expect(first.status).toBe(200);
    expect(first.body.version.files.map((f: { path: string }) => f.path)).toEqual(["index.html", "style.css"]);
    expect((await fromArtifactHost(admin, first.body.version.frameUrl)).body.toString()).toBe(site["index.html"]);
    expect((await admin.get(`/api/artifacts/${artifact.id}/versions/3`)).status).toBe(404);
  });

  it("refuses a publish based on an outdated Version, naming the latest, so the publisher merges first", async () => {
    const { admin, artifact } = await published();
    await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1`, await tarGz(site));

    const stale = await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1`, await tarGz(site));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ version: 2, error: expect.stringMatching(/Version 2.*merge/) });
    expect((await admin.get(`/api/artifacts/${artifact.id}`)).body.artifact.version).toBe(2);
  });
});

describe("What an Artifact's folder may hold", () => {
  it("must hold index.html at its top, after unwrapping the folder an archive adds", async () => {
    const { admin } = await setup();

    const without = await admin.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz({ "page.html": "<p>hi</p>" }));
    expect(without.status).toBe(400);
    expect(without.body.error).toMatch(/index\.html/);

    const wrapped = await admin.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz({ "limits/index.html": "<p>hi</p>", "limits/app.js": "1" }));
    expect(wrapped.status).toBe(201);
    expect((await admin.get(`/api/artifacts/${wrapped.body.artifact.id}/versions/1`)).body.version.files.map((f: { path: string }) => f.path)).toEqual([
      "app.js",
      "index.html",
    ]);
  });

  it("is limited per Workspace to 500 files and 25 MB a Version unless an Admin changes the limits", async () => {
    const { admin } = await setup();
    expect((await admin.get("/api/workspace")).body).toMatchObject({ artifactMaxFiles: 500, artifactMaxBytes: 25 * 1024 * 1024 });

    const many = Object.fromEntries([["index.html", "<p>hi</p>"], ...Array.from({ length: 500 }, (_, i) => [`part-${i}.js`, ""])]);
    const tooMany = await admin.upload("/api/projects/CRONK/artifacts?title=Many", await tarGz(many));
    expect(tooMany.status).toBe(413);
    expect(tooMany.body.error).toMatch(/501 files.*500/);

    const big = { "index.html": "x".repeat(25 * 1024 * 1024 + 1) };
    expect((await admin.upload("/api/projects/CRONK/artifacts?title=Big", await tarGz(big))).status).toBe(413);

    expect((await admin.patch("/api/workspace", { artifactMaxFiles: 1000, artifactMaxBytes: 30 * 1024 * 1024 })).status).toBe(200);
    expect((await admin.upload("/api/projects/CRONK/artifacts?title=Many", await tarGz(many))).status).toBe(201);
    expect((await admin.upload("/api/projects/CRONK/artifacts?title=Big", await tarGz(big))).status).toBe(201);
  });
});

describe("Who may publish and read an Artifact", () => {
  it("follows the access of the Project it belongs to: hidden in a private Project, read-only for Read", async () => {
    const { cronk, admin, artifact } = await published();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;

    await admin.put(`/api/projects/CRONK/members/${bobId}`, { access: "read" });
    expect((await bob.get(`/api/artifacts/${artifact.id}`)).status).toBe(200);
    expect((await bob.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1`, await tarGz(site))).status).toBe(403);
    expect((await bob.upload("/api/projects/CRONK/artifacts?title=Mine", await tarGz(site))).status).toBe(403);

    await admin.delete(`/api/projects/CRONK/members/${bobId}`);
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    expect((await bob.get(`/api/artifacts/${artifact.id}`)).status).toBe(404);
    expect((await bob.get(`/api/artifacts/${artifact.id}/versions/1`)).status).toBe(404);
  });

  it("belongs to the Workspace when published outside any Project", async () => {
    const { admin } = await setup();
    const res = await admin.upload("/api/workspace/artifacts?title=Team%20dashboard", await tarGz(site));
    expect(res.status).toBe(201);
    expect(res.body.artifact).toMatchObject({ projectKey: null, title: "Team dashboard" });
    expect((await admin.get("/api/workspace/artifacts")).body.artifacts.map((a: { id: string }) => a.id)).toEqual([res.body.artifact.id]);
    expect((await admin.get("/api/projects/CRONK/artifacts")).body.artifacts).toEqual([]);
  });

  it("records the Agent Session an Agent published it in, and the Ticket whose Claim it held", async () => {
    const { session } = await delegatedSetup();
    const claude = await session();
    await claude.post("/api/tickets/CRONK-1/claim");

    const res = await claude.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz(site));
    expect(res.status).toBe(201);
    expect(res.body.artifact).toMatchObject({
      publishedBy: { kind: "agent", name: "claude-laptop", session: { id: claude.sessionId } },
      sourceTicket: { key: "CRONK-1", title: "Ticket 1" },
    });
    expect((await claude.get(`/api/artifacts/${res.body.artifact.id}`)).body.artifact.versions[0]).toMatchObject({
      actor: { kind: "agent", session: { id: claude.sessionId } },
      sourceTicket: { key: "CRONK-1" },
    });
  });
});

describe("A Protected Artifact", () => {
  it("can be marked by a User with Write, after which Agents may read it but not publish new Versions", async () => {
    const { admin, session } = await delegatedSetup();
    const claude = await session();
    const { artifact } = (await claude.upload("/api/projects/CRONK/artifacts?title=Limits", await tarGz(site))).body;

    expect((await claude.post(`/api/artifacts/${artifact.id}/protection`, { protected: true })).status).toBe(403);
    const marked = await admin.post(`/api/artifacts/${artifact.id}/protection`, { protected: true });
    expect(marked.status).toBe(200);
    expect(marked.body.artifact.protected).toBe(true);
    expect((await admin.get(`/api/artifacts/${artifact.id}/protection`)).body.markings).toEqual([
      expect.objectContaining({ protected: true, actor: expect.objectContaining({ name: "Ada" }) }),
    ]);

    expect((await claude.get(`/api/artifacts/${artifact.id}`)).status).toBe(200);
    const refused = await claude.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1`, await tarGz(site));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Protected.*Suggestion/);
    expect((await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1`, await tarGz(site))).status).toBe(201);
  });
});

describe("Storage Artifacts take", () => {
  it("is shown to Admins beside Attachments' storage, counting every Version's files", async () => {
    const { admin, artifact } = await published();
    await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1`, await tarGz({ "index.html": "12345" }));
    const bytes = Buffer.byteLength(site["index.html"]) + Buffer.byteLength(site["style.css"]) + 5;
    expect((await admin.get("/api/workspace/storage")).body).toEqual({ attachments: { files: 0, bytes: 0 }, artifacts: { files: 3, bytes } });
  });
});
