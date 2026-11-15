import { randomBytes } from "node:crypto";
import { crc32, deflateRawSync, gunzipSync, gzipSync } from "node:zlib";
import pg from "pg";
import tar from "tar-stream";
import { inject, onTestFinished } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import type { Clock } from "../src/server/clock.js";
import { LiveUpdates, type LiveEvent } from "../src/server/live/live-updates.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Live updates whose publishes tests can hold back, as if the server were slow to push them after their change committed.
 * No timer runs their streams' heartbeats, which would refresh Agent Sessions at whatever the fake clock reads
 * whenever real time lets it fire; tests run them with `Cronk.heartbeat`.
 */
class HoldableLiveUpdates extends LiveUpdates {
  private holding: [string, LiveEvent][] | null = null;

  constructor() {
    super({ heartbeatMs: null });
  }

  override publish(topic: string, event: LiveEvent): void {
    if (this.holding) this.holding.push([topic, event]);
    else super.publish(topic, event);
  }

  /** Holds every publish from now on until the returned function is called, which publishes them in order. */
  hold(): () => void {
    this.holding ??= [];
    return () => {
      const held = this.holding ?? [];
      this.holding = null;
      for (const [topic, event] of held) super.publish(topic, event);
    };
  }
}

/** A clock tests control. Starts at a fixed instant and only moves when told to. */
export class FakeClock implements Clock {
  private current: Date;
  private step = 0;
  constructor(start = new Date("2026-01-01T09:00:00Z")) {
    this.current = start;
  }
  now(): Date {
    const now = new Date(this.current);
    this.advance(this.step);
    return now;
  }
  /** Moves the clock on by `ms` after every read from now on, as a real clock moves within a request; 0 stops it. */
  tickEachRead(ms: number): void {
    this.step = ms;
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
    const res = await this.cronk.app.inject({
      method,
      url,
      headers: this.authHeaders(),
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
  /**
   * Locks the row of `table` with this id, as a transaction updating it would, so writes that
   * reference it (such as rows with a foreign key to it) wait until it is released.
   */
  holdRow(table: string, id: string): Promise<HeldLock>;
  /** Locks all of `table`, as a schema change would, so every query on it (reads too) waits until it is released. */
  holdTable(table: string): Promise<HeldLock>;
  /**
   * Holds back every live update the server pushes from now on, as if each change committed
   * but its push hadn't run yet, until released, which pushes them in order. Released when the test ends.
   */
  holdPushes(): HeldPushes;
  /**
   * Runs the heartbeat of every live-update stream still open now, as its 25-second timer does
   * outside tests (no timer runs it in them), and waits until each has run. Streams a test closed
   * just before are given a moment to end first.
   */
  heartbeat(): Promise<void>;
  /**
   * Undoes migration `id` by running `undo` and forgets it was applied, as on a database from
   * before it shipped, so the next `restart` applies it again over the data already there.
   */
  undoMigration(id: string, undo: string): Promise<void>;
  /** Starts listening on a free local port (once) and returns the base URL, for clients that need real HTTP. */
  url(): Promise<string>;
}

/** Live updates held by `Cronk.holdPushes`, until released. */
export interface HeldPushes {
  /** Pushes the held updates, in the order they were made, and stops holding. */
  release(): void;
}

/** A row held by `Cronk.holdRow`, or a table held by `Cronk.holdTable`, until released. */
export interface HeldLock {
  /** Resolves once at least `n` queries on this test's database are waiting on a lock. */
  waiters(n: number): Promise<void>;
  /** Lets the writes waiting on the row through. */
  release(): Promise<void>;
}

/** Checks `done` every 10ms until it holds, failing with `failure` (or what it answers) after five seconds. */
async function pollUntil(done: () => Promise<boolean>, failure: string | (() => Promise<string>)): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(typeof failure === "string" ? failure : await failure());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** How many queries on database `dbName` are waiting on a lock, asked through `client`. */
async function lockWaiters(client: pg.Client, dbName: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'", [dbName]);
  return rows[0]!.n;
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
  let live!: HoldableLiveUpdates;
  const start = () => buildApp({ config: { databaseUrl, cookieSecure: false }, clock, live: (live = new HoldableLiveUpdates()), lapseCheckMs: 50 });

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
        const connections = async () =>
          (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [dbName])).rows[0]!.n;
        await pollUntil(async () => (await connections()) === 0, async () => `${await connections()} connections to ${dbName} outlived pg_terminate_backend`);
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
        // Terminates the connections whose queries wait on a lock, once there are any.
        const terminated = async () =>
          (
            await admin.query<{ n: number }>(
              "SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
              [dbName],
            )
          ).rows[0]!.n > 0;
        await pollUntil(terminated, `No query waited on ${table}`);
      } finally {
        await admin.query("ROLLBACK").catch(() => {});
        await admin.end();
      }
    },
    holdRow: (table, id) => hold(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]),
    holdTable: (table) => hold(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`, []),
    holdPushes: () => {
      const release = live.hold();
      onTestFinished(release);
      return { release };
    },
    heartbeat: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await live.heartbeat();
    },
    undoMigration: async (id, undo) => {
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(undo);
        await client.query("DELETE FROM schema_migrations WHERE id = $1", [id]);
      } finally {
        await client.end();
      }
    },
    url: () => (listening ??= cronk.app.listen({ host: "127.0.0.1", port: 0 })),
  };
  /** Takes a lock with `sql` in a transaction it keeps open until released. */
  async function hold(sql: string, params: unknown[]): Promise<HeldLock> {
    const holder = new pg.Client({ connectionString: databaseUrl });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(sql, params);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    };
    onTestFinished(release);
    return {
      waiters: async (n) => {
        // Asked outside the holding transaction, as pg_stat_activity stays the same within one.
        const watcher = new pg.Client({ connectionString: databaseUrl });
        await watcher.connect();
        try {
          await pollUntil(async () => (await lockWaiters(watcher, dbName)) >= n, `Fewer than ${n} queries waited on a lock`);
        } finally {
          await watcher.end();
        }
      },
      release,
    };
  }
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
 * Without it, the client never opens that stream (its GET is answered 405, as by a server that
 * offers none), so its Agent Session stays silent between its requests whatever heartbeats run.
 */
export async function connectMcp(cronk: Cronk, token: string, opts: { listening?: boolean } = {}): Promise<McpConnection> {
  let listening!: () => void;
  const listens = new Promise<void>((resolve) => (listening = resolve));
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", await cronk.url()), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      if (init?.method === "GET" && !opts.listening) return new globalThis.Response(null, { status: 405 });
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

/**
 * A zip archive holding `files` (path to text; a path ending in `/` is a folder entry), as a file manager's
 * "Compress" makes of a folder: each file deflated, or stored when `stored` is set.
 */
export function zip(files: Record<string, string>, { stored = false } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const method = stored || name.endsWith("/") ? 0 : 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const header = (signature: number, size: number) => {
      const b = Buffer.alloc(size);
      b.writeUInt32LE(signature, 0);
      return b;
    };
    const local = header(0x04034b50, 30);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = header(0x02014b50, 46);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
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
