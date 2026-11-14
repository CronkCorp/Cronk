import { HttpError } from "../context.js";
import type { User } from "./users.js";

/** Refuses anyone but an Admin. `what` completes "Only an Admin can …". */
export function requireAdmin(user: User, what: string): void {
  if (user.role !== "admin") throw new HttpError(403, `Only an Admin can ${what}`);
}
