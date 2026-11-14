import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    postgresAdminUrl: string;
  }
}

/**
 * Starts one disposable Postgres for the whole test run. Each test then creates
 * its own database on it (see harness.ts). Set TEST_POSTGRES_URL to use an
 * existing server instead of a container.
 */
export default async function setup(project: TestProject) {
  const existing = process.env.TEST_POSTGRES_URL;
  let container: StartedPostgreSqlContainer | undefined;
  let url = existing;
  if (!url) {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    url = container.getConnectionUri();
  }
  project.provide("postgresAdminUrl", url);
  return async () => {
    await container?.stop();
  };
}
