import { insertProtectionChange, protectionChangesToExport, setProtectedFlag, type ProtectableItem } from "../knowledge/protection.js";
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
  const changes = await protectionChangesToExport(ctx.db, item);
  return {
    protected: marked,
    protection:
      changes.length === 0
        ? undefined
        : changes.map((c) => ({ protected: c.protected, at: iso(c.at), by: ctx.actor({ actor_user_id: c.actor_user_id, actor_agent_id: null, actor_session_id: null }) })),
  };
}

/**
 * Marks an imported item as `data` says, with its history. `data` without `protected`, as written before
 * Protected marks were, leaves it as `unsaid` says: an accepted Decision is Protected by default.
 */
export async function importProtection(ctx: ImportContext, item: ProtectableItem, data: File["data"], where: string, unsaid = false): Promise<void> {
  const marked = data.protected ?? unsaid;
  if (typeof marked !== "boolean") refuse(`${where} protected must be true or false`);
  const changes = data.protection ?? [];
  if (!Array.isArray(changes) || !changes.every(isRecord)) refuse(`${where} protection must be a list`);
  for (const [i, change] of changes.entries()) {
    const at = `${where} protection[${i}]`;
    if (typeof change.protected !== "boolean") refuse(`${at} protected must be true or false`);
    const by = await ctx.actor(change.by, `${at} by`);
    if (by.kind !== "user") refuse(`${at} by must name a User: only Users mark items Protected`);
    await insertProtectionChange(ctx.db, item, { protected: change.protected, at: date(change.at, `${at} at`), userId: by.userId });
  }
  if (marked) await setProtectedFlag(ctx.db, item, true);
}
