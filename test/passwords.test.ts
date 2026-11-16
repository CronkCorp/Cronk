import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ada, joinAs, memberPassword, registerAgent, startInstalledCronk, startSession, type Client, type Cronk } from "./harness.js";

/** The id of the User with `email`, as the Users page lists it. */
async function userId(admin: Client, email: string): Promise<string> {
  const users: { id: string; email: string }[] = (await admin.get("/api/users")).body.users;
  return users.find((u) => u.email === email)!.id;
}

/** Signs `email` in on a new client and returns the answer's status. */
async function signInStatus(cronk: Cronk, email: string, password: string): Promise<number> {
  return (await cronk.client().post("/api/sign-in", { email, password })).status;
}

describe("password reset links", () => {
  it("lets the User set a new password once, which signs them in", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await joinAs(cronk, admin, "bob@example.com");

    const issued = await admin.post(`/api/users/${await userId(admin, "bob@example.com")}/password-reset`);
    expect(issued.status).toBe(201);
    const token: string = issued.body.token;

    const visitor = cronk.client();
    const shown = await visitor.get(`/api/password-resets/by-token/${token}`);
    expect(shown).toMatchObject({ status: 200, body: { email: "bob@example.com", name: "bob", workspaceName: "Acme" } });

    const used = await visitor.post(`/api/password-resets/by-token/${token}`, { password: "bob's new password" });
    expect(used.status).toBe(200);
    expect(used.body.user.email).toBe("bob@example.com");
    expect((await visitor.get("/api/me")).body.user.email).toBe("bob@example.com");

    expect(await signInStatus(cronk, "bob@example.com", memberPassword)).toBe(401);
    expect(await signInStatus(cronk, "bob@example.com", "bob's new password")).toBe(200);

    // The link works once.
    expect((await cronk.client().get(`/api/password-resets/by-token/${token}`)).status).toBe(404);
    expect((await cronk.client().post(`/api/password-resets/by-token/${token}`, { password: "another password" })).status).toBe(404);
    expect(await signInStatus(cronk, "bob@example.com", "bob's new password")).toBe(200);
  });

  it("ends the User's sign-ins and stops their old password when issued, while their Agents' Sessions keep running", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const laptop = await joinAs(cronk, admin, "bob@example.com");
    const phone = cronk.client();
    await phone.post("/api/sign-in", { email: "bob@example.com", password: memberPassword });
    const claude = await registerAgent(laptop, "claude-laptop");
    const session = await startSession(cronk, claude.secret);

    await admin.post(`/api/users/${await userId(admin, "bob@example.com")}/password-reset`);

    expect((await laptop.get("/api/me")).status).toBe(401);
    expect((await phone.get("/api/me")).status).toBe(401);
    expect((await session.get("/api/agent-sessions/current")).status).toBe(200);
    // Until the link is used, nobody can sign in as Bob, so a reset secures the account.
    expect(await signInStatus(cronk, "bob@example.com", memberPassword)).toBe(401);
    expect((await admin.get("/api/me")).status).toBe(200);
  });

  it("expires after 7 days, and issuing another replaces the earlier link", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await joinAs(cronk, admin, "bob@example.com");
    const bob = await userId(admin, "bob@example.com");

    const first = (await admin.post(`/api/users/${bob}/password-reset`)).body;
    expect(first.expiresAt).toBe("2026-01-08T09:00:00.000Z");
    const second = (await admin.post(`/api/users/${bob}/password-reset`)).body;
    expect((await cronk.client().get(`/api/password-resets/by-token/${first.token}`)).status).toBe(404);

    cronk.clock.advance(7 * 24 * 60 * 60 * 1000 - 1000);
    expect((await cronk.client().get(`/api/password-resets/by-token/${second.token}`)).status).toBe(200);
    cronk.clock.advance(1000);
    expect((await cronk.client().get(`/api/password-resets/by-token/${second.token}`)).status).toBe(404);
    expect((await cronk.client().post(`/api/password-resets/by-token/${second.token}`, { password: "too late now" })).status).toBe(404);
  });

  it("is issued only by Admins, for active Users of their Workspace", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await joinAs(cronk, admin, "cy@example.com");
    const adaId = await userId(admin, ada.email);
    const cyId = await userId(admin, "cy@example.com");
    const claude = cronk.client((await registerAgent(admin, "claude-laptop")).secret);

    expect((await bob.post(`/api/users/${adaId}/password-reset`)).status).toBe(403);
    expect((await claude.post(`/api/users/${cyId}/password-reset`)).status).toBe(403);
    expect((await admin.post("/api/users/00000000-0000-0000-0000-000000000000/password-reset")).status).toBe(404);

    await admin.patch(`/api/users/${cyId}`, { active: false });
    const refused = await admin.post(`/api/users/${cyId}/password-reset`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/deactivated/);
  });

  it("stops working when its User is deactivated, so reactivating them needs a new link", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await joinAs(cronk, admin, "bob@example.com");
    const bob = await userId(admin, "bob@example.com");
    const { token } = (await admin.post(`/api/users/${bob}/password-reset`)).body;

    await admin.patch(`/api/users/${bob}`, { active: false });
    await admin.patch(`/api/users/${bob}`, { active: true });
    expect((await cronk.client().post(`/api/password-resets/by-token/${token}`, { password: "bob's new password" })).status).toBe(404);

    const again = (await admin.post(`/api/users/${bob}/password-reset`)).body.token;
    expect((await cronk.client().post(`/api/password-resets/by-token/${again}`, { password: "bob's new password" })).status).toBe(200);
    expect(await signInStatus(cronk, "bob@example.com", "bob's new password")).toBe(200);
  });

  it("refuses a new password the rules refuse, leaving the link usable", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await joinAs(cronk, admin, "bob@example.com");
    const { token } = (await admin.post(`/api/users/${await userId(admin, "bob@example.com")}/password-reset`)).body;
    expect((await cronk.client().post(`/api/password-resets/by-token/${token}`, { password: "short" })).status).toBe(400);
    expect((await cronk.client().post(`/api/password-resets/by-token/${token}`, { password: "long enough now" })).status).toBe(200);
  });
});

