import type { AppContext } from "../context.js";
import { findLapsedClaims, listLiveClaims } from "./claims.js";
import { claimsEnded } from "./ready.js";

/**
 * Claims lapse by time alone, when their Agent Session stays silent too long (or the Workspace
 * shortens its silence threshold), so no call marks the moment. Every `intervalMs` this notes
 * which Claims are live, by the application's clock, and finds those that lapsed since it last
 * looked (live then, or lapsing after then), to tell their Tickets' watchers and the Agents they
 * are now Ready for.
 * Claims released or whose Agent Session was ended are told of where that happens. Claims that
 * lapse while the server is down aren't told of; a stream reopening catches up with its `ready`.
 * Stops when the returned function is called.
 */
export function watchClaimLapses(ctx: AppContext, intervalMs: number): () => void {
  let last = { at: ctx.clock.now(), live: new Map<string, string>() };
  let looking = false;
  const look = async () => {
    const now = ctx.clock.now();
    const lapsed = await findLapsedClaims(ctx.db, last.live, last.at, now);
    if (lapsed.length > 0) await claimsEnded(ctx, lapsed);
    last = { at: now, live: await listLiveClaims(ctx.db, now) };
  };
  const timer = setInterval(() => {
    if (looking) return;
    looking = true;
    // A failed look (a database blip) is tried again next time, from the same Claims.
    look()
      .catch(() => {})
      .finally(() => (looking = false));
  }, intervalMs).unref();
  return () => clearInterval(timer);
}
