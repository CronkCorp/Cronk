import pg from "pg";
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
export function createDatabase(databaseUrl: string, onIdleError: (err: Error) => void = () => {}): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  pool.on("error", onIdleError);
  return pool;
}

/** Runs `fn` in a transaction, committing on success and rolling back on error. */
export async function transaction<T>(db: Database, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
      await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    }
  });
}
