import { defineConfig } from "vitest/config";

/**
 * Runs `server-errors.fixture.ts` alone, for `test/server-errors.test.ts` to read what a run prints. The run's own tests
 * use the Postgres of the run that starts it, named by TEST_POSTGRES_URL, rather than starting another.
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["server-errors.fixture.ts"],
    testTimeout: 30_000,
    provide: { postgresAdminUrl: process.env.TEST_POSTGRES_URL!, s3Server: null },
  },
});
