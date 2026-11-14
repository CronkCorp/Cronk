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
    id: "0003_invitations_access",
    sql: `
      -- An Admin's invitation for someone to join the Workspace. Only the token's hash is stored.
      CREATE TABLE invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        email text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin', 'member')),
        token_hash text NOT NULL UNIQUE,
        invited_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL
      );
      -- One pending invitation per email; inviting again replaces it.
      CREATE UNIQUE INDEX invitations_email_unique ON invitations (lower(email));

      -- A deactivated User can't sign in; their history stays.
      ALTER TABLE users ADD COLUMN deactivated_at timestamptz;

      -- Open Projects are open to every Member; private ones only to those listed in project_members.
      ALTER TABLE projects ADD COLUMN visibility text NOT NULL DEFAULT 'open' CHECK (visibility IN ('open', 'private'));

      -- A Member's access in a Project: who may enter a private Project, and Read or Write in any Project.
      CREATE TABLE project_members (
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        access text NOT NULL CHECK (access IN ('read', 'write')),
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX project_members_user ON project_members (user_id);
    `,
  },
  {
    id: "0004_agents_tokens",
    sql: `
      -- An Agent acts for exactly one User, its Owner (ADR 0001). A removed Agent keeps its row so history still names it.
      CREATE TABLE agents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        owner_id uuid NOT NULL REFERENCES users(id),
        name text NOT NULL,
        created_at timestamptz NOT NULL,
        removed_at timestamptz
      );
      -- An Owner's Agents have distinct names while they exist.
      CREATE UNIQUE INDEX agents_owner_name_unique ON agents (owner_id, lower(name)) WHERE removed_at IS NULL;

      -- A token an Agent calls the API with, full or read-only. Only its hash is stored; revoking deletes it.
      CREATE TABLE agent_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        read_only boolean NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX agent_tokens_agent ON agent_tokens (agent_id);

      -- The most Agents may do in a Project, or in the Workspace outside any Project (ADR 0004).
      ALTER TABLE projects ADD COLUMN agent_access text NOT NULL DEFAULT 'write' CHECK (agent_access IN ('none', 'read', 'write'));
      ALTER TABLE workspaces ADD COLUMN agent_access text NOT NULL DEFAULT 'write' CHECK (agent_access IN ('none', 'read', 'write'));

      -- A change an Agent made records the Agent; actor_user_id then holds its Owner.
      ALTER TABLE ticket_changes DROP CONSTRAINT ticket_changes_actor_kind_check;
      ALTER TABLE ticket_changes ADD CONSTRAINT ticket_changes_actor_kind_check CHECK (actor_kind IN ('user', 'agent'));
      ALTER TABLE ticket_changes ADD COLUMN actor_agent_id uuid REFERENCES agents(id);
      ALTER TABLE ticket_changes ADD CONSTRAINT ticket_changes_actor_agent CHECK ((actor_kind = 'agent') = (actor_agent_id IS NOT NULL));
    `,
  },
];
