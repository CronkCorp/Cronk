import type { ReactNode } from "react";
import type { Priority } from "../api.js";

// Small labels set into rows and headings: docs/ui.md § Component conventions.

/** What an entry is. Each kind has its colour, which backs up the label and never replaces it. */
export type Kind = "plan" | "progress" | "finding" | "question" | "blocking" | "error" | "report" | "comment" | "review";

/** An 11px uppercase label saying what an Activity, Comment or Report is. */
export function KindLabel(props: { kind: Kind; children: ReactNode }) {
  return <span className={`kind-label ${props.kind}`}>{props.children}</span>;
}

export const PRIORITY_NAMES: Record<Priority, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No Priority" };

/** A Ticket's Priority as a small uppercase tag; no Priority shows nothing. */
export function PriorityTag(props: { priority: Priority }) {
  if (props.priority === "none") return null;
  return (
    <span className={`priority ${props.priority}`} title={`Priority: ${PRIORITY_NAMES[props.priority]}`}>
      {PRIORITY_NAMES[props.priority]}
    </span>
  );
}

/**
 * A neutral chip, such as a Label or a marker like "Private". `as="li"` puts it in a list; `onRemove`
 * adds a × button named `Remove <children>`. `tone="ok"` marks something settled, such as "Answered".
 */
export function Chip(props: { children: string; as?: "span" | "li"; tone?: "ok"; onRemove?: () => void; disabled?: boolean }) {
  const Tag = props.as ?? "span";
  return (
    <Tag className={`chip${props.tone ? ` ${props.tone}` : ""}`}>
      {props.children}
      {props.onRemove && (
        <button type="button" className="chip-remove" aria-label={`Remove ${props.children}`} disabled={props.disabled} onClick={props.onRemove}>
          ×
        </button>
      )}
    </Tag>
  );
}
