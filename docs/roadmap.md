# Roadmap

Cronk is built in three phases. Vocabulary follows `GLOSSARY.md`; decisions are in `docs/adr/`. Each phase goes through the same loop:

1. **Reconcile.** Check `GLOSSARY.md` and the ADRs against what was actually built in the previous phase, and fix whichever is wrong. `/retro` on the build sessions is a separate, optional step: it improves the agent environment (checks, navigation, coding standards), not the design.
2. **Grill** the phase's open questions with `/grill-with-docs`, starting from the "Decided so far" and "Open questions" lists below.
3. **Spec** with `/to-spec`, then **tickets** with `/to-tickets` (published as GitHub issues: the spec as a parent, tickets as sub-issues), in the same session as the grilling, since both synthesise from that conversation.
4. **Build**, then update this roadmap.

## Where the design lives

A session starting a later phase should read, in order:

1. `GLOSSARY.md`: the vocabulary. Use these terms and avoid the listed synonyms.
2. `docs/adr/`: decisions that are hard to reverse (0001–0011).
3. This roadmap: scope per phase, the cross-phase choices below, and each phase's decided and open lists.
4. The Phase 1 spec, GitHub issue #1 (`gh issue view 1`): the format and level of detail a phase spec should have, and the Phase 1 model later phases build on.
5. `docs/testing.md`: the test seams every phase uses.
6. `docs/research/existing-platforms.md`: what comparable tools do, with sources, for when an open question needs outside examples.

## Settled across all phases

Choices made in the initial design that are not ADRs (easy to reverse or unsurprising) but should not be reopened without reason:

- **Vocabulary.** The unit of work is a Ticket (not Issue, Task or Work item), partly to avoid clashing with GitHub and GitLab Issues.
- **Structure.** The Workspace holds Projects plus knowledge spanning them (Documents, Terms, Decisions, Guidance) but never Tickets. Project knowledge layers over the Workspace's.
- **Agent Sessions.** One MCP connection is one Agent Session; the Claim silence threshold defaults to 5 minutes and is configurable per Workspace. Activities and tool calls keep Claims alive.
- **Ticket keys.** `<PROJECT KEY>-<n>`, numbered in order per Project by the server.
- **Ticket model.** Priority, Labels, parent, blocks / relates-to relations. No cycles, sprints, estimates, due dates or custom fields unless a later phase decides otherwise.
- **Reports.** Required whenever an Agent hands work over: moving a Ticket to In Review, or completing it under Autonomous Delegation. Not required when an Agent just releases its Claim.
- **Documents.** Human-curated Documents live in a page tree per Project and Workspace; Reports live with their Ticket; Terms and Decisions get their own views. Agents follow Guidance about where new Documents go.
- **Comments.** Threaded, on Tickets and Documents, from any Actor, optionally anchored to a passage. Answers to Agent questions are Comment replies. Comments, @mentions and answers mark work as waiting for an Agent.
- **Inbox and Triage.** One Inbox per User for everything waiting on them, blocking questions first; Triage for waiting items without a clear User.
- **Access.** Workspace roles Admin and Member; open or private Projects; Read or Write per Member. Admins have Write in every Project. A Member listed in a Project has the access listed; an unlisted Member has Write in an open Project and nothing in a private one, which answers as if it didn't exist. Only Admins change roles, invitations, visibility and listings. Protected means "Agents can't edit", not "only Admins can edit".
- **Agents and tokens.** Any User registers and manages only their own Agents; Admins can see every Agent but not change others'. An Agent calls the API with a bearer token, full or read-only; only the token's hash is stored and its secret is shown once. Revoking a token or removing the Agent refuses it at once; a deactivated Owner's Agents are refused until the Owner is reactivated. Agents can't manage Agents, change Agent Access, or do anything only Admins can, even for an Admin Owner.
- **Agent Access.** None, Read or Write, Write by default, per Project and for the Workspace (which covers what lies outside any Project, such as creating Projects or listing Users). A Project's is set by Users with Write in it; the Workspace's by Admins. An Agent's access is the lowest of its Owner's, the Agent Access and its token; a Project it has None in answers as if it didn't exist.
- **Invitations.** Until outside-app email arrives (Phase 3), inviting a User gives the Admin a one-time link, valid 7 days, to send themselves.
- **Sign-in.** Email and password, with optional OIDC in Phase 3.
- **Search.** Postgres full-text search plus context on claim. Semantic search is optional and off by default; Cronk must never require an extra AI service.
- **Notifications.** In-app live updates. Outside the app only from Phase 3, via webhooks or optional email, defaulting to urgent events only. No native apps for now.
- **Portability.** A documented HTTP API; full export as Markdown with frontmatter; import of that format and of plain Markdown folders.
- **Deployment.** Docker Compose first; standalone servers and Proxmox later, so nothing may assume Docker (ADR 0006).

