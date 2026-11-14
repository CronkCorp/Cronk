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
  {
    id: "0002_projects_statuses_tickets",
    sql: `
      CREATE TABLE projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        name text NOT NULL,
        key text NOT NULL,
        archived_at timestamptz,
        -- The number the Project's next Ticket gets; taken and bumped in one UPDATE so keys never repeat.
        next_ticket_number integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX projects_key_unique ON projects (workspace_id, key);

      CREATE TABLE statuses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        category text NOT NULL CHECK (category IN ('backlog', 'unstarted', 'started', 'in_review', 'completed', 'canceled')),
        position integer NOT NULL
      );
      CREATE INDEX statuses_project ON statuses (project_id, position);

      CREATE TABLE tickets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number integer NOT NULL,
        title text NOT NULL,
        description text NOT NULL DEFAULT '',
        status_id uuid NOT NULL REFERENCES statuses(id),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (project_id, number)
      );

      -- A Ticket's history: one row per change, oldest first by id.
      -- Statuses are copied in (not referenced) so history survives renaming or removing them.
      CREATE TABLE ticket_changes (
        id bigserial PRIMARY KEY,
        ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        at timestamptz NOT NULL,
        actor_kind text NOT NULL CHECK (actor_kind IN ('user')),
        actor_user_id uuid REFERENCES users(id),
        change text NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX ticket_changes_ticket ON ticket_changes (ticket_id, id);
    `,
  },
  {
    id: "0003_ticket_fields_and_relations",
    sql: `
      ALTER TABLE tickets
        ADD COLUMN priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
        -- Free-form, in the order given; never two that differ only in case.
        ADD COLUMN labels text[] NOT NULL DEFAULT '{}';
    `,
  },
];
