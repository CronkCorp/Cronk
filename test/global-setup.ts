import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import type { TestProject } from "vitest/node";

/** Where a disposable S3-compatible store (MinIO) answers, and the keys to it. */
export interface S3Server {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    postgresAdminUrl: string;
    /** The disposable MinIO, or null when none could be started: S3 tests are then skipped. */
    s3Server: S3Server | null;
  }
}

/**
 * Starts one disposable Postgres and one disposable MinIO for the whole test run. Each test then creates
 * its own database (see harness.ts) or bucket on them. Set TEST_POSTGRES_URL to use an existing Postgres
 * instead of a container, and TEST_S3_ENDPOINT (with TEST_S3_ACCESS_KEY_ID and TEST_S3_SECRET_ACCESS_KEY)
 * to use an existing S3-compatible server. Without one, and with no MinIO to start, the S3 tests are skipped.
 */
export default async function setup(project: TestProject) {
  const [postgres, minio] = await Promise.all([startPostgres(), startMinio()]);
  project.provide("postgresAdminUrl", postgres.url);
  project.provide("s3Server", minio.server);
  return async () => {
    await Promise.all([postgres.container?.stop(), minio.container?.stop()]);
  };
}

async function startPostgres(): Promise<{ url: string; container?: StartedPostgreSqlContainer }> {
  const existing = process.env.TEST_POSTGRES_URL;
  if (existing) return { url: existing };
  const container = await new PostgreSqlContainer("postgres:17-alpine")
    // A disposable database needs no durability: not waiting for disk speeds up every commit and every CREATE DATABASE.
    .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"])
    .start();
  return { url: container.getConnectionUri(), container };
}

async function startMinio(): Promise<{ server: S3Server | null; container?: StartedMinioContainer }> {
  const endpoint = process.env.TEST_S3_ENDPOINT;
  if (endpoint) {
    return {
      server: { endpoint, accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "" },
    };
  }
  try {
    const container = await new MinioContainer("minio/minio:RELEASE.2025-09-07T16-13-09Z").start();
    return {
      server: { endpoint: container.getConnectionUrl(), accessKeyId: container.getUsername(), secretAccessKey: container.getPassword() },
      container,
    };
  } catch (err) {
    const reason = (err as Error).message;
    if (process.env.CI) {
      throw new Error(`No MinIO could be started, and in CI the S3-compatible storage tests must run, not be skipped: ${reason}`, { cause: err });
    }
    console.warn(`No MinIO could be started, so the S3-compatible storage tests are skipped: ${reason}`);
    return { server: null };
  }
}