## Phase 1: Core loop

Spec: GitHub issue #1; its 17 tickets are sub-issues #2–#18 with native blocking dependencies.

Workspace, Projects, Users (Admin, Member), open and private Projects, Agents with tokens and Agent Access, Agent Sessions over MCP, Tickets with Statuses, Status Categories, Priority, Labels, Sub-Tickets and blocking, Delegation, Claims, Ready and `next`, Activities, Reports (required when an Agent moves a Ticket to In Review), Comments and answering questions, the Inbox, Documents with Versions and version-based edits, Guidance, full-text search with context on claim, the HTTP API, Markdown export and import. Terms and Decisions exist only as plain Documents.

## Phase 2: Knowledge and review

Scope:

- **Terms and Decisions** as typed records, with Project Terms layered over Workspace Terms, exported as `GLOSSARY.md` and `docs/adr/`.
- **Protected** items and **Suggestions**; accepted Decisions Protected by default (ADR 0004).
- **Autonomous Delegation**: Agents may complete Tickets, each completion Unverified until a User Accepts or Reopens it (ADR 0002).
- **Discovered Tickets** filed by Agents into Backlog, and the shared **Triage** view.
- **Artifacts** with Versions, served from a separate hostname (ADR 0007), and **Attachments**.
- Inbox extended with Unverified completions, Suggestions and Discovered Tickets.

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

Open questions to grill before writing the spec:

- **Terms**: exact fields; how a Project Term overrides a Workspace Term (replace, extend, or hide); whether Agents are warned when they write a word a Term says to avoid, and where (on save, on search, in the welcome).
- **Decisions**: exact fields and statuses; how superseding works in the UI; how Decisions link to Tickets and Terms; whether Decisions can be proposed by Agents directly or only via Suggestions.
- **Suggestions**: is a Suggestion a diff against a specific Version; what happens when the item changes before the Suggestion is accepted; can a User edit a Suggestion before accepting it.
- **Protected**: who may mark or unmark; does Protected apply per item only, or also to a whole page-tree branch.
- **Autonomous Delegation**: is it set per Ticket, per parent Ticket (covering its Sub-Tickets), as a Project default, or all three; what Reopen does to dependents that already continued on the Unverified completion.
- **Discovered Tickets**: may an Agent mark a Discovered Ticket as blocking queued Tickets on its own; which Inbox or Triage it lands in when the source Ticket's Assignee is known.
- **Artifacts**: what an Agent publishes (one HTML page or a folder of files); the default CDN allow-list and how a publish declares more; links to a specific Version; how Artifacts embed in Documents and Reports; whether Artifacts take Comments and whether those reach the producing Agent; size limits.
- **Attachments**: size limits; local disk versus S3-compatible storage defaults; video handling.

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
- Real-time collaborative editing.
- Native mobile apps.
- Deployment guides for standalone servers and Proxmox.
- Multiple organizations per installation.
- Linear and Jira importers, if asked for.

## Never

- Cronk launching, hosting or supervising agents (ADR 0005).
