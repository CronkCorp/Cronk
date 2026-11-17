import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { E2E_HOST, E2E_PORT } from "../playwright.config.js";

const SERVER_LOG = "test-results/cronk-server.log";
// A server that keeps exiting is broken, not unlucky: after this many restarts the tests are left to fail.
const MAX_RESTARTS = 3;

/**
 * Starts a disposable Postgres and the real server process, configured only
 * through environment variables, serving the built web client (`npm run build:web`).
 * Set TEST_POSTGRES_URL to use an existing Postgres instead of a container: the run then gets
 * a fresh database of its own in it, dropped again when the run ends.
 *
 * The server's log goes to `test-results/cronk-server.log`, kept with the traces. Should the server exit while
 * the tests run, every later test would fail at once with ERR_CONNECTION_REFUSED; instead it is said on the
 * console and started again on the same database, so the tests after the one it took down run on their own.
 */
export default async function globalSetup() {
  await assertPortFree(E2E_PORT);
  await mkdir("test-results", { recursive: true });
  const log = createWriteStream(SERVER_LOG);
  // The log is evidence, not a reason to fail the run: losing it only goes to the console.
  log.on("error", (err) => console.error(`Could not write ${SERVER_LOG}: ${err.message}`));
  // Started last, so that nothing before the health check can fail and leave its database behind in a shared Postgres.
  const postgres = await startPostgres();
  const start = (): Server => {
    const running = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: postgres.url,
        HOST: E2E_HOST,
        PORT: String(E2E_PORT),
        WEB_ROOT: "dist/web",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.stdout!.pipe(log, { end: false });
    running.stderr!.pipe(log, { end: false });
    // Errors also reach the console, so a run that fails shows why the server did.
    running.stderr!.pipe(process.stderr, { end: false });
    // "close" comes once the process has exited and its output has all reached the log.
    const closed = new Promise<void>((resolve) => running.once("close", () => resolve()));
    return { process: running, closed };
  };

  let stopping = false;
  let server = start();
  let exited = false;
  void server.closed.then(() => (exited = true));
  const healthy = await waitFor(`http://${E2E_HOST}:${E2E_PORT}/api/health`, 30_000, () => exited);
  if (!healthy) {
    await stop(server);
    log.end();
    await postgres.stop();
    throw new Error(`${exited ? "Cronk exited during startup" : "Cronk did not become healthy within 30 seconds"}; see ${SERVER_LOG}`);
  }

  let restarts = 0;
  const restartOnExit = (running: Server) =>
    running.process.once("exit", async (code, signal) => {
      if (stopping) return;
      const exit = `Cronk exited during the smoke tests (${signal ?? `code ${code}`}); the test running then fails. Its log is in ${SERVER_LOG}.`;
      if (restarts++ === MAX_RESTARTS) return console.error(`\n${exit} It has exited ${restarts} times, so it is not started again.\n`);
      // Another process may have taken the port meanwhile; the tests must not go on against it.
      const free = await assertPortFree(E2E_PORT).then(() => true, (err: Error) => (console.error(`\n${exit} ${err.message}\n`), false));
      if (!free || stopping) return;
      console.error(`\n${exit} Starting it again on the same database.\n`);
      server = start();
      restartOnExit(server);
    });
  restartOnExit(server);

  return async () => {
    stopping = true;
    try {
      await stop(server);
      log.end();
    } finally {
      await postgres.stop();
    }
  };
}

interface Postgres {
  url: string;
  /** Drops the run's database, or stops the container it lives in. */
  stop: () => Promise<void>;
}

/** A fresh database for this run: in the Postgres at TEST_POSTGRES_URL when set, else in a disposable container. */
async function startPostgres(): Promise<Postgres> {
  const existing = process.env.TEST_POSTGRES_URL;
  if (!existing) {
    const container = await new PostgreSqlContainer("postgres:17-alpine").start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  }
  const dbName = `cronk_e2e_${randomBytes(6).toString("hex")}`;
  const admin = async (sql: string) => {
    const client = new pg.Client({ connectionString: existing });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  await admin(`CREATE DATABASE ${dbName}`);
  const url = new URL(existing);
  url.pathname = `/${dbName}`;
  return { url: url.toString(), stop: () => admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`) };
}

interface Server {
  process: ChildProcess;
  /** Settles once the process has exited and its output has all been read. */
  closed: Promise<void>;
}

/** Stops `server` (if it still runs) with SIGTERM, or SIGKILL if it has not gone within 10 seconds, and waits until it has. */
async function stop(server: Server): Promise<void> {
  const running = server.process.exitCode === null && server.process.signalCode === null;
  if (running) server.process.kill("SIGTERM");
  const killing = running ? setTimeout(() => server.process.kill("SIGKILL"), 10_000) : undefined;
  await server.closed;
  clearTimeout(killing);
}

/**
 * Fails fast when another process (another worktree's e2e run, a leftover
 * server) already holds the port: the spawned server could not bind it, and the
 * smoke tests would run against the foreign one.
 */
async function assertPortFree(port: number): Promise<void> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, E2E_HOST, resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    throw new Error(
      `Port ${port} is already in use, so the smoke tests cannot start their own Cronk there. ` +
        `Stop the process on port ${port}, or set E2E_PORT to a free port.`,
    );
  }
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

async function waitFor(url: string, timeoutMs: number, gaveUp: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !gaveUp()) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
