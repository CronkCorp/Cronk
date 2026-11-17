import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ada, delegatedSetup, startCronk, startInstalledCronk } from "./harness.js";

/** The bound on closing these tests start Cronk with. */
const CLOSE_WITHIN_MS = 500;
/**
 * The time past the bound a close may take: cutting off what still waits takes up to a second, ending the connections still
 * open a quarter of a second more, and the rest is for a loaded machine.
 */
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

/** Bytes an endless upload sends before it stalls: more than the connection's buffers hold, so once they are all taken the server is reading them. */
const SENT_BEFORE_STALLING = 32 * 1024 * 1024;

/**
 * An upload body that sends `SENT_BEFORE_STALLING` bytes and then never sends more nor ends, as a very slow client does;
 * `stalled` resolves once all those bytes have been taken.
 */
function endlessUpload(): { body: Readable; stalled: Promise<void> } {
  const chunk = Buffer.alloc(1024 * 1024);
  let sent = 0;
  let allRead!: () => void;
  const stalled = new Promise<void>((resolve) => (allRead = resolve));
  const body = new Readable({
    read() {
      if (sent >= SENT_BEFORE_STALLING) return allRead();
      sent += chunk.length;
      this.push(chunk);
    },
  });
  return { body, stalled };
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
    const held = await cronk.holdTable("tickets");
    cronk.clock.advance(threshold * 1000 + 1);
    const looking = cronk.lookForLapses();
    looking.catch(() => {});
    await held.waiters(1);

    await expectWithin(CLOSE_WITHIN_MS + SLACK_MS, cronk.restart());

    // The look cut off finds nothing done; the Claim is found lapsed again once the table is free.
    await expect(looking).rejects.toThrow();
    expect(await admin.get("/api/health")).toEqual({ status: 200, body: { status: "ok" } });
    await held.release();
    expect((await admin.get("/api/tickets/CRONK-1")).body.claim).toBeNull();
  });

  it("finishes within its bound while a request waits on a lock never released, and answers after it starts again", async () => {
    const { cronk, admin } = await delegatedSetup(1, { closeWithinMs: CLOSE_WITHIN_MS });
    const held = await cronk.holdTable("tickets");
    const editing = admin.patch("/api/tickets/CRONK-1", { title: "Cut off" });
    await held.waiters(1);

    await expectWithin(CLOSE_WITHIN_MS + SLACK_MS, cronk.restart());

    // The edit cut off is answered as failed, and nothing of it is kept.
    expect((await editing).status).toBe(500);
    expect(await admin.get("/api/health")).toEqual({ status: 200, body: { status: "ok" } });
    await held.release();
    expect((await admin.get("/api/tickets/CRONK-1")).body.ticket.title).toBe("Ticket 1");
  });

  it("finishes within its bound while a request over HTTP waits on a lock never released", async () => {
    const { cronk, admin } = await delegatedSetup(1, { closeWithinMs: CLOSE_WITHIN_MS });
    const held = await cronk.holdTable("tickets");
    // Over a connection kept alive, which would hold the server open after the answer unless the answer ends it.
    const reading = admin.send("/api/tickets/CRONK-1");
    reading.catch(() => {});
    await held.waiters(1);

    await expectWithin(CLOSE_WITHIN_MS + SLACK_MS, cronk.restart());

    expect((await reading).statusCode).toBe(500);
    expect((await admin.send("/api/health")).statusCode).toBe(200);
  });

  it("finishes within its bound while an upload's body never finishes arriving, and answers after it starts again", async () => {
    const { cronk, admin } = await delegatedSetup(1, { closeWithinMs: CLOSE_WITHIN_MS });
    const upload = endlessUpload();
    const uploading = admin.send("/api/tickets/CRONK-1/attachments?name=endless.bin", { method: "POST", body: upload.body, headers: { "content-type": "application/octet-stream" } });
    uploading.catch(() => {});
    await upload.stalled;

    await expectWithin(CLOSE_WITHIN_MS + SLACK_MS, cronk.restart());

    // The client mid-upload sees its connection end without an answer, and nothing of the upload is kept.
    await expect(uploading).rejects.toThrow();
    expect((await admin.send("/api/health")).statusCode).toBe(200);
    expect((await admin.get("/api/tickets/CRONK-1/attachments")).body.attachments).toEqual([]);
  });
});

describe("losing database connections", () => {
  it("keeps answering after Postgres terminates its idle connections, as on a Postgres restart", async () => {
    const { cronk, admin } = await startInstalledCronk("Acme");

    await cronk.terminateConnections();

    expect((await admin.get("/api/workspace")).body).toMatchObject({ name: "Acme" });
  });
});
