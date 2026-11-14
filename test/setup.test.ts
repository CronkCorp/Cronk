import { describe, expect, it } from "vitest";
import { ada as admin, startCronk } from "./harness.js";

describe("first-run setup", () => {
  it("makes the first account on a fresh installation the Admin and signs it in", async () => {
    const cronk = await startCronk();
    const browser = cronk.client();

    expect((await browser.get("/api/setup")).body).toEqual({ required: true });

    const created = await browser.post("/api/setup", { ...admin, workspaceName: "Acme" });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ email: "ada@example.com", name: "Ada", role: "admin" });

    const me = await browser.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: "ada@example.com", role: "admin" });
    expect(me.body.user).not.toHaveProperty("passwordHash");
  });

  it("refuses to set up an installation that already has a User", async () => {
    const cronk = await startCronk();
    await cronk.client().post("/api/setup", admin);

    const visitor = cronk.client();
    expect((await visitor.get("/api/setup")).body).toEqual({ required: false });
    const second = await visitor.post("/api/setup", { email: "eve@example.com", password: "another password", name: "Eve" });
    expect(second.status).toBe(409);
    expect((await visitor.get("/api/me")).status).toBe(401);
  });

  it("lets exactly one of several simultaneous setups through", async () => {
    const cronk = await startCronk();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        cronk.client().post("/api/setup", { email: `admin${i}@example.com`, password: "a long password", name: `Admin ${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
  });
});
