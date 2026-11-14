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

/** One API caller with its own cookie jar, like a browser tab or a script, optionally sending a bearer token. */
export class Client {
  private cookies = new Map<string, string>();
  constructor(
    private readonly cronk: Cronk,
    private readonly token?: string,
  ) {}

  get<T = any>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  put<T = any>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body);
  }
  delete<T = any>(path: string) {
    return this.request<T>("DELETE", path);
  }

  private async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<Response<T>> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await this.cronk.app.inject({
      method,
      url,
      headers: { ...(cookie && { cookie }), ...(this.token && { authorization: `Bearer ${this.token}` }) },
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
  /** A new caller with an empty cookie jar, sending `token` as a bearer token if given. */
  client(token?: string): Client;
  /** Stops the application and starts it again on the same database. */
  restart(): Promise<void>;
  /**
   * Has Postgres terminate every connection to this test's database, as it does when
   * it restarts, and waits until they are gone.
   */
  terminateConnections(): Promise<void>;
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
    client: (token?: string) => new Client(cronk, token),
    restart: async () => {
      await cronk.app.close();
      cronk.app = await start();
    },
    terminateConnections: async () => {
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [dbName]);
        for (;;) {
          const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [dbName]);
          if (rows[0]!.n === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        await admin.end();
      }
      // Give the server's clients a moment to read the termination notice.
      await new Promise((resolve) => setTimeout(resolve, 50));
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

/**
 * Has `admin` invite `email` and accepts the invitation on a new client, which is
 * returned signed in. The name is the email's local part and the password is fixed.
 */
export async function joinAs(cronk: Cronk, admin: Client, email: string, role: "admin" | "member" = "member"): Promise<Client> {
  const invited = await admin.post("/api/invitations", { email, role });
  if (invited.status !== 201) throw new Error(`Inviting ${email} failed: ${JSON.stringify(invited.body)}`);
  const client = cronk.client();
  const accepted = await client.post(`/api/invitations/${invited.body.token}/accept`, { name: email.split("@")[0], password: memberPassword });
  if (accepted.status !== 201) throw new Error(`Accepting ${email} failed: ${JSON.stringify(accepted.body)}`);
  return client;
}

/** The password `joinAs` gives every User it creates. */
export const memberPassword = "member password";

/**
 * Has `owner` register an Agent called `name` and issue it a token, and returns a
 * client calling the API as that Agent.
 */
export async function agentOf(cronk: Cronk, owner: Client, name: string, opts: { readOnly?: boolean } = {}): Promise<Client> {
  const agent = await owner.post("/api/agents", { name });
  if (agent.status !== 201) throw new Error(`Registering ${name} failed: ${JSON.stringify(agent.body)}`);
  const issued = await owner.post(`/api/agents/${agent.body.agent.id}/tokens`, { readOnly: opts.readOnly ?? false });
  if (issued.status !== 201) throw new Error(`Issuing a token for ${name} failed: ${JSON.stringify(issued.body)}`);
  return cronk.client(issued.body.secret);
}

/** Creates a Project named after its key, with `count` Tickets titled "Ticket 1", "Ticket 2", … */
export async function projectWithTickets(client: Client, key: string, count: number): Promise<void> {
  const res = await client.post("/api/projects", { name: key, key });
  if (res.status !== 201) throw new Error(`Creating Project ${key} failed: ${JSON.stringify(res.body)}`);
  for (let i = 1; i <= count; i++) await client.post(`/api/projects/${key}/tickets`, { title: `Ticket ${i}` });
}
