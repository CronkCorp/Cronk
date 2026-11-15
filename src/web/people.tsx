import { Actor } from "./components/actor.js";
import { useState } from "react";
import { api, type Access, type Invitation, type Member, type Project, type Role, type User } from "./api.js";
import { AuthCard, Field, Show, useAction, useLoad, useSubmit } from "./ui.js";

const inviteLink = (token: string) => `${location.origin}/invite/${token}`;

/** The Workspace's Users and pending invitations, managed by an Admin. */
export function UsersPage(props: { me: User }) {
  const [users, reloadUsers] = useLoad(() => api.users(), []);
  const [invitations, reloadInvitations] = useLoad(() => api.invitations(), []);
  const [lastLink, setLastLink] = useState<string>();
  const invited = (token: string) => {
    setLastLink(inviteLink(token));
    reloadInvitations();
  };

  return (
    <section>
      <div className="page-head">
        <h1>Users</h1>
      </div>
      <InviteUser onDone={invited} />
      {lastLink && (
        <div className="panel wide" role="status">
          <p>Send this link to the invitee. It works once, for 7 days.</p>
          <input className="copy" readOnly value={lastLink} aria-label="Invitation link" onFocus={(e) => e.target.select()} />
        </div>
      )}
      <Show state={invitations}>
        {(list) => list.length > 0 && <Invitations invitations={list} onChanged={reloadInvitations} />}
      </Show>
      <h2>Members and Admins</h2>
      <Show state={users}>
        {(list) => (
          <ul className="rows" aria-label="Users">
            {list.map((user) => (
              <UserRow key={user.id} user={user} isMe={user.id === props.me.id} onChanged={reloadUsers} onInvited={invited} />
            ))}
          </ul>
        )}
      </Show>
    </section>
  );
}

