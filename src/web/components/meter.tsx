import { useEffect, useState } from "react";

// A meter counting down until an Agent Session falls silent (docs/ui.md § Agents), or its Claim lapses.

/** Re-renders every second, so a countdown moves between the server's updates. */
function useSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const ago = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  return seconds < 60 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
};

/**
 * A bar that empties from when an Agent Session was last heard (`from`) to when it falls silent (`until`),
 * with how long ago it was heard under it. It counts down on its own, by the browser's clock.
 */
export function SilenceMeter(props: { from: string; until: string }) {
  const now = useSecondTick();
  const from = new Date(props.from).getTime();
  const until = new Date(props.until).getTime();
  const left = Math.min(1, Math.max(0, (until - now) / Math.max(1, until - from)));
  const secondsLeft = Math.max(0, Math.round((until - now) / 1_000));
  return (
    <span className="silence-meter">
      <span
        className="meter"
        role="meter"
        aria-label="Time until it falls silent"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(left * 100)}
        aria-valuetext={`Falls silent in ${secondsLeft} s`}
        title={`Falls silent in ${secondsLeft} s unless it calls`}
      >
        <span className="meter-fill" style={{ width: `${left * 100}%` }} />
      </span>
      <span className="meter-label">heard {ago(now - from)}</span>
    </span>
  );
}
