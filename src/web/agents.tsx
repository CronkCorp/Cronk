import { useState } from "react";
import { api, sessionName, type Agent, type AgentAccess, type AgentSession, type AgentWork, type User } from "./api.js";
import { Link } from "./router.js";
import { ACTIVITY_NAMES } from "./timeline.js";
import { Field, Show, useAction, useLoad, useSubmit } from "./ui.js";
import { describeChange } from "./work.js";

/** The signed-in User's Agents and their tokens; an Admin also sees everyone else's Agents. */
export function AgentsPage(props: { me: User }) {
  const [agents, reload] = useLoad(() => api.agents(), []);
  return (
    <section>
      <div className="page-head">
        <h1>Agents</h1>
      </div>
      <p className="muted">
        An Agent acts in Cronk for you, through a token you give your AI tool. It never gets more access than you have, nor more
        than a Project's Agent Access allows.
      </p>
      <NewAgent onDone={reload} />
      <h2>Your Agents</h2>
      <Show state={agents}>
        {(list) =>
          list.length === 0 ? (
            <p className="muted">You have no Agents yet.</p>
          ) : (
            <ul className="rows" aria-label="Your Agents">
              {list.map((agent) => (
                <AgentRow key={agent.id} agent={agent} onChanged={reload} />
              ))}
            </ul>
          )
        }
      </Show>
      {props.me.role === "admin" && <OthersAgents me={props.me} />}
    </section>
  );
}

function NewAgent(props: { onDone: () => void }) {
  const [name, setName] = useState("");
  const { submit, error, busy } = useSubmit(
    () => api.createAgent(name),
    () => {
      setName("");
      props.onDone();
    },
  );
  return (
    <section className="panel">
      <h2>Register an Agent</h2>
      <form onSubmit={submit}>
        <Field label="Agent name" value={name} onChange={setName} placeholder="claude-laptop" />
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>Register Agent</button>
      </form>
    </section>
  );
}

