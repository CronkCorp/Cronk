import { randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import pg from "pg";
import tar from "tar-stream";
import { inject, onTestFinished } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import type { Clock } from "../src/server/clock.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
    private readonly headers: Record<string, string> = {},
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

  /**
   * Opens a server-sent event stream at `path` over real HTTP, as a browser's EventSource
   * does, sending this caller's cookies and headers, and any extra `headers` (such as
   * `last-event-id`). Closed when the test ends.
   */
  async events(path: string, headers: Record<string, string> = {}): Promise<EventStream> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const abort = new AbortController();
    const res = await fetch(new URL(path, await this.cronk.url()), {
      headers: { ...this.headers, ...headers, accept: "text/event-stream", ...(cookie && { cookie }), ...(this.token && { authorization: `Bearer ${this.token}` }) },
      signal: abort.signal,
    });
    onTestFinished(() => abort.abort());
    return new EventStream(res, () => abort.abort());
  }

  /** Downloads `path` as raw bytes, as a browser saving a file does. */
  async download(path: string): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
    const res = await this.cronk.app.inject({ method: "GET", url: path, headers: this.authHeaders() });
    return { status: res.statusCode, headers: res.headers, body: res.rawPayload };
  }

  /** Uploads `bytes` to `path` as a file of `contentType`; the answer is JSON. */
  async upload<T = any>(path: string, bytes: Buffer, contentType = "application/gzip"): Promise<Response<T>> {
    const res = await this.cronk.app.inject({
      method: "POST",
      url: path,
      headers: { ...this.authHeaders(), "content-type": contentType },
      payload: bytes,
    });
    return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : undefined) as T };
  }

  private authHeaders(): Record<string, string> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    return { ...this.headers, ...(cookie && { cookie }), ...(this.token && { authorization: `Bearer ${this.token}` }) };
  }

  private async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<Response<T>> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await this.cronk.app.inject({
      method,
      url,
      headers: { ...this.headers, ...(cookie && { cookie }), ...(this.token && { authorization: `Bearer ${this.token}` }) },
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

/** One server-sent event: its name, parsed JSON data, and its id if it has one. */
export interface ServerEvent {
  event: string;
  data: any;
  id?: string;
}

/** A server-sent event stream being read, one event at a time. */
export class EventStream {
  readonly status: number;
  private buffer = "";
  private readonly reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private readonly decoder = new TextDecoder();

  constructor(
    res: globalThis.Response,
    readonly close: () => void,
  ) {
    this.status = res.status;
    this.reader = res.ok ? res.body!.getReader() : undefined;
  }

  /** The next event, skipping comments; null once the server ends the stream. Fails if none comes within `timeoutMs`. */
  async next(timeoutMs = 5_000): Promise<ServerEvent | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const fields = block.split("\n").filter((line) => !line.startsWith(":"));
        if (fields.length === 0) continue;
        const field = (name: string) => fields.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim();
        const data = field("data");
        const id = field("id");
        return { event: field("event") ?? "message", data: data === undefined ? undefined : JSON.parse(data), ...(id !== undefined && { id }) };
      }
      if (!this.reader) return null;
      const read = await Promise.race([
        this.reader.read().catch(() => ({ done: true as const, value: undefined })),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("No server-sent event came in time")), Math.max(0, deadline - Date.now()))),
      ]);
      if (read.done) return null;
      this.buffer += this.decoder.decode(read.value, { stream: true });
    }
  }
}

