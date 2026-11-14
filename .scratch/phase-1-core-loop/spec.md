# Phase 1: Core loop

Status: ready-for-agent

## Problem Statement

I work on several software projects with a mix of humans and AI agents (Claude Code and similar). The work itself lives in an issue tracker, the knowledge that goes with it lives in scattered Markdown files and wiki pages, and my agents have no shared, structured place to pick up work, report what they are doing, ask me questions, or record what they found. Each agent session starts from zero, two agents can start on the same task, I can't tell my own edits apart from my agents', and I have no single view of what is waiting on me. Existing tools either treat agents as an afterthought, lock my data into proprietary formats, or try to also run the agents and collapse under that scope.

## Solution

Cronk, a self-hosted platform (installed with Docker Compose) where Users and their Agents share one Workspace of Projects. Each Project holds Tickets and Documents. Users delegate Tickets to their own Agents; an Agent connects over MCP with its own token, and each connection is an Agent Session that can atomically Claim the next Ready Ticket, log Activities while it works, ask blocking questions, write a Report, and move the Ticket as far as In Review. Users see everything waiting on them in a personal Inbox, answer questions by Comment, and are the only ones who complete or cancel Tickets. Documents are Markdown, versioned, and edited safely by Users and Agents alike. Everything can be exported as Markdown and imported back. Cronk coordinates Agents but never runs them.

## User Stories

### Installation and Workspace

1. As an Admin, I want to install Cronk with a single Docker Compose file, so that self-hosting takes minutes.
2. As an Admin, I want Cronk configured entirely through environment variables, so that I can later run it outside Docker on a standalone server or Proxmox container.
3. As an Admin, I want the first account created on a fresh installation to become the Admin, so that setup needs no command-line steps.
4. As an Admin, I want to name the Workspace, so that it reflects my organization.
5. As an Admin, I want to set the Workspace's Claim silence threshold (default 5 minutes), so that I can tune how quickly abandoned Claims lapse.

### Users and access

6. As an Admin, I want to invite Users by email, so that collaborators can join my Workspace.
7. As a User, I want to sign in with email and password, so that I can access Cronk without extra infrastructure.
8. As an Admin, I want to make another User an Admin or demote them to Member, so that I can share administration.
9. As an Admin, I want to deactivate a User, so that former collaborators lose access and their Agents stop working.
10. As a Member, I want to see all open Projects, so that I can work across the Workspace by default.
11. As an Admin, I want to make a Project private and invite specific Members to it, so that sensitive work stays restricted.
12. As an Admin, I want to give each Member Read or Write access in a Project, so that some people can view without changing anything.
13. As a Member with Read access, I want to be prevented from changing anything in that Project, so that access rules are enforced.

### Projects

14. As a User, I want to create a Project with a name and a short key (e.g. `CRONK`), so that its Tickets get recognisable keys.
15. As a User, I want each Project to have its own Statuses grouped into the fixed Status Categories, so that I can tune the workflow without confusing Agents.
16. As a User, I want a sensible default set of Statuses for new Projects, so that I can start immediately.
17. As a User, I want to rename, reorder, add and remove Statuses in a Project, as long as every Status keeps a Status Category, so that the workflow fits the Project.
18. As a User, I want to set the Project's Agent Access to None, Read or Write, so that I control how much Agents may do there.
19. As a User, I want to archive a Project, so that finished work leaves my overview without being deleted.

### Tickets

