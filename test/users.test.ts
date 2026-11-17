import { describe, expect, it } from "vitest";
import { ada, joinAs, memberPassword, registerAgent, startInstalledCronk } from "./harness.js";

describe("inviting Users", () => {
  it("lets an Admin invite a User by email, who sets a password and signs in", async () => {
    const { cronk, admin } = await startInstalledCronk();

    const invited = await admin.post("/api/invitations", { email: "bob@example.com" });
    expect(invited.status).toBe(201);
    expect(invited.body.invitation).toMatchObject({ email: "bob@example.com", role: "member" });
    const token: string = invited.body.token;
    expect(token).toEqual(expect.any(String));

    const bob = cronk.client();
    const viewed = await bob.get(`/api/invitations/by-token/${token}`);
    expect(viewed.status).toBe(200);
    expect(viewed.body).toMatchObject({ email: "bob@example.com", workspaceName: "Acme" });

    const accepted = await bob.post(`/api/invitations/by-token/${token}/accept`, { name: "Bob", password: "bobs password" });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user).toMatchObject({ email: "bob@example.com", name: "Bob", role: "member" });
    expect((await bob.get("/api/me")).body.user.name).toBe("Bob");

    const later = cronk.client();
    expect((await later.post("/api/sign-in", { email: "bob@example.com", password: "bobs password" })).status).toBe(200);
  });
});

describe("invitations", () => {
  it("can only be sent by an Admin", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.post("/api/invitations", { email: "eve@example.com" })).status).toBe(403);
    expect((await bob.get("/api/invitations")).status).toBe(403);
    expect((await cronk.client().post("/api/invitations", { email: "eve@example.com" })).status).toBe(401);
  });

  it("work once, and not after 7 days", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const first = (await admin.post("/api/invitations", { email: "bob@example.com" })).body.token;
    expect((await cronk.client().post(`/api/invitations/by-token/${first}/accept`, { name: "Bob", password: "bobs password" })).status).toBe(201);
    expect((await cronk.client().post(`/api/invitations/by-token/${first}/accept`, { name: "Bob 2", password: "bobs password" })).status).toBe(404);

    const late = (await admin.post("/api/invitations", { email: "cy@example.com" })).body.token;
    cronk.clock.advance(7 * 24 * 60 * 60 * 1000);
    expect((await cronk.client().get(`/api/invitations/by-token/${late}`)).status).toBe(404);
    expect((await cronk.client().post(`/api/invitations/by-token/${late}/accept`, { name: "Cy", password: "cys password" })).status).toBe(404);
  });

  it("are refused for an email that already has an account", async () => {
    const { admin } = await startInstalledCronk();
    const res = await admin.post("/api/invitations", { email: "ADA@example.com" });
    expect(res.status).toBe(409);
  });

  it("replace an earlier invitation to the same email, and can be listed and withdrawn", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const old = (await admin.post("/api/invitations", { email: "bob@example.com" })).body.token;
    const fresh = await admin.post("/api/invitations", { email: "bob@example.com", role: "admin" });
    expect((await cronk.client().get(`/api/invitations/by-token/${old}`)).status).toBe(404);

    const listed = await admin.get("/api/invitations");
    expect(listed.body.invitations).toEqual([expect.objectContaining({ email: "bob@example.com", role: "admin" })]);

    expect((await admin.delete(`/api/invitations/${fresh.body.invitation.id}`)).status).toBe(204);
    expect((await admin.get("/api/invitations")).body.invitations).toEqual([]);
    expect((await cronk.client().get(`/api/invitations/by-token/${fresh.body.token}`)).status).toBe(404);
  });

  it("carry the cronk_inv_ prefix", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const token: string = (await admin.post("/api/invitations", { email: "bob@example.com" })).body.token;
    expect(token).toMatch(/^cronk_inv_[A-Za-z0-9_-]{43}$/);
    expect((await cronk.client().post(`/api/invitations/by-token/${token}/accept`, { name: "Bob", password: "bobs password" })).status).toBe(201);
  });

  it("can still be accepted when sent before invitations had a prefix", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bare = await cronk.issuedBeforePrefixes((await admin.post("/api/invitations", { email: "bob@example.com" })).body.token);
    const bob = cronk.client();
    expect((await bob.get(`/api/invitations/by-token/${bare}`)).body.email).toBe("bob@example.com");
    expect((await bob.post(`/api/invitations/by-token/${bare}/accept`, { name: "Bob", password: "bobs password" })).status).toBe(201);
    expect((await bob.get("/api/me")).body.user.name).toBe("Bob");
  });

  it("can make the invitee an Admin", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com", "admin");
    expect((await bob.get("/api/me")).body.user.role).toBe("admin");
  });
});

