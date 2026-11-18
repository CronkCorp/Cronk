import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { fixtureRun } from "./fixture-run.js";

/** How long a fixture run may take: starting the run and Cronk, the test's own bound, and teardown's bound on closing. */
const RUN_WITHIN_MS = 30_000;
const runFixture = fixtureRun(fileURLToPath(new URL("fixtures/close-never-finishes/vitest.config.ts", import.meta.url)), {
  within: RUN_WITHIN_MS,
});

/** Whether the database and the directory of files that a fixture test printed are still there after its run. */
async function placesLeft(output: string): Promise<{ database: boolean; files: boolean }> {
  const database = output.match(/^database: (\S+)$/m)?.[1];
  const files = output.match(/^files: (\/\S+)$/m)?.[1];
  expect({ database, files }, output).toEqual({ database: expect.any(String), files: expect.any(String) });
  const admin = new pg.Client({ connectionString: inject("postgresAdminUrl") });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    return { database: rowCount !== 0, files: await access(files!).then(() => true, () => false) };
  } finally {
    await admin.end();
  }
}

describe("a test whose close never finishes", () => {
  it("fails on a restart with its own error, without waiting out the hook timeout", { timeout: RUN_WITHIN_MS + 10_000 }, async () => {
    const { output, ms } = await runFixture("fails on a restart whose close never finishes");

    expect(ms).toBeLessThan(RUN_WITHIN_MS);
    expect(output).toContain("1 failed");
    expect(output).toContain("Restarting did not finish within its bound");
    // Its only error is its own: one failure reported, and teardown adds none of its own.
    expect(output).toContain("Failed Tests 1");
    expect(output).not.toContain("Hook timed out");
    expect(output).not.toContain("Closing the application did not finish");
    // Teardown drops them all the same, rather than leaving them to pile up.
    expect(await placesLeft(output)).toEqual({ database: false, files: false });
  });

  it("fails a test that passed, saying so, without waiting out the hook timeout", { timeout: RUN_WITHIN_MS + 10_000 }, async () => {
    const { output, ms } = await runFixture("fails on a close that never finishes once it passes");

    expect(ms).toBeLessThan(RUN_WITHIN_MS);
    expect(output).toContain("1 failed");
    expect(output).toContain("Failed Tests 1");
    expect(output).toMatch(/Closing the application did not finish within \d+ ms/);
    expect(output).not.toContain("Hook timed out");
    expect(await placesLeft(output)).toEqual({ database: false, files: false });
  });
});

describe("a test whose close finishes", () => {
  it("leaves neither its database nor its files behind", { timeout: RUN_WITHIN_MS + 10_000 }, async () => {
    const { output } = await runFixture("passes, closing as it should");

    expect(output).toContain("1 passed");
    expect(await placesLeft(output)).toEqual({ database: false, files: false });
  });
});