20. As a User, I want to create a Ticket with a title and Markdown description, so that work is recorded.
21. As a User, I want each Ticket to get a key like `CRONK-12`, numbered in order per Project, so that I can refer to it unambiguously.
22. As a User, I want to set a Ticket's Priority (Urgent, High, Medium, Low, None), so that important work is picked first.
23. As a User, I want to add Labels to Tickets, so that I can group and filter them.
24. As a User, I want to make a Ticket the Sub-Ticket of another, so that large work can be split.
25. As a User, I want to mark that one Ticket blocks another, so that dependent work isn't started too early.
26. As a User, I want to mark Tickets as relating to each other and to Documents, so that context is one click away.
27. As a User, I want to see a Project's Tickets as a list and as a board grouped by Status, so that I get an overview.
28. As a User, I want to filter Tickets by Status, Status Category, Assignee, Delegate, Priority and Label, so that I can find what matters.
29. As a User, I want to set myself or another User as a Ticket's Assignee, so that someone is accountable.
30. As a User, I want an Agent to be refused as Assignee, so that accountability always rests with a person.
31. As a User, I want to move a Ticket to any Status, including Completed and Canceled, so that I stay in control of the workflow.
32. As a User, I want a Ticket's full history (who changed what, when, and through which Agent Session), so that I can tell my edits from my Agents'.
33. As a User, I want references like `CRONK-12` in any Markdown to become links, so that cross-referencing is effortless.

### Agents

34. As a User, I want to register an Agent (e.g. `claude-laptop`) that I own, so that my AI tools get their own identity.
35. As a User, I want to own many Agents, so that different tools and machines are told apart.
36. As a User, I want to issue a token for an Agent, optionally read-only, so that I can connect it to Cronk.
37. As a User, I want to revoke an Agent's token, so that I can cut off an Agent immediately.
38. As a User, I want to see my Agents' currently connected Agent Sessions, so that I know what is running right now.
39. As a User, I want to see everything a given Agent did, so that I can answer "what did my agents do this week?"
40. As a User, I want an Agent never to exceed my own access or the Project's Agent Access, so that delegation can't leak data or rights.

### Delegation and Claims

41. As an Assignee, I want to set one of my own Agents as a Ticket's Delegate, so that the Agent can work on it.
42. As an Assignee, I want to be refused when delegating to someone else's Agent, so that each Agent only does its Owner's work.
43. As an Agent Session, I want to ask for the next Ready Ticket and Claim it in one atomic step, so that two sessions never pick the same Ticket.
44. As an Agent Session, I want Ready Tickets offered highest Priority first, so that the most important work happens first.
45. As an Agent Session, I want Tickets blocked by unfinished Tickets left out of Ready, so that I don't start work that can't be done.
46. As an Agent Session, I want to Claim a specific Ticket delegated to my Agent, so that I can work on a Ticket I was asked about.
47. As an Agent Session, I want my Claim refused when another session holds a live Claim, so that work is never duplicated.
48. As an Agent Session, I want to release my Claim, so that another session can take over.
49. As a User, I want a Claim to lapse when its Agent Session has been silent longer than the silence threshold, so that a crashed session doesn't block the Ticket forever.
50. As a User, I want a lapsed Ticket to keep its Delegate, so that another session of the same Agent can pick it up.
51. As an Agent Session, I want to split my delegated Ticket into Sub-Tickets that stay delegated to my Agent, so that I can plan larger work.

### Working on a Ticket

52. As an Agent Session, I want to log Activities (plan, progress, finding, question, error) on the Ticket I've Claimed, so that my work is visible as it happens.
53. As a User, I want to watch a Ticket's Activities update live, so that I can follow an Agent's work.
54. As an Agent Session, I want each Activity to keep my Claim alive, so that active work never lapses.
55. As an Agent Session, I want to ask a blocking question as an Activity and wait for the answer, so that I don't guess on important choices.
56. As an Agent Session, I want to move my Claimed Ticket into Started and In Review Statuses, so that the board reflects my progress.
57. As a User, I want an Agent's attempt to move a Ticket into a Completed or Canceled Status refused, so that only humans close work.
58. As an Agent Session, I want to write a Report on the Ticket, so that my findings are recorded as a lasting Document.
58a. As a User, I want an Agent's move to In Review refused unless it wrote a Report during its Claim, so that every hand-over comes with an account of the work.
59. As a User, I want to read the Report and Activities together with Comments in one Ticket timeline, so that I see the whole story in one place.
60. As a User, I want Comments and Activities kept distinct in that timeline, so that the Agent's work log stays clean.

### Comments and questions