describe("managing Users", () => {
  it("lists the Workspace's Users", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const listed = await bob.get("/api/users");
    expect(listed.status).toBe(200);
    expect(listed.body.users).toEqual([
      expect.objectContaining({ name: "Ada", role: "admin", active: true }),
      expect.objectContaining({ name: "bob", role: "member", active: true }),
    ]);
  });

  it("lets an Admin promote a Member to Admin and demote them again", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;

    const promoted = await admin.patch(`/api/users/${bobId}`, { role: "admin" });
    expect(promoted.status).toBe(200);
    expect(promoted.body.user).toMatchObject({ id: bobId, role: "admin" });
    expect((await bob.get("/api/me")).body.user.role).toBe("admin");

    await admin.patch(`/api/users/${bobId}`, { role: "member" });
    expect((await bob.get("/api/me")).body.user.role).toBe("member");
  });

  it("refuses role changes and deactivation from Members", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const adaId = (await admin.get("/api/me")).body.user.id;
    const bobId = (await bob.get("/api/me")).body.user.id;
    expect((await bob.patch(`/api/users/${bobId}`, { role: "admin" })).status).toBe(403);
    expect((await bob.patch(`/api/users/${adaId}`, { active: false })).status).toBe(403);
  });

  it("deactivates a User, who is signed out and can no longer sign in, until reactivated", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;

    const deactivated = await admin.patch(`/api/users/${bobId}`, { active: false });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.user).toMatchObject({ active: false });

    expect((await bob.get("/api/me")).status).toBe(401);
    expect((await bob.get("/api/projects")).status).toBe(401);
    const signIn = await cronk.client().post("/api/sign-in", { email: "bob@example.com", password: memberPassword });
    expect(signIn.status).toBe(403);
    expect(signIn.body.error).toMatch(/deactivated/);

    await admin.patch(`/api/users/${bobId}`, { active: true });
    expect((await cronk.client().post("/api/sign-in", { email: "bob@example.com", password: memberPassword })).status).toBe(200);
  });

  it("keeps at least one active Admin", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const adaId = (await admin.get("/api/me")).body.user.id;
    expect((await admin.patch(`/api/users/${adaId}`, { role: "member" })).status).toBe(409);
    expect((await admin.patch(`/api/users/${adaId}`, { active: false })).status).toBe(409);

    const bob = await joinAs(cronk, admin, "bob@example.com", "admin");
    expect((await admin.patch(`/api/users/${adaId}`, { role: "member" })).status).toBe(200);
    const bobId = (await bob.get("/api/me")).body.user.id;
    expect((await bob.patch(`/api/users/${bobId}`, { active: false })).status).toBe(409);
  });

  it("answers 404 for a User that doesn't exist", async () => {
    const { admin } = await startInstalledCronk();
    expect((await admin.patch("/api/users/00000000-0000-4000-8000-000000000000", { role: "admin" })).status).toBe(404);
  });
});

describe("a User's Diff view", () => {
  it("is unified for a new User, and changes to side by side for them alone", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    expect((await bob.get("/api/me")).body.user.diffView).toBe("unified");

    const changed = await bob.patch("/api/me", { diffView: "split" });
    expect(changed.status).toBe(200);
    expect(changed.body.user).toMatchObject({ email: "bob@example.com", diffView: "split" });
    expect((await bob.get("/api/me")).body.user.diffView).toBe("split");
    expect((await admin.get("/api/me")).body.user.diffView).toBe("unified");
  });
});

describe("changing a User's Diff view", () => {
  it("is refused for any other value or field", async () => {
    const { admin } = await startInstalledCronk();
    expect((await admin.patch("/api/me", { diffView: "sideways" })).status).toBe(400);
    expect((await admin.patch("/api/me", { diffView: "split", name: "Eve" })).status).toBe(400);
    expect((await admin.patch("/api/me", {})).status).toBe(400);
    expect((await admin.get("/api/me")).body.user).toMatchObject({ name: "Ada", diffView: "unified" });
  });

  it("is only for signed-in Users, not Agents, and signs no one in", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = cronk.client((await registerAgent(admin, "claude-laptop")).secret);
    const refused = await claude.patch("/api/me", { diffView: "split" });
    expect(refused.status).toBe(403);
    expect(claude.lastSetCookie("cronk_sign_in")).toBeUndefined();
    expect((await claude.get("/api/me")).body).not.toHaveProperty("user");
    expect((await cronk.client().patch("/api/me", { diffView: "split" })).status).toBe(401);
    expect((await admin.get("/api/me")).body.user.diffView).toBe("unified");
  });

  it("lasts into a fresh sign-in", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.patch("/api/me", { diffView: "split" });
    const later = cronk.client();
    expect((await later.post("/api/sign-in", { email: ada.email, password: ada.password })).body.user.diffView).toBe("split");
    expect((await later.get("/api/me")).body.user.diffView).toBe("split");
  });
});
