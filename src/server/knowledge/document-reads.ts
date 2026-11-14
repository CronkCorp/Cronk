import { actingUser, type Actor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { requireProjectAccess, requireWorkspaceAccess, type Access } from "../identity/access.js";
import { findProjectById } from "../work/projects.js";
import { findDocument, type Document } from "./documents.js";

/**
 * The Document with this id, if `actor` has at least `need` where it belongs: in its
 * Project (one they can't see answers 404, as if the Document didn't exist), or in the
 * Workspace for a Workspace Document.
 */
export async function documentFor(db: Queryable, actor: Actor, id: string, need: Access, opts: { forUpdate?: boolean } = {}): Promise<Document> {
  const document = await findDocument(db, actingUser(actor).workspaceId, id, opts);
  if (!document) throw new HttpError(404, "No such Document");
  if (document.projectId === null) {
    await requireWorkspaceAccess(db, actor, need);
  } else {
    await requireProjectAccess(db, actor, (await findProjectById(db, document.projectId))!, need, "No such Document");
  }
  return document;
}
