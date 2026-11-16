import type { ReactNode } from "react";
import { Link } from "../router.js";
import type { DecisionStatus, Priority, Status } from "../api.js";

// Small labels set into rows and headings: docs/ui.md § Component conventions.

/** What an entry is. Each kind has its colour, which backs up the label and never replaces it. */
export type Kind = "plan" | "progress" | "finding" | "question" | "blocking" | "error" | "report" | "comment" | "review" | "unverified" | "decision";

/** An 11px uppercase label saying what an Activity, Comment or Report is. */
export function KindLabel(props: { kind: Kind; children: ReactNode }) {
  return <span className={`kind-label ${props.kind}`}>{props.children}</span>;
}

/** Each Priority as the UI names it. */
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
 * adds a × button named `Remove <children>`. `tone="ok"` marks something settled, such as "Answered"; `warn` and `danger` something waiting, as a question does;
 * `danger` also marks a merge's "Both changed". `info` is an outlined pill for what to know, such as a Term overriding the Workspace's.
 */
export function Chip(props: { children: string; as?: "span" | "li"; tone?: "ok" | "warn" | "danger" | "info"; onRemove?: () => void; disabled?: boolean }) {
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

/** A Status: its Category's dot and its name. */
export function StatusPill(props: { status: Status }) {
  return (
    <span className="status-pill">
      <span className={`dot ${props.status.category}`} aria-hidden="true" />
      {props.status.name}
    </span>
  );
}

/** A Status as its Category's dot alone, for dense rows: the name is in its tooltip and accessible label. */
export function StatusDot(props: { status: Status }) {
  return <span className={`dot ${props.status.category}`} role="img" aria-label={props.status.name} title={props.status.name} />;
}

/** Each Decision status as the UI names it. */
export const DECISION_STATUS_NAMES: Record<DecisionStatus, string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  rejected: "Rejected",
  deprecated: "Deprecated",
  superseded: "Superseded",
};

/** A Decision's status as an 11px uppercase pill, styled by status (docs/ui.md § Component conventions). */
export function DecisionStatusPill(props: { status: DecisionStatus }) {
  return <span className={`decision-status ${props.status}`}>{DECISION_STATUS_NAMES[props.status]}</span>;
}

/** A filter as a pill linking to the view it filters to, such as "Accepted 3"; the filter in force is marked current. */
export function FilterChip(props: { to: string; current: boolean; children: string }) {
  return (
    <Link to={props.to} className={`filter-chip${props.current ? " pressed" : ""}`} {...(props.current ? { "aria-current": "true" as const } : {})}>
      {props.children}
    </Link>
  );
}
