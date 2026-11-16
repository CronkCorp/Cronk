# Roadmap

Cronk is built in three phases. Vocabulary follows `GLOSSARY.md`; decisions are in `docs/adr/`. Each phase goes through the same loop:

1. **Reconcile.** Check `GLOSSARY.md` and the ADRs against what was actually built in the previous phase, and fix whichever is wrong. `/retro` on the build sessions is a separate, optional step: it improves the agent environment (checks, navigation, coding standards), not the design.
2. **Grill** the phase's open questions with `/grill-with-docs`, starting from the "Decided so far" and "Open questions" lists below.
3. **Prototype** the phase's new or changed key screens with `/prototype` (throwaway HTML), when the phase adds UI. Choose a direction with the User and record it in `docs/ui.md`, so tickets follow one design instead of each inventing its own.
4. **Spec** with `/to-spec`, then **tickets** with `/to-tickets` (published as GitHub issues: the spec as a parent, tickets as sub-issues), in the same session as the grilling, since both synthesise from that conversation.
5. **Build**, then update this roadmap.

Phase 1 was built without step 3; #98 reviewed its UI afterwards and wrote the first `docs/ui.md`, which later phases extend.

## Where the design lives

A session starting a later phase should read, in order:

1. `GLOSSARY.md`: the vocabulary. Use these terms and avoid the listed synonyms.
2. `docs/adr/`: decisions that are hard to reverse (0001–0014).
3. This roadmap: scope per phase, the cross-phase choices below, and each phase's decided and open lists.
4. The Phase 1 spec, GitHub issue #1 (`gh issue view 1`): the format and level of detail a phase spec should have, and the Phase 1 model later phases build on.
5. `docs/testing.md`: the test seams every phase uses.
6. `docs/research/existing-platforms.md`: what comparable tools do, with sources, for when an open question needs outside examples.

## Settled across all phases

Choices made in the initial design that are not ADRs (easy to reverse or unsurprising) but should not be reopened without reason:

- **Vocabulary.** The unit of work is a Ticket (not Issue, Task or Work item), partly to avoid clashing with GitHub and GitLab Issues.
- **Structure.** The Workspace holds Projects plus knowledge spanning them (Documents, Terms, Decisions, Guidance) but never Tickets. Project knowledge layers over the Workspace's.
- **Agent Sessions.** One MCP connection is one Agent Session; the MCP session id is the Agent Session's id. It ends when the client disconnects (an MCP DELETE) or stays silent longer than the Workspace's silence threshold (default 5 minutes, configurable per Workspace), after which the client must reconnect. Every call in a Session refreshes it; Activities and tool calls keep Claims alive. An open stream of the Session's waiting work (`GET /api/agent-sessions/current/events`) counts as not silent too: its heartbeat refreshes the Session, so an Agent waiting on a blocking question keeps its Session and Claims for as long as it stays connected. Over MCP, that stream is followed only while the client keeps open its own stream it hears notifications on, so a client that crashes without disconnecting still goes silent. The MCP server calls the HTTP API as the Agent, sending the `Cronk-Agent-Session` header so the API knows the Session; history records it. An Agent changes things only within an Agent Session: a write sent with a bare token is refused (403) with how to start one, while reads with a bare token work; a script starts a Session with `POST /api/agent-sessions` and ends it with `DELETE /api/agent-sessions/current`.
- **Ticket keys.** `<PROJECT KEY>-<n>`, numbered in order per Project by the server.
- **Ticket model.** Priority, Labels, parent, blocks / relates-to relations. No cycles, sprints, estimates, due dates or custom fields unless a later phase decides otherwise. Ticket fields are last-write-wins; only Documents take version-based edits (ADR 0009).
- **Reports.** Required whenever an Agent hands work over: moving a Ticket to In Review, or completing it under Autonomous Delegation. Not required when an Agent just releases its Claim.
- **Documents.** Human-curated Documents live in a page tree per Project and Workspace; Reports live with their Ticket; Terms and Decisions get their own views. Agents follow Guidance about where new Documents go.
- **Comments.** Threaded, on Tickets and Documents, from any Actor, optionally anchored to a passage. Answers to Agent questions are Comment replies. Comments, @mentions and answers mark work as waiting for an Agent.
- **Inbox and Triage.** One Inbox per User for everything waiting on them, blocking questions first; Triage for waiting items without a clear User.
- **Access.** Workspace roles Admin and Member; open or private Projects; Read or Write per Member. Admins have Write in every Project. A Member listed in a Project has the access listed; an unlisted Member has Write in an open Project and nothing in a private one, which answers as if it didn't exist. Only Admins change roles, invitations, visibility and listings. Protected means "Agents can't edit", not "only Admins can edit".
- **Agents and tokens.** Any User registers and manages only their own Agents; Admins can see every Agent but not change others'. An Agent calls the API with a bearer token, full or read-only; only the token's hash is stored and its secret is shown once. Revoking a token or removing the Agent refuses it at once; deactivating an Owner ends their Agents' Agent Sessions (and so their Claims) and refuses the Agents until the Owner is reactivated, when their next Agent Sessions start afresh. Agents can't manage Agents, change Agent Access, or do anything only Admins can, even for an Admin Owner.
- **Agent Access.** None, Read or Write, Write by default, per Project and for the Workspace (which covers what lies outside any Project, such as creating Projects or listing Users). A Project's is set by Users with Write in it; the Workspace's by Admins. An Agent's access is the lowest of its Owner's, the Agent Access and its token; a Project it has None in answers as if it didn't exist.
- **Users.** Unique by email across the installation, which a second Workspace (ADR 0008) would have to revisit. There is no password change or reset yet.
- **Invitations.** Until outside-app email arrives (Phase 3), inviting a User gives the Admin a one-time link, valid 7 days, to send themselves.
- **Sign-in.** Email and password, with optional OIDC in Phase 3.
- **Search.** Postgres full-text search plus context on claim. Semantic search is optional and off by default; Cronk must never require an extra AI service. Full-text search uses Postgres's `english` configuration; changing it means rebuilding the indexes.
- **Notifications.** In-app live updates. Outside the app only from Phase 3, via webhooks or optional email, defaulting to urgent events only. No native apps for now.
- **Portability.** A documented HTTP API; full export as Markdown with frontmatter; import of that format and of plain Markdown folders. Export and import are Admin-only, except that anyone who can read a scope can download its Terms alone as `GLOSSARY.md` and its Decisions alone as `docs/adr/`. Import gives Agents and Agent Sessions new ids.
- **Deployment.** Docker Compose first; standalone servers and Proxmox later, so nothing may assume Docker (ADR 0006).