61. As any Actor, I want to post threaded Comments on Tickets and Documents, so that we can discuss work.
62. As a User, I want to anchor a Comment to a passage of a Document, so that feedback is precise.
63. As a User, I want to answer an Agent's question by replying to it, so that the Agent gets an unambiguous answer.
64. As an Agent Session, I want to be told when my question is answered, so that I can continue.
65. As a User, I want @mentioning an Agent, or commenting on a Ticket it's delegated, to mark work as waiting for that Agent, so that its next Agent Session picks it up.

### Inbox

66. As a User, I want an Inbox listing Tickets In Review for which I'm the Assignee, so that I know what to review.
67. As a User, I want my Agents' open questions in my Inbox with blocking questions pinned first, so that waiting Agents are unblocked quickly.
68. As a User, I want to filter my Inbox by kind, Project and Agent, so that I can work through it efficiently.
69. As a User, I want to act on Inbox items directly (complete, send back to Started with a Comment, answer), so that review is fast.
70. As a User, I want my Inbox and open views to update live, so that I never have to refresh.

### Documents

71. As a User, I want to create Documents in a Project or in the Workspace, so that knowledge has a home.
72. As a User, I want Documents arranged in a page tree, so that related knowledge sits together.
73. As a User, I want to edit Documents in a comfortable editor that saves Markdown, so that I get a good experience without lock-in.
74. As an Agent Session, I want to read and write Documents as Markdown, so that I work with exactly what is stored.
75. As an Agent Session, I want to replace a single section of a Document, so that my edits are small and rarely conflict.
76. As any Actor, I want every save to create a Version recording who made it, so that changes can be traced and undone.
77. As a User, I want to view and compare a Document's Versions and restore an earlier one, so that I can undo an Agent's mistake.
78. As an Agent Session, I want an edit based on an outdated Version refused with the current Version returned, so that I can retry without overwriting someone.
79. As a User, I want to be warned when the Document I'm editing changed underneath me, shown the other edit, and offered a merge (automatic when edits touch different sections), so that nobody's work is lost.
80. As a User, I want Reports kept out of the page tree but listed in a Project-wide Reports view, so that they don't bury curated Documents.
81. As a User, I want to keep a glossary and decision records as ordinary Documents for now, so that I can use them before their structured versions arrive.

### Guidance

82. As a User, I want to write Guidance for Agents at Workspace and Project level, so that every Agent follows our conventions.
83. As an Agent Session, I want to receive the Workspace and then Project Guidance when I connect, so that I know the rules before working.

### MCP

84. As a User, I want to connect an Agent by adding Cronk's MCP address and the Agent's token to my AI tool, so that there's nothing extra to install.
85. As an Agent Session, I want my connection to start an Agent Session and my disconnection to end it, so that sessions match reality.
86. As an Agent Session, I want a welcome on connect listing Guidance, my Agent's Ready Tickets, and work waiting for it (answered questions, new Comments), so that I can start immediately.
87. As an Agent Session, I want a small set of tools grouped by resource (Tickets, Documents, Activities, Comments, search), so that my context isn't flooded.
88. As an Agent Session, I want Claiming a Ticket to return its description, parent, related Tickets and Documents, so that I start with the right context.
89. As an Agent with a read-only token, I want write actions unavailable, so that lookup-only agents stay harmless.

### Search

90. As any Actor, I want full-text search across Tickets, Documents, Reports and Comments, filterable by kind and Project, so that I can find knowledge.
91. As an Agent Session, I want search results to include a short excerpt, so that I don't open every result.
92. As any Actor, I want search to only return what I'm allowed to see, so that access rules hold everywhere.

### API, export and import

93. As a developer, I want a documented HTTP API (OpenAPI) usable with a User or Agent token, so that scripts and CI can create and update Tickets.
94. As an Admin, I want to export the whole Workspace or one Project as a folder of Markdown files with frontmatter, so that my data is never locked in.
95. As an Admin, I want to import such an export back, so that I can move or restore an installation.
96. As a User, I want to import a folder of Markdown files as Documents, so that I can bring existing notes into Cronk.

## Implementation Decisions

