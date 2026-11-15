import type { ReactNode } from "react";

/**
 * A banner above an editor (docs/ui.md § Component conventions): `info` for something to settle, such as
 * a merge, and `warn` for something to heed, such as a newer Version saved meanwhile. `role` is `alert`
 * when it answers what the User just did, and `status` when it arrives on its own.
 */
export function Banner(props: { tone: "info" | "warn"; role: "alert" | "status"; children: ReactNode }) {
  return (
    <div className={`banner ${props.tone}`} role={props.role}>
      {props.children}
    </div>
  );
}
