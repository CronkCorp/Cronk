import type { Ref } from "react";
import type { RecordedActor } from "../api.js";
import { TextArea } from "../ui.js";
import { Button } from "./button.js";

/**
 * The box a User rejects a Decision in: a required reason, which reaches the Agent that proposed it, if an
 * Agent did, then Reject and Cancel. Shown in place of the actions that opened it.
 */
export function RejectDecisionForm(props: {
  proposedBy: RecordedActor;
  reason: string;
  onReasonChange: (reason: string) => void;
  onReject: () => void;
  onCancel: () => void;
  busy: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <form
      className="comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onReject();
      }}
    >
      <TextArea label="Why reject it" value={props.reason} onChange={props.onReasonChange} rows={3} inputRef={props.inputRef} disabled={props.disabled} />
      {props.proposedBy.kind === "agent" && <p className="muted small">{`The reason reaches ${props.proposedBy.name} as Waiting Work.`}</p>}
      <div className="actions">
        <Button type="submit" disabled={props.disabled || props.busy || !props.reason.trim()}>Reject</Button>
        <Button type="button" variant="secondary" onClick={props.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
