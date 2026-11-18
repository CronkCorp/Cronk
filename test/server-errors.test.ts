import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureRun } from "./fixture-run.js";

/** The error `failCommitsWriting` fails a commit with. */
const COMMIT_FAILED = "Commit failed by the test harness";
const runFixture = fixtureRun(fileURLToPath(new URL("fixtures/server-errors/vitest.config.ts", import.meta.url)));

describe("a test run", () => {
  it("shows the error behind an answer of 500 in a test that fails", async () => {
    const { output } = await runFixture("fails on an answer of 500");

    expect(output).toContain("1 failed");
    // The error failCommitsWriting raises, with its stack down into the code that sent the query.
    expect(output).toMatch(new RegExp(`${COMMIT_FAILED}[^]*\n\\s+at .*node_modules/pg/`));
  });

  it("shows nothing of an answer of 400", async () => {
    const { output } = await runFixture("fails on an answer of 400");

    expect(output).toContain("1 failed");
    // Neither the refusal ("body must have required property 'key'") nor a heading for errors the server logged.
    expect(output).not.toMatch(/required property|The server logged/);
  });

  it("shows nothing of an answer of 500 a passing test provokes", async () => {
    const { output } = await runFixture("passes on an answer of 500 it provokes");

    expect(output).toContain("1 passed");
    expect(output).not.toContain(COMMIT_FAILED);
  });
});
