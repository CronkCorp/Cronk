import { describe, expect, it } from "vitest";
import { ada, delegatedSetup, startCronk, startInstalledCronk } from "./harness.js";

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

describe("stopping the application", () => {
  it("waits for a look for lapsed Claims still running, and live updates work after it starts again", async () => {
    const { cronk, admin, session } = await delegatedSetup(1);
    const threshold = (await admin.get("/api/workspace")).body.silenceThresholdSeconds;
    expect((await (await session()).post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    // Every look stalls on the held table, and the one after the clock moves finds the Claim lapsed, so it goes on to tell of it.
    const held = await cronk.holdTable("tickets");
    cronk.clock.advance(threshold * 1000 + 1);
    const looking = cronk.lookForLapses();
    await held.waiters(1);

    const restarting = cronk.restart();
    await held.release();
    await restarting;
    await expect(looking).resolves.toBeUndefined();

    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
    const stream = await admin.events("/api/projects/CRONK/events");
    expect((await stream.next())?.event).toBe("ready");
    await admin.patch("/api/tickets/CRONK-1", { title: "After the restart" });
    expect(await stream.next()).toEqual({ event: "changed", data: { ticket: "CRONK-1" } });
  });
});

describe("losing database connections", () => {
  it("keeps answering after Postgres terminates its idle connections, as on a Postgres restart", async () => {
    const { cronk, admin } = await startInstalledCronk("Acme");

    await cronk.terminateConnections();

    expect((await admin.get("/api/workspace")).body).toMatchObject({ name: "Acme" });
  });
});