export interface Cronk {
  app: FastifyInstance;
  clock: FakeClock;
  /** A new caller with an empty cookie jar, sending `token` as a bearer token if given, and any extra `headers`. */
  client(token?: string, headers?: Record<string, string>): Client;
  /** Stops the application and starts it again on the same database. */
  restart(): Promise<void>;
  /**
   * Has Postgres terminate every connection to this test's database, as it does when
   * it restarts, and waits until they are gone.
   */
  terminateConnections(): Promise<void>;
  /**
   * Holds back every query on `table` while `cause` runs, then has Postgres terminate the
   * connections whose queries are waiting on it, so those queries fail as on a database
   * blip, and lets the rest through.
   */
  interruptQueriesOn(table: string, cause: () => Promise<unknown>): Promise<void>;
  /** Starts listening on a free local port (once) and returns the base URL, for clients that need real HTTP. */
  url(): Promise<string>;
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
    client: (token?: string, headers?: Record<string, string>) => new Client(cronk, token, headers),
    restart: async () => {
      await cronk.app.close();
      cronk.app = await start();
      listening = undefined;
    },
    terminateConnections: async () => {
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [dbName]);
        const deadline = Date.now() + 5_000;
        for (;;) {
          const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [dbName]);
          if (rows[0]!.n === 0) break;
          if (Date.now() > deadline) throw new Error(`${rows[0]!.n} connections to ${dbName} outlived pg_terminate_backend`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        await admin.end();
      }
      // Give the server's clients a moment to read the termination notice.
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    interruptQueriesOn: async (table, cause) => {
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      try {
        await admin.query("BEGIN");
        await admin.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
        await cause();
        const deadline = Date.now() + 5_000;
        for (;;) {
          const { rows } = await admin.query<{ n: number }>(
            "SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
            [dbName],
          );
          if (rows[0]!.n > 0) break;
          if (Date.now() > deadline) throw new Error(`No query waited on ${table}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        await admin.query("ROLLBACK").catch(() => {});
        await admin.end();
      }
    },
    url: () => (listening ??= cronk.app.listen({ host: "127.0.0.1", port: 0 })),
  };
  let listening: Promise<string> | undefined;

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
 * returned signed in. The name defaults to the email's local part and the password is fixed.
 */
export async function joinAs(
  cronk: Cronk,
  admin: Client,
  email: string,
  role: "admin" | "member" = "member",
  name = email.split("@")[0],
): Promise<Client> {
  const invited = await admin.post("/api/invitations", { email, role });
  if (invited.status !== 201) throw new Error(`Inviting ${email} failed: ${JSON.stringify(invited.body)}`);
  const client = cronk.client();
  const accepted = await client.post(`/api/invitations/by-token/${invited.body.token}/accept`, { name, password: memberPassword });
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
  return cronk.client((await registerAgent(owner, name, opts)).secret);
}

/** Has `owner` register an Agent called `name` and issue it a token; returns the Agent's id, the token's id and its secret. */
export async function registerAgent(
  owner: Client,
  name: string,
  opts: { readOnly?: boolean } = {},
): Promise<{ agentId: string; tokenId: string; secret: string }> {
  const agent = await owner.post("/api/agents", { name });
  if (agent.status !== 201) throw new Error(`Registering ${name} failed: ${JSON.stringify(agent.body)}`);
  const issued = await owner.post(`/api/agents/${agent.body.agent.id}/tokens`, { readOnly: opts.readOnly ?? false });
  if (issued.status !== 201) throw new Error(`Issuing a token for ${name} failed: ${JSON.stringify(issued.body)}`);
  return { agentId: agent.body.agent.id, tokenId: issued.body.token.id, secret: issued.body.secret };
}

/** An MCP connection to Cronk, made by a real MCP client over streamable HTTP. */
export interface McpConnection {
  client: McpClient;
  transport: StreamableHTTPClientTransport;
  /** Disconnects as a well-behaved client does: ends the MCP session, then closes. */
  disconnect(): Promise<void>;
}

/**
 * Connects a real MCP client to Cronk's MCP endpoint with `token`; closed when the test ends.
 * With `listening`, also waits until the client has opened the stream it hears notifications on.
 */
export async function connectMcp(cronk: Cronk, token: string, opts: { listening?: boolean } = {}): Promise<McpConnection> {
  let listening!: () => void;
  const listens = new Promise<void>((resolve) => (listening = resolve));
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", await cronk.url()), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      if (init?.method === "GET" && res.ok) listening();
      return res;
    },
  });
  const client = new McpClient({ name: "cronk-tests", version: "0.0.0" });
  await client.connect(transport);
  onTestFinished(() => client.close());
  if (opts.listening) await listens;
  return {
    client,
    transport,
    disconnect: async () => {
      await transport.terminateSession();
      await client.close();
    },
  };
}

/** Creates a Project named after its key, with `count` Tickets titled "Ticket 1", "Ticket 2", … */
export async function projectWithTickets(client: Client, key: string, count: number): Promise<void> {
  const res = await client.post("/api/projects", { name: key, key });
  if (res.status !== 201) throw new Error(`Creating Project ${key} failed: ${JSON.stringify(res.body)}`);
  for (let i = 1; i <= count; i++) await client.post(`/api/projects/${key}/tickets`, { title: `Ticket ${i}` });
}

/**
 * Ada, the Admin, with the Project CRONK holding `tickets` Tickets, all assigned to her and
 * delegated to her Agent claude-laptop. `session()` starts a new Agent Session of that Agent.
 */
export async function delegatedSetup(tickets = 1) {
  const { cronk, admin } = await startInstalledCronk();
  await projectWithTickets(admin, "CRONK", tickets);
  const claude = await registerAgent(admin, "claude-laptop");
  const adaId = (await admin.get("/api/users")).body.users[0].id;
  for (let i = 1; i <= tickets; i++) await admin.patch(`/api/tickets/CRONK-${i}`, { assigneeId: adaId, delegateId: claude.agentId });
  return { cronk, admin, claude, adaId, session: () => startSession(cronk, claude.secret) };
}

/** Starts an Agent Session with `secret` and returns a client calling within it, with the Session's id. */
export async function startSession(cronk: Cronk, secret: string): Promise<Client & { sessionId: string }> {
  const started = await cronk.client(secret).post("/api/agent-sessions");
  if (started.status !== 201) throw new Error(`Starting a Session failed: ${JSON.stringify(started.body)}`);
  const sessionId: string = started.body.session.id;
  return Object.assign(cronk.client(secret, { "cronk-agent-session": sessionId }), { sessionId });
}

/** A gzipped tar archive holding `files` (path to text), as `tar czf` makes of a folder. */
export async function tarGz(files: Record<string, string>): Promise<Buffer> {
  const pack = tar.pack();
  for (const [name, text] of Object.entries(files)) pack.entry({ name }, text);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk as Uint8Array));
  return gzipSync(Buffer.concat(chunks));
}

/** The files in a gzipped tar archive, path to text. */
export async function untarGz(archive: Buffer): Promise<Record<string, string>> {
  const extract = tar.extract();
  const files: Record<string, string> = {};
  const done = (async () => {
    for await (const entry of extract) {
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(Buffer.from(chunk as Uint8Array));
      if (entry.header.type === "file") files[entry.header.name] = Buffer.concat(chunks).toString("utf8");
    }
  })();
  extract.end(gunzipSync(archive));
  await done;
  return files;
}
