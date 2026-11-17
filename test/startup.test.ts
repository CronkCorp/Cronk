import { describe, expect, it } from "vitest";
import { ada, delegatedSetup, startCronk, startInstalledCronk, type Cronk, type HeldLock } from "./harness.js";

/** The bound on closing these tests start Cronk with. */
const CLOSE_WITHIN_MS = 500;
/** The time past the bound a close may take: cutting off what still waits takes up to a second, and the rest is for a loaded machine. */
const SLACK_MS = 2_000;

/** Fails unless `work` settles within `ms`, rather than waiting on it for the test's whole timeout. */
async function expectWithin(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), ms)));
  try {
    expect(await Promise.race([work.then(() => "done"), late]), `did not finish within ${ms} ms`).toBe("done");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Holds the Tickets table, starts `wait` on it, and once it waits there closes the application and starts it again, failing
 * unless closing finishes within its bound and Cronk then answers over HTTP. Answers what `wait` started, which a test awaits to
 * see how it failed, and the table, still held until the test releases it.
 */
async function restartWhileWaiting<T>(cronk: Cronk, wait: () => Promise<T>): Promise<{ waiting: Promise<T>; held: HeldLock }> {
  const held = await cronk.holdTable("tickets");
  const waiting = wait();
  // Cut off by the close, so it fails before the test awaits it.
  waiting.catch(() => {});
  await held.waiters(1);

  await expectWithin(CLOSE_WITHIN_MS + SLACK_MS, cronk.restart());

  const health = await cronk.client().send("/api/health");
  health.resume();
  expect(health.statusCode).toBe(200);
  return { waiting, held };
}

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
    // The server looks for lapsed Claims only when told to, so the look running is the one the test starts.
    const { cronk, admin, session } = await delegatedSetup(1, { lapseCheckMs: 3_600_000 });
    const threshold = (await admin.get("/api/workspace")).body.silenceThresholdSeconds;
    expect((await (await session()).post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    // The look stalls on the held table; it finds the Claim lapsed, so once let through it goes on to tell of it.
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

  it("finishes within its bound while a look for lapsed Claims waits on a lock never released, and answers after it starts again", async () => {
    const { cronk, admin, session } = await delegatedSetup(1, { lapseCheckMs: 3_600_000, closeWithinMs: CLOSE_WITHIN_MS });
    const threshold = (await admin.get("/api/workspace")).body.silenceThresholdSeconds;
    expect((await (await session()).post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    cronk.clock.advance(threshold * 1000 + 1);

    const { waiting: looking, held } = await restartWhileWaiting(cronk, () => cronk.lookForLapses());

    // The look cut off finds nothing done; the Claim is found lapsed again once the table is free.
    await expect(looking).rejects.toThrow();
    await held.release();
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
  });

  it("finishes within its bound while a request waits on a lock never released, and answers after it starts again", async () => {
    const { cronk, admin } = await delegatedSetup(1, { closeWithinMs: CLOSE_WITHIN_MS });

    const { waiting: editing, held } = await restartWhileWaiting(cronk, () => admin.patch("/api/tickets/CRONK-1", { title: "Cut off" }));

    // The edit cut off is answered as failed, and nothing of it is kept.
    expect((await editing).status).toBe(500);
    await held.release();
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.title).toBe("Ticket 1");
  });

  it("finishes within its bound while a request over HTTP waits on a lock never released", async () => {
    const { cronk, admin } = await delegatedSetup(1, { closeWithinMs: CLOSE_WITHIN_MS });

    // Over a connection kept alive, which would hold the server open after the answer unless the answer ends it.
    const { waiting: reading } = await restartWhileWaiting(cronk, () => admin.send("/api/tickets/CRONK-1"));

    expect((await reading).statusCode).toBe(500);
  });
});

describe("losing database connections", () => {
  it("keeps answering after Postgres terminates its idle connections, as on a Postgres restart", async () => {
    const { cronk, admin } = await startInstalledCronk("Acme");

    await cronk.terminateConnections();

    expect((await admin.get("/api/workspace")).body).toMatchObject({ name: "Acme" });
  });
});