function AgentRow(props: { agent: Agent; onChanged: () => void }) {
  const a = props.agent;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(a.name);
  const [tokens, reloadTokens] = useLoad(() => api.agentTokens(a.id), [a.id]);
  const [secret, setSecret] = useState<string>();
  const rename = useSubmit(
    () => api.renameAgent(a.id, name),
    () => {
      setRenaming(false);
      props.onChanged();
    },
  );
  const remove = useAction(() => api.removeAgent(a.id), props.onChanged);
  const issue = useAction(
    (readOnly: boolean) => api.issueAgentToken(a.id, readOnly),
    (issued) => {
      setSecret(issued.secret);
      reloadTokens();
    },
  );
  const revoke = useAction((tokenId: string) => api.revokeAgentToken(a.id, tokenId), reloadTokens);
  const error = rename.error ?? remove.error ?? issue.error ?? revoke.error;

  return (
    <li className="agent" aria-label={a.name}>
      <div className="row">
        {renaming ? (
          <form className="actions grow" onSubmit={rename.submit}>
            <input className="inline-input grow" aria-label="New name" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" disabled={rename.busy}>Save</button>
            <button type="button" className="secondary" onClick={() => setRenaming(false)}>Cancel</button>
          </form>
        ) : (
          <>
            <strong className="grow">{a.name}</strong>
            <button className="link" onClick={() => setRenaming(true)}>Rename</button>
            <button className="link" disabled={remove.busy} onClick={() => void remove.run()}>Remove</button>
          </>
        )}
      </div>
      <div className="agent-tokens">
        <LiveSessions agent={a} />
        <WorkLog agent={a} />
        <Show state={tokens}>
          {(list) => (
            <ul className="token-list" aria-label={`Tokens of ${a.name}`}>
              {list.length === 0 && <li className="muted">No tokens. Issue one to connect this Agent.</li>}
              {list.map((t) => (
                <li key={t.id} className="token">
                  <span className="grow">
                    {t.readOnly ? "Read-only token" : "Full token"}{" "}
                    <span className="muted">issued {new Date(t.createdAt).toLocaleString()}</span>
                  </span>
                  <button className="link" disabled={revoke.busy} onClick={() => void revoke.run(t.id)}>Revoke</button>
                </li>
              ))}
            </ul>
          )}
        </Show>
        <div className="actions">
          <button className="secondary" disabled={issue.busy} onClick={() => void issue.run(false)}>Issue full token</button>
          <button className="secondary" disabled={issue.busy} onClick={() => void issue.run(true)}>Issue read-only token</button>
        </div>
        {secret && (
          <div role="status" className="secret">
            <p>Give this token to your AI tool now; Cronk won't show it again. It is sent as <code>Authorization: Bearer …</code>.</p>
            <input className="copy" readOnly value={secret} aria-label="New token" onFocus={(e) => e.target.select()} />
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
      </div>
    </li>
  );
}

/** An Agent's live Agent Sessions: what is connected right now. */
function LiveSessions(props: { agent: Agent }) {
  const sessions: AgentSession[] = props.agent.sessions;
  return (
    <ul className="session-list" aria-label={`Live Agent Sessions of ${props.agent.name}`}>
      {sessions.length === 0 && <li className="muted">Not connected.</li>}
      {sessions.map((s) => (
        <li key={s.id} className="session">
          <span className="live-dot" aria-hidden="true" />
          <span className="grow">
            Connected, {sessionName(s.id)}{" "}
            <span className="muted">
              since {new Date(s.startedAt).toLocaleString()}, last heard from {new Date(s.lastSeenAt).toLocaleTimeString()}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Cronk's MCP address, where an Agent connects: this installation's own origin. */
const mcpUrl = () => `${window.location.origin}/mcp`;

/** What an Agent did across the Workspace, newest first, shown on request. */
function WorkLog(props: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="work-log">
      <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide what it did" : "Show what it did"}
      </button>
      {open && <WorkEntries agent={props.agent} />}
    </div>
  );
}

/** The entries of an Agent's work, loaded when shown. */
function WorkEntries(props: { agent: Agent }) {
  const [work] = useLoad(() => api.agentWork(props.agent.id), [props.agent.id]);
  return (
    <Show state={work}>
      {(entries) =>
        entries.length === 0 ? (
          <p className="muted">It hasn't done anything yet.</p>
        ) : (
          <ol className="history" aria-label={`What ${props.agent.name} did`}>
            {entries.map((entry, i) => (
              <li key={i}>
                <span className="muted">
                  {new Date(entry.at).toLocaleString()}
                  {entry.session && `, ${sessionName(entry.session.id)}`}
                </span>{" "}
                {describeWork(entry)} <WorkPlace entry={entry} />
              </li>
            ))}
          </ol>
        )
      }
    </Show>
  );
}

/** What one entry of an Agent's work was, as a phrase like "logged a Plan". */
function describeWork(entry: AgentWork): string {
  if (entry.change) return describeChange(entry.change);
  if (entry.activity) return `logged ${entry.activity.blocking ? "a blocking question" : `a ${ACTIVITY_NAMES[entry.activity.kind]}`}`;
  if (entry.comment) return "commented";
  return entry.version!.number === 1 ? "wrote" : `saved Version ${entry.version!.number} of`;
}

/** Where an entry of an Agent's work happened: its Ticket, or the Document it was on. */
function WorkPlace(props: { entry: AgentWork }) {
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
      on <Link to={`/tickets/${ticket!.key}`} className="link">{ticket!.key}</Link> <span className="muted">{ticket!.title}</span>
    </>
  );
}

/** Every other User's Agents, for an Admin to see. Only an Agent's Owner can change it. */
function OthersAgents(props: { me: User }) {
  const [agents] = useLoad(() => api.agents(true), []);
  return (
    <>
      <h2>Everyone else's Agents</h2>
      <Show state={agents}>
        {(list) => {
          const others = list.filter((a) => a.owner.id !== props.me.id);
          return others.length === 0 ? (
            <p className="muted">No other User has Agents.</p>
          ) : (
            <ul className="rows" aria-label="Everyone else's Agents">
              {others.map((a) => (
                <li key={a.id} className="agent" aria-label={a.name}>
                  <div className="row">
                    <strong className="grow">{a.name}</strong>
                    <span className="muted">owned by {a.owner.name}</span>
                  </div>
                  <div className="agent-tokens">
                    <LiveSessions agent={a} />
                    <WorkLog agent={a} />
                  </div>
                </li>
              ))}
            </ul>
          );
        }}
      </Show>
    </>
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
