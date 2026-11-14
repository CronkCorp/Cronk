# Existing platforms: issues + docs + artifacts + agents

Research date: 2026-11-14. Sources are official docs, product pages, changelogs and GitHub repos unless marked *(secondary)*. Product features in this space change monthly, so check the cited page before relying on a detail.

**Scope.** This note informs the design of one platform that combines issue tracking, a wiki, hosting for agent-made artifacts, a glossary and an ADR log. Humans and AI agents share it, and agents connect over MCP.

---

## 1. Platforms that already combine issues and docs

### Linear (issues, Projects, Docs, MCP, agents)

**Summary.** Linear is the reference design for treating agents as first-class participants in an issue tracker. Its workspace is organised around teams. Each team owns a workflow, cycles, triage and issues. Documents hang off projects and initiatives, and since June 2026 also off teams ("team documents"). Linear runs a hosted MCP server, and it has a dedicated Agent API in which agents are app users that can be *delegated* issues. Partner agents include Cursor, Codex, Copilot, Devin and Sentry.

**Data model.** The concepts are Workspace, Team (nestable), Issue, Workflow (ordered statuses per team), Triage, Project, Milestone, Initiative (nestable), Cycle, View and Document ([conceptual model](https://linear.app/docs/conceptual-model)). Team documents are created from the team home page ([changelog 2026-06-04](https://linear.app/changelog/2026-06-04-team-documents)). Private teams are limited to invited members ([teams](https://linear.app/docs/teams)).

**How agents interact.**
- **MCP.** The server is at `https://mcp.linear.app/mcp` (Streamable HTTP, OAuth 2.1 with dynamic client registration, or a bearer API key). A separate read-only endpoint is at `/mcp/readonly`, or a client can request only the `read` scope ([MCP docs](https://linear.app/docs/mcp)).
- **Agent identity.** Agents install with `actor=app` and become an *app user*. Opt-in scopes are `app:assignable` (the agent can be a delegate) and `app:mentionable`. An `actor=app` install cannot request `admin` ([developers/agents](https://linear.app/developers/agents)).
- **Delegate vs assignee.** When an agent is "assigned" an issue, it is set as the **delegate** and the human stays the **assignee**. Agents cannot be project members or leads. "Agents cannot sign in to the app, access admin functionality or manage users" ([agents in Linear](https://linear.app/docs/agents-in-linear)).
- **Agent Sessions.** A session is created on mention or delegation, and its state is derived from the activities the agent emits. The states are `pending`, `active`, `error`, `awaitingInput`, `complete` and `stale`. The activity types are `thought`, `elicitation`, `action`, `response`, `error` and `prompt` (prompt is user-only). `thought` and `action` can be `ephemeral`. A session-level **plan** is a checklist whose items have a status. `externalUrls` link out to the agent's own UI. The agent must acknowledge a session within 10 seconds or it is marked unresponsive ([agent interaction](https://linear.app/developers/agent-interaction)).
- **Guidance.** Admins write markdown guidance for agents at workspace level and per team, and team guidance wins. Admins also choose which teams an agent can access ([agents in Linear](https://linear.app/docs/agents-in-linear)).

**Steal this.**
- Keep a human accountable owner (assignee) and an agent executor (delegate) as separate fields.
- Model sessions and activities as a typed log of agent work, with state derived from the last activity instead of set by hand.
- Offer a read-only MCP endpoint.
- Let admins write guidance per team.
- Make agents non-billable app users that admins scope per team.

**Avoid this.**
- Docs are second-class: they attach to projects, initiatives or teams and have no real tree or wiki.
- There is no artifact hosting. Agents link out through `externalUrls`.
- Write permissions for documents vs issues can't be scoped finely per agent; the controls are team access plus the read scope.

### Plane (open source: work items, Pages/Wiki, Agents)

**Summary.** Plane is an open-source Jira/Linear alternative (the platform is AGPL *(secondary)*). It combines work items with **Pages**, which live at three levels: project, workspace **Wiki**, and teamspace. In September 2026 it shipped **Plane Agents**, a near copy of Linear's agent-session model. Its MCP server is MIT-licensed ([plane-mcp-server](https://github.com/makeplane/plane-mcp-server)).

**Data model.** Workspace, Project, Work item, Cycle, Module, Teamspace, Release, Customer and Page. Pages can be nested, labelled, version-historied, inline-commented, templated, published to the web, and linked to work items. Wiki pages can additionally be shared with specific members and grouped into collections ([pages overview](https://docs.plane.so/core-concepts/pages/overview)).

**Agents.**
- **MCP.** The hosted endpoint is `https://mcp.plane.so/http/mcp` (OAuth), or a PAT at `/http/api-key/mcp`. The server has 30 resource tools, each taking an `action` parameter (207 operations in total), plus a `get_pql_reference` tool for Plane's query language. The hosted server reaches Plane Cloud only. Self-hosters run it locally.
- **Plane Agents (beta in the dev docs).** An OAuth app with "Enable App Mentions" becomes a non-billable **bot user**. Mentions create an **Agent Run** with states `created`, `in_progress`, `awaiting`, `completed`, `stopping`, `stopped`, `failed` and `stale` (stale after 5 minutes without updates). Activities are `prompt`, `thought`, `action`, `response`, `elicitation` and `error`. `response` and `elicitation` become comments ([dev docs](https://developers.plane.so/dev-tools/agents/overview), [launch](https://plane.so/blog/agents-are-now-live-in-plane)).

**Steal this.**
- A three-level page placement (project / team / workspace wiki) with clear visibility rules per level.
- Pages linked to work items.
- One MCP tool per resource with an `action` parameter, which keeps the tool list small.
- A query language the agent can learn through a reference tool.

**Avoid this.**
- Feature parity differs by placement: teamspace pages can't be published or linked, which is confusing.
- Self-hosted CE has no public Pages API, so a community MCP uses the internal API ([plane-ce-mcp](https://glama.ai/mcp/servers/Bl4nk44/plane-ce-mcp) *(secondary)*). Make docs a first-class API from day one.

### Huly (open-source all-in-one) — cautionary tale

**Summary.** Huly bundled tracker, documents, chat, CRM, HRM and ATS into one EPL-2.0 platform. The README now says: "This repository is frozen and is no longer actively maintained" and "The hosted platform is no longer available" ([hcengineering/platform](https://github.com/hcengineering/platform)). It is not a viable base or dependency.

**Avoid this.** Scope sprawl. "Replace Notion + Slack + Linear + CRM" in one product proved unsustainable. Keep the combined scope narrow: work, knowledge, artifacts.

### Notion (pages, databases, MCP, Custom Agents)

**Summary.** Notion's universal primitive is the page. Databases are collections of pages with typed properties, so "issues" are just a database. Notion runs a hosted MCP server, and the local `@notionhq/notion-mcp-server` is effectively deprecated *(secondary)*. **Custom Agents** are workspace agents with their *own* permissions.

**Data model.** Page = properties + blocks. Database → **data sources** (the schema lives here since API 2025-09-03) → pages. Views and linked databases display a data source elsewhere ([working with databases](https://developers.notion.com/docs/working-with-databases)).

**Agents and permissions.**
- MCP is hosted at `mcp.notion.com/mcp` *(secondary)*. It searches, creates and edits pages and manages databases. Admins can manage MCP clients ([Notion MCP](https://developers.notion.com/docs/mcp)).
- A Custom Agent "responds using *the agent's own access*, not the permissions of the person who triggered it." New agents start with **no access**, and pages are granted explicitly at Can view / Can comment / Can edit. You "can't grant higher than Can View to all pages in a workspace." Who can use or edit the agent is a separate layer: *Can view and interact*, *Can edit*, *Full access*. Page owners can remove an agent from their pages ([sharing & permissions](https://www.notion.com/help/custom-agents-sharing-and-permissions)).

**Steal this.**
- The agent as a principal with its own ACL that starts at default-deny.
- Separate access levels for "what the agent can touch" and "who can drive the agent".
- Page owners can evict an agent.
- The workspace-wide cap at view-only maps exactly onto a "human-only area agents can read".

**Avoid this.**
- An agent with its own access can leak content to invokers who couldn't see it directly (Notion calls this out).
- Generic databases-as-issues means no native workflow semantics such as triage, cycles or blocked-by. Agents have to infer conventions per workspace.

### Jira + Confluence (Rovo, Rovo MCP, agents in Jira)

**Summary.** Atlassian splits issues (Jira) and docs (Confluence) into separate products joined by "Teamwork Graph". **Rovo** is the AI layer. The hosted **Rovo MCP Server** covers Jira, Confluence, Bitbucket, Compass and JSM through one endpoint (`mcp.atlassian.com/v1/mcp` *(secondary)*), with OAuth 2.1 or API tokens, and calls consume Rovo credits ([support](https://support.atlassian.com/rovo/docs/atlassian-remote-mcp-server/)). **Agents in Jira** puts Rovo, space-built and third-party agents (Copilot coding agent first) into work items.

**Agent interaction.** Agents can be invoked four ways: from the Agents picker on a work item, by @mention, by a **workflow transition rule** (the agent runs when an item enters a status), or by a **board column** (team-managed spaces). Only the person who triggered the agent sees its output until it is shared as a comment ([collaborate with AI agents](https://support.atlassian.com/jira-software-cloud/docs/collaborate-on-work-items-with-ai-agents/)).

**Permissions.** Rovo agents act *on behalf of the invoking user* and see only what that user can see. Automations run as the rule creator ([Rovo agent permissions](https://support.atlassian.com/rovo/docs/rovo-agent-permissions-and-governance/)). Admins allow or block MCP access per app in Atlassian Administration. Guard can block AI reads of specific content *(secondary)*.

**Steal this.**
- Workflow states and board columns that trigger agents, so dropping a card into a column runs the agent.
- Agent output stays private to the triggerer until a human publishes it, a review gate for free.
- One MCP endpoint across issues and docs.

**Avoid this.**
- Two products, two permission systems, two search indexes, joined after the fact.
- Pure "act as user" delegation can't express an area agents may only read.
- Inconsistent automation identity (AUTO-2337 vs ROVO-837 on the [Jira tracker](https://jira.atlassian.com/browse/ROVO-837)).
- Metered credits on every agent call.

### GitHub (Issues, Projects, Wiki, Copilot cloud agent, Agent HQ)

**Summary.** Issues now have org-level **issue types**, **sub-issues** and **issue fields** pinned to types. Projects are views over issues with up to 50 fields ([best practices](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/best-practices-for-projects), [issue fields](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields)). The Wiki is a separate git repo with no links to issues. Issues can be assigned to the Copilot cloud agent. **Agent HQ** (Feb 2026, public preview) adds Claude and Codex as assignable agents ([GitHub blog](https://github.blog/news-insights/company-news/welcome-home-agents/)).

**Agent interaction.**
- **Guardrails.** Copilot pushes only to a `copilot/` branch, or to the PR branch it was mentioned on. Only users with write access can trigger it. It can't approve, merge or mark a PR ready. The requester can't approve their own agent PR. Actions workflows wait for "Approve and run". Commits are authored by Copilot, co-authored by the human, signed, and link to session logs ([risks & mitigations](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations)).
- **MCP.** The remote server is at `https://api.githubcopilot.com/mcp/`. Tools are grouped into **toolsets** (`repos`, `issues`, `actions`…), and a `--read-only` flag overrides any write tool ([github-mcp-server](https://github.com/github/github-mcp-server)).

**Steal this.**
- Constrain an agent's write *surface*, not only its role: a dedicated branch namespace, never approve its own work, a human-in-the-loop gate before side effects.
- Attribute work as agent author + human co-author, with a link to the session log.
- Toolsets plus read-only mode for MCP context control.

**Avoid this.**
- The Wiki is a disconnected git repo with no backlinks to issues. Docs are an afterthought.
- Projects cap fields, and issue fields are org-scoped.

### GitLab (issues, wiki, Duo Agent Platform)

**Summary.** GitLab has issues/work items, a project and group wiki, and the **Duo Agent Platform**. Assigning an issue to the "Duo Developer" service account (or clicking "Implement work item") starts a **flow**, and progress appears under *AI > Sessions* ([Developer flow](https://docs.gitlab.com/user/project/merge_requests/developer/)). External agents each need a group service account ([external agents](https://docs.gitlab.com/user/duo_agent_platform/agents/external/)).

**Permissions — composite identity.** One token combines the human and a service account. The effective role is the *more restrictive* of the two. Accessible projects are the *intersection* of both principals'. Token scopes are limited to `ai_workflows` + `mcp`. The human is the primary author of MRs and the service account is the secondary author on commits. Service accounts are named `ai-<flow>-<group>` or `duo-<flow>-<group>` ([composite identity](https://docs.gitlab.com/user/duo_agent_platform/composite_identity/)).

**Steal this.** Composite identity is the cleanest model found for "the agent works for Alice but must never exceed its own grants". Effective permission = user ∩ agent.

**Avoid this.** Per-project service-account plumbing and push rules that block agents by commit email or branch prefix (a documented troubleshooting item).

### Shortcut

**Summary.** Stories, Epics, Iterations, Objectives and **Docs** in one product. The hosted MCP is at `https://mcp.shortcut.com/mcp` with OAuth and no tokens. It finds, creates and updates Stories, Epics and Docs. A `read` OAuth scope gives read-only access, and some entities (Objectives, Teams, Members, Workflows) are always read-only ([MCP help](https://www.shortcut.com/help/integrations/mcp-server.md)).

**Steal this.** Mark some entity types as read-only for every agent regardless of scope. Workflow and team definitions are a good candidate.

### Height — dead

Height shut down on 24 Sep 2025 ([AlternativeTo news](https://alternativeto.net/news/2025/3/height-project-management-tool-to-shut-down-by-september-2025) *(secondary)*). It is listed only to note that even an "AI-first tracker" positioning did not save it.

### AFFiNE / AppFlowy

Local-first Notion alternatives. In AFFiNE, docs and whiteboards are two views of the same block data, with database and kanban views, built on BlockSuite/OctoBase/y-octo CRDTs *(secondary: [opentechhub](https://www.opentechhub.io/affine-an-ambitious-local-first-open-source-workspace-attempting-to-merge-notion-miro-and-jira/))*. Official MCP support is unconfirmed. They matter mainly as references for the editor and sync layer (CRDT block editors), not for workflow or agents.

### Outline (open-source wiki)

**Summary.** A clean Markdown-ish wiki with collections and nested docs. It shipped an **official built-in MCP** at `https://<subdomain>.getoutline.com/mcp` (also on self-hosted instances), Streamable HTTP only, OAuth by default or an API key. It searches, reads, creates and edits documents. Admins toggle MCP workspace-wide, and a settings field holds *guidance for the AI* on navigating the knowledge base ([Outline MCP guide](https://docs.getoutline.com/s/guide/doc/mcp-6j9jtENNKL)).

**Steal this.** A built-in MCP on self-hosted instances (`/mcp` on your own domain), plus an admin-written "how to navigate this KB" guidance string.

**Avoid this.** There is no issue tracking, and per-collection agent scoping isn't documented.

---

## 2. Agent-native task and knowledge tools

### beads (steveyegge/beads)

**Summary.** "A distributed graph issue tracker for AI agents." The backend is now **Dolt**, a versioned SQL database with cell-level merge, branching and push/pull to `refs/dolt/data` on a git remote. JSONL is only an export ([repo](https://github.com/steveyegge/beads)).

**Data model.**
- Issue fields are title, priority, type, status (`open` / `in_progress` / `closed`), assignee, labels, due/defer dates and external refs.
- Dependencies are `blocks`, `related` and `parent-child`. Knowledge links are `relates-to`, `duplicates`, `supersedes` and `replies-to`.
- Messages are an issue type with threads.
- Hash IDs (`bd-a1b2`) with dotted children (`bd-a3f8.1.1`) avoid merge collisions.

**Agent loop.**
1. `bd prime` injects workflow context and memories.
2. `bd ready` lists unblocked work.
3. `bd update <id> --claim` atomically sets assignee and in_progress.
4. `bd close` finishes the item.

`bd remember` stores project memory. Compaction summarises old closed tasks ("memory decay"). `bd init` writes AGENTS.md.

**Steal this.**
- A **ready queue** computed from the dependency graph.
- **Atomic claim**, essential when several agents race for work.
- Hash IDs for distributed creation.
- A "prime" call that returns everything an agent needs to start.
- Memory compaction of closed work.

**Avoid this.** It is repo-local, CLI-first and has no human-friendly docs or UI. It is a backend for agents, not a shared knowledge base.

### Backlog.md

**Summary.** Each task is a Markdown file in `backlog/`, with ID prefix `TASK-1`, acceptance criteria, a Definition-of-Done checklist, dependencies, milestones, an implementation plan and notes. There are also `docs/`, `decisions/` and drafts. It has a kanban web UI (`backlog browser`) that writes back to the files, and an MCP server (`backlog mcp start`) that exposes workflow guidance as resources (`backlog://workflow/overview`). The recommended agent workflow has three review checkpoints (spec → plan → code), one task per session and one PR per task ([repo](https://github.com/MrLesk/Backlog.md)).

**Steal this.**
- Tasks, docs and decisions side by side in one tool.
- Acceptance criteria and DoD as structured fields.
- Workflow instructions served as MCP *resources*.
- Archive = read-only but still searchable.

**Avoid this.** Files-in-repo doesn't scale to multi-repo or non-code knowledge, and has no permissions.

### Task Master (claude-task-master)

**Summary.** Parses a PRD (`.taskmaster/docs/prd.txt`) into tasks with dependencies, subtasks and complexity analysis. Tags separate workstreams. The MCP server offers selectable tool tiers: `core` (7), `standard` (15), `all` (36), set by `TASK_MASTER_TOOLS` ([repo](https://github.com/eyaltoledano/claude-task-master)).

**Steal this.**
- **Tiered MCP tool sets** to save agent context.
- The PRD → task decomposition workflow, with the PRD kept as a linked doc.

### Vibe Kanban — sunsetting

**Summary.** A kanban board that launches coding agents (Claude Code, Codex, Gemini CLI, Copilot, Amp, Cursor and others) into isolated workspaces (branch + terminal + dev server), with diff review and inline comments fed back to the agent ([repo](https://github.com/BloopAI/vibe-kanban)). bloop shut down in April 2026. Remote features (issues, comments, projects, orgs) were removed and the product went local-only and community-maintained ([shutdown notice](https://vibekanban.com/blog/shutdown)).

**Steal this.** Board card → isolated agent workspace → review diff → comment back to the agent.

**Avoid this.** Coupling the tracker to agent *execution*. Execution was the expensive, commoditised part. Store and coordinate work, and let external agents execute.

### Conventions: AGENTS.md and memory banks

- **AGENTS.md.** Plain Markdown "README for agents", stewarded by the Agentic AI Foundation (Linux Foundation). The nearest file in the tree wins and user prompts override it. Codex, Copilot, Cursor, Devin, Jules, Gemini CLI, Zed and others support it, and over 60k repos use it ([agents.md](https://agents.md/)).
- **Cline Memory Bank.** Fixed files: `projectbrief.md`, `productContext.md`, `activeContext.md`, `systemPatterns.md`, `techContext.md`, `progress.md`. The agent reads them at the start of a task and updates them at milestones ([Cline docs](https://docs.cline.bot/features/memory-bank)).

**Steal this.**
- Export or serve AGENTS.md-style project guidance from the platform, so it plugs into existing agents.
- A small, opinionated set of "context" docs (brief, active context, progress) that agents keep current. This is what agents write "findings into documents" means in practice.

---

## 3. Artifact hosting (agent outputs: storage, versions, sharing)

### Claude Artifacts (claude.ai / Claude Code)

**Summary.** An artifact is a single self-contained HTML or Markdown page published to a private URL on claude.ai and served under a strict CSP from a sandboxed `*.claudeusercontent.com` origin. The CDN allowlist is cdnjs, unpkg, jsDelivr `/npm/`, Tailwind and jQuery. The page has no backend, a 16 MiB limit and no relative links ([Claude Code artifacts](https://code.claude.com/docs/en/artifacts)).

**Model.**
- **Versions.** Each publish to the same URL is a **version**. The Share control picks "always latest" or a pinned version.
- **Sharing.** Audiences are private → specific people / whole org → shared folder → public link. Public sharing is off by default on Team/Enterprise.
- **Editors.** Editors republish through their own agent. A publish built on a stale copy is refused and must be merged first (optimistic concurrency).
- **Comments.** Threads sit on the page. "Send to Claude" or `@claude` routes a thread to the publishing agent session, which can reply, with rate limits.
- **Runtime capabilities.** These are declared at publish time (MCP connector calls, file downloads). Connector calls run with the **viewer's** account.
- **Admin.** Retention policies are set separately for private and shared artifacts. A Compliance API lists versions and deletes artifacts.
- **Persistence.** Viewers' state lives in browser storage, and shared state needs a declared capability.

**Steal this.**
- Version-per-publish on a stable URL with a pinned or latest choice.
- Optimistic-concurrency refusal on stale publishes.
- Comment threads that route to an agent.
- A sandboxed origin with a CSP.
- Capabilities declared up front and reviewed at publish.
- Viewer-identity data calls.

**Avoid this.**
- Artifacts are tied to a chat or session account, not to a project, ticket or doc.
- No backlinks to the work item that produced the artifact.
- Single page only.

### v0 (Vercel)

**Summary.** Every chat belongs to a **Project**. Each message that changes code creates a **version**; direct edits don't. Publishing deploys to Vercel with a stable production URL, and working branches get preview deployments. Several chats can share a project and its production URL. The Platform API can **fork a chat from a specific version** and list versions ([versions](https://0jo2xuhypsg.v0.build/docs/versions), [deployments](https://v0.app/docs/deployments), [platform API](https://v0.dev/docs/api/platform)).

**Steal this.**
- Preview vs production URLs.
- Fork-from-version.
- Many sessions contributing to one project artifact.

### Lovable

**Summary.** Every change is a version automatically, and you can bookmark and revert versions. GitHub sync pushes Lovable's changes to a separate `lovable-sync` branch ([git sync](https://docs.lovable.dev/integrations/git-sync-overview)). **Project access** (who can view, edit or remix in the editor) is separate from **who can visit the published app**. Public projects were removed on 22 Apr 2026 ([project visibility](https://docs.lovable.dev/features/project-visibility)).

**Steal this.**
- Keep "who can see the source and history" separate from "who can view the rendered output".
- Bookmarked versions.

### Val Town

**Summary.** Vals are small hosted TypeScript projects. Every file change is versioned, with branches and remixes. HTTP vals expose public endpoints even when the code is private. An official MCP server offers more than three dozen tools (code, SQLite, blobs, logs) and surfaces agent instructions to any agent ([docs index](https://docs.val.town/llms.txt), [changelog May 2026](https://releases.sh/release/rel_usp92y_ose6A4mEFBU9bD-changelog-may-26-2026) *(secondary)*).

**Steal this.** Branches and remixes for artifacts, with public output and private source.

### GitHub/GitLab Pages-style previews

The model is a per-branch or per-PR preview deploy (v0 and Vercel do this natively, and Log4brains documents GitHub/GitLab Pages CI). The useful idea is a **preview URL per ticket or PR** that is torn down on merge.

---

## 4. Glossary and ADR tooling

| Tool | What it is | Notes |
|---|---|---|
| **MADR 4.0.0** ([adr.github.io/madr](https://adr.github.io/madr/)) | ADR template | Sections: Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome (Consequences good/bad/neutral, **Confirmation**), Pros and Cons, More Information. Status values: proposed / rejected / accepted / deprecated / "superseded by ADR-NNNN". Front matter: `status`, `date`, `decision-makers`, `consulted`, `informed`. Files: `docs/decisions/NNNN-title.md` |
| **adr-tools** ([npryce/adr-tools](https://github.com/npryce/adr-tools)) | Bash CLI | `adr init`, `adr new`, `adr new -s N` creates a new ADR and marks N superseded |
| **Log4brains** ([thomvaill/log4brains](https://github.com/thomvaill/log4brains)) | ADRs → static site | MADR by default, **no numbering** (avoids merge conflicts), infers metadata from git log, timeline and search. Activity appears low (Releases list empty) |
| **Backstage TechDocs** ([docs](https://backstage.io/docs/features/techdocs/)) | Docs-like-code | Markdown next to code, built with MkDocs, stored in S3/GCS/Azure, shown on the owning **catalog entity's** page |
| **Contextive** ([dev-cycles/contextive](https://github.com/dev-cycles/contextive)) | Glossary as a first-class artifact | YAML term definitions (`*.glossary.yml`, per module) shown in IDE hover and autocomplete over LSP |

**Gap.** No mainstream tracker or wiki treats the **glossary** as a structured entity. Contextive is the only tool found that does, and only inside the IDE. ADRs are treated as Markdown files with a status line. None of them link decisions to the tickets that implement them or to the glossary terms they define.

**Steal this.**
- MADR's fields as a structured schema: status, deciders, consulted/informed, considered options, consequences, confirmation.
- `supersedes` as a typed link (beads has it too).
- Glossary terms as entities that other content references and that hover or autocomplete in the editor.
- Glossary served to agents as an MCP resource.

---

## 5. Permission models for "agents can read but not write some areas"

| Platform | Agent principal | How scope is limited | Can express "agent read-only here"? |
|---|---|---|---|
| **Linear** | App user (`actor=app`), non-billable, no login/admin | OAuth scopes (`read`, `write`, `app:assignable`, `app:mentionable`…), admin picks teams, read-only MCP endpoint | Per team (on/off), global read-only. **Not** per document |
| **Plane** | Bot user per OAuth app | Workspace install by admin. Scopes not documented | Not documented |
| **Notion Custom Agents** | Own principal, own ACL, default no access | Per page/db: view / comment / edit. Workspace-wide max = view. Page owners can remove agents | **Yes**, natively |
| **Notion AI / MCP** | The user | User's permissions | No (inherits user) |
| **Atlassian Rovo** | The invoking user (or automation creator) | Space/page/project perms of that user. Admin allow/block per app for MCP. Guard data controls | Only via the user's own perms |
| **GitHub Copilot agent** | App identity + human co-author | Write access to trigger. `copilot/` branches only. Can't approve or merge. Workflows need approval | By surface (branch namespace), not by path |
| **GitLab Duo** | Composite identity (user + service account) | Effective = min(role) and ∩(projects). Token scopes `ai_workflows`, `mcp` | **Yes**: give the service account Reporter (read) on a project and the intersection makes it read-only even for an Owner user |
| **Shortcut / Outline / Linear MCP** | The user (OAuth) | `read` scope / workspace toggle | Global only |

**Takeaways for "human-only area".**
1. Make the agent a **distinct principal** (Linear, Notion, GitLab), never just the user's token.
2. Compute effective permission as **user ∩ agent** (GitLab composite identity). This prevents the Notion leak where an agent sees more than its invoker, and the Rovo problem where an agent gets everything its user has.
3. Grant per area at the levels **view / comment / edit**, default **no access**, with a workspace-level ceiling (Notion caps workspace-wide grants at view).
4. Let some entity types be read-only for all agents (Shortcut).
5. Constrain write *surfaces*: agents propose, humans accept. Examples: GitHub's own-branch and can't-approve rules, and Jira's private-until-shared output.

---

## 6. Synthesis

### Recurring patterns

1. **Agent = a non-billable app/bot user that can be assigned or mentioned** (Linear, Plane, Jira, GitHub, GitLab). It is now table stakes.
2. **Accountability split.** A human stays the owner while the agent executes: Linear `assignee` vs `delegate`, GitHub author + co-author, GitLab primary vs secondary author.
3. **Agent session / run as a typed activity log** (thought / action / elicitation / response / error, with state derived from activity). Linear and Plane have converged on almost identical schemas, so it is a de facto standard worth adopting.
4. **Hosted remote MCP with OAuth plus a read-only mode** (Linear, Notion, Atlassian, GitHub, Shortcut, Outline, Plane). Toolsets or tiers control context size (GitHub, Task Master). Admin-written **guidance** is served to agents (Linear, Outline, Backlog.md, AGENTS.md).
5. **Workflow-triggered agents.** Moving an item into a status or column runs an agent (Jira, GitLab assign triggers).
6. **Human review gates.** Agent output is private until shared (Jira). Agents can't approve or merge (GitHub). Backlog.md has spec → plan → code checkpoints.
7. **Version-per-publish on a stable URL** for artifacts (Claude, v0, Lovable, Val Town), with pinned vs latest and fork/remix.
8. **Graph semantics for agents.** Agents need a ready queue (blocked-by), atomic claim and memory compaction (beads). Humans rarely ask for these, but agents need them.

### Gaps nobody fills well

- **Issues + docs + artifacts in one graph.** Linear and Plane have issues and docs but no artifact hosting. Claude, v0 and Lovable host artifacts but tie them to a chat session, not to a ticket or doc. Nobody backlinks "this prototype was produced while working ticket X and is referenced in doc Y".
- **The glossary as a first-class, agent-served entity.** Absent everywhere except Contextive in the IDE.
- **ADRs as structured, linkable records.** Every tool treats them as Markdown files. None links decision → implementing tickets → superseded decision → glossary terms.
- **Per-area agent permissions combined with user ∩ agent.** Notion has per-page agent ACLs but no intersection. GitLab has the intersection but only at project/role granularity. Nobody offers "this space is human-authored; agents read only" as a simple space-level switch.
- **Agent-written findings in docs.** Agents can edit docs (Notion, Outline, Linear MCP), but no tool separates *agent-authored* from *human-authored* content, or offers a "proposed edit / suggestion" mode for agents in human areas.
- **Coordination for many agents.** Atomic claim, leases or heartbeats (Linear's 10 s ack and Plane's 5-minute stale come closest) and a dependency-aware ready queue exist in beads but not in SaaS trackers.
- **Sustainability warning.** Huly (frozen), Height (shut down) and Vibe Kanban (sunset) show the cost of sprawl and of owning agent execution. Store and coordinate; don't execute.

### Vocabulary across tools

| Concept | Names in the wild | Notes for choosing |
|---|---|---|
| Top-level tenant | Workspace (Linear, Notion, Plane, Outline), Site/Org (Atlassian), Organization (GitHub) | "Workspace" dominates |
| Group of people with a workflow | Team (Linear), Teamspace (Plane), Space (Jira/Confluence), Group (GitLab) | "Space" fits a KB with per-area permissions |
| Unit of work | Issue (Linear, GitHub, GitLab), Work item (Plane, Jira, GitLab), Story (Shortcut), Task (Backlog.md, Task Master), Bead (beads) | "Issue" is most familiar. "Work item" is the vendor-neutral trend. "Ticket" is used colloquially but appears in no product found |
| Outcome-scoped grouping | Project (Linear/Plane), Epic (Jira/Shortcut), Milestone | |
| Time box | Cycle (Linear, Plane), Sprint (Jira), Iteration (Shortcut) | |
| Ordered statuses | Workflow / Status (Linear), State (Plane) | |
| Long-form knowledge | Document (Linear, Outline), Page (Notion, Plane, Confluence), Doc (Shortcut), Wiki | "Page" in tree/wiki contexts, "Document" for standalone |
| Docs container | Collection (Outline, Plane wiki), Space (Confluence), Wiki | |
| Agent executing work | Delegate (Linear), Assignee (Jira, GitHub, GitLab), Agent | |
| One agent engagement | Agent Session (Linear, GitLab "Sessions"), Agent Run (Plane), Session (Copilot) | "Session" is most common |
| Agent output step | Activity (Linear, Plane), with types thought / action / elicitation / response / error | |
| Agent instructions | Guidance (Linear), AGENTS.md, Custom instructions (GitHub), Rules (Cline), "AI guidance" (Outline) | |
| Agent-produced page | Artifact (Claude), Version / Deployment (v0), Val (Val Town), Preview | "Artifact" is now widely understood |
| Snapshot | Version (Claude, v0, Lovable, Val Town), Revision, Bookmark (Lovable) | |
| Decision record | ADR / Decision (MADR, Backlog.md `decisions/`) | MADR statuses: proposed / accepted / rejected / deprecated / superseded |
| Term definitions | Glossary, Ubiquitous language (Contextive), Definitions | |
| Project memory for agents | Memory (beads `remember`), Memory Bank (Cline), Context | |
