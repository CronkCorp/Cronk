import { insertAgent } from "../identity/agents.js";
import { insertUserWithoutPassword } from "../identity/users.js";
import { roleSchema } from "../schemas.js";
import { iso, type ExportContext } from "./export-context.js";
import { date, list, oneOf, optionalDate, refuse, text, type File } from "./fields.js";
import type { ImportContext } from "./import-context.js";

/**
 * `people.md`: the Users (by email) and Agents (by id) the other files name, and the Agent
 * Sessions Agents worked in. Importing matches Users by email and Agents by Owner and name.
 */

/**
 * Writes `people.md`, after every other file: every User and Agent of a Workspace export, only
 * those the files name in a Project export, and the Agent Sessions the files name.
 */
export async function exportPeople(ctx: ExportContext): Promise<void> {
  const whole = ctx.scope.projectId === null;
  const { rows: agents } = await ctx.db.query<{ id: string; name: string; owner_id: string; created_at: Date; removed_at: Date | null }>(
    "SELECT * FROM agents WHERE workspace_id = $1 ORDER BY created_at, id",
    [ctx.scope.workspaceId],
  );
  const exportedAgents = agents.filter((a) => whole || ctx.usedAgents.has(a.id));
  for (const a of exportedAgents) ctx.usedUsers.add(a.owner_id);
  const { rows: sessions } = await ctx.db.query<{ id: string; agent_id: string; started_at: Date; last_seen_at: Date; ended_at: Date | null }>(
    "SELECT * FROM agent_sessions WHERE id = ANY($1::uuid[]) ORDER BY started_at, id",
    [[...ctx.usedSessions]],
  );
  ctx.add(
    "people.md",
    {
      users: ctx.users
        .filter((u) => whole || ctx.usedUsers.has(u.id))
        .map((u) => ({ email: u.email, name: u.name, role: u.role, active: u.deactivated_at === null })),
      agents: exportedAgents.map((a) => ({ id: a.id, name: a.name, owner: ctx.emailOf.get(a.owner_id), createdAt: iso(a.created_at), removedAt: iso(a.removed_at) })),
      sessions: sessions.map((s) => ({ id: s.id, agent: s.agent_id, startedAt: iso(s.started_at), lastSeenAt: iso(s.last_seen_at), endedAt: iso(s.ended_at) })),
    },
    "The Users and Agents this export names. Files name a User by email, and an Agent and its Agent Sessions by the ids listed here.\n",
  );
}

/** Imports `people.md`, filling `ctx`'s maps so the other files can name who they list. */
export async function importPeople(ctx: ImportContext): Promise<void> {
  const people = ctx.need("people.md");
  await importUsers(ctx, people);
  await importAgents(ctx, people);
  await importSessions(ctx, people);
}

/** Users already here by email are used as they are; the rest come in deactivated, with no password until they accept an invitation. */
async function importUsers(ctx: ImportContext, people: File): Promise<void> {
  for (const [i, u] of list(people, "users").entries()) {
    const where = `people.md users[${i}]`;
    const email = text(u.email, `${where}.email`);
    const { rows } = await ctx.db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM users WHERE lower(email) = lower($1)", [email]);
    if (rows[0] && rows[0].workspace_id !== ctx.workspaceId) refuse(`${email} is a User of another Workspace`);
    // With no password, the User can't sign in until they accept an invitation.
    const id =
      rows[0]?.id ??
      (
        await insertUserWithoutPassword(ctx.db, {
          workspaceId: ctx.workspaceId,
          email,
          name: text(u.name, `${where}.name`),
          role: oneOf(u.role, roleSchema.enum, `${where}.role`),
          now: ctx.now,
        })
      ).id;
    ctx.userIds.set(email.toLowerCase(), id);
  }
}

/** An Agent its Owner already has by that name is used as it is, unless the export's was removed. */
async function importAgents(ctx: ImportContext, people: File): Promise<void> {
  for (const [i, a] of list(people, "agents").entries()) {
    const where = `people.md agents[${i}]`;
    const ownerId = await ctx.userId(a.owner, `${where}.owner`);
    const name = text(a.name, `${where}.name`);
    const removedAt = optionalDate(a.removedAt, `${where}.removedAt`);
    const { rows: existing } =
      removedAt === null
        ? await ctx.db.query<{ id: string }>("SELECT id FROM agents WHERE owner_id = $1 AND lower(name) = lower($2) AND removed_at IS NULL", [ownerId, name])
        : { rows: [] };
    const exportedId = text(a.id, `${where}.id`);
    const id =
      existing[0]?.id ??
      (
        await insertAgent(ctx.db, {
          owner: { id: ownerId, workspaceId: ctx.workspaceId },
          name,
          now: date(a.createdAt, `${where}.createdAt`),
          removedAt,
          id: await freeId(ctx, "agents", exportedId),
        })
      ).id;
    ctx.agentIds.set(exportedId, { id, ownerId });
    await ctx.renamed("agent", exportedId, id);
  }
}

/** An Agent Session live at export has no connection here, so it ends when it was last seen. */
async function importSessions(ctx: ImportContext, people: File): Promise<void> {
  for (const [i, s] of list(people, "sessions").entries()) {
    const where = `people.md sessions[${i}]`;
    const lastSeenAt = date(s.lastSeenAt, `${where}.lastSeenAt`);
    const exportedId = text(s.id, `${where}.id`);
    const { rows } = await ctx.db.query<{ id: string }>(
      "INSERT INTO agent_sessions (id, agent_id, started_at, last_seen_at, ended_at) VALUES (COALESCE($5, gen_random_uuid()), $1, $2, $3, $4) RETURNING id",
      [
        ctx.agent(s.agent, `${where}.agent`).id,
        date(s.startedAt, `${where}.startedAt`),
        lastSeenAt,
        optionalDate(s.endedAt, `${where}.endedAt`) ?? lastSeenAt,
        await freeId(ctx, "agent_sessions", exportedId),
      ],
    );
    ctx.sessionIds.set(exportedId, rows[0]!.id);
    await ctx.renamed("agentSession", exportedId, rows[0]!.id);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `id`, the id an Agent or Agent Session had in the export, if it can keep it here: no row of `table` has it yet. */
async function freeId(ctx: ImportContext, table: "agents" | "agent_sessions", id: string): Promise<string | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await ctx.db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return rows.length === 0 ? id : undefined;
}
