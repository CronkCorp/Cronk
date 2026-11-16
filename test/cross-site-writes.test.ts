import { describe, expect, it } from "vitest";
import { ada, registerAgent, startCronk, startInstalledCronk } from "./harness.js";

/** A page on another site, such as an Artifact served from a subdomain of Cronk's own (ADR 0007). */
const foreign = "http://artifacts.localhost";

describe("writes from other sites", () => {
  it("refuses a signed-in User's write sent from a page on another site, and changes nothing", async () => {
    const { admin } = await startInstalledCronk();

    const refused = await admin.elsewhere({ origin: foreign }).post("/api/projects", { name: "Cronk", key: "CRONK" });
    expect(refused).toMatchObject({ status: 403, body: { error: expect.stringMatching(/another site/) } });
    expect((await admin.get("/api/projects/CRONK")).status).toBe(404);
  });

  it("judges a write by its Referer when the browser sends no Origin", async () => {
    const { admin } = await startInstalledCronk();

    const fromElsewhere = admin.elsewhere({ origin: null, referer: `${foreign}/report/index.html` });
    expect((await fromElsewhere.post("/api/projects", { name: "Cronk", key: "CRONK" })).status).toBe(403);
    const fromCronk = admin.elsewhere({ origin: null, referer: "http://localhost/projects" });
    expect((await fromCronk.post("/api/projects", { name: "Cronk", key: "CRONK" })).status).toBe(201);
  });

  it("refuses a write with the sign-in cookie that names no page, but lets one without it through", async () => {
    const { cronk, admin } = await startInstalledCronk();

    const unnamed = admin.elsewhere({ origin: null });
    expect((await unnamed.post("/api/projects", { name: "Cronk", key: "CRONK" })).status).toBe(403);
    expect((await unnamed.delete("/api/sign-in")).status).toBe(403);
    expect((await admin.get("/api/me")).status).toBe(200);

    // A script signing in names no page and has no cookie yet; nothing of anyone's is at stake.
    const script = cronk.client(undefined, { origin: null });
    expect((await script.post("/api/sign-in", { email: ada.email, password: ada.password })).status).toBe(200);
  });

  it("refuses a write from a page whose origin the browser hides", async () => {
    const { admin } = await startInstalledCronk();
    expect((await admin.elsewhere({ origin: "null" }).post("/api/projects", { name: "Cronk", key: "CRONK" })).status).toBe(403);
  });

  it("still answers reads from pages on other sites", async () => {
    const { admin } = await startInstalledCronk();
    expect((await admin.elsewhere({ origin: foreign }).get("/api/me")).status).toBe(200);
  });

  it("lets an Agent's token through whatever page, if any, it names", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const { secret } = await registerAgent(admin, "claude-laptop");

    const fromElsewhere = cronk.client(secret, { origin: foreign });
    expect((await fromElsewhere.post("/api/agent-sessions")).status).toBe(201);
    const unnamed = cronk.client(secret, { origin: null });
    expect((await unnamed.post("/api/agent-sessions")).status).toBe(201);
  });

  it("keeps the sign-in cookie to requests from Cronk's own pages", async () => {
    const { cronk } = await startInstalledCronk();
    const browser = cronk.client();
    await browser.post("/api/sign-in", { email: ada.email, password: ada.password });
    expect(browser.cookieSet("cronk_sign_in")).toMatchObject({ sameSite: "Strict", httpOnly: true });
  });

  it("lets an invitation link opened from another site be accepted, as it needs no sign-in", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const { token } = (await admin.post("/api/invitations", { email: "grace@example.com", role: "member" })).body;

    // Followed from an email in a webmail page: the browser sends no cookie, and Cronk's page then calls as itself.
    const invitee = cronk.client();
    expect((await invitee.elsewhere({ referer: "https://mail.example/inbox" }).get(`/api/invitations/by-token/${token}`)).status).toBe(200);
    expect((await invitee.post(`/api/invitations/by-token/${token}/accept`, { name: "Grace", password: "grace's password" })).status).toBe(201);
    expect((await invitee.post("/api/projects", { name: "Grace's", key: "GRACE" })).status).toBe(201);
  });

  it("refuses a sign-in sent from a page on another site, so it can't sign a browser in as someone else", async () => {
    const { cronk } = await startInstalledCronk();
    const browser = cronk.client();

    const refused = await browser.elsewhere({ origin: foreign }).post("/api/sign-in", { email: ada.email, password: ada.password });
    expect(refused.status).toBe(403);
    expect((await browser.get("/api/me")).status).toBe(401);
  });

  it("takes writes only from pages of its public address when one is configured, as behind a proxy that rewrites the host", async () => {
    const cronk = await startCronk({ publicUrl: "https://cronk.example/" });
    const browser = cronk.client(undefined, { origin: "https://cronk.example" });
    expect((await browser.post("/api/setup", { ...ada, workspaceName: "Acme" })).status).toBe(201);

    // The proxy sends every request on to the host Cronk listens on, so a page there isn't Cronk's own.
    expect((await browser.elsewhere({ origin: "http://localhost" }).post("/api/projects", { name: "Cronk", key: "CRONK" })).status).toBe(403);
    expect((await browser.elsewhere({ origin: "http://cronk.example" }).post("/api/projects", { name: "Cronk", key: "CRONK" })).status).toBe(403);
    expect((await browser.post("/api/projects", { name: "Cronk", key: "CRONK" })).status).toBe(201);
  });
});
