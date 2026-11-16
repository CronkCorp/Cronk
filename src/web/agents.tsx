import { Button } from "./components/button.js";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { SilenceMeter } from "./components/meter.js";
import { ConfirmDialog, Dialog } from "./components/overlays.js";
import { RelativeTime } from "./components/time.js";
import { useEffect, useState, type ReactNode } from "react";
import { Actor, agentActor, Avatar, SessionName } from "./components/actor.js";
import { api, watchAgents, type Agent, type AgentAccess, type AgentToken, type AgentRecordEntry, type User } from "./api.js";
import { Link } from "./router.js";
import { ACTIVITY_NAMES, describeChange } from "./timeline.js";
import { Field, Show, useAction, useLoad, useSubmit, type Loaded } from "./ui.js";

/**
 * The signed-in User's Agents, one card each, kept current by the Agents stream; an Admin also sees
 * everyone else's Agents, refreshed on load and whenever the stream reconnects.
 */
export function AgentsPage(props: { me: User }) {
  const admin = props.me.role === "admin";
  const [agents, reload] = useLoad(() => api.agents(), []);
  const [everyone, reloadEveryone] = useLoad(() => (admin ? api.agents(true) : Promise.resolve([])), [admin]);
  const [live, onLive] = useLiveState();
  const [registering, setRegistering] = useState(false);
  useEffect(
    () =>
      watchAgents({
        ready: () => {
          reload();
          if (admin) reloadEveryone();
        },
        onLive,
        on: { changed: reload },
      }),
    [admin],
  );
  return (
    <section className="agents-page">
      <div className="page-head">
        <h1>Agents</h1>
        <div className="actions">
          <LiveIndicator state={live} />
          <Button onClick={() => setRegistering(true)}>Register an Agent</Button>
        </div>
      </div>
      <p className="muted">
        An Agent acts for you through a token you give your AI tool. It never gets more access than you have, nor more than a
        Project's Agent Access allows.
      </p>
      <RegisterAgentDialog open={registering} onOpenChange={setRegistering} onDone={reload} />
      <Show state={agents}>
        {(list) =>
          list.length === 0 ? (
            <div className="empty">
              <h2>No Agents yet</h2>
              <p className="muted">Register an Agent, then give it a token to connect your AI tool.</p>
            </div>
          ) : (
            <ul className="agent-cards" aria-label="Your Agents">
              {list.map((agent) => (
                <AgentCard key={agent.id} agent={agent} onChanged={reload} />
              ))}
            </ul>
          )
        }
      </Show>
      {admin && <OthersAgents me={props.me} agents={everyone} />}
    </section>
  );
}

function RegisterAgentDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const { submit, error, busy } = useSubmit(
    () => api.createAgent(name),
    () => {
      setName("");
      props.onOpenChange(false);
      props.onDone();
    },
  );
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} title="Register an Agent" description="Name it after the tool and machine it runs on.">
      <form onSubmit={submit}>
        <Field label="Agent name" value={name} onChange={setName} placeholder="claude-laptop" />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions dialog-actions">
          <Button type="button" variant="secondary" onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={busy}>Register Agent</Button>
        </div>
      </form>
    </Dialog>
  );
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "2 live Agent Sessions · Delegate on 3 Tickets", leaving out what is zero. */
function agentSummary(agent: Agent): string {
  const parts = [];
  if (agent.sessions.length > 0) parts.push(plural(agent.sessions.length, "live Agent Session"));
  if (agent.delegateTicketCount > 0) parts.push(`Delegate on ${plural(agent.delegateTicketCount, "Ticket")}`);
  return parts.join(" · ");
}