describe("changing your own password", () => {
  it("needs the current password, keeps this sign-in and ends the others", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const phone = cronk.client();
    await phone.post("/api/sign-in", { email: ada.email, password: ada.password });

    const wrong = await admin.put("/api/me/password", { currentPassword: "not my password", password: "a brand new password" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toMatch(/current password/i);
    expect(await signInStatus(cronk, ada.email, ada.password)).toBe(200);

    expect((await admin.put("/api/me/password", { currentPassword: ada.password, password: "a brand new password" })).status).toBe(204);
    expect((await admin.get("/api/me")).status).toBe(200);
    expect((await phone.get("/api/me")).status).toBe(401);
    expect(await signInStatus(cronk, ada.email, ada.password)).toBe(401);
    expect(await signInStatus(cronk, ada.email, "a brand new password")).toBe(200);
  });

  it("refuses a new password the rules refuse, keeping the old one", async () => {
    const { cronk, admin } = await startInstalledCronk();
    expect((await admin.put("/api/me/password", { currentPassword: ada.password, password: "short" })).status).toBe(400);
    expect(await signInStatus(cronk, ada.email, ada.password)).toBe(200);
  });

  it("is only for signed-in Users, not Agents", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = cronk.client((await registerAgent(admin, "claude-laptop")).secret);
    const body = { currentPassword: ada.password, password: "a brand new password" };
    expect((await cronk.client().put("/api/me/password", body)).status).toBe(401);
    expect((await claude.put("/api/me/password", body)).status).toBe(403);
    expect(await signInStatus(cronk, ada.email, ada.password)).toBe(200);
  });
});

/** Runs the server command that issues a reset link, as an operator would on the server, against this test's database. */
function resetPasswordCommand(cronk: Cronk, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/server/reset-password.ts", ...args],
      { env: { ...process.env, DATABASE_URL: cronk.databaseUrl } },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") reject(err);
        else resolve({ code: err ? (err.code as number) : 0, stdout, stderr });
      },
    );
  });
}

describe("the server command for a reset link", () => {
  it("prints a link for any User, which works through the API and ends their sign-ins", async () => {
    const { cronk, admin } = await startInstalledCronk();

    const run = await resetPasswordCommand(cronk, "ADA@example.com", "--url", "https://cronk.example.com/");
    expect(run.code).toBe(0);
    const link = /https:\/\/cronk\.example\.com\/reset-password\/(\S+)/.exec(run.stdout);
    expect(link).not.toBeNull();
    expect((await admin.get("/api/me")).status).toBe(401);
    expect(await signInStatus(cronk, ada.email, ada.password)).toBe(401);

    const browser = cronk.client();
    const used = await browser.post(`/api/password-resets/by-token/${link![1]}`, { password: "back in at last" });
    expect(used.status).toBe(200);
    expect(used.body.user).toMatchObject({ email: ada.email, role: "admin" });
    expect(await signInStatus(cronk, ada.email, "back in at last")).toBe(200);
  });

  it("fails without printing a link for an unknown email", async () => {
    const { cronk } = await startInstalledCronk();
    const run = await resetPasswordCommand(cronk, "nobody@example.com");
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/No User has the email nobody@example.com/);
  });
});
