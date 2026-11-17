import { describe, expect, it } from "vitest";
import { startInstalledCronk } from "./harness.js";

describe("staging database faults", () => {
  // What fails here without the fix is the run, not an assertion: a client the failed hold left open is cut off when
  // the test's database is dropped, and its error surfaces as an unhandled one.
  it("closes its client when holding a row fails", async () => {
    const { cronk } = await startInstalledCronk();

    // Not an id at all, so the locking query fails.
    await expect(cronk.holdRow("tickets", "not-an-id")).rejects.toThrow();
  });
});
