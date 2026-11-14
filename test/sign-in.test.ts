import { describe, expect, it } from "vitest";
import { startCronk, type Cronk } from "./harness.js";

const admin = { email: "ada@example.com", password: "correct horse battery", name: "Ada" };

async function installed(): Promise<Cronk> {
  const cronk = await startCronk();
  await cronk.client().post("/api/setup", admin);
  return cronk;
}

describe("signing in and out", () => {
  it("signs a User in with email and password, then out again", async () => {
    const cronk = await installed();
    const browser = cronk.client();
    expect((await browser.get("/api/me")).status).toBe(401);

    const signIn = await browser.post("/api/sessions", { email: "ADA@example.com", password: admin.password });
    expect(signIn.status).toBe(200);
    expect(signIn.body.user).toMatchObject({ email: "ada@example.com", role: "admin" });
    expect((await browser.get("/api/me")).body.user.name).toBe("Ada");

    expect((await browser.delete("/api/sessions/current")).status).toBe(204);
    expect((await browser.get("/api/me")).status).toBe(401);
  });

  it("refuses a wrong password or unknown email with the same answer", async () => {
    const cronk = await installed();
    const wrongPassword = await cronk.client().post("/api/sessions", { email: admin.email, password: "not the password" });
    const unknownEmail = await cronk.client().post("/api/sessions", { email: "nobody@example.com", password: admin.password });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail).toEqual(wrongPassword);
  });

  it("signing out in one browser leaves other sign-ins alone", async () => {
    const cronk = await installed();
    const laptop = cronk.client();
    const phone = cronk.client();
    await laptop.post("/api/sessions", { email: admin.email, password: admin.password });
    await phone.post("/api/sessions", { email: admin.email, password: admin.password });

    await laptop.delete("/api/sessions/current");
    expect((await laptop.get("/api/me")).status).toBe(401);
    expect((await phone.get("/api/me")).status).toBe(200);
  });

  it("ends a sign-in after 30 days", async () => {
    const cronk = await installed();
    const browser = cronk.client();
    await browser.post("/api/sessions", { email: admin.email, password: admin.password });

    cronk.clock.advance(30 * 24 * 60 * 60 * 1000 - 1000);
    expect((await browser.get("/api/me")).status).toBe(200);
    cronk.clock.advance(1000);
    expect((await browser.get("/api/me")).status).toBe(401);
  });
});
