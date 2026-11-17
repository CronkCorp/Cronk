import pg from "pg";
import type { LiveEvent } from "../live/live-updates.js";
import { migrations as allMigrations, type Migration } from "./migrations.js";

export type Database = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

/** Postgres's error code for a unique index refusing a row. */
export const UNIQUE_VIOLATION = "23505";

/**
 * Opens a connection pool. Postgres may drop an idle connection at any time (a
 * restart, an admin terminating it); the pool discards that connection and opens a
 * new one when needed, and the error goes to `onIdleError` instead of crashing the process.
 */
export function createDatabase(databaseUrl: string, onIdleError: (err: Error) => void): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  pool.on("error", onIdleError);
  return pool;
}

/** A connection inside a transaction, which can also hold work back until the transaction commits. */
export interface Transaction extends pg.PoolClient {
  /**
   * Runs `work` once the transaction has committed, after any registered before it; never if it
   * rolls back or its commit fails. Work that throws is logged and passed over: what committed stands.
   */
  afterCommit(work: () => void): void;
}

/** Where live updates are published (see `LiveUpdates`). */
export interface Publisher {
  publish(topic: string, event: LiveEvent): void;
}

/** A database whose transactions can publish live updates once committed, logging work after a commit that fails. */
export interface LiveDatabase {
  db: Database;
  live: Publisher;
  log: { error(obj: object, msg: string): void };
}

/** A transaction that can tell watchers of its changes, once they are committed. */
export interface PublishingTransaction extends Transaction {
  /** Publishes `event` on `topic` once the transaction has committed, never before (ADR 0012), and never if it rolls back. */
  publish(topic: string, event: LiveEvent): void;
}

/**
 * Runs `fn` in a transaction, committing on success and rolling back on error, then the work `fn`
 * registered with `afterCommit`. A connection Postgres drops meanwhile fails the transaction and is
 * discarded instead of going back to the pool. Given a `LiveDatabase`, `fn` can also `publish`.
 */
export function transaction<T>(db: Database, fn: (tx: Transaction) => Promise<T>): Promise<T>;
export function transaction<T>(on: LiveDatabase, fn: (tx: PublishingTransaction) => Promise<T>): Promise<T>;
export async function transaction<T>(on: Database | LiveDatabase, fn: (tx: PublishingTransaction) => Promise<T>): Promise<T> {
  const { db, live, log } = on instanceof pg.Pool ? { db: on, live: undefined, log: undefined } : on;
  const client = await db.connect();
  // The pool listens for a lost connection only while it is idle; the query running when it is lost fails instead.
  let lost: Error | undefined;
  const onError = (err: Error) => (lost = err);
  client.on("error", onError);
  const pending: (() => void)[] = [];
  const afterCommit = (work: () => void) => void pending.push(work);
  // The handle is the pooled connection itself, so what is added to it here is taken off again before it goes back to the pool.
  const tx = Object.assign(client, {
    afterCommit,
    publish: (topic: string, event: LiveEvent) => {
      if (!live) throw new Error("This transaction has nowhere to publish");
      afterCommit(() => live.publish(topic, event));
    },
  });
  let result: T;
  let committed = false;
  try {
    await client.query("BEGIN");
    result = await fn(tx);
    // Postgres answers COMMIT of a transaction an error aborted with ROLLBACK, failing nothing; the held work must not run then.
    committed = (await client.query("COMMIT")).command === "COMMIT";
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: Error) => (lost ??= rollbackErr));
    throw err;
  } finally {
    const added = client as unknown as Partial<PublishingTransaction>;
    delete added.afterCommit;
    delete added.publish;
    client.removeListener("error", onError);
    client.release(lost);
  }
  if (!committed) return result;
  for (const work of pending) {
    try {
      work();
    } catch (err) {
      if (log) log.error({ err }, "Work after a commit failed");
      else console.error("Work after a commit failed", err);
    }
  }
  return result;
}

/**
 * Runs `fn` in a read-only, repeatable-read transaction, so everything it reads is one consistent view of the database:
 * rows that change while it runs read as they were at its first read.
 */
export function readConsistently<T>(db: Database, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return transaction(db, async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return fn(tx);
  });
}

/** Takes a lock named `name` until the transaction ends, so work under the same name runs one at a time. */
export async function lockUntilCommit(tx: Queryable, name: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [name]);
}

// Arbitrary constant so concurrent starts against one database migrate one at a time.
const MIGRATION_LOCK = 0x63726f6e6b;

/** Applies every migration not yet recorded in `schema_migrations`. Safe to run on every start. */
export async function migrate(db: Database, migrations: Migration[] = allMigrations): Promise<void> {
  await transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await tx.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.id));
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      await tx.query(m.sql);
      await m.backfill?.(tx);
      await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    }
  });
}