function AgentCard(props: { agent: Agent; onChanged: () => void }) {
  const a = props.agent;
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [managing, setManaging] = useState(false);
  const [name, setName] = useState(a.name);
  const [tokens, reloadTokens] = useLoad(() => api.agentTokens(a.id), [a.id]);
  const rename = useSubmit(
    () => api.renameAgent(a.id, name),
    () => {
      setRenaming(false);
      props.onChanged();
    },
  );
  const remove = useAction(() => api.removeAgent(a.id), props.onChanged);
  const error = rename.error ?? remove.error;

  return (
    <li className="agent-card" aria-label={a.name}>
      <div className="agent-card-head">
        {renaming ? (
          <form className="actions grow" onSubmit={rename.submit}>
            <input className="inline-input grow" aria-label="New name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" disabled={rename.busy}>Save</Button>
            <Button type="button" variant="secondary" onClick={() => setRenaming(false)}>Cancel</Button>
          </form>
        ) : (
          <>
            <Avatar actor={agentActor(a)} large />
            <div className="grow">
              <div className="agent-name">{a.name}</div>
              <div className="agent-summary muted">{agentSummary(a)}</div>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setName(a.name);
                setRenaming(true);
              }}
            >
              Rename
            </Button>
            <Button variant="ghost" onClick={() => setRemoving(true)}>Remove</Button>
          </>
        )}
      </div>
      <LiveSessions agent={a} />
      <RecordLog agent={a} />
      <div className="agent-card-foot">
        <span className="grow"><TokenSummary tokens={tokens} /></span>
        <Button variant="ghost" onClick={() => setManaging(true)}>Manage tokens</Button>
      </div>
      {error && <p className="error agent-card-error" role="alert">{error}</p>}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${a.name}?`}
        description="Its tokens are revoked and its live Agent Sessions end. What it did stays on its record."
        confirmLabel="Remove Agent"
        busy={remove.busy}
        onConfirm={() => void remove.run().then(() => setRemoving(false))}
      />
      <TokensDialog agent={a} open={managing} onOpenChange={setManaging} tokens={tokens} onChanged={reloadTokens} />
    </li>
  );
}

/** What kind of token it is: "full" or "read-only". */
const tokenKind = (t: AgentToken) => (t.readOnly ? "read-only" : "full");

/** "2 tokens: full (issued 3 Nov), read-only (issued 9 Nov)". */
function TokenSummary(props: { tokens: Loaded<AgentToken[]> }) {
  return (
    <Show state={props.tokens}>
      {(list) =>
        list.length === 0 ? (
          <span className="muted">No tokens. Issue one to connect this Agent.</span>
        ) : (
          <>
            {plural(list.length, "token")}:{" "}
            {list.map((t, i) => (
              <span key={t.id}>
                {i > 0 && ", "}
                {tokenKind(t)} <span className="muted">(issued <RelativeTime at={t.createdAt} />)</span>
              </span>
            ))}
          </>
        )
      }
    </Show>
  );
}

/** Issues and revokes an Agent's tokens. A new token's secret shows here once, until the dialog closes. */
function TokensDialog(props: { agent: Agent; open: boolean; onOpenChange: (open: boolean) => void; tokens: Loaded<AgentToken[]>; onChanged: () => void }) {
  const a = props.agent;
  const [secret, setSecret] = useState<string>();
  const [copied, setCopied] = useState(false);
  const issue = useAction(
    (readOnly: boolean) => api.issueAgentToken(a.id, readOnly),
    (issued) => {
      setSecret(issued.secret);
      setCopied(false);
      props.onChanged();
    },
  );
  const revoke = useAction((tokenId: string) => api.revokeAgentToken(a.id, tokenId), props.onChanged);
  const error = issue.error ?? revoke.error;
  const openChange = (open: boolean) => {
    if (!open) setSecret(undefined);
    props.onOpenChange(open);
  };
  const copy = () => {
    if (!secret) return;
    void navigator.clipboard?.writeText(secret).then(() => setCopied(true), () => {});
  };
  return (
    <Dialog open={props.open} onOpenChange={openChange} title={`Tokens of ${a.name}`} description="Your AI tool connects as this Agent with one of them.">
      <div className="tokens-dialog">
      <Show state={props.tokens}>
        {(list) => (
          <ul className="token-list" aria-label={`Tokens of ${a.name}`}>
            {list.length === 0 && <li className="muted">No tokens yet.</li>}
            {list.map((t) => (
              <li key={t.id} className="token">
                <span className="grow">
                  {tokenKind(t) === "full" ? "Full" : "Read-only"} token <span className="muted">issued <RelativeTime at={t.createdAt} /></span>
                </span>
                <Button variant="ghost" disabled={revoke.busy} onClick={() => void revoke.run(t.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </Show>
      <div className="actions">
        <Button variant="secondary" disabled={issue.busy} onClick={() => void issue.run(false)}>Issue full token</Button>
        <Button variant="secondary" disabled={issue.busy} onClick={() => void issue.run(true)}>Issue read-only token</Button>
      </div>
      {secret && (
        <div role="status" className="secret">
          <p>Give this token to your AI tool now; Cronk won't show it again. It is sent as <code>Authorization: Bearer …</code>.</p>
          <div className="actions">
            <input className="copy grow" readOnly value={secret} aria-label="New token" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
          </div>
          <p>Then add Cronk to your AI tool as a streamable-HTTP MCP server at <code>{mcpUrl()}</code>. For Claude Code, run:</p>
          <input
            className="copy"
            readOnly
            value={`claude mcp add --transport http cronk ${mcpUrl()} --header "Authorization: Bearer ${secret}"`}
            aria-label="Command to connect Claude Code"
            onFocus={(e) => e.target.select()}
          />
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions dialog-actions">
        <Button variant="secondary" onClick={() => openChange(false)}>Done</Button>
      </div>
      </div>
    </Dialog>
  );
}

/** An Agent's live Agent Sessions, each with what it is working on and a meter until it falls silent; or when it was last connected. */
function LiveSessions(props: { agent: Agent }) {
  const a = props.agent;
  return (
    <ul className="session-list" aria-label={`Live Agent Sessions of ${a.name}`}>
      {a.sessions.length === 0 && (
        <li className="session">
          <NotConnected />
          {a.lastSessionEndedAt && (
            <span className="muted">
              last Agent Session ended <RelativeTime at={a.lastSessionEndedAt} />
            </span>
          )}
        </li>
      )}
      {a.sessions.map((s) => (
        <li key={s.id} className="session">
          <LiveIndicator state="live" /> <SessionName id={s.id} />
          <span className="grow session-work">
            {s.claims.length === 0 ? (
              <span className="muted">Connected, no Claim</span>
            ) : (
              <>
                Working on{" "}
                {s.claims.map((c, i) => (
                  <span key={c.ticketKey}>
                    {i > 0 && ", "}
                    <Link to={`/tickets/${c.ticketKey}`} className="link">
                      <span className="claim-key">{c.ticketKey}</span> {c.title}
                    </Link>
                  </span>
                ))}
              </>
            )}
          </span>
          <span className="muted session-since">
            since <RelativeTime at={s.startedAt} />
          </span>
          <SilenceMeter from={s.lastSeenAt} until={s.endsIfSilentAt} />
        </li>
      ))}
    </ul>
  );
}

/** Cronk's MCP address, where an Agent connects: this installation's own origin. */
const mcpUrl = () => `${window.location.origin}/mcp`;

/** What an Agent did across the Workspace, newest first, shown on request. */
function RecordLog(props: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="record-log">
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide what it did" : "Show what it did"}
      </Button>
      {open && <RecordEntries agent={props.agent} />}
    </div>
  );
}

/** The entries of an Agent's record, loaded when shown. */
function RecordEntries(props: { agent: Agent }) {
  const [record] = useLoad(() => api.agentRecord(props.agent.id), [props.agent.id]);
  return (
    <Show state={record}>
      {(entries) =>
        entries.length === 0 ? (
          <p className="muted">It hasn't done anything yet.</p>
        ) : (
          <ol className="history" aria-label={`What ${props.agent.name} did`}>
            {entries.map((entry, i) => (
              <li key={i}>
                <span className="muted"><RelativeTime at={entry.at} /></span>
                {entry.session && <> <SessionName id={entry.session.id} /></>} {describeRecordEntry(entry)} <RecordEntryPlace entry={entry} />
              </li>
            ))}
          </ol>
        )
      }
    </Show>
  );
}

/** What one entry of an Agent's record was, as a phrase like "logged a Plan". */
function describeRecordEntry(entry: AgentRecordEntry): ReactNode {
  if (entry.change) return describeChange(entry.change);
  if (entry.activity) return `logged ${entry.activity.blocking ? "a blocking question" : `a ${ACTIVITY_NAMES[entry.activity.kind]}`}`;
  if (entry.comment) return "commented";
  return entry.version!.number === 1 ? "wrote" : `saved Version ${entry.version!.number} of`;
}

/** Where an entry of an Agent's record happened: its Ticket, or the Document it was on. */
function RecordEntryPlace(props: { entry: AgentRecordEntry }) {
  const { ticket, document, version } = props.entry;
  // A saved Version is of its Document, even a Report, which also names its Ticket.
  if (document && (version || !ticket)) {
    return (
      <>
        {!version && "on "}
        <Link to={`/documents/${document.id}`} className="link">{document.title}</Link>
        {ticket && <span className="muted"> ({ticket.key})</span>}
      </>
    );
  }
  return (
    <>
      on <Link to={`/tickets/${ticket!.key}`} className="link"><span className="claim-key">{ticket!.key}</span> {ticket!.title}</Link>
    </>
  );
}

/** An Agent with no live Agent Session: a hollow dot and "Not connected". */
function NotConnected() {
  return (
    <span className="not-connected">
      <span className="offline-dot" aria-hidden="true" /> Not connected
    </span>
  );
}

/** Every other User's Agents, read-only, for an Admin: Agent, Owner and whether it is connected. */
function OthersAgents(props: { me: User; agents: Loaded<Agent[]> }) {
  return (
    <div className="others-agents">
      <h2 className="others-head">
        Everyone else's Agents <span className="muted others-badge">Admin</span>
      </h2>
      <Show state={props.agents}>
        {(list) => {
          const others = list.filter((a) => a.owner.id !== props.me.id);
          return others.length === 0 ? (
            <p className="muted">No other User has Agents.</p>
          ) : (
            <ul className="rows" aria-label="Everyone else's Agents">
              {others.map((a) => (
                <li key={a.id} className="row" aria-label={a.name}>
                  <span className="grow"><Actor actor={agentActor(a)} /></span>
                  {a.sessions.length > 0 ? (
                    <LiveIndicator state="live" />
                  ) : (
                    <NotConnected />
                  )}
                </li>
              ))}
            </ul>
          );
        }}
      </Show>
    </div>
  );
}

const AGENT_ACCESS_NAMES: Record<AgentAccess, string> = { none: "None", read: "Read", write: "Write" };

/** Picks the Agent Access of a Project or the Workspace. */
export function AgentAccessSelect(props: { value: AgentAccess; disabled?: boolean; onChange: (access: AgentAccess) => void }) {
  return (
    <label className="field inline">
      <span>Agent Access</span>
      <select value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as AgentAccess)}>
        {(["write", "read", "none"] as const).map((a) => (
          <option key={a} value={a}>{AGENT_ACCESS_NAMES[a]}</option>
        ))}
      </select>
    </label>
  );
}