function InviteUser(props: { onDone: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const { submit, error, busy } = useSubmit(
    () => api.invite({ email, role }),
    (result) => {
      setEmail("");
      props.onDone(result.token);
    },
  );
  return (
    <section className="panel">
      <h2>Invite a User</h2>
      <form onSubmit={submit}>
        <Field label="Email" type="email" value={email} onChange={setEmail} />
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>Invite</button>
      </form>
    </section>
  );
}

function Invitations(props: { invitations: Invitation[]; onChanged: () => void }) {
  const withdraw = useAction((id: string) => api.withdrawInvitation(id), props.onChanged);
  return (
    <>
      <h2>Pending invitations</h2>
      {withdraw.error && <p className="error" role="alert">{withdraw.error}</p>}
      <ul className="rows" aria-label="Pending invitations">
        {props.invitations.map((i) => (
          <li key={i.id} className="row">
            <span className="grow">{i.email}</span>
            <span className="muted">{roleName(i.role)}, until {new Date(i.expiresAt).toLocaleDateString()}</span>
            <button className="link" disabled={withdraw.busy} onClick={() => void withdraw.run(i.id)}>Withdraw</button>
          </li>
        ))}
      </ul>
    </>
  );
}

function UserRow(props: { user: User; isMe: boolean; onChanged: () => void; onInvited: (token: string) => void }) {
  const u = props.user;
  const change = useAction((changes: { role?: Role; active?: boolean }) => api.updateUser(u.id, changes), props.onChanged);
  // A User an import brought in joins by accepting an invitation, keeping their role.
  const invite = useAction(() => api.invite({ email: u.email, role: u.role }), (result) => props.onInvited(result.token));
  return (
    <li className="row">
      <span className="grow">
        <Actor actor={{ kind: "user", name: u.name }} />
        {props.isMe && <span className="muted"> (you)</span>} <span className="muted">{u.email}</span>
        {!u.joined ? (
          <span className="badge">Imported, not signed in yet</span>
        ) : (
          !u.active && <span className="badge">Deactivated</span>
        )}
        {change.error && <span className="error" role="alert"> {change.error}</span>}
        {invite.error && <span className="error" role="alert"> {invite.error}</span>}
      </span>
      <select
        aria-label={`Role of ${u.name}`}
        value={u.role}
        disabled={change.busy}
        onChange={(e) => void change.run({ role: e.target.value as Role })}
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </select>
      {(u.joined || u.active) && (
        <button className="link" disabled={change.busy} onClick={() => void change.run({ active: !u.active })}>
          {u.active ? "Deactivate" : "Reactivate"}
        </button>
      )}
      {!u.joined && (
        <button className="link" disabled={invite.busy} onClick={() => void invite.run()}>
          Invite
        </button>
      )}
    </li>
  );
}

const roleName = (role: Role) => (role === "admin" ? "Admin" : "Member");

/** Who may enter a Project and with what access: open or private, and its listed members. Admins only. */
export function ProjectAccessPanel(props: { project: Project; onProjectChanged: (project: Project) => void }) {
  const p = props.project;
  const [members, reloadMembers] = useLoad(() => api.members(p.key), [p.key]);
  const [users] = useLoad(() => api.users(), []);
  const visibility = useAction(
    () => api.updateProject(p.key, { visibility: p.visibility === "open" ? "private" : "open" }),
    props.onProjectChanged,
  );

  return (
    <section className="panel wide" aria-label="Project access">
      <h2>Access</h2>
      <p className="muted">
        {p.visibility === "open"
          ? "Open: every Member has Write access, unless listed below with other access."
          : "Private: only Admins and the Members listed below can see this Project."}
      </p>
      <button className="secondary" disabled={visibility.busy} onClick={() => void visibility.run()}>
        {p.visibility === "open" ? "Make private" : "Make open"}
      </button>
      {visibility.error && <p className="error" role="alert">{visibility.error}</p>}
      <Show state={members}>
        {(list) => (
          <Show state={users}>
            {(all) => <MemberList projectKey={p.key} members={list} users={all} onChanged={reloadMembers} />}
          </Show>
        )}
      </Show>
    </section>
  );
}

function MemberList(props: { projectKey: string; members: Member[]; users: User[]; onChanged: () => void }) {
  const set = useAction((userId: string, access: Access) => api.setMember(props.projectKey, userId, access), props.onChanged);
  const remove = useAction((userId: string) => api.removeMember(props.projectKey, userId), props.onChanged);
  const listed = new Set(props.members.map((m) => m.user.id));
  const candidates = props.users.filter((u) => u.role === "member" && u.active && !listed.has(u.id));
  const [adding, setAdding] = useState("");
  const busy = set.busy || remove.busy;

  return (
    <>
      <h3>Members</h3>
      {props.members.length === 0 ? (
        <p className="muted">Nobody is listed.</p>
      ) : (
        <ul className="rows" aria-label="Project members">
          {props.members.map((m) => (
            <li key={m.user.id} className="row">
              <span className="grow">{m.user.name}</span>
              <AccessSelect label={`Access of ${m.user.name}`} value={m.access} disabled={busy} onChange={(a) => void set.run(m.user.id, a)} />
              <button className="link" disabled={busy} onClick={() => void remove.run(m.user.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && (
        <div className="actions add-member">
          <select aria-label="Member to add" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Choose a Member…</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
          <button disabled={busy || !adding} onClick={() => void set.run(adding, "write").then(() => setAdding(""))}>Add with Write</button>
          <button className="secondary" disabled={busy || !adding} onClick={() => void set.run(adding, "read").then(() => setAdding(""))}>
            Add with Read
          </button>
        </div>
      )}
      {(set.error ?? remove.error) && <p className="error" role="alert">{set.error ?? remove.error}</p>}
    </>
  );
}

function AccessSelect(props: { label: string; value: Access; disabled: boolean; onChange: (access: Access) => void }) {
  return (
    <select aria-label={props.label} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as Access)}>
      <option value="write">Write</option>
      <option value="read">Read</option>
    </select>
  );
}

/** Where an invitee lands from their link: sets their name and password, then is signed in. */
export function AcceptInvitationPage(props: { token: string; onDone: (user: User) => void }) {
  const [invitation] = useLoad(() => api.invitation(props.token), [props.token]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const { submit, error, busy } = useSubmit(() => api.acceptInvitation(props.token, { name, password }), props.onDone);
  if (invitation.kind === "failed") {
    return (
      <AuthCard title="Invitation unavailable">
        <p className="error" role="alert">{invitation.message}</p>
        <a className="link" href="/">Go to sign-in</a>
      </AuthCard>
    );
  }
  if (invitation.kind === "loading") return null;
  const i = invitation.value;
  return (
    <AuthCard title={`Join ${i.workspaceName}`} intro={`You were invited as ${i.email}. Choose your name and a password.`}>
      <form onSubmit={submit}>
        <Field label="Your name" value={name} onChange={setName} autoComplete="name" />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" />
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>Join</button>
      </form>
    </AuthCard>
  );
}
