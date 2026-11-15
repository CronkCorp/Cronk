import { useCallback, useState } from "react";
import type { StreamState } from "../api.js";

/** Where a view's live-update stream is: still opening, or as its `watch…` call last reported. */
export type LiveState = "connecting" | StreamState;

/** Tracks a stream's state; pass `onLive` to its `watch…` call and the state to `LiveIndicator`. */
export function useLiveState(): [LiveState, (state: StreamState) => void] {
  const [state, setState] = useState<LiveState>("connecting");
  return [state, useCallback((next: StreamState) => setState(next), [])];
}

const LIVE_TEXT: Record<StreamState, string> = { live: "Live", away: "Reconnecting…", closed: "Not live; reload to catch up" };

/** A green dot with "Live" while a view streams, a muted "Reconnecting…" while its stream is away (docs/ui.md § Live updates). */
export function LiveIndicator(props: { state: LiveState }) {
  if (props.state === "connecting") return null;
  return (
    <span className={`live-indicator ${props.state}`} aria-live="polite">
      <span className="live-dot" aria-hidden="true" />
      {LIVE_TEXT[props.state]}
    </span>
  );
}