- **Stack (ADR 0006).** TypeScript on server and client, Postgres for all data, one application process configured by environment variables, shipped with a Docker Compose file. No Docker-only assumptions.
- **One API, many clients.** All business rules live behind a single HTTP API. The web UI and the MCP server are both clients of it; the MCP server is a thin layer mapping grouped tools onto API operations. The API is described with OpenAPI.
- **Modules.**
  - *Identity and access*: Users, Admin/Member roles, email+password sign-in, Project membership (Read/Write), open/private Projects, Agents, Agent tokens (full or read-only). Exposes a single "can Actor do X on Y" check that every other module uses. An Agent's effective access is the lower of its Owner's access and the Project's (or Workspace's) Agent Access (ADR 0004).
  - *Work*: Projects, Statuses and Status Categories, Tickets (key, title, description, Status, Priority, Labels, parent, Assignee, Delegate), relations (blocks / relates to / links to Documents), history.
  - *Coordination*: Agent Sessions, Claims, Ready computation and `next`, Activities, silence threshold, "work waiting" markers for Agents. Claiming is a single atomic database operation; a Ticket has at most one live Claim, enforced by the database.
  - *Knowledge*: Documents (Workspace or Project, page tree), Versions, Reports (a Document kind attached to a Ticket and kept out of the tree), Guidance (Workspace and Project).
  - *Conversation*: Comments (threaded, on Tickets and Documents, optionally anchored to a passage, optionally replying to an Activity).
  - *Inbox*: a per-User computed view over Tickets In Review and Agent questions.
  - *Search*: Postgres full-text search with excerpts, filtered through the access check.
  - *Portability*: Markdown export and import.
  - *Live updates*: server-pushed change events (WebSocket or server-sent events) for the UI and Agent welcome data.
  - *MCP server*: streamable-HTTP MCP endpoint hosted by the application.
- **Actors in history.** Every change records the Actor; for Agents it also records the Agent Session. History reads "claude-laptop (session a3f2, for Christiaan) moved CRONK-12 to In Review".
- **Assignee and Delegate rules (ADR 0001).** Assignee must be a User. Delegate must be an Agent owned by the Assignee. Changing the Assignee to someone who doesn't own the Delegate clears the Delegate.
- **Status rules.** Status Categories are fixed: Backlog, Unstarted, Started, In Review, Completed, Canceled. Every Status belongs to exactly one. Agents may only move Tickets into Statuses in Unstarted, Started or In Review; Users may move into any Status.
- **Ready.** A Ticket is Ready for an Agent when its Delegate is that Agent, its Status is not Completed or Canceled, no blocking Ticket is unfinished, and it has no live Claim. `next` picks the Ready Ticket with the highest Priority, then the oldest.
- **Claims.** A Claim belongs to an Agent Session. Any Activity or tool call from the Session refreshes it. It lapses when the Session is silent longer than the Workspace's silence threshold (default 5 minutes). Lapsing keeps the Delegate. Time is read through an injectable clock so lapsing is testable.
- **Sub-Tickets by Agents.** An Agent Session holding a Claim may create Sub-Tickets of the Claimed Ticket; they inherit its Assignee and Delegate.
- **Activities.** Kinds: plan, progress, finding, question, error. A question may be marked blocking. An Activity can only be written by a Session holding the Ticket's Claim.
- **Reports.** A Report is a Document attached to a Ticket by an Agent Session; a Ticket may have several. An Agent Session may only move a Ticket into an In Review Status if the Ticket has a Report written during the current Claim; otherwise the move is refused. Releasing a Claim without handing over needs no Report. (Phase 2 extends the same rule to autonomous completions.)
- **Document storage (ADR 0003).** The stored form is Markdown with a defined set of extensions; in Phase 1 only Ticket references are an extension (rendered as links). Every save creates an immutable Version with Actor (and Agent Session).
- **Version-based edits.** Every write names the Version it is based on and is refused if that is no longer current; the refusal returns the current Version. Agents can replace a section addressed by its heading. The UI merges automatically when the two edits touch different sections, otherwise shows both and lets the User resolve.
- **Inbox.** Contains (a) Tickets in an In Review Status whose Assignee is the User, and (b) open Agent questions from Agents the User owns, blocking first. Triage is not needed yet, as every Phase 1 Inbox item has a clear User.
- **Waking Agents (ADR 0005).** Cronk never launches Agents. A Comment on a delegated Ticket, an @mention of an Agent, or an answer to its question marks work as waiting for the Agent; this appears in the welcome of its next Agent Session (and is pushed to any connected Session).
- **MCP surface.** Tools grouped by resource, each with an `action` parameter: `tickets` (list, get, next, claim, release, update status, create sub-ticket), `activities` (log, ask), `comments` (list, post), `documents` (get, list, search tree, create, update, replace section, write report), `search`. Read-only tokens see only read actions. The welcome contains Workspace then Project Guidance, the Agent's Ready Tickets, and waiting work.
- **Search.** One Postgres full-text index across Tickets, Documents (including Reports) and Comments, with excerpts, filtered by the access check. Claiming returns the Ticket with its parent, Sub-Tickets, related Tickets and linked Documents.
- **Ticket keys.** `<PROJECT KEY>-<n>`, numbered in order per Project, allocated by the server.
- **Export format.** One folder per Project plus a Workspace folder: Tickets, Documents (with Versions optional), Comments and Activities as Markdown files with YAML frontmatter holding structured fields and relations by key. Import accepts exactly this format, and separately a plain folder of Markdown files as Documents (folder structure becomes the page tree).

