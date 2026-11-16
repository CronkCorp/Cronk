import { describe, expect, it } from "vitest";
import { ada, startCronk, startInstalledCronk } from "./harness.js";

describe("starting the application", () => {
  it("creates the schema on an empty database and keeps data across restarts", async () => {
    const { cronk } = await startInstalledCronk("Acme");

    await cronk.restart();

    const browser = cronk.client();
    expect((await browser.get("/api/setup")).body).toEqual({ required: false });
    expect((await browser.post("/api/sign-in", { email: ada.email, password: ada.password })).status).toBe(200);
    expect((await browser.get("/api/workspace")).body).toMatchObject({ name: "Acme" });
  });

  it("reports itself healthy once the database is reachable", async () => {
    const cronk = await startCronk();
    expect(await cronk.client().get("/api/health")).toEqual({ status: 200, body: { status: "ok" } });
  });
});

describe("losing database connections", () => {
  it("keeps answering after Postgres terminates its idle connections, as on a Postgres restart", async () => {
    const { cronk, admin } = await startInstalledCronk("Acme");

    await cronk.terminateConnections();

    expect((await admin.get("/api/workspace")).body).toMatchObject({ name: "Acme" });
  });

  it("keeps answering when it reconnects while Postgres is still terminating its connections", async () => {
    const { cronk, admin } = await startInstalledCronk("Acme");
    let busy = true;
    const traffic = Promise.all(
      Array.from({ length: 5 }, async () => {
        while (busy) await admin.get("/api/workspace");
      }),
    );

    try {
      await cronk.terminateConnections();
    } finally {
      busy = false;
      await traffic;
    }

    expect((await admin.get("/api/workspace")).body).toMatchObject({ name: "Acme" });
  });
});
