import { insertProtectionMarking, PROTECTION_COLUMN, setProtectedFlag, type ProtectableItem } from "../knowledge/protection.js";
import { iso, type ExportContext } from "./export-context.js";
import { date, refuse, type File } from "./fields.js";
import { isRecord } from "./format.js";
import type { ImportContext } from "./import-context.js";

/**
 * Protected marks, in the frontmatter of the item they belong to: `protected`, whether it is marked now,
 * and `protection`, each time a User marked or unmarked it, oldest first, left out when there are none.
 */

/** The frontmatter fields of an item's Protected mark and its history. */
export async function protectionToExport(ctx: ExportContext, item: ProtectableItem, marked: boolean) {
  const { rows: markings } = await ctx.db.query<{ protected: boolean; at: Date; actor_user_id: string }>(
    `SELECT protected, at, actor_user_id FROM protection_markings WHERE ${PROTECTION_COLUMN[item.kind]} = $1 ORDER BY id`,
    [item.id],
  );
  return {
    protected: marked,
    protection:
      markings.length === 0
        ? undefined
        : markings.map((c) => ({ protected: c.protected, at: iso(c.at), by: ctx.actor({ actor_user_id: c.actor_user_id, actor_agent_id: null, actor_session_id: null }) })),
  };
}

/**
 * Marks an imported item as `data` says, with its history. `data` without `protected`, as written before
 * Protected marks were, leaves it marked as `markedByDefault` says: an accepted Decision is Protected by default.
 */
export async function importProtection(ctx: ImportContext, item: ProtectableItem, data: File["data"], where: string, markedByDefault = false): Promise<void> {
  const marked = data.protected ?? markedByDefault;
  if (typeof marked !== "boolean") refuse(`${where} protected must be true or false`);
  const markings = data.protection ?? [];
  if (!Array.isArray(markings) || !markings.every(isRecord)) refuse(`${where} protection must be a list`);
  for (const [i, marking] of markings.entries()) {
    const at = `${where} protection[${i}]`;
    if (typeof marking.protected !== "boolean") refuse(`${at} protected must be true or false`);
    const by = await ctx.actor(marking.by, `${at} by`);
    if (by.kind !== "user") refuse(`${at} by must name a User: only Users mark items Protected`);
    await insertProtectionMarking(ctx.db, item, { protected: marking.protected, at: date(marking.at, `${at} at`), userId: by.userId });
  }
  if (marked) await setProtectedFlag(ctx.db, item, true);
}
