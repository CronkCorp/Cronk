import type { AppContext } from "../context.js";
import { findLapsedClaims, listLiveClaims } from "./claims.js";
import { claimsEnded } from "./ready.js";
import { lookAtLiveAgentSessions, ownersWithChangedSessions, type SessionLook } from "./agent-sessions.js";
import { agentsTopic } from "../live/topics.js";
import { transaction } from "../db/database.js";

/**
 * Watches what changes by time alone, as Agent Sessions fall silent. Claims lapse by time alone, when their Agent Session stays silent too long (or the Workspace
 * shortens its silence threshold), so no call marks the moment. Every `intervalMs` this notes
 * which Claims are live, by the application's clock, and finds those that lapsed since it last
 * looked (live then, or lapsing after then), to tell their Tickets' watchers and the Agents they
 * are now Ready for.
 * Claims released or whose Agent Session was ended are told of where that happens. Claims that
 * lapse while the server is down aren't told of; a stream reopening catches up with its `ready`.
 * `stop` stops it and resolves once any look still running is done, so the database can be closed after it; `lookNow` looks at
 * once, for tests to choose when it happens, and does nothing once stopped.
 */
export function watchSilence(ctx: AppContext, intervalMs: number): { stop: () => Promise<void>; lookNow: () => Promise<void> } {
  let stopped = false;
  let last = { at: ctx.clock.now(), live: new Map<string, string>(), sessions: new Map<string, SessionLook>() };
  let looking: Promise<void> | null = null;
  const look = async () => {
    const now = ctx.clock.now();
    // One snapshot for the whole look: a silence threshold lowered between finding lapsed Claims and listing live ones
    // would otherwise leave a Claim neither lapsed this time nor live for the next look to find lapsed.
    const { lapsed, live, sessions } = await transaction(ctx.db, async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      return {
        lapsed: await findLapsedClaims(tx, last.live, last.at, now),
        live: await listLiveClaims(tx, now),
        sessions: await lookAtLiveAgentSessions(tx, now),
      };
    });
    if (lapsed.length > 0) await claimsEnded(ctx, lapsed);
    for (const owner of ownersWithChangedSessions(last.sessions, sessions)) ctx.live.publish(agentsTopic(owner), { event: "changed", data: {} });
    last = { at: now, live, sessions };
  };
  // One look at a time, each from where the last left off. A look that fails rejects, so `lookNow` doesn't pass for a look made.
  const lookAfterAny = async (): Promise<void> => {
    while (looking) await looking.catch(() => {});
    if (stopped) return;
    looking = look().finally(() => (looking = null));
    await looking;
  };
  const timer = setInterval(() => {
    // A failed look (a database blip) is tried again next time, from the same Claims and Sessions.
    if (!looking) lookAfterAny().catch(() => {});
  }, intervalMs).unref();
  const stop = async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    while (looking) await looking.catch(() => {});
  };
  return { stop, lookNow: lookAfterAny };
}
