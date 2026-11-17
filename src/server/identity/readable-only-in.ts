import type { Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { findProjectById } from "../work/projects.js";
import { visibleProjects } from "./access.js";

/** Where a tagged value may be read: the id of its Project. A symbol, so it is never serialized. */
const READABLE_IN = Symbol("readableIn");

/** A value `readableOnlyIn` tagged, with the id of the Project it may be read in. */
type Tagged = { [READABLE_IN]: string };

/**
 * Tags `value`, part of something read elsewhere, as readable only by those who can read the Project `projectId`,
 * as a Discovered Ticket's source Ticket in another Project. `forReader` takes it out of an answer for anyone else:
 * an object property becomes null, an array item is dropped. Returns `value`, tagged. The tag isn't enumerable, so a
 * copy (spread, `structuredClone`, a JSON round trip) loses it: tag the value the answer carries, after any copying.
 */
export function readableOnlyIn<T extends object>(projectId: string, value: T): T {
  Object.defineProperty(value, READABLE_IN, { value: projectId, enumerable: false });
  return value;
}

/** Whether `readableOnlyIn` tagged `value`. */
const isTagged = (value: unknown): value is Tagged => typeof value === "object" && value !== null && READABLE_IN in value;

/** Whether `value` is a plain object or an array, which `forReader` looks inside; a Date, a Buffer or a stream isn't. */
const isWalked = (value: unknown): value is Record<string, unknown> | unknown[] =>
  Array.isArray(value) || (typeof value === "object" && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value)));

/**
 * `payload` as `actor` may read it: each value tagged by `readableOnlyIn` with a Project they can't read taken out
 * (null in an object, dropped from an array). With no `actor`, as for a caller who isn't signed in, every tagged value
 * is taken out. Untouched parts are shared with `payload`, and `payload` itself is returned when nothing is tagged.
 */
export async function forReader<T>(db: Queryable, actor: Actor | undefined, payload: T): Promise<T> {
  const projectIds = new Set<string>();
  const collect = (value: unknown): void => {
    if (isTagged(value)) projectIds.add(value[READABLE_IN]);
    if (isWalked(value)) for (const item of Object.values(value)) collect(item);
  };
  collect(payload);
  if (projectIds.size === 0) return payload;

  const projects = (await Promise.all([...projectIds].map((id) => findProjectById(db, id)))).filter((p) => p !== undefined);
  const readable = new Set(actor ? (await visibleProjects(db, actor, projects)).map((p) => p.id) : []);
  const hidden = (value: unknown) => isTagged(value) && !readable.has(value[READABLE_IN]);
  const shape = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter((item) => !hidden(item)).map(shape);
    if (!isWalked(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hidden(item) ? null : shape(item)]));
  };
  return shape(payload) as T;
}
