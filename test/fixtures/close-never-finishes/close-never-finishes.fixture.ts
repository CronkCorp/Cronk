// Tests that `test/close-never-finishes.test.ts` runs, to read what the run prints. The first two fail on purpose.
import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { delegatedSetup, type Client, type Cronk } from "../../harness.js";

/** The bound on closing these tests start Cronk with. */
const CLOSE_WITHIN_MS = 500;
/** How long a restart may take, as `test/startup.test.ts` bounds it: the bound on closing, and slack past it. */
const RESTART_WITHIN_MS = CLOSE_WITHIN_MS + 2_000;

/** More bytes than a connection's buffers hold, so a download of them stalls on a client that stops reading. */
const MORE_THAN_BUFFERED = 32 * 1024 * 1024;

/**
 * Has a download's client stop reading midway, and turns off the application's cut-off of the connections still open once
 * closing has waited its bound, as a regression would: closing then never finishes, as the download never does.
 */
async function stallClosing(cronk: Cronk, client: Client): Promise<void> {
  const res = await client.upload("/api/tickets/CRONK-1/attachments?name=large.bin", randomBytes(MORE_THAN_BUFFERED), "application/octet-stream");
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  vi.spyOn(cronk.app.server, "closeAllConnections").mockImplementation(() => {});
  const download = await client.send(`/api/attachments/${res.body.attachment.id}/file`);
  expect(download.statusCode).toBe(200);
  await new Promise((resolve) => download.once("readable", resolve));
}

/** Prints where the test keeps its database and files, for the run that reads its output to look for them afterwards. */
function printPlaces(cronk: Cronk): void {
  console.log(`database: ${new URL(cronk.databaseUrl).pathname.slice(1)}`);
  console.log(`files: ${cronk.filesDir}`);
}

it("fails on a restart whose close never finishes", async () => {
  const { cronk, admin } = await delegatedSetup(1, { closeWithinMs: CLOSE_WITHIN_MS });
  printPlaces(cronk);
  await stallClosing(cronk, admin);

  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), RESTART_WITHIN_MS)));
  const restarted = await Promise.race([cronk.restart().then(() => "done"), late]);
  clearTimeout(timer);
  expect(restarted, "Restarting did not finish within its bound").toBe("done");
});

it("fails on a close that never finishes once it passes", async () => {
  const { cronk, admin } = await delegatedSetup(1, { closeWithinMs: CLOSE_WITHIN_MS });
  printPlaces(cronk);
  await stallClosing(cronk, admin);
});

it("passes, closing as it should", async () => {
  const { cronk } = await delegatedSetup(1, { closeWithinMs: CLOSE_WITHIN_MS });
  printPlaces(cronk);
});
