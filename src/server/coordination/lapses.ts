import type { AppContext } from "../context.js";
import { ticketsChanged } from "../work/ticket-changes.js";
import { findTicketsByIds } from "../work/tickets.js";

/**
 * Claims lapse by time alone, when their Agent Session stays silent too long, so no call
 * marks the moment. Every `intervalMs` this looks for the Claims that lapsed since it last
 * looked, by the application's clock, and tells their Tickets' watchers (see `onLapsed`).
 * Claims that lapse while the server is down aren't told of; a stream reopening catches up
 * with its `ready`. Stops when the returned function is called.
 */
export function watchClaimLapses(ctx: AppContext, intervalMs: number, onLapsed: (ticketIds: string[]) => Promise<void> = async () => {}): () => void {
  let since = ctx.clock.now();
  let looking = false;
  const look = async () => {
    const now = ctx.clock.now();
    if (now <= since) return;
    const { rows } = await ctx.db.query<{ id: string }>(
      `SELECT t.id FROM tickets t JOIN agent_sessions s ON s.id = t.claim_session_id
       JOIN agents a ON a.id = s.agent_id JOIN workspaces w ON w.id = a.workspace_id
       WHERE s.ended_at IS NULL
         AND s.last_seen_at + make_interval(secs => w.silence_threshold_seconds) > $1
         AND s.last_seen_at + make_interval(secs => w.silence_threshold_seconds) <= $2`,
      [since, now],
    );
    since = now;
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    ticketsChanged(ctx.live, await findTicketsByIds(ctx.db, ids));
    await onLapsed(ids);
  };
  const timer = setInterval(() => {
    if (looking) return;
    looking = true;
    // A failed look (a database blip) is tried again next time, over the same span.
    look()
      .catch(() => {})
      .finally(() => (looking = false));
  }, intervalMs).unref();
  return () => clearInterval(timer);
}
