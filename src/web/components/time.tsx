import { useEffect, useState } from "react";

// When something happened, as docs/ui.md § Component conventions (Times) describes.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const clock = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * A time as the UI shows it: relative within the hour ("12 min ago", "in 4 min"), then the clock time
 * today ("10:18"), "yesterday 10:18", and otherwise day and time ("14 Nov 09:52"), with the year only
 * when it differs from the current one.
 */
export function formatTime(at: Date, now: Date): string {
  const diff = at.getTime() - now.getTime();
  const minutes = Math.round(Math.abs(diff) / MINUTE);
  if (Math.abs(diff) < HOUR) {
    if (minutes === 0) return "just now";
    return diff < 0 ? `${minutes} min ago` : `in ${minutes} min`;
  }
  const days = Math.round((startOfDay(at) - startOfDay(now)) / (24 * HOUR));
  if (days === 0) return clock(at);
  if (days === -1) return `yesterday ${clock(at)}`;
  if (days === 1) return `tomorrow ${clock(at)}`;
  const day = at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day} ${clock(at)}`;
}

/** A time as a timeline shows it: the clock time alone ("10:18"), under a separator for its day. */
export const formatClock = (at: Date) => clock(at);

/** A timeline's day separator: "Today", "Yesterday", or the day ("14 Nov"), with the year only when it differs from the current one. */
export function formatDay(at: Date, now: Date): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / (24 * HOUR));
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/** Whether two times fall on the same local day. */
export const sameDay = (a: Date, b: Date) => startOfDay(a) === startOfDay(b);

/** Re-renders every half minute, so relative times stay true while a page stays open. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * A time, relative while recent, with the exact time in its tooltip. `clock` shows the clock time alone,
 * as a timeline does under its day separators.
 */
export function RelativeTime(props: { at: Date | string; className?: string; clock?: boolean }) {
  const now = useNow();
  const at = new Date(props.at);
  return (
    <time className={props.className ?? "time"} dateTime={at.toISOString()} title={at.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "medium" })}>
      {props.clock ? formatClock(at) : formatTime(at, now)}
    </time>
  );
}