## Phase 1: Core loop

Spec: GitHub issue #1; its 17 tickets are sub-issues #2–#18 with native blocking dependencies.

Workspace, Projects, Users (Admin, Member), open and private Projects, Agents with tokens and Agent Access, Agent Sessions over MCP, Tickets with Statuses, Status Categories, Priority, Labels, Sub-Tickets and blocking, Delegation, Claims, Ready and `next`, Activities, Reports (required when an Agent moves a Ticket to In Review), Comments and answering questions, the Inbox, Documents with Versions and version-based edits, Guidance, full-text search with context on claim, the HTTP API, Markdown export and import. Terms and Decisions exist only as plain Documents.

## Phase 2: Knowledge and review

Spec: GitHub issue #149; its 31 tickets are sub-issues #150–#180 with native blocking dependencies, and the Reconcile fixes #138–#145 are sub-issues too. Screens: `docs/ui.md`.

Scope:

- **Terms and Decisions** as typed records, with Project Terms layered over Workspace Terms, exported as `GLOSSARY.md` and `docs/adr/`.
- **Protected** items and **Suggestions**; accepted Decisions Protected by default (ADR 0004).
- **Autonomous Delegation**: Agents may complete Tickets, each completion Unverified until a User Accepts or Reopens it (ADR 0002).
- **Discovered Tickets** filed by Agents into Backlog, and the shared **Triage** view.
- **Artifacts** with Versions, served from a separate hostname (ADR 0007), and **Attachments**.
- Inbox extended with Unverified completions, Suggestions and Discovered Tickets.
- **Transcripts** of chats that led Agents to change things, uploaded from the client side and linked to what they led to (ADR 0013). A separate slice that nothing else in the phase depends on, so it can be built last or cut.

Decided so far (beyond the glossary and ADRs):