## Testing Decisions

- **What a good test is.** Tests exercise external behaviour only: they call the HTTP API (or the MCP protocol) as a real User or Agent token would, and assert on responses and on what a later API call returns. They never reach into tables, internal modules or private functions, so internals can be refactored freely.
- **Seam 1: HTTP API against a real Postgres (primary).** The application runs in-process against a real, disposable Postgres database per test run. Nearly every rule is tested here, including: Assignee/Delegate rules; Agents refused Completed/Canceled; Agents refused In Review without a Report from the current Claim; Agent access capped by Owner and Agent Access; read-only tokens; Ready and `next` ordering; atomic Claims under concurrent requests; Claim lapse via an injected clock; Activities only from the Claim holder; Version-based edit refusal and section replace; Inbox contents; search respecting access; export then import round-tripping to the same data.
- **Seam 2: MCP protocol (thin).** A few tests drive a real MCP client against the running server: connecting creates an Agent Session and returns the welcome with Guidance, Ready Tickets and waiting work; grouped tools map onto the API; disconnecting ends the Session; read-only tokens expose only read actions.
- **UI.** One Playwright smoke test: sign in, open the Inbox, open a Ticket. No other UI tests in Phase 1, because the UI holds no business rules.
- **Prior art.** None yet: this is the first code in the repository. The first tests written establish the pattern for the rest.

## Out of Scope

- Terms and Decisions as typed records, layered glossaries (Phase 2; plain Documents meanwhile).
- Protected items and Suggestions (Phase 2).
- Autonomous Delegation, Unverified completions, Verification, Discovered Tickets, Triage (Phase 2).
- Artifacts and Attachments, and the separate Artifact hostname (Phase 2, ADR 0007).
- Repositories, Pull Request linking, CI-driven Status changes, GitHub Issues import (Phase 3).
- Agent Webhooks, User Webhooks and email notifications (Phase 3). Phase 1 notifies only inside the app.
- OIDC sign-in (Phase 3).
- Semantic search.
- Real-time collaborative editing.
- Cycles, sprints, estimates, due dates, custom fields.
- Native mobile apps.
- Launching or hosting agents in any form (ADR 0005).

## Further Notes

- Vocabulary follows `GLOSSARY.md`; decisions follow ADRs 0001–0007. Research behind them is in `docs/research/existing-platforms.md`.
- Notifications to Users outside the app are deliberately deferred to Phase 3, alongside Agent Webhooks; until then a blocking question waits until the User next opens Cronk.
- Even though Phase 1 lacks Protected items, Autonomous Delegation and Artifacts, the data model should leave room for them (an Agent's completion flag, a Protected flag, an Artifact owner) so Phase 2 doesn't require reshaping Tickets or Documents.
