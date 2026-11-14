/**
 * Schema migrations, applied in order on startup. Never edit or reorder a
 * migration once it has shipped; add a new one instead.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: "0001_workspace_users_sign_ins",
    sql: `
      CREATE TABLE workspaces (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        created_at timestamptz NOT NULL
      );

      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        email text NOT NULL,
        name text NOT NULL,
        password_hash text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin', 'member')),
        created_at timestamptz NOT NULL
      );
      -- Email identifies a User across the installation: sign-in has no Workspace to scope by (ADR 0008).
      CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

      CREATE TABLE sign_ins (
        token_hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX sign_ins_user ON sign_ins (user_id);
    `,
  },
];
