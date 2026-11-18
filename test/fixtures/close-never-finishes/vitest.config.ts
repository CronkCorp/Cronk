import { defineConfig } from "vitest/config";

/**
 * Runs `close-never-finishes.fixture.ts` alone, for `test/close-never-finishes.test.ts` to read what a run prints. It keeps the
 * hook timeout of the repository's own run, which a close that never finishes would otherwise wait out. The run's own tests use
 * the Postgres of the run that starts it, named by TEST_POSTGRES_URL, rather than starting another.
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["close-never-finishes.fixture.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    provide: { postgresAdminUrl: process.env.TEST_POSTGRES_URL!, s3Server: null },
  },
});
