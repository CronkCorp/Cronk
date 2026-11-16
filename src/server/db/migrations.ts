import type { Queryable } from "./database.js";
import { backfillTicketMentions } from "../knowledge/ticket-mentions.js";
import { recordAllMentions } from "../knowledge/mentions.js";

/**
 * Schema migrations, applied in order on startup. Never edit or reorder a
 * migration once it has shipped; add a new one instead.
 */
export interface Migration {
  id: string;
  sql: string;
  /** Fills what the SQL created from existing data, when SQL alone can't, in the same transaction. */
  backfill?: (db: Queryable) => Promise<void>;
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
    id: "0004_ticket_fields_and_relations",
    sql: `
      ALTER TABLE tickets
        ADD COLUMN priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
        -- Free-form, in the order given; never two that differ only in case.
        ADD COLUMN labels text[] NOT NULL DEFAULT '{}',
        ADD COLUMN assignee_id uuid REFERENCES users(id),
        -- Set on a Sub-Ticket: its parent, always in the same Project.
        ADD COLUMN parent_id uuid REFERENCES tickets(id) ON DELETE SET NULL;
      CREATE INDEX tickets_parent ON tickets (parent_id);

      -- 'blocks' runs from the blocking Ticket to the blocked one and never forms a cycle.
      -- 'relates_to' reads the same both ways, so it is stored once with the lower id first.
      CREATE TABLE ticket_relations (
        kind text NOT NULL CHECK (kind IN ('blocks', 'relates_to')),
        from_ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        to_ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        PRIMARY KEY (kind, from_ticket_id, to_ticket_id),
        CHECK (from_ticket_id <> to_ticket_id),
        CHECK (kind <> 'relates_to' OR from_ticket_id < to_ticket_id)
      );
      CREATE INDEX ticket_relations_to ON ticket_relations (to_ticket_id);
      CREATE INDEX ticket_relations_from ON ticket_relations (from_ticket_id);
    `,
  },
  {
    id: "0005_status_names_unique",
    sql: `
      -- A Project's Statuses are told apart by name, so no two may share one, ignoring case.
      -- IF NOT EXISTS: this ran as 0004_status_names_unique on databases from the unmerged branch.
      CREATE UNIQUE INDEX IF NOT EXISTS statuses_name_unique ON statuses (project_id, lower(name));
    `,
  },
  {
    id: "0006_agents_tokens",
    sql: `
      -- IF NOT EXISTS / IF EXISTS: this ran as 0005_agents_tokens on databases from the unmerged branch.
      -- An Agent acts for exactly one User, its Owner (ADR 0001). A removed Agent keeps its row so history still names it.
      CREATE TABLE IF NOT EXISTS agents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        owner_id uuid NOT NULL REFERENCES users(id),
        name text NOT NULL,
        created_at timestamptz NOT NULL,
        removed_at timestamptz
      );
      -- An Owner's Agents have distinct names while they exist.
      CREATE UNIQUE INDEX IF NOT EXISTS agents_owner_name_unique ON agents (owner_id, lower(name)) WHERE removed_at IS NULL;

      -- A token an Agent calls the API with, full or read-only. Only its hash is stored; revoking deletes it.
      CREATE TABLE IF NOT EXISTS agent_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        read_only boolean NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_tokens_agent ON agent_tokens (agent_id);

      -- The most Agents may do in a Project, or in the Workspace outside any Project (ADR 0004).
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS agent_access text NOT NULL DEFAULT 'write' CHECK (agent_access IN ('none', 'read', 'write'));
      ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_access text NOT NULL DEFAULT 'write' CHECK (agent_access IN ('none', 'read', 'write'));

      -- A change an Agent made records the Agent; actor_user_id then holds its Owner.
      ALTER TABLE ticket_changes DROP CONSTRAINT IF EXISTS ticket_changes_actor_kind_check;
      ALTER TABLE ticket_changes ADD CONSTRAINT ticket_changes_actor_kind_check CHECK (actor_kind IN ('user', 'agent'));
      ALTER TABLE ticket_changes ADD COLUMN IF NOT EXISTS actor_agent_id uuid REFERENCES agents(id);
      ALTER TABLE ticket_changes DROP CONSTRAINT IF EXISTS ticket_changes_actor_agent;
      ALTER TABLE ticket_changes ADD CONSTRAINT ticket_changes_actor_agent CHECK ((actor_kind = 'agent') = (actor_agent_id IS NOT NULL));
    `,
  },
  {
    id: "0007_agent_sessions",
    sql: `
      -- How long an Agent Session may stay silent before it ends (and, later, its Claims lapse).
      ALTER TABLE workspaces ADD COLUMN silence_threshold_seconds integer NOT NULL DEFAULT 300 CHECK (silence_threshold_seconds > 0);

      -- One continuous connection of an Agent, over MCP. It is live until it is ended or stays
      -- silent longer than its Workspace's silence threshold; every call in it refreshes last_seen_at.
      CREATE TABLE agent_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id uuid NOT NULL REFERENCES agents(id),
        -- The token that started it; revoking the token ends the Session.
        token_id uuid REFERENCES agent_tokens(id) ON DELETE SET NULL,
        started_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL,
        ended_at timestamptz
      );
      CREATE INDEX agent_sessions_open ON agent_sessions (agent_id) WHERE ended_at IS NULL;

      -- A change an Agent made in an Agent Session records the Session too.
      ALTER TABLE ticket_changes ADD COLUMN actor_session_id uuid REFERENCES agent_sessions(id);
    `,
  },
  {
    id: "0008_documents_versions",
    sql: `
      -- A Document belongs to a Project, or to the Workspace when project_id is null, and sits in that
      -- container's page tree: under parent_id (null at the top), ordered among its siblings by position.
      -- title and body repeat its current Version, which is numbered version.
      CREATE TABLE documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
        parent_id uuid REFERENCES documents(id),
        position integer NOT NULL,
        title text NOT NULL,
        body text NOT NULL,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX documents_tree ON documents (workspace_id, project_id, parent_id, position);
      CREATE INDEX documents_parent ON documents (parent_id);

      -- Every saved state of a Document, numbered from 1 and never changed, with the Actor who saved it.
      -- restored_from names the Version a restore copied.
      CREATE TABLE document_versions (
        document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        number integer NOT NULL,
        title text NOT NULL,
        body text NOT NULL,
        at timestamptz NOT NULL,
        actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent')),
        actor_user_id uuid NOT NULL REFERENCES users(id),
        actor_agent_id uuid REFERENCES agents(id),
        actor_session_id uuid REFERENCES agent_sessions(id),
        restored_from integer,
        PRIMARY KEY (document_id, number),
        CHECK ((actor_kind = 'agent') = (actor_agent_id IS NOT NULL))
      );
    `,
  },
  {
    id: "0009_delegation_claims",
    sql: `
      -- IF NOT EXISTS: this ran as 0008_delegation_claims on databases from the unmerged branch.
      -- The Agent the Assignee handed the Ticket to: always one of the Assignee's own Agents (ADR 0001).
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS delegate_id uuid REFERENCES agents(id);
      CREATE INDEX IF NOT EXISTS tickets_delegate ON tickets (delegate_id) WHERE delegate_id IS NOT NULL;

      -- The Agent Session holding the Ticket's Claim. Being one column, a Ticket has at most one Claim;
      -- it is live while that Session is (see coordination/claims.ts) and lapses with it.
      ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS claim_session_id uuid REFERENCES agent_sessions(id),
        ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
    `,
  },
  {
    id: "0010_guidance",
    sql: `
      -- IF NOT EXISTS: this ran as 0008_guidance on databases from the unmerged branch.
      -- Guidance: standing instructions Users write for Agents, for the Workspace (project_id NULL)
      -- or one Project. Each save is a new Version, numbered from 1; the highest is current.
      CREATE TABLE IF NOT EXISTS guidance_versions (
        id bigserial PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
        version integer NOT NULL CHECK (version > 0),
        markdown text NOT NULL,
        at timestamptz NOT NULL,
        actor_user_id uuid NOT NULL REFERENCES users(id)
      );
      -- Two saves based on the same Version can't both become the next one.
      CREATE UNIQUE INDEX IF NOT EXISTS guidance_versions_unique ON guidance_versions (workspace_id, project_id, version) NULLS NOT DISTINCT;
    `,
  },
  {
    id: "0011_activities",
    sql: `
      -- One timestamped entry an Agent Session writes on a Ticket while holding its Claim. Only a
      -- question may be blocking. actor_user_id is the Agent's Owner, as history records it.
      CREATE TABLE activities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq bigserial NOT NULL,
        ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('plan', 'progress', 'finding', 'question', 'error')),
        body text NOT NULL,
        blocking boolean NOT NULL DEFAULT false CHECK (NOT blocking OR kind = 'question'),
        at timestamptz NOT NULL,
        actor_user_id uuid NOT NULL REFERENCES users(id),
        actor_agent_id uuid NOT NULL REFERENCES agents(id),
        actor_session_id uuid NOT NULL REFERENCES agent_sessions(id)
      );
      CREATE INDEX activities_ticket ON activities (ticket_id, seq);
    `,
  },
  {
    id: "0012_reports",
    sql: `
      -- Each Claim gets its own id when it is taken, so a Report can say which Claim it was written in;
      -- releasing and Claiming again starts a new Claim even within the same Agent Session.
      ALTER TABLE tickets ADD COLUMN claim_id uuid;
      UPDATE tickets SET claim_id = gen_random_uuid() WHERE claim_session_id IS NOT NULL;

      -- A Report is a Document on a Ticket, written in one of its Claims (claim_id), and kept out of the
      -- page tree: it has no parent and nothing sits under it.
      ALTER TABLE documents
        ADD COLUMN ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
        ADD COLUMN claim_id uuid,
        ADD CONSTRAINT documents_report_outside_tree CHECK (ticket_id IS NULL OR (parent_id IS NULL AND claim_id IS NOT NULL));
      CREATE INDEX documents_ticket ON documents (ticket_id, created_at) WHERE ticket_id IS NOT NULL;
    `,
  },
  {
    id: "0013_comments",
    sql: `
      -- A message any Actor posts on a Ticket or a Document: on exactly one of them. It may reply to
      -- another Comment on the same Ticket or Document, or to an Activity on the same Ticket.
      -- actor_user_id is the Agent's Owner when an Agent posted it, as history records it.
      CREATE TABLE comments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq bigserial NOT NULL,
        ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
        document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
        reply_to_comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
        reply_to_activity_id uuid REFERENCES activities(id) ON DELETE CASCADE,
        -- A Comment on a Document may anchor to a passage: text the Document held at Version anchor_version.
        -- It stays anchored while the Document's current Version still holds the passage.
        anchor_passage text,
        anchor_version integer,
        body text NOT NULL,
        at timestamptz NOT NULL,
        actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent')),
        actor_user_id uuid NOT NULL REFERENCES users(id),
        actor_agent_id uuid REFERENCES agents(id),
        actor_session_id uuid REFERENCES agent_sessions(id),
        CHECK ((ticket_id IS NULL) <> (document_id IS NULL)),
        CHECK (reply_to_comment_id IS NULL OR reply_to_activity_id IS NULL),
        CHECK (reply_to_activity_id IS NULL OR ticket_id IS NOT NULL),
        CHECK ((anchor_passage IS NULL) = (anchor_version IS NULL)),
        CHECK (anchor_passage IS NULL OR document_id IS NOT NULL),
        CHECK ((actor_kind = 'agent') = (actor_agent_id IS NOT NULL))
      );
      CREATE INDEX comments_ticket ON comments (ticket_id, seq) WHERE ticket_id IS NOT NULL;
      CREATE INDEX comments_document ON comments (document_id, seq) WHERE document_id IS NOT NULL;

      -- The Comment that answered a question: the first reply to it from a User.
      ALTER TABLE activities ADD COLUMN answer_comment_id uuid REFERENCES comments(id) ON DELETE SET NULL
        CHECK (answer_comment_id IS NULL OR kind = 'question');

      -- A Comment waiting for an Agent it concerns (ADR 0005): it answers the Agent's question, @mentions
      -- it, or is on a Ticket delegated to it. The welcome of the Agent's next Agent Session takes it.
      CREATE TABLE waiting_work (
        seq bigserial PRIMARY KEY,
        agent_id uuid NOT NULL REFERENCES agents(id),
        comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        reason text NOT NULL CHECK (reason IN ('answer', 'mention', 'comment')),
        at timestamptz NOT NULL,
        taken_at timestamptz,
        taken_by_session_id uuid REFERENCES agent_sessions(id),
        UNIQUE (agent_id, comment_id)
      );
      CREATE INDEX waiting_work_waiting ON waiting_work (agent_id, seq) WHERE taken_at IS NULL;
    `,
  },
  {
    id: "0014_search",
    sql: `
      -- Full-text search (search/search.ts) matches these exact expressions, so keep the two in step.
      CREATE INDEX tickets_search ON tickets USING gin (to_tsvector('english', title || ' ' || description));
      CREATE INDEX documents_search ON documents USING gin (to_tsvector('english', title || ' ' || body));
      CREATE INDEX comments_search ON comments USING gin (to_tsvector('english', body));
    `,
  },
  {
    id: "0015_document_ticket_mentions",
    sql: `
      -- The Ticket keys each Document's current Version mentions (knowledge/ticket-mentions.ts), rewritten
      -- on every change to it, so a Ticket finds the Documents that mention it without reading them all.
      -- Keys stay as written, so a mention counts once a Ticket with that key exists.
      CREATE TABLE document_ticket_mentions (
        document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ticket_key text NOT NULL,
        PRIMARY KEY (document_id, ticket_key)
      );
      CREATE INDEX document_ticket_mentions_key ON document_ticket_mentions (ticket_key);
    `,
    backfill: backfillTicketMentions,
  },
  {
    id: "0016_ticket_document_links",
    sql: `
      -- A Document a User or Agent linked to a Ticket from the Ticket's side (work/document-links.ts),
      -- listed among the Ticket's Documents beside its Reports and the Documents that mention it.
      -- Who linked it, and when, is in the Ticket's history; seq keeps the links in the order made.
      CREATE TABLE ticket_document_links (
        ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        seq bigserial NOT NULL,
        PRIMARY KEY (ticket_id, document_id)
      );
      CREATE INDEX ticket_document_links_document ON ticket_document_links (document_id);
    `,
  },
  {
    id: "0017_send_back_comments",
    sql: `
      -- The Comment a User sent a Ticket back from review with (the send-back route), so the Ticket's
      -- timeline can label it without pairing it with the Status Change by time.
      ALTER TABLE comments ADD COLUMN send_back boolean NOT NULL DEFAULT false CHECK (NOT send_back OR ticket_id IS NOT NULL);
    `,
  },
  {
    id: "0018_assign_delegated_tickets",
    sql: `
      -- Cronk itself may record a Ticket change, as this upgrade does: a 'system' change has no acting User.
      ALTER TABLE ticket_changes DROP CONSTRAINT IF EXISTS ticket_changes_actor_kind_check;
      ALTER TABLE ticket_changes ADD CONSTRAINT ticket_changes_actor_kind_check CHECK (actor_kind IN ('user', 'agent', 'system'));
      ALTER TABLE ticket_changes DROP CONSTRAINT IF EXISTS ticket_changes_actor_user;
      ALTER TABLE ticket_changes ADD CONSTRAINT ticket_changes_actor_user CHECK ((actor_kind = 'system') = (actor_user_id IS NULL));

      -- Delegated work always has a clear User: each delegated Ticket without an Assignee goes to its Delegate's Owner.
      CREATE TEMPORARY TABLE assigned_on_upgrade ON COMMIT DROP AS
        SELECT t.id AS ticket_id, u.id AS user_id, u.name AS user_name
        FROM tickets t JOIN agents a ON a.id = t.delegate_id JOIN users u ON u.id = a.owner_id
        WHERE t.assignee_id IS NULL;
      UPDATE tickets t SET assignee_id = x.user_id, updated_at = now() FROM assigned_on_upgrade x WHERE t.id = x.ticket_id;
      INSERT INTO ticket_changes (ticket_id, at, actor_kind, change, data)
        SELECT ticket_id, now(), 'system', 'assignee', jsonb_build_object('from', NULL, 'to', jsonb_build_object('id', user_id, 'name', user_name))
        FROM assigned_on_upgrade ORDER BY ticket_id;
    `,
  },
  {
    id: "0019_password_resets",
    sql: `
      -- A one-time link letting a User choose a new password (identity/password-resets.ts), issued by an Admin
      -- or, with no issuer, by the server command. Only the token's hash is stored; issuing again replaces it.
      CREATE TABLE password_resets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        issued_by uuid REFERENCES users(id),
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL
      );
    `,
  },
  {
    id: "0020_renamed_ids",
    sql: `
      -- An Agent or Agent Session an import (portability/people.ts) couldn't give the id it had in the
      -- export, because the id was taken here: the id it had there and the one it got. Transcripts name
      -- Agent Sessions by id, so linking one written before the import looks its ids up here too.
      -- from_id is text: an export edited by hand may name them by anything.
      CREATE TABLE renamed_ids (
        seq bigserial PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        kind text NOT NULL CHECK (kind IN ('agent', 'agent_session')),
        from_id text NOT NULL,
        to_id uuid NOT NULL,
        at timestamptz NOT NULL
      );
      CREATE INDEX renamed_ids_from ON renamed_ids (workspace_id, from_id);
    `,
  },
  {
    id: "0021_terms",
    sql: `
      -- Terms (knowledge/terms.ts): the glossary of the Workspace (project_id NULL) or a Project. Names
      -- are unique per place ignoring case, so a Project Term overrides the Workspace Term of the same name.
      CREATE TABLE terms (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        definition text NOT NULL,
        avoid text[] NOT NULL,
        group_name text,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX terms_name ON terms (workspace_id, project_id, lower(name)) NULLS NOT DISTINCT;
      CREATE INDEX terms_lower_name ON terms (workspace_id, lower(name));

      -- Every saved state of a Term, with the Actor who saved it.
      CREATE TABLE term_versions (
        term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        number integer NOT NULL,
        name text NOT NULL,
        definition text NOT NULL,
        avoid text[] NOT NULL,
        group_name text,
        at timestamptz NOT NULL,
        actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent')),
        actor_user_id uuid NOT NULL REFERENCES users(id),
        actor_agent_id uuid REFERENCES agents(id),
        actor_session_id uuid REFERENCES agent_sessions(id),
        PRIMARY KEY (term_id, number),
        CHECK ((actor_kind = 'agent') = (actor_agent_id IS NOT NULL))
      );
    `,
  },
  {
    id: "0022_decisions",
    sql: `
      -- The number the next Decision of a Project, or of the Workspace outside any Project, gets;
      -- taken and bumped in one UPDATE so numbers never repeat.
      ALTER TABLE projects ADD COLUMN next_decision_number integer NOT NULL DEFAULT 1;
      ALTER TABLE workspaces ADD COLUMN next_decision_number integer NOT NULL DEFAULT 1;

      -- A Decision belongs to a Project, or to the Workspace when project_id is null, and is numbered in
      -- order within it. title, body, status, group_name and supersedes repeat its current Version.
      -- supersedes and superseded_by name other Decisions of the same Project (or the Workspace) by number.
      CREATE TABLE decisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
        number integer NOT NULL CHECK (number > 0),
        title text NOT NULL,
        body text NOT NULL,
        status text NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'deprecated', 'superseded')),
        group_name text,
        supersedes integer[] NOT NULL DEFAULT '{}',
        superseded_by integer,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX decisions_number_unique ON decisions (workspace_id, project_id, number) NULLS NOT DISTINCT;

      -- Every saved state of a Decision, numbered from 1 and never changed, with the Actor who saved it:
      -- an edit, or a change of status.
      CREATE TABLE decision_versions (
        decision_id uuid NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        number integer NOT NULL,
        title text NOT NULL,
        body text NOT NULL,
        status text NOT NULL,
        group_name text,
        supersedes integer[] NOT NULL,
        at timestamptz NOT NULL,
        actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent')),
        actor_user_id uuid NOT NULL REFERENCES users(id),
        actor_agent_id uuid REFERENCES agents(id),
        actor_session_id uuid REFERENCES agent_sessions(id),
        PRIMARY KEY (decision_id, number),
        CHECK ((actor_kind = 'agent') = (actor_agent_id IS NOT NULL))
      );
    `,
  },
  {
    id: "0023_autonomous_delegation",
    sql: `
      -- Autonomous Delegation (work/routes.ts): whether the Delegate may complete the Ticket itself. Only Users set it.
      ALTER TABLE tickets ADD COLUMN autonomous boolean NOT NULL DEFAULT false;
      -- What delegating one of the Project's Tickets sets Autonomous Delegation to, unless the User says otherwise.
      ALTER TABLE projects ADD COLUMN autonomous_by_default boolean NOT NULL DEFAULT false;
      -- Verification of an Agent's completion: Unverified until a User Accepts it (Verified). Null for any other Ticket.
      ALTER TABLE tickets ADD COLUMN verification text CHECK (verification IN ('unverified', 'verified'));
    `,
  },
  {
    id: "0024_attachments",
    sql: `
      -- A file attached to a Ticket (files/attachments.ts). Its bytes live in the file store under
      -- attachments/<id>; the row is what Cronk knows of it. It is readable by whoever can read its Ticket.
      CREATE TABLE attachments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq bigserial NOT NULL,
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        name text NOT NULL CHECK (name <> ''),
        content_type text NOT NULL,
        size bigint NOT NULL CHECK (size >= 0),
        at timestamptz NOT NULL,
        actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent')),
        actor_user_id uuid NOT NULL REFERENCES users(id),
        actor_agent_id uuid REFERENCES agents(id),
        actor_session_id uuid REFERENCES agent_sessions(id),
        CHECK ((actor_kind = 'agent') = (actor_agent_id IS NOT NULL))
      );
      CREATE INDEX attachments_ticket ON attachments (ticket_id, seq);
      CREATE INDEX attachments_workspace ON attachments (workspace_id);

      -- The largest file an Attachment may be: 100 MB unless an Admin changes it.
      ALTER TABLE workspaces ADD COLUMN attachment_max_bytes bigint NOT NULL DEFAULT 104857600 CHECK (attachment_max_bytes > 0);
    `,
  },
  {
    id: "0025_transcripts",
    sql: `
      -- The most a Transcript may hold, all its texts together, in bytes: 10 MB unless an Admin changes it.
      ALTER TABLE workspaces ADD COLUMN transcript_max_bytes integer NOT NULL DEFAULT 10485760 CHECK (transcript_max_bytes > 0);

      -- The verbatim chat behind an Agent's changes (transcripts/transcripts.ts), one per Agent and client chat id. markdown is
      -- the latest upload's text; earlier holds, oldest first, texts a later upload didn't continue. Its Owner is its Agent's.
      CREATE TABLE transcripts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        agent_id uuid NOT NULL REFERENCES agents(id),
        chat_id text NOT NULL,
        markdown text NOT NULL,
        earlier text[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (agent_id, chat_id)
      );

      -- The uploading Agent's Agent Sessions a Transcript names, and so everything they changed. Links only grow.
      CREATE TABLE transcript_sessions (
        transcript_id uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
        session_id uuid NOT NULL REFERENCES agent_sessions(id),
        PRIMARY KEY (transcript_id, session_id)
      );
      CREATE INDEX transcript_sessions_session ON transcript_sessions (session_id);
    `,
  },
  {
    id: "0026_mentions",
    sql: `
      -- What mentions each Decision and Term (knowledge/mentions.ts): the Ticket, Document, Comment, Term or
      -- Decision whose current text names a Decision's key (kept as written, so a mention counts once a Decision
      -- with that key exists) or a Term's name (the Term it names where the text lies). Rewritten on every change
      -- to the text, and for every text naming a Term's name when a Term takes or gives up that name.
      CREATE TABLE mentions (
        ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
        document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
        comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
        term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
        decision_id uuid REFERENCES decisions(id) ON DELETE CASCADE,
        decision_key text,
        mentioned_term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
        CHECK (num_nonnulls(ticket_id, document_id, comment_id, term_id, decision_id) = 1),
        CHECK (num_nonnulls(decision_key, mentioned_term_id) = 1)
      );
      CREATE INDEX mentions_decision_key ON mentions (decision_key);
      CREATE INDEX mentions_mentioned_term ON mentions (mentioned_term_id);
      CREATE INDEX mentions_ticket ON mentions (ticket_id);
      CREATE INDEX mentions_document ON mentions (document_id);
      CREATE INDEX mentions_comment ON mentions (comment_id);
      CREATE INDEX mentions_term ON mentions (term_id);
      CREATE INDEX mentions_decision ON mentions (decision_id);
    `,
    backfill: (db) => recordAllMentions(db),
  },
  {
    id: "0027_proposed_decisions",
    sql: `
      -- Why a Decision took its status, as the User gave it; required when rejecting one. Null otherwise.
      ALTER TABLE decisions ADD COLUMN status_reason text;
      ALTER TABLE decision_versions ADD COLUMN status_reason text;
      -- An Agent's proposed Decision: the Ticket whose Claim its Agent Session held when proposing it, and that
      -- Claim's id (see tickets.claim_id), which a Report written in the same Claim lists it by. Null otherwise.
      ALTER TABLE decisions ADD COLUMN source_ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL;
      ALTER TABLE decisions ADD COLUMN source_claim_id uuid;
      CREATE INDEX decisions_source_claim ON decisions (source_claim_id) WHERE source_claim_id IS NOT NULL;
      -- Waiting Work is also a rejection of a Decision the Agent proposed: the Version that rejected it, with its reason.
      ALTER TABLE waiting_work ALTER COLUMN comment_id DROP NOT NULL;
      ALTER TABLE waiting_work ADD COLUMN decision_id uuid REFERENCES decisions(id) ON DELETE CASCADE;
      ALTER TABLE waiting_work ADD COLUMN decision_version integer;
      ALTER TABLE waiting_work DROP CONSTRAINT waiting_work_reason_check;
      ALTER TABLE waiting_work ADD CONSTRAINT waiting_work_reason_check CHECK (reason IN ('answer', 'mention', 'comment', 'rejected'));
      ALTER TABLE waiting_work ADD CONSTRAINT waiting_work_on_one CHECK (
        (comment_id IS NULL) = (reason = 'rejected') AND (decision_id IS NULL) = (reason <> 'rejected') AND (decision_version IS NULL) = (decision_id IS NULL));
      ALTER TABLE waiting_work ADD UNIQUE (agent_id, decision_id, decision_version);
    `,
  },
  {
    id: "0028_protected",
    sql: `
      -- Protected (ADR 0004): Agents may read the item but never change it. Only Users set or unset the mark.
      -- A Document's mark also covers every Document under it in the page tree, worked out when read.
      ALTER TABLE documents ADD COLUMN protected boolean NOT NULL DEFAULT false;
      ALTER TABLE terms ADD COLUMN protected boolean NOT NULL DEFAULT false;
      ALTER TABLE decisions ADD COLUMN protected boolean NOT NULL DEFAULT false;

      -- Every time a User marked or unmarked an item, its protection history. Exactly one item column is set.
      CREATE TABLE protection_markings (
        id bigserial PRIMARY KEY,
        document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
        term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
        decision_id uuid REFERENCES decisions(id) ON DELETE CASCADE,
        protected boolean NOT NULL,
        at timestamptz NOT NULL,
        actor_user_id uuid NOT NULL REFERENCES users(id),
        CHECK (num_nonnulls(document_id, term_id, decision_id) = 1)
      );
      CREATE INDEX protection_markings_document ON protection_markings (document_id) WHERE document_id IS NOT NULL;
      CREATE INDEX protection_markings_term ON protection_markings (term_id) WHERE term_id IS NOT NULL;
      CREATE INDEX protection_markings_decision ON protection_markings (decision_id) WHERE decision_id IS NOT NULL;

      -- Accepted Decisions are Protected by default: mark those already accepted, as by the User who accepted them, then.
      INSERT INTO protection_markings (decision_id, protected, at, actor_user_id)
      SELECT d.id, true, v.at, v.actor_user_id
      FROM decisions d JOIN decision_versions v ON v.decision_id = d.id
      WHERE d.status = 'accepted'
        AND v.number = (SELECT coalesce(max(number), 0) + 1 FROM decision_versions WHERE decision_id = d.id AND status <> 'accepted');
      UPDATE decisions SET protected = true WHERE status = 'accepted';
    `,
  },
];
