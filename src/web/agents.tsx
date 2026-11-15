import { LiveIndicator } from "./components/live.js";
import { RelativeTime } from "./components/time.js";
import { useState } from "react";
import { Actor, SessionName } from "./components/actor.js";
import { api, type Agent, type AgentAccess, type AgentSession, type User } from "./api.js";
import { Field, Show, useAction, useLoad, useSubmit } from "./ui.js";

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
            <span className="grow"><Actor actor={{ kind: "agent", name: a.name }} /></span>
            <button className="link" onClick={() => setRenaming(true)}>Rename</button>
            <button className="link" disabled={remove.busy} onClick={() => void remove.run()}>Remove</button>
          </>
        )}
      </div>
      <div className="agent-tokens">
        <LiveSessions agent={a} />
        <Show state={tokens}>
          {(list) => (
            <ul className="token-list" aria-label={`Tokens of ${a.name}`}>
              {list.length === 0 && <li className="muted">No tokens. Issue one to connect this Agent.</li>}
              {list.map((t) => (
                <li key={t.id} className="token">
                  <span className="grow">
                    {t.readOnly ? "Read-only token" : "Full token"}{" "}
                    <span className="muted">issued <RelativeTime at={t.createdAt} /></span>
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
          <span className="grow">
            <LiveIndicator state="live" /> <SessionName id={s.id} />{" "}
            <span className="muted">
              connected <RelativeTime at={s.startedAt} />, last heard <RelativeTime at={s.lastSeenAt} />
            </span>
          </span>
        </li>
      ))}
    </ul>
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
                    <span className="grow"><Actor actor={{ kind: "agent", name: a.name, owner: a.owner }} /></span>
                  </div>
                  <div className="agent-tokens">
                    <LiveSessions agent={a} />
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
