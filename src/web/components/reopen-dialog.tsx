import { useEffect, useState } from "react";
import { api, type ReopenChoice, type Ticket, type TicketDetail } from "../api.js";
import { TextArea, useAction, useLoad } from "../ui.js";
import { Button } from "./button.js";
import { Dialog } from "./overlays.js";
import { StatusPill } from "./tags.js";

/** The choices a dependent takes, with their labels, the first being its default; none for work that hasn't continued or can't be reopened. */
function choicesFor(ticket: Ticket): [ReopenChoice, string][] {
  if (ticket.status.category === "started") return [["keep", "Keep going"], ["pause", "Pause"]];
  if (ticket.verification === "unverified") return [["keep", "Keep"], ["reopen", "Reopen too"]];
  return [];
}

/** What a dependent is, beside its Status: who holds it, whose completion awaits checking, or what Reopening means for it. */
function stateOf(detail: TicketDetail): string {
  const t = detail.ticket;
  switch (t.status.category) {
    case "started":
      return detail.claim ? `Claimed by ${detail.claim.agent.name}` : "not Claimed";
    case "in_review":
      return "waits on review, kept";
    case "completed":
      return t.verification === "unverified" ? `Unverified${t.delegate ? ` · ${t.delegate.name}` : ""}` : "finished, kept";
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
  // Loaded each time it opens, so the list shows the dependents as they are now.
  const [dependents] = useLoad(async () => {
    if (!props.open) return [];
    const { relations } = await api.ticket(ticket.key);
    const details = await Promise.all(relations.blocks.map((t) => api.ticket(t.key)));
    return details.filter((d) => d.ticket.status.category !== "canceled");
  }, [props.open, ticket.key]);
  useEffect(() => {
    if (props.open) setChosen({});
  }, [props.open]);
  const listed = dependents.kind === "loaded" ? dependents.value : [];
  const continued = listed.filter((d) => ["started", "in_review", "completed"].includes(d.ticket.status.category));
  const reopen = useAction(
    () => {
      const choices = Object.fromEntries(listed.filter((d) => choicesFor(d.ticket).length > 0).map((d) => [d.ticket.key, chosen[d.ticket.key] ?? "keep"]));
      return props.reopen({ comment: reason, dependents: choices });
    },
    () => {
      setReason("");
      props.onOpenChange(false);
      props.onDone();
    },
  );
  const delegate = ticket.delegate?.name ?? "its Delegate";

  return (
    <Dialog
      medium
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
              const choices = choicesFor(d.ticket);
              const current = chosen[d.ticket.key] ?? "keep";
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
                  {choices.length > 0 && (
                    <div className="segmented" role="radiogroup" aria-label={`What happens to ${d.ticket.key}`}>
                      {choices.map(([choice, label]) => (
                        <button
                          key={choice}
                          type="button"
                          role="radio"
                          aria-checked={current === choice}
                          className={current === choice ? "segment active" : "segment"}
                          onClick={() => setChosen({ ...chosen, [d.ticket.key]: choice })}
                        >
                          {label}
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
          {`${listed.some((d) => d.ticket.status.category === "started") ? "Pause releases the Claim and moves it back to Unstarted. " : ""}Every dependent's Agent is told ${ticket.key} was Reopened.`}
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
