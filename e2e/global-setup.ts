import { spawn } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { E2E_PORT } from "../playwright.config.js";

/**
 * Starts a disposable Postgres and the real server process, configured only
 * through environment variables, serving the built web client (`npm run build:web`).
 */
export default async function globalSetup() {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const server = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: container.getConnectionUri(),
      HOST: "127.0.0.1",
      PORT: String(E2E_PORT),
      WEB_ROOT: "dist/web",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  let exited = false;
  server.once("exit", () => (exited = true));
  const healthy = await waitFor(`http://127.0.0.1:${E2E_PORT}/api/health`, 30_000, () => exited);
  if (!healthy) {
    server.kill();
    await container.stop();
    throw new Error(exited ? "Cronk exited during startup" : "Cronk did not become healthy within 30 seconds");
  }

  return async () => {
    server.kill("SIGTERM");
    await container.stop();
  };
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
