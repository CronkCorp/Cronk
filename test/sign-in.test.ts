import { describe, expect, it } from "vitest";
import { ada as admin, startInstalledCronk } from "./harness.js";

describe("signing in and out", () => {
  it("signs a User in with email and password, then out again", async () => {
    const { cronk } = await startInstalledCronk();
    const browser = cronk.client();
    expect((await browser.get("/api/me")).status).toBe(401);

    const signIn = await browser.post("/api/sign-in", { email: "ADA@example.com", password: admin.password });
    expect(signIn.status).toBe(200);
    expect(signIn.body.user).toMatchObject({ email: "ada@example.com", role: "admin" });
    expect((await browser.get("/api/me")).body.user.name).toBe("Ada");

    expect((await browser.delete("/api/sign-in")).status).toBe(204);
    expect((await browser.get("/api/me")).status).toBe(401);
  });

  it("refuses a wrong password or unknown email with the same answer", async () => {
    const { cronk } = await startInstalledCronk();
    const wrongPassword = await cronk.client().post("/api/sign-in", { email: admin.email, password: "not the password" });
    const unknownEmail = await cronk.client().post("/api/sign-in", { email: "nobody@example.com", password: admin.password });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail).toEqual(wrongPassword);
  });

  it("signing out in one browser leaves other sign-ins alone", async () => {
    const { cronk } = await startInstalledCronk();
    const laptop = cronk.client();
    const phone = cronk.client();
    await laptop.post("/api/sign-in", { email: admin.email, password: admin.password });
    await phone.post("/api/sign-in", { email: admin.email, password: admin.password });

    await laptop.delete("/api/sign-in");
    expect((await laptop.get("/api/me")).status).toBe(401);
    expect((await phone.get("/api/me")).status).toBe(200);
  });

  it("ends a sign-in after 30 days", async () => {
    const { cronk } = await startInstalledCronk();
    const browser = cronk.client();
    await browser.post("/api/sign-in", { email: admin.email, password: admin.password });

    cronk.clock.advance(30 * 24 * 60 * 60 * 1000 - 1000);
    expect((await browser.get("/api/me")).status).toBe(200);
    cronk.clock.advance(1000);
    expect((await browser.get("/api/me")).status).toBe(401);
  });

  it("keeps a sign-in in a cookie carrying the cronk_si_ prefix", async () => {
    const { cronk } = await startInstalledCronk();
    const browser = cronk.client();
    await browser.post("/api/sign-in", { email: admin.email, password: admin.password });
    expect(browser.cookie("cronk_sign_in")).toMatch(/^cronk_si_[A-Za-z0-9_-]{43}$/);
    expect((await browser.get("/api/me")).status).toBe(200);
  });

  it("keeps a sign-in from before cookies had a prefix", async () => {
    const { cronk } = await startInstalledCronk();
    const browser = cronk.client();
    await browser.post("/api/sign-in", { email: admin.email, password: admin.password });
    const bare = await cronk.issuedBeforePrefixes(browser.cookie("cronk_sign_in")!);
    const old = cronk.client(undefined, { cookie: `cronk_sign_in=${bare}` });
    expect((await old.get("/api/me")).body.user.name).toBe("Ada");
    expect((await old.delete("/api/sign-in")).status).toBe(204);
    expect((await cronk.client(undefined, { cookie: `cronk_sign_in=${bare}` }).get("/api/me")).status).toBe(401);
  });
});
