import { PRIORITIES, RELATION_KINDS, STATUS_CATEGORIES } from "../../shared/values.js";
import { recordChange, type TicketChange } from "../work/tickets.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { date, isUuid, list, oneOf, refuse, text, type File } from "./fields.js";
import { CHANGE_FIELDS, isRecord } from "./format.js";
import type { ImportContext } from "./import-context.js";

/**
 * A Ticket's history: `<KEY>.history.md` beside it, its changes oldest first with the names
 * recorded at the time, plus what an import finds Users, Agents and Statuses by (see `CHANGE_FIELDS`).
 */

/** Writes the history of the Ticket `ticketId` at `${base}.history.md`; `statusNow` names its Project's Statuses by id. */
export async function exportHistory(ctx: ExportContext, base: string, ticketId: string, statusNow: Map<string, string>): Promise<void> {
  const { rows: changes } = await ctx.db.query<ActorColumns & { at: Date; change: TicketChange["change"]; data: Record<string, unknown> }>(
    "SELECT * FROM ticket_changes WHERE ticket_id = $1 ORDER BY id",
    [ticketId],
  );
  ctx.add(`${base}.history.md`, {
    changes: changes.map((c) => ({ at: iso(c.at), by: ctx.actor(c), change: c.change, ...changeToExport(c.change, c.data, ctx.emailOf, statusNow) })),
  });
}

/** A Ticket change's fields as the export writes them (see `CHANGE_FIELDS`): a User with their `email`, a Status with its `current` name. */
function changeToExport(
  change: TicketChange["change"],
  data: Record<string, unknown>,
  emailOf: Map<string, string>,
  statusNow: Map<string, string>,
): Record<string, unknown> {
  const written = { ...data };
  for (const [field, { holds }] of Object.entries(CHANGE_FIELDS[change])) {
    const ref = data[field];
    if (!isRecord(ref)) continue;
    if (holds === "user") written[field] = { ...ref, email: emailOf.get(String(ref.id)) };
    if (holds === "status") written[field] = { ...ref, current: statusNow.get(String(ref.id)) };
  }
  return written;
}

/** Finds a record in this installation by what an export names it by, if it is here. */
type Finder = (name: string) => Promise<string | undefined>;
interface Finders {
  user: Finder;
  agent: Finder;
  status: Finder;
}

/**
 * Imports the history `file` onto the Ticket `ticketId`, once every Ticket is in, naming records by
 * what this installation calls them; `statusIds` are its Project's Statuses by lower-case name.
 */
export async function importHistory(ctx: ImportContext, file: File, ticketId: string, statusIds: Map<string, string>): Promise<void> {
  const find: Finders = {
    user: (email) => ctx.findUser(email),
    agent: async (id) => ctx.agentIds.get(id)?.id,
    status: async (name) => statusIds.get(name.toLowerCase()),
  };
  for (const [i, entry] of list(file, "changes").entries()) {
    const where = `${file.path} changes[${i}]`;
    const { at, by, change, ...fields } = entry;
    const kind = oneOf(change, Object.keys(CHANGE_FIELDS) as TicketChange["change"][], `${where}.change`);
    const when = date(at, `${where}.at`);
    const actor = await ctx.actor(by, `${where}.by`);
    const recorded = await importedChange(kind, fields, find, where);
    await recordChange(ctx.db, ticketId, actor, when, { change: kind, ...recorded } as TicketChange);
  }
}

/**
 * A Ticket change's fields as Cronk records them, from those the export wrote (see `CHANGE_FIELDS`), refusing any
 * that isn't what its kind holds. Users, Agents and Statuses get the id they have here, keeping the names recorded
 * at the time; one with nothing here to map to keeps the id it was written with.
 */
async function importedChange(change: TicketChange["change"], fields: Record<string, unknown>, find: Finders, where: string): Promise<Record<string, unknown>> {
  const recorded: Record<string, unknown> = {};
  for (const [field, { holds, nullable }] of Object.entries(CHANGE_FIELDS[change])) {
    const value = fields[field];
    const at = `${where}.${field}`;
    if (nullable && value === null) recorded[field] = null;
    else if (holds === "title") recorded[field] = text(value, at);
    else if (holds === "text") recorded[field] = typeof value === "string" ? value : refuse(`${at} must be text`);
    else if (holds === "priority") recorded[field] = oneOf(value, PRIORITIES, at);
    else if (holds === "relation kind") recorded[field] = oneOf(value, RELATION_KINDS, at);
    else if (holds === "labels") {
      if (!Array.isArray(value) || !value.every((l) => typeof l === "string")) refuse(`${at} must be a list of text`);
      recorded[field] = value;
    } else {
      if (!isRecord(value)) refuse(`${at} must be a mapping${nullable ? " or null" : ""}`);
      if (holds === "ticket") recorded[field] = { key: text(value.key, `${at}.key`), title: text(value.title, `${at}.title`) };
      else {
        const foundBy = { user: value.email, agent: value.id, status: value.current }[holds];
        const id = (typeof foundBy === "string" ? await find[holds](foundBy) : undefined) ?? (isUuid(value.id) ? value.id : refuse(`${at} names no record here and has no id`));
        const named = { id, name: text(value.name, `${at}.name`) };
        recorded[field] = holds === "status" ? { ...named, category: oneOf(value.category, STATUS_CATEGORIES, `${at}.category`) } : named;
      }
    }
  }
  return recorded;
}
