# Cronk

A self-hosted platform where humans and AI agents share one place for a team's Tickets, documentation, decisions and agent-produced artifacts.

## Language

### Structure

**Workspace**:
The single organization a Cronk installation serves. Holds the Projects plus knowledge that spans them; never holds Tickets directly.
_Avoid_: Organization, tenant, company

**Project**:
The main container of work and the knowledge that goes with it, usually corresponding to one product or set of repositories. Its knowledge layers on top of the Workspace's.
_Avoid_: Team, space, board

### Work

**Ticket**:
A unit of work tracked within a Project.
_Avoid_: Issue, task, work item, card, story

**Status**:
Where a Ticket currently stands in its Project's workflow. Each Project defines its own Statuses, each belonging to exactly one Status Category.
_Avoid_: State, column, stage

**Status Category**:
One of the fixed groups every Status belongs to, shared by all Projects: Backlog, Unstarted, Started, In Review, Completed, Canceled.
_Avoid_: Status type, phase

**Ready**:
Said of a Ticket an Agent can take up now: delegated to it, not Completed or Canceled, not blocked by an unfinished Ticket, and not Claimed. An Unverified completion counts as finished for blocking.
_Avoid_: Available, open, unblocked (as the overall term)

**Assignee**:
The User accountable for a Ticket. Always a User, never an Agent.
_Avoid_: Owner (reserved for Agents), responsible

**Delegate**:
The Agent a Ticket's Assignee has handed the work to. Must be one of the Assignee's own Agents.
_Avoid_: Agent assignee, worker

**Autonomous Delegation**:
A Delegation in which the Delegate may complete Tickets itself rather than stopping at In Review. Every completion it makes is Unverified until a User checks it.
_Avoid_: Auto mode, unattended mode, YOLO mode

**Report**:
The Document of findings an Agent writes on a Ticket it worked on, with supporting evidence such as Artifacts and Attachments. Lives with its Ticket rather than in the Project's page tree. Required whenever an Agent hands work over, by moving a Ticket to In Review or completing it.
_Avoid_: Summary, write-up, result

**Verification**:
A User's after-the-fact judgement on a Ticket an Agent completed: Unverified until a User either Accepts it (Verified) or Reopens it back to the Delegate.
_Avoid_: Approval, sign-off, QA

**Discovered Ticket**:
A Ticket an Agent files for work it noticed outside the scope of the Ticket it was working on. It waits in Backlog until a User delegates it, and may block other Tickets meanwhile.
_Avoid_: Follow-up, spin-off, finding

**Sub-Ticket**:
A Ticket that splits up part of a parent Ticket's work and stays within the parent's Delegation. Its parent is in the same Project.
_Avoid_: Subtask, child issue

**Priority**:
How urgent a Ticket is: Urgent, High, Medium, Low or None. Ready Tickets are offered highest Priority first.
_Avoid_: Severity, importance, rank

**Label**:
A free-form tag on a Ticket for grouping and filtering, matched ignoring case.
_Avoid_: Tag, category (reserved for Status Category)

**Relation**:
A link between two Tickets, in any Projects of the Workspace: one **blocks** the other (which is **blocked by** it), or they **relate to** each other. Blocking never forms a cycle.
_Avoid_: Dependency, link (as the term)

**Activity**:
One timestamped entry an Agent Session writes on a Ticket while working: a plan, progress, finding, question or error. Activities also keep the Agent Session's Claim alive.
_Avoid_: Log line, event, comment, thought

**Comment**:
A message any Actor posts on a Ticket or Document, possibly in reply to another Comment or an Activity, or anchored to a passage of a Document. Conversation, as opposed to an Agent's own Activities.
_Avoid_: Reply, note, message, discussion

**Claim**:
An Agent Session's exclusive, temporary hold on a Ticket while it works on it. A Ticket has at most one live Claim; a Claim lapses when its Agent Session falls silent for too long.
_Avoid_: Lock, checkout, lease

**Inbox**:
A User's personal list of everything waiting on them: Tickets In Review, Unverified completions, Agent questions, Suggestions and Discovered Tickets that concern them.
_Avoid_: Review queue, notifications, to-do

**Triage**:
The shared list of waiting items that have no clear User to go to.
_Avoid_: Unassigned queue, backlog

### Code

**Repository**:
A code repository on an external Git host that a Project lists as holding its code.
_Avoid_: Repo (in the product), codebase, source

**Pull Request**:
A proposed code change on a Git host, linked to one or more Tickets. Covers GitLab's merge requests too.
_Avoid_: Merge request, MR, PR (in the product), change

### Knowledge

**Document**:
A piece of written knowledge belonging to a Project or the Workspace, kept as Markdown.
_Avoid_: Page, doc, wiki page, note

**Version**:
One saved state of a Document, Artifact or Guidance, recording which Actor produced it.
_Avoid_: Revision, snapshot, history entry

**Artifact**:
A live, viewable thing built by an Actor, such as an HTML prototype, served in isolation at a stable address. Belongs to a Project or the Workspace, records the Ticket or Agent Session it came from, and can be embedded in many places.
_Avoid_: Prototype (as the general term), app, preview, page

**Attachment**:
A plain file, such as an image, video, PDF or log, embedded in a Document, Report or Ticket.
_Avoid_: Upload, asset, media, file (as the term)

**Term**:
A glossary entry naming one concept: its canonical name, definition and the words to avoid for it. Belongs to the Workspace or a Project; a Project's Terms layer over the Workspace's.
_Avoid_: Glossary entry, definition, word

**Decision**:
A recorded choice with its reasoning and a lifecycle status (proposed, accepted, deprecated, superseded), which may supersede earlier Decisions.
_Avoid_: ADR (in the product), RFC, ruling

### Actors

**User**:
A human who signs in to Cronk.
_Avoid_: Person, human account

**Admin**:
A User who manages the Workspace: its Users, settings and Workspace-level knowledge.
_Avoid_: Owner (reserved for Agents), superuser

**Member**:
A User without Admin rights, who works in the Projects open to them or that they were invited to, with Read or Write access in each.
_Avoid_: Collaborator, guest, contributor

**Agent**:
A non-human account that acts in Cronk on behalf of exactly one User. A User may have many Agents active at the same time.
_Avoid_: Bot, AI user, integration

**Agent Session**:
One continuous connection of an Agent, from connect to disconnect. Many Agent Sessions of the same Agent may run at once.
_Avoid_: Run, instance, conversation

**Owner**:
The User an Agent acts on behalf of and who is accountable for its actions.
_Avoid_: Operator, sponsor, parent

**Actor**:
Either a User or an Agent; whoever performed an action.
_Avoid_: Principal, author (when meaning the doer of any action)

**Guidance**:
Standing instructions Users write for Agents, layered Workspace then Project, handed to every Agent Session when it connects.
_Avoid_: System prompt, rules, AGENTS.md (in the product)

**Agent Webhook**:
An address an Agent may register so Cronk can tell the Agent's own runner that work is waiting for it.
_Avoid_: Trigger, callback, wake-up hook

### Access

**Agent Access**:
The most a Project (or the Workspace) lets Agents do in it: None, Read or Write. An Agent never gets more than its Owner has.
_Avoid_: AI permissions, bot role, agent scope

**Protected**:
Said of a Document, Term, Decision or Artifact that Agents may read but never edit, regardless of Agent Access.
_Avoid_: Locked, read-only, human-only

**Suggestion**:
A change an Agent proposes to a Protected item, with its reasoning, that takes effect only if a User accepts it.
_Avoid_: Proposal, change request, draft
