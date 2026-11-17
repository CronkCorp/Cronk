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
    // No same origin, so it reads no cookie or storage; no popups, which could carry data out where requests can't.
    expect(policy).not.toMatch(/allow-same-origin|allow-popups/);

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
    // A proxy naming the port it took the request on still reaches the Artifact hostname.
    expect((await cronk.client().download(new URL(frameUrl).pathname, { host: `${ARTIFACT_HOST}:443` })).status).toBe(200);
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

  it("locks its Project before its source Ticket, as filing a Discovered Ticket from the same Claim does", async () => {
    const { cronk, admin, session } = await delegatedSetup();
    const claude = await session();
    await claude.post("/api/tickets/CRONK-1/claim");
    const projectId = (await admin.get("/api/projects/CRONK")).body.project.id;

    // The Discovered Ticket waits on the Project first, then the publish does.
    const held = await cronk.holdRow("projects", projectId);
    const filing = claude.post("/api/projects/CRONK/tickets", { title: "Found", ticket: "CRONK-1" });
    await held.waiters(1);
    const publishing = claude.upload("/api/projects/CRONK/artifacts?title=Limits&ticket=CRONK-1", await tarGz(site));
    await held.waiters(2);
    await held.release();

    // Neither is aborted as a deadlock.
    expect((await filing).status).toBe(201);
    expect((await publishing).status).toBe(201);
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

/** The sources one directive of `policy` names, such as `script-src`'s. */
function sourcesOf(policy: string, directive: string): string[] {
  const found = policy.split(";").map((d) => d.trim().split(/\s+/)).find(([name]) => name === directive);
  expect(found, `${directive} in ${policy}`).toBeDefined();
  return found!.slice(1);
}

/** The content policy the latest Version of `artifactId` is served with on the Artifact hostname, or Version `version`. */
async function servedPolicy(client: Client, artifactId: string, version?: number): Promise<string> {
  const { frameUrl } = version === undefined ? (await client.get(`/api/artifacts/${artifactId}`)).body.artifact : (await client.get(`/api/artifacts/${artifactId}/versions/${version}`)).body.version;
  const page = await fromArtifactHost(client, frameUrl);
  expect(page.status).toBe(200);
  return String(page.headers["content-security-policy"]);
}

describe("The Workspace's allow-list", () => {
  it("starts with cdnjs, jsDelivr, unpkg and Google Fonts, and an Admin's changes decide what every Artifact may load from", async () => {
    const { cronk, admin, artifact } = await published();
    expect((await admin.get("/api/workspace")).body).toMatchObject({
      artifactAllowedOrigins: ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      artifactExtraOriginsAllowed: true,
    });

    const changed = await admin.patch("/api/workspace", { artifactAllowedOrigins: ["https://cdn.jsdelivr.net", "https://esm.sh"] });
    expect(changed.status).toBe(200);
    expect(changed.body.artifactAllowedOrigins).toEqual(["https://cdn.jsdelivr.net", "https://esm.sh"]);

    const policy = await servedPolicy(admin, artifact.id);
    for (const directive of ["script-src", "style-src", "font-src"]) {
      expect(sourcesOf(policy, directive)).toEqual(expect.arrayContaining(["https://cdn.jsdelivr.net", "https://esm.sh"]));
      expect(sourcesOf(policy, directive)).not.toContain("https://cdnjs.cloudflare.com");
      expect(sourcesOf(policy, directive)).not.toContain("https://fonts.googleapis.com");
    }
    expect(sourcesOf(policy, "connect-src")).toEqual(["'none'"]);

    // An empty list leaves the Artifact its own files alone.
    await admin.patch("/api/workspace", { artifactAllowedOrigins: [] });
    expect(sourcesOf(await servedPolicy(admin, artifact.id), "script-src").filter((s) => s.startsWith("https://"))).toEqual([]);

    // Only Admins change it.
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.patch("/api/workspace", { artifactAllowedOrigins: ["https://evil.example"] })).status).toBe(403);
  });

  it("takes only bare http or https origins, each once", async () => {
    const { admin } = await setup();
    for (const bad of [["https://cdn.example/path"], ["cdn.example"], ["https://*.example"], ["javascript:alert(1)"], ["https://a.example; script-src *"], ["https://a.example", "https://a.example"], ["'unsafe-inline'"]]) {
      const res = await admin.patch("/api/workspace", { artifactAllowedOrigins: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    // Written with a trailing slash or capitals, an origin is kept as browsers write it.
    const res = await admin.patch("/api/workspace", { artifactAllowedOrigins: ["HTTPS://CDN.Example/", "http://localhost:8080"] });
    expect(res.status).toBe(200);
    expect(res.body.artifactAllowedOrigins).toEqual(["https://cdn.example", "http://localhost:8080"]);
  });
});

/** `extras` as the `extraOrigins` query parameter of a publish. */
const declaring = (extras: unknown) => `extraOrigins=${encodeURIComponent(JSON.stringify(extras))}`;
const plotly = { origin: "https://cdn.plot.ly", uses: ["scripts"], reason: "Plotly draws the chart" };
const statusApi = { origin: "https://status.example.com", uses: ["connect", "images"], reason: "The dashboard reads live sign-in counts" };

describe("Extra origins a publish declares", () => {
  it("are added to that Version's content policy for what each was declared for, and shown on the Version and the Artifact", async () => {
    const { admin } = await setup();
    const res = await admin.upload(`/api/projects/CRONK/artifacts?title=Limits&${declaring([plotly, statusApi])}`, await tarGz(site));
    expect(res.status).toBe(201);
    expect(res.body.artifact.extraOrigins).toEqual([plotly, statusApi]);
    const { artifact } = (await admin.get(`/api/artifacts/${res.body.artifact.id}`)).body;
    expect(artifact.extraOrigins).toEqual([plotly, statusApi]);
    expect(artifact.versions[0].extraOrigins).toEqual([plotly, statusApi]);
    expect((await admin.get(`/api/artifacts/${artifact.id}/versions/1`)).body.version.extraOrigins).toEqual([plotly, statusApi]);

    const policy = await servedPolicy(admin, artifact.id);
    expect(sourcesOf(policy, "script-src")).toContain("https://cdn.plot.ly");
    expect(sourcesOf(policy, "style-src")).not.toContain("https://cdn.plot.ly");
    expect(sourcesOf(policy, "connect-src")).toEqual(["https://status.example.com"]);
    expect(sourcesOf(policy, "img-src")).toContain("https://status.example.com");
    expect(sourcesOf(policy, "script-src")).not.toContain("https://status.example.com");
    // Still no same origin and no popups, whatever was declared.
    expect(sourcesOf(policy, "sandbox")).toEqual(["allow-scripts", "allow-modals", "allow-downloads"]);
  });

  it("are never carried over: the next Version has only what its own publish declared, and earlier Versions keep theirs", async () => {
    const { admin } = await setup();
    const { artifact } = (await admin.upload(`/api/projects/CRONK/artifacts?title=Limits&${declaring([plotly])}`, await tarGz(site))).body;

    const next = await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1`, await tarGz(site));
    expect(next.status).toBe(201);
    expect(next.body.artifact.extraOrigins).toEqual([]);
    expect(sourcesOf(await servedPolicy(admin, artifact.id), "script-src")).not.toContain("https://cdn.plot.ly");
    expect(sourcesOf(await servedPolicy(admin, artifact.id, 1), "script-src")).toContain("https://cdn.plot.ly");

    const third = await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=2&${declaring([statusApi])}`, await tarGz(site));
    expect(third.body.artifact.extraOrigins).toEqual([statusApi]);
    expect((await admin.get(`/api/artifacts/${artifact.id}`)).body.artifact.versions.map((v: { extraOrigins: unknown[] }) => v.extraOrigins)).toEqual([[statusApi], [], [plotly]]);
  });

  it("must each be a bare origin, declared once, for at least one use and with a reason", async () => {
    const { admin } = await setup();
    const refused = async (extras: unknown) => {
      const res = await admin.upload(`/api/projects/CRONK/artifacts?title=Limits&${declaring(extras)}`, await tarGz(site));
      expect(res.status, JSON.stringify(extras)).toBe(400);
      return res.body.error as string;
    };
    expect(await refused([{ ...plotly, reason: "  " }])).toMatch(/reason/);
    expect(await refused([{ ...plotly, uses: [] }])).toMatch(/uses/);
    expect(await refused([{ ...plotly, uses: ["frames"] }])).toMatch(/uses/);
    expect(await refused([{ ...plotly, origin: "https://cdn.plot.ly/plotly.js" }])).toMatch(/origin/);
    expect(await refused([{ ...plotly, origin: "*" }])).toMatch(/origin/);
    expect(await refused([plotly, plotly])).toMatch(/more than once/);
    expect(await refused({ origin: "https://cdn.plot.ly" })).toMatch(/list/);
    expect((await admin.upload("/api/projects/CRONK/artifacts?title=Limits&extraOrigins=nope", await tarGz(site))).status).toBe(400);
  });
});

describe("An Admin turning declared extras off", () => {
  it("refuses publishes that declare some, and serves Versions that did without them", async () => {
    const { admin } = await setup();
    const { artifact } = (await admin.upload(`/api/projects/CRONK/artifacts?title=Limits&${declaring([plotly, statusApi])}`, await tarGz(site))).body;

    expect((await admin.patch("/api/workspace", { artifactExtraOriginsAllowed: false })).body.artifactExtraOriginsAllowed).toBe(false);
    const refused = await admin.upload(`/api/artifacts/${artifact.id}/versions?baseVersion=1&${declaring([plotly])}`, await tarGz(site));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/extra origins/);

    // What was declared stays on record and shown, but no longer applies.
    expect((await admin.get(`/api/artifacts/${artifact.id}`)).body.artifact.extraOrigins).toEqual([plotly, statusApi]);
    const policy = await servedPolicy(admin, artifact.id);
    expect(sourcesOf(policy, "script-src")).not.toContain("https://cdn.plot.ly");
    expect(sourcesOf(policy, "connect-src")).toEqual(["'none'"]);
    expect(sourcesOf(policy, "img-src")).not.toContain("https://status.example.com");

    await admin.patch("/api/workspace", { artifactExtraOriginsAllowed: true });
    expect(sourcesOf(await servedPolicy(admin, artifact.id), "connect-src")).toEqual(["https://status.example.com"]);
  });
});
