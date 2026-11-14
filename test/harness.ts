import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject, onTestFinished } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import type { Clock } from "../src/server/clock.js";

/** A clock tests control. Starts at a fixed instant and only moves when told to. */
export class FakeClock implements Clock {
  private current: Date;
  constructor(start = new Date("2026-01-01T09:00:00Z")) {
    this.current = start;
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface Response<T = any> {
  status: number;
  body: T;
}

/** One API caller with its own cookie jar, like a browser tab or a script. */
export class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly cronk: Cronk) {}

  get<T = any>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  delete<T = any>(path: string) {
    return this.request<T>("DELETE", path);
  }

  private async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<Response<T>> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await this.cronk.app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(body === undefined ? {} : { payload: body as object }),
    });
    for (const c of res.cookies) {
      if (c.value === "" || (c.maxAge !== undefined && c.maxAge <= 0)) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const text = res.body;
    return { status: res.statusCode, body: (text ? JSON.parse(text) : undefined) as T };
  }
}

export interface Cronk {
  app: FastifyInstance;
  clock: FakeClock;
  /** A new caller with an empty cookie jar. */
  client(): Client;
  /** Stops the application and starts it again on the same database. */
  restart(): Promise<void>;
}

/**
 * Starts Cronk in-process on a fresh, empty database and stops it when the test ends.
 */
export async function startCronk(): Promise<Cronk> {
  const adminUrl = inject("postgresAdminUrl");
  const dbName = `cronk_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const databaseUrl = url.toString();

  const clock = new FakeClock();
  const start = () => buildApp({ config: { databaseUrl, cookieSecure: false }, clock });

  const cronk: Cronk = {
    app: await start(),
    clock,
    client: () => new Client(cronk),
    restart: async () => {
      await cronk.app.close();
      cronk.app = await start();
    },
  };

  onTestFinished(async () => {
    await cronk.app.close();
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  return cronk;
}

/** The first User in most tests: the Admin created at setup. */
export const ada = { email: "ada@example.com", password: "correct horse battery", name: "Ada" } as const;

/** Cronk after first-run setup, with Ada signed in as the Admin on `admin`. */
export async function startInstalledCronk(workspaceName = "Acme"): Promise<{ cronk: Cronk; admin: Client }> {
  const cronk = await startCronk();
  const admin = cronk.client();
  const setup = await admin.post("/api/setup", { ...ada, workspaceName });
  if (setup.status !== 201) throw new Error(`Setup failed: ${JSON.stringify(setup.body)}`);
  return { cronk, admin };
}
