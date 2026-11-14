# Roadmap

Cronk is built in three phases. Vocabulary follows `GLOSSARY.md`; decisions are in `docs/adr/`. Each phase goes through the same loop: grill the open questions (`/grill-with-docs`), write the spec (`/to-spec`), break it into tickets (`/to-tickets`), build, then look back (`/retro`) and fix the glossary and ADRs before starting the next phase.

## Phase 1: Core loop

Spec and tickets: `.scratch/phase-1-core-loop/`.

Workspace, Projects, Users (Admin, Member), open and private Projects, Agents with tokens and Agent Access, Agent Sessions over MCP, Tickets with Statuses, Status Categories, Priority, Labels, Sub-Tickets and blocking, Delegation, Claims, Ready and `next`, Activities, Reports (required when an Agent moves a Ticket to In Review), Comments and answering questions, the Inbox, Documents with Versions and version-based edits, Guidance, full-text search with context on claim, the HTTP API, Markdown export and import. Terms and Decisions exist only as plain Documents.

## Phase 2: Knowledge and review

Scope:

- **Terms and Decisions** as typed records, with Project Terms layered over Workspace Terms, exported as `GLOSSARY.md` and `docs/adr/`.
- **Protected** items and **Suggestions**; accepted Decisions Protected by default (ADR 0004).
- **Autonomous Delegation**: Agents may complete Tickets, each completion Unverified until a User Accepts or Reopens it (ADR 0002).
- **Discovered Tickets** filed by Agents into Backlog, and the shared **Triage** view.
- **Artifacts** with Versions, served from a separate hostname (ADR 0007), and **Attachments**.
- Inbox extended with Unverified completions, Suggestions and Discovered Tickets.

Open questions to grill before writing the spec:

- **Terms**: exact fields; how a Project Term overrides a Workspace Term (replace, extend, or hide); whether Agents are warned when they write a word a Term says to avoid, and where (on save, on search, in the welcome).
- **Decisions**: exact fields and statuses; how superseding works in the UI; how Decisions link to Tickets and Terms; whether Decisions can be proposed by Agents directly or only via Suggestions.
- **Suggestions**: is a Suggestion a diff against a specific Version; what happens when the item changes before the Suggestion is accepted; can a User edit a Suggestion before accepting it.
- **Protected**: who may mark or unmark; does Protected apply per item only, or also to a whole page-tree branch.
- **Autonomous Delegation**: is it set per Ticket, per parent Ticket (covering its Sub-Tickets), as a Project default, or all three; what Reopen does to dependents that already continued on the Unverified completion.
- **Discovered Tickets**: may an Agent mark a Discovered Ticket as blocking queued Tickets on its own; which Inbox or Triage it lands in when the source Ticket's Assignee is known.
- **Artifacts**: what an Agent publishes (one HTML page or a folder of files); the default CDN allow-list and how a publish declares more; links to a specific Version; how Artifacts embed in Documents and Reports; size limits.
- **Attachments**: size limits; local disk versus S3-compatible storage defaults; video handling.

## Phase 3: Code and reach

Scope:

- **Repositories** listed per Project.
- **Pull Request** linking by Ticket key or explicit link, shown with status and CI checks on the Ticket.
- Pull Request events drive Status: ready for review → In Review; CI failure or changes requested → back to Started with an Activity; merge by a User → Completed and Verified; automated merge → Completed but Unverified.
- **Agent Webhooks** to wake an Agent's own runner (ADR 0005), and **User Webhooks** plus optional email for urgent events such as blocking questions.
- **OIDC** sign-in.
- **GitHub Issues** importer.

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