- Under Autonomous Delegation, an Agent's question doesn't wait: the Agent records its best guess and carries on, and the question lands in the Owner's Inbox.
- Reopening a Ticket requires a Comment saying why; it goes back to the same Delegate.
- An Unverified completion counts as finished for blocking; Reopening makes it block its dependents again.
- An Agent may split its own delegated Ticket into Sub-Tickets but may not work on Discovered Tickets until a User delegates them; the Report lists every Discovered Ticket from the work.
- A Discovered Ticket may block queued Tickets and so pause that part of an autonomous run; this is intended.
- Suggestions land in the same Inbox as Unverified completions; Suggestions on Workspace-level items with no clear owner go to Triage, as do unassigned Discovered Tickets.
- Terms and Decisions are stored as Markdown with frontmatter (ADR 0003); in the product they are called Decisions, "ADR" is only the export format.
- Artifacts belong to a Project or the Workspace, never to a Ticket or chat; they record the Ticket or Agent Session they came from and can be embedded in many places.
- Each Artifact publish creates a new Version; the Artifact's address shows the latest Version, and a link can name a specific Version. A publish based on an outdated Version is refused, so the publisher merges first.
- Artifact pages may load scripts only from a short CDN allow-list by default; anything more is declared when publishing, kept minimal.
- Transcripts are verbatim, never an Agent's summary. Cronk never captures chats; a client-side hook uploads them with the Agent's full token (read-only tokens are refused), and Cronk links them by scanning for the uploading Agent's own Agent Session ids (ADR 0013). One Transcript may cover many Agent Sessions.
- Only Transcripts whose linked Agent Sessions changed at least one thing are kept; others are refused, so a hook can upload every chat.
- Re-uploads upsert by (Agent, client chat id), such as Claude Code's `session_id`: the new text replaces the old and links only grow. If the new text doesn't continue the stored one, the old text is kept as well.
- A Transcript is readable by its Owner and by anyone with Read in every Project its Agent Sessions changed things in (Workspace read for Workspace-level changes); Agents are capped as usual (ADR 0004). The Owner may delete it. Transcripts outlive their Agent's removal.
- Cronk scrubs known secret patterns on upload (its own tokens, private keys, common provider tokens, `Authorization` headers) and never stores the originals; the Owner can also redact passages by hand, and those redactions survive re-uploads. Scrubbing is documented as best-effort.
- Transcripts are uploaded as Markdown following a documented turn convention (`## User`, `## Assistant`, tool calls and results as fenced blocks). Cronk ships a reference Claude Code hook that converts deterministically and trims long tool output; Cronk parses no client formats.
- Users and Agents can search Transcripts, as a separate result type ranked below Documents, Terms and Decisions, with hits pointing at the matching turn. Context on claim lists linked Transcripts but never includes their text.
- Every item a linked Agent Session changed gets a "From Transcript" link to the turn where its key or id first appears, falling back to the top; the Transcript view marks those turns with chips for the items.
- A Transcript may be at most 10 MB by default (configurable per Workspace); it is kept until its Owner deletes it.
- Transcripts are always part of the full export, as Markdown with frontmatter (Agent, client chat id, linked Agent Sessions and items), with hand redactions applied, and are restored on import.

Decided in the Phase 2 grilling:

- **Suggestions** are full proposed content based on a specific Version (ADR 0014). An outdated one is merged on accept. "Accept" credits the Agent; "edit and accept" credits the User and links the Suggestion. Rejecting needs a Comment, which reaches the Agent as Waiting Work. A Suggestion on a Project item goes to the source Ticket's Assignee, else the Agent's Owner, else Triage; Suggestions on Workspace items always go to Triage.
- **Protected** is set and unset by any User with Write where the item lives, recorded in its history. Protecting a Document covers every Document under it, including ones added later; adding a Document under a protected branch, or moving one in or out, takes a User or a Suggestion.
- **Terms** have a name, definition, words to avoid and an optional group. Links come from mentions: a Term's name, matched with its capitalisation, and Decision keys. A Project Term replaces a Workspace Term of the same name (ignoring case), and both views show the override. When an Agent saves text with an avoided word (outside code and quotes), the save succeeds and the result lists the words with the Term to use. The welcome lists Term names, with a tool to look one up.
- **Decisions** have a number (per Project or Workspace), title, status (proposed, accepted, rejected, deprecated, superseded), a Markdown body prefilled with the ADR sections, and an optional group. They are referred to as `CRONK-D7`, or `D7` in the Workspace. Only Users change status; superseding is set from the new Decision and takes effect when it is accepted. Agents may create proposed Decisions, which go to the source Ticket's Assignee, else the Owner; Reports list them.
- **Autonomous Delegation** is set by a User per Ticket, inherited by its Sub-Tickets, and pre-filled from a Project default (off unless changed). Reopening lists the dependents that already continued so the User can decide on each; their Agents get Waiting Work.
- **Discovered Tickets.** Every Ticket an Agent creates, other than a Sub-Ticket of its own Claimed Ticket, is one: in Backlog, undelegated, recording its source Ticket and Agent Session if any, with no Claim needed. An Agent may add blocks from its own Discovered Tickets. One goes to the source Ticket's Assignee, else the Agent's Owner; Triage only when that User has no access to the Project.
- **Claims.** Editing any field of a Ticket needs its Claim, except on Discovered Tickets the Agent filed until a User delegates them. Claiming needs the Ticket to be Ready, and a refusal says why. Moving to In Review, or completing, ends the Claim (#138).
- **Delegating** a Ticket without an Assignee assigns the delegating User. Existing unassigned delegated Tickets get their Delegate's Owner as Assignee once, on upgrade.
- **Agent writes.** Agents may still create Projects; renaming, archiving and Statuses are for Users (#139). Agents change things only within an Agent Session; reads with a bare token stay allowed.
- **Workspace knowledge.** Any User writes Workspace Documents, Terms and Decisions; only Admins write Workspace Guidance.
- **Passwords.** Admins issue one-time reset links, valid 7 days like Invitations; signed-in Users change their own; a server command issues a link for a lost last Admin. Issuing a reset ends the User's sign-ins but not their Agents' Sessions. Emailed self-service reset comes with SMTP in Phase 3.
- **Import** keeps Agent and Agent Session ids, giving a new id (and keeping the mapping) only when one is taken, so Transcripts keep linking after a move.
- **Origin.** The API refuses state-changing requests from other Origins, and the sign-in cookie becomes `SameSite=Strict`. Setup docs recommend a separate domain for Artifacts but allow a subdomain.
- **Artifacts** are published as a folder with `index.html`, the whole folder per Version. Default allow-list: cdnjs, jsDelivr, unpkg and Google Fonts; no network requests by default. A publish may declare extra origins with reasons, shown on the Artifact and never carried over; Admins can edit the list and turn extras off. A bare Artifact link on its own line embeds it (the named Version, else the latest); Reports should embed a Version. Comments record the Version viewed and reach the Agent that published it.
- **Limits and storage**, per Workspace: 25 MB and 500 files per Artifact Version, 100 MB per Attachment, no quota, storage used shown to Admins. Local disk by default, S3-compatible optional.
- **Attachments** belong to the Ticket, Document or Report they were attached to, which decides who can read them, and survive across Document Versions. Video and audio are stored as uploaded and play in the browser when MP4 or WebM; no transcoding.
- **Triage** shows each User the items they could act on (Admins see all), with a count in the sidebar. An item leaves Triage when someone acts on it.

## Phase 3: Code and reach

Scope:

- **Repositories** listed per Project.
- **Pull Request** linking by Ticket key or explicit link, shown with status and CI checks on the Ticket.
- Pull Request events drive Status: ready for review → In Review; CI failure or changes requested → back to Started with an Activity; merge by a User → Completed and Verified; automated merge → Completed but Unverified.
- **Agent Webhooks** to wake an Agent's own runner (ADR 0005), and **User Webhooks** plus optional email for urgent events such as blocking questions.
- **OIDC** sign-in.
- **GitHub Issues** importer.

Decided so far (beyond the glossary and ADRs):

- A Pull Request links to a Ticket when its branch name or title contains the Ticket key, or when an Agent links it explicitly; a Ticket may have many Pull Requests and vice versa.
- A Project can turn automatic Status changes from Pull Request events off.
- GitHub and GitLab each get an adapter behind webhooks; nothing specific to either enters the core model.
- Outside-the-app notifications by default cover only blocking questions and Reopen requests; each User chooses which event kinds notify them, via User Webhooks (e.g. n8n, ntfy, Discord, Home Assistant) or optional SMTP email.
- An Agent Webhook only signals that work is waiting; whatever runner the User has decides whether to start an Agent Session.

Open questions to grill before writing the spec: GitHub and GitLab adapter shape and authentication (app vs. token); webhook payloads and retries; which events Users can subscribe to; whether CI-driven Status changes are on by default per Project.

## Later, not scheduled

- Semantic search with pgvector (optional, off by default).
- Underlining words a Term says to avoid in the editor, for Users.
- Real-time collaborative editing.
- Native mobile apps.
- Deployment guides for standalone servers and Proxmox.
- Multiple organizations per installation.
- Linear and Jira importers, if asked for.

## Never

- Cronk launching, hosting or supervising agents (ADR 0005).
