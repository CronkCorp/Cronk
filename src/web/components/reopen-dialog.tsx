import { useEffect, useState } from "react";
import { api, type DependentChoice, type ReopenChoice, type StatusCategory, type Ticket } from "../api.js";
import { TextArea, useAction, useLoad } from "../ui.js";
import { Button } from "./button.js";
import { Dialog } from "./overlays.js";
import { StatusPill } from "./tags.js";

/** Started, In Review or finished: work that went on after its blocker was completed. */
export const CONTINUED: readonly StatusCategory[] = ["started", "in_review", "completed"];

/** A choice's label; Keep reads "Keep going" for work in progress. */
function labelOf(choice: ReopenChoice, d: DependentChoice): string {
  if (choice === "keep") return d.choices.includes("pause") ? "Keep going" : "Keep";
  return choice === "pause" ? "Pause" : "Reopen too";
}

/** What a dependent is, beside its Status: who holds it, whose completion awaits checking, or what Reopening means for it. */
function stateOf(d: DependentChoice): string {
  const t = d.ticket;
  if (d.claim) return `Claimed by ${d.claim.agent.name}`;
  if (t.verification === "unverified") return `Unverified${t.delegate ? ` · ${t.delegate.name}` : ""}`;
  switch (t.status.category) {
    case "started":
      return "not Claimed";
    case "in_review":
      return "waits on review, kept";
    case "completed":
      return "finished, kept";
    default:
      return "not started, waits again";
  }
}

/**
 * Reopen…: a required reason, which reaches the Delegate as Waiting Work, then every Ticket the completion blocks, each that
 * already continued with its choice (docs/ui.md § Inbox and Triage in Phase 2). `reopen` sends it.
 */
export function ReopenDialog(props: {
  ticket: Ticket;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reopen: (input: { comment: string; dependents: Record<string, ReopenChoice> }) => Promise<unknown>;
  onDone: () => void;
}) {
  const { ticket } = props;
  const [reason, setReason] = useState("");
  const [chosen, setChosen] = useState<Record<string, ReopenChoice>>({});
  // Loaded each time it opens, so the list shows the dependents as they are now. The server says what each one takes.
  const [dependents] = useLoad(async (): Promise<DependentChoice[]> => (props.open ? api.reopenChoices(ticket.key) : []), [props.open, ticket.key]);
  useEffect(() => {
    if (props.open) setChosen({});
  }, [props.open]);
  const listed = dependents.kind === "loaded" ? dependents.value : [];
  // One the User can only read is kept, whatever was clicked.
  const chosenFor = (d: DependentChoice): ReopenChoice => (d.canChange ? (chosen[d.ticket.key] ?? d.choices[0] ?? "keep") : "keep");
  const continued = listed.filter((d) => CONTINUED.includes(d.ticket.status.category));
  const reopen = useAction(
    () => {
      const choices = Object.fromEntries(listed.filter((d) => d.choices.length > 0).map((d) => [d.ticket.key, chosenFor(d)]));
      return props.reopen({ comment: reason, dependents: choices });
    },
    () => {
      setReason("");
      props.onOpenChange(false);
      props.onDone();
    },
  );
  const delegate = ticket.delegate?.name ?? "its Delegate";
  // Where a Pause would move the dependents the User may pause, each named once.
  const pausesTo = [...new Set(listed.flatMap((d) => (d.canChange && d.pausesTo ? [d.pausesTo.name] : [])))];

  return (
    <Dialog
      size="medium"
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={`Reopen ${ticket.key}`}
      description={`It goes back to ${delegate} in a Started Status and blocks its dependents again.`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void reopen.run();
        }}
      >
        <TextArea label={`What is wrong (required; ${delegate} gets it as Waiting Work)`} value={reason} onChange={setReason} rows={3} />
        {dependents.kind === "failed" && <p className="error" role="alert">{dependents.message}</p>}
        {listed.length > 0 && (
          <div className="reopen-dependents">
            <div className="reopen-dependents-head">
              {continued.length === 1 ? "1 Ticket already continued on this work" : `${continued.length} Tickets already continued on this work`}
            </div>
            {listed.map((d) => {
              const current = chosenFor(d);
              return (
                <div key={d.ticket.key} className="reopen-dependent">
                  <div className="reopen-dependent-text">
                    <div className="reopen-dependent-title">
                      <span className="key">{d.ticket.key}</span>
                      <span>{d.ticket.title}</span>
                    </div>
                    <div className="reopen-dependent-state">
                      <StatusPill status={d.ticket.status} />
                      <span className="muted">{`· ${stateOf(d)}`}</span>
                    </div>
                  </div>
                  {d.choices.length > 0 && (
                    <div
                      className="segmented"
                      role="radiogroup"
                      aria-label={`What happens to ${d.ticket.key}`}
                      title={d.canChange ? undefined : `You can only read ${d.ticket.key}'s Project, so it is kept`}
                    >
                      {d.choices.map((choice) => (
                        <button
                          key={choice}
                          type="button"
                          role="radio"
                          aria-checked={current === choice}
                          disabled={!d.canChange && choice !== "keep"}
                          className={current === choice ? "segment active" : "segment"}
                          onClick={() => setChosen({ ...chosen, [d.ticket.key]: choice })}
                        >
                          {labelOf(choice, d)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="muted reopen-note">
          {`${pausesTo.length > 0 ? `Pause releases the Claim and moves it back to ${pausesTo.join(" or ")}. ` : ""}The Agents of the dependents you can change are told ${ticket.key} was Reopened.`}
        </p>
        {reopen.error && <p className="error" role="alert">{reopen.error}</p>}
        <div className="actions dialog-actions">
          <Button type="button" variant="secondary" onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={reopen.busy || !reason.trim() || dependents.kind === "loading"}>{`Reopen ${ticket.key}`}</Button>
        </div>
      </form>
    </Dialog>
  );
}
