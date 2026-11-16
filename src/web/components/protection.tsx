import type { ProtectionChange } from "../api.js";
import { useLoad, Show } from "../ui.js";
import { Actor } from "./actor.js";
import { RelativeTime } from "./time.js";

/**
 * An item's protection history, newest first: each time a User marked it Protected or unmarked it.
 * Shows nothing while it was never marked. Loaded again whenever `reloadOn` changes.
 */
export function ProtectionHistory(props: { load: () => Promise<ProtectionChange[]>; reloadOn: unknown[] }) {
  const [changes] = useLoad(props.load, props.reloadOn);
  return (
    <Show state={changes}>
      {(list) =>
        list.length === 0 ? null : (
          <ol className="history protection" aria-label="Protected marks">
            {list.map((c, i) => (
              <li key={i}>
                <strong>{c.protected ? "Marked Protected" : "Unmarked Protected"}</strong> <RelativeTime at={c.at} /> <Actor actor={c.actor} />
              </li>
            ))}
          </ol>
        )
      }
    </Show>
  );
}
