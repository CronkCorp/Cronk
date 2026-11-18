import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

const VITEST = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

/** What a fixture test run printed, failing or passing, and how long it took. */
export interface FixtureRun {
  output: string;
  ms: number;
}

/**
 * Runs the fixture test named `name` alone, as a test run of its own with the vitest config at `config`, on this run's
 * Postgres. With `within`, the run is killed once it has taken that many milliseconds, so a run that would wait out a
 * hook timeout fails the test reading it rather than outlasting it.
 */
export async function runFixture(config: string, name: string, { within }: { within?: number } = {}): Promise<FixtureRun> {
  const started = Date.now();
  const output = await new Promise<string>((resolve) =>
    execFile(
      process.execPath,
      [VITEST, "run", "--config", config, "--reporter=default", "-t", name],
      { env: { ...process.env, TEST_POSTGRES_URL: inject("postgresAdminUrl"), NO_COLOR: "1", FORCE_COLOR: "0" }, timeout: within },
      (_err, stdout, stderr) => resolve(stdout + stderr),
    ),
  );
  return { output, ms: Date.now() - started };
}
