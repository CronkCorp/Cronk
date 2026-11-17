import { describe, expect, it } from "vitest";
import { startInstalledCronk } from "./harness.js";

describe("staging database faults", () => {
  // A client the failed hold left open would be cut off when the test's database is dropped, failing the run with its error.
  it("closes its client when holding a row fails", async () => {
    const { cronk, admin } = await startInstalledCronk("Acme");

    // Not an id at all, so the locking query fails.
    await expect(cronk.holdRow("tickets", "not-an-id")).rejects.toThrow();

    expect((await admin.get("/api/projects")).status).toBe(200);
  });
});
