import { useState } from "react";

/** Where a live-update stream is: opening, streaming, or away and reconnecting. */
export type LiveState = "connecting" | "live" | "away";

/** Tracks a stream's state; pass `onLive` to its `watch…` call and the state to `LiveIndicator`. */
export function useLiveState(): [LiveState, (live: boolean) => void] {
  const [state, setState] = useState<LiveState>("connecting");
  return [state, (live) => setState(live ? "live" : "away")];
}

/** A green dot with "Live" while a view streams, a muted "Reconnecting…" while its stream is away (docs/ui.md § Live updates). */
export function LiveIndicator(props: { state: LiveState }) {
  if (props.state === "connecting") return null;
  const live = props.state === "live";
  return (
    <span className={`live-indicator${live ? "" : " away"}`} aria-live="polite">
      <span className="live-dot" aria-hidden="true" />
      {live ? "Live" : "Reconnecting…"}
    </span>
  );
}
