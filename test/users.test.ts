import { describe, expect, it } from "vitest";
import { joinAs, startInstalledCronk } from "./harness.js";

describe("inviting Users", () => {
  it("lets an Admin invite a User by email, who sets a password and signs in", async () => {
    const { cronk, admin } = await startInstalledCronk();

    const invited = await admin.post("/api/invitations", { email: "bob@example.com" });
    expect(invited.status).toBe(201);
    expect(invited.body.invitation).toMatchObject({ email: "bob@example.com", role: "member" });
    const token: string = invited.body.token;
    expect(token).toEqual(expect.any(String));

    const bob = cronk.client();
    const viewed = await bob.get(`/api/invitations/${token}`);
    expect(viewed.status).toBe(200);
    expect(viewed.body).toMatchObject({ email: "bob@example.com", workspaceName: "Acme" });

    const accepted = await bob.post(`/api/invitations/${token}/accept`, { name: "Bob", password: "bobs password" });
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
    expect((await cronk.client().post(`/api/invitations/${first}/accept`, { name: "Bob", password: "bobs password" })).status).toBe(201);
    expect((await cronk.client().post(`/api/invitations/${first}/accept`, { name: "Bob 2", password: "bobs password" })).status).toBe(404);

    const late = (await admin.post("/api/invitations", { email: "cy@example.com" })).body.token;
    cronk.clock.advance(7 * 24 * 60 * 60 * 1000);
    expect((await cronk.client().get(`/api/invitations/${late}`)).status).toBe(404);
    expect((await cronk.client().post(`/api/invitations/${late}/accept`, { name: "Cy", password: "cys password" })).status).toBe(404);
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
    expect((await cronk.client().get(`/api/invitations/${old}`)).status).toBe(404);

    const listed = await admin.get("/api/invitations");
    expect(listed.body.invitations).toEqual([expect.objectContaining({ email: "bob@example.com", role: "admin" })]);

    expect((await admin.delete(`/api/invitations/${fresh.body.invitation.id}`)).status).toBe(204);
    expect((await admin.get("/api/invitations")).body.invitations).toEqual([]);
    expect((await cronk.client().get(`/api/invitations/${fresh.body.token}`)).status).toBe(404);
  });

  it("can make the invitee an Admin", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com", "admin");
    expect((await bob.get("/api/me")).body.user.role).toBe("admin");
  });
});
