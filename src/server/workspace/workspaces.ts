import type { Queryable } from "../db/database.js";

export interface Workspace {
  id: string;
  name: string;
}

export async function insertWorkspace(db: Queryable, input: { name: string; now: Date }): Promise<Workspace> {
  const { rows } = await db.query<Workspace>(
    "INSERT INTO workspaces (name, created_at) VALUES ($1, $2) RETURNING id, name",
    [input.name, input.now],
  );
  return rows[0]!;
}
