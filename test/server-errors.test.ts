import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, inject, it } from "vitest";

const VITEST = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const CONFIG = fileURLToPath(new URL("fixtures/server-errors/vitest.config.ts", import.meta.url));

/** What a test run prints running the fixture test named `name` alone, on this run's Postgres. */
async function runFixture(name: string): Promise<string> {
  const ran = await promisify(execFile)(process.execPath, [VITEST, "run", "--config", CONFIG, "--reporter=default", "-t", name], {
    env: { ...process.env, TEST_POSTGRES_URL: inject("postgresAdminUrl"), NO_COLOR: "1", FORCE_COLOR: "0" },
  }).catch((err: { stdout: string; stderr: string }) => err);
  return ran.stdout + ran.stderr;
}

describe("a test run", () => {
  it("shows the error behind an answer of 500 in a test that fails", async () => {
    const output = await runFixture("fails on an answer of 500");

    expect(output).toContain("1 failed");
    expect(output).toContain("Commit failed by the test harness");
    // Its stack too, down into the code that sent the query.
    expect(output).toMatch(/Commit failed by the test harness[^]*\n\s+at .*node_modules\/pg/);
  });

  it("shows nothing of an answer of 400", async () => {
    const output = await runFixture("fails on an answer of 400");

    expect(output).toContain("1 failed");
    // Neither the refusal ("body must have required property 'key'") nor a heading for errors the server logged.
    expect(output).not.toMatch(/required property|logged/i);
  });

  it("shows nothing of an answer of 500 a passing test provokes", async () => {
    const output = await runFixture("passes on an answer of 500 it provokes");

    expect(output).toContain("1 passed");
    expect(output).not.toContain("Commit failed by the test harness");
  });
});
