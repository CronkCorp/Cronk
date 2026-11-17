import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { E2E_HOST, E2E_PORT } from "../playwright.config.js";

const SERVER_LOG = "test-results/cronk-server.log";
// A server that keeps exiting is broken, not unlucky: after this many restarts the tests are left to fail.
const MAX_RESTARTS = 3;

/**
 * Starts a disposable Postgres and the real server process, configured only
 * through environment variables, serving the built web client (`npm run build:web`).
 *
 * The server's log goes to `test-results/cronk-server.log`, kept with the traces. Should the server exit while
 * the tests run, every later test would fail at once with ERR_CONNECTION_REFUSED; instead it is said on the
 * console and started again on the same database, so the tests after the one it took down run on their own.
 */
export default async function globalSetup() {
  await assertPortFree(E2E_PORT);
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  await mkdir("test-results", { recursive: true });
  const log = createWriteStream(SERVER_LOG);
  const start = () =>
    spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: container.getConnectionUri(),
        HOST: E2E_HOST,
        PORT: String(E2E_PORT),
        WEB_ROOT: "dist/web",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

  let stopping = false;
  let server = start();
  const watch = (running: ChildProcess) => {
    running.stdout!.pipe(log, { end: false });
    running.stderr!.pipe(log, { end: false });
    // Errors also reach the console, so a run that fails shows why the server did.
    running.stderr!.pipe(process.stderr, { end: false });
  };
  watch(server);

  let exited = false;
  server.once("exit", () => (exited = true));
  const healthy = await waitFor(`http://${E2E_HOST}:${E2E_PORT}/api/health`, 30_000, () => exited);
  if (!healthy) {
    server.kill();
    await container.stop();
    throw new Error(`${exited ? "Cronk exited during startup" : "Cronk did not become healthy within 30 seconds"}; see ${SERVER_LOG}`);
  }

  let restarts = 0;
  const restartOnExit = (running: ChildProcess) =>
    running.once("exit", (code, signal) => {
      if (stopping || restarts++ === MAX_RESTARTS) return;
      console.error(
        `\nCronk exited during the smoke tests (${signal ?? `code ${code}`}); the test running then fails. ` +
          `Starting it again on the same database. Its log is in ${SERVER_LOG}.\n`,
      );
      server = start();
      watch(server);
      restartOnExit(server);
    });
  restartOnExit(server);

  return async () => {
    stopping = true;
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await stopped;
    }
    log.end();
    await container.stop();
  };
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
