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

export async function getWorkspace(db: Queryable, id: string): Promise<Workspace> {
  const { rows } = await db.query<Workspace>("SELECT id, name FROM workspaces WHERE id = $1", [id]);
  return rows[0]!;
}

export async function renameWorkspace(db: Queryable, id: string, name: string): Promise<Workspace> {
  const { rows } = await db.query<Workspace>("UPDATE workspaces SET name = $2 WHERE id = $1 RETURNING id, name", [id, name]);
  return rows[0]!;
}
