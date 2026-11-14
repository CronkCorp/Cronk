import { describe, expect, it } from "vitest";
import { startCronk } from "./harness.js";

describe("starting the application", () => {
  it("creates the schema on an empty database and keeps data across restarts", async () => {
    const cronk = await startCronk();
    await cronk.client().post("/api/setup", { email: "ada@example.com", password: "correct horse battery", name: "Ada", workspaceName: "Acme" });

    await cronk.restart();

    const browser = cronk.client();
    expect((await browser.get("/api/setup")).body).toEqual({ required: false });
    expect((await browser.post("/api/sessions", { email: "ada@example.com", password: "correct horse battery" })).status).toBe(200);
    expect((await browser.get("/api/workspace")).body).toEqual({ name: "Acme" });
  });

  it("reports itself healthy once the database is reachable", async () => {
    const cronk = await startCronk();
    expect(await cronk.client().get("/api/health")).toEqual({ status: 200, body: { status: "ok" } });
  });
});
