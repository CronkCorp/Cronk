# Cronk

A self-hosted platform where humans and AI agents share one place for a team's Tickets, documentation, decisions and agent-produced artifacts.

## Language

### Structure

**Workspace**:
The single organization a Cronk installation serves. Holds the Projects plus knowledge that spans them; never holds Tickets directly.
_Avoid_: Organization, tenant, company

**Project**:
The main container of work and the knowledge that goes with it, usually corresponding to one product or set of repositories. Its knowledge layers on top of the Workspace's. It is **open** or **private** (see Member), and may be **archived**, which hides it from the Project list and takes its Tickets out of Ready.
_Avoid_: Team, space, board

### Work

**Ticket**:
A unit of work tracked within a Project.
_Avoid_: Issue, task, work item, card, story

**Status**:
Where a Ticket currently stands in its Project's workflow. Each Project defines its own Statuses, each belonging to exactly one Status Category, and keeps at least one Status in every Category. A new Ticket starts in the Project's first Status, Backlog by default.
_Avoid_: State, column, stage

**Status Category**:
One of the fixed groups every Status belongs to, shared by all Projects: Backlog, Unstarted, Started, In Review, Completed, Canceled. Agents may move Tickets only into Unstarted, Started and In Review; Users decide the rest (ADR 0011).
_Avoid_: Status type, phase

**Ready**:
Said of a Ticket an Agent can take up now: delegated to it, in a Backlog, Unstarted or Started Status, not blocked by an unfinished Ticket, and not Claimed, in an unarchived Project the Agent may write in, with an active Owner. A Ticket In Review waits on a User, so it is not Ready until Sent back. An Unverified completion counts as finished for blocking.
_Avoid_: Available, open, unblocked (as the overall term)

**Assignee**:
The User accountable for a Ticket. Always a User, never an Agent.
_Avoid_: Owner (reserved for Agents), responsible

**Delegate**:
The Agent a Ticket's Assignee has handed the work to. Must be one of the Assignee's own Agents, so a delegated Ticket always has an Assignee: delegating a Ticket without one assigns the delegating User. Removing the Agent clears it as Delegate of every Ticket, as a change by whoever removed it.
_Avoid_: Agent assignee, worker

**Autonomous Delegation**:
A Delegation in which the Delegate may complete Tickets itself rather than stopping at In Review. Every completion it makes is Unverified until a User checks it. A User sets it on a Ticket, and the Ticket's Sub-Tickets inherit it.
_Avoid_: Auto mode, unattended mode, YOLO mode

**Report**:
The Document of findings an Agent writes on a Ticket it worked on, with supporting evidence such as Artifacts and Attachments. Lives with its Ticket rather than in the Project's page tree. Required whenever an Agent hands work over, by moving a Ticket to In Review or completing it. Like any Document, only a User may delete one; an Agent may change one only while holding its Ticket's Claim.
_Avoid_: Summary, write-up, result

**Verification**:
A User's after-the-fact judgement on a Ticket an Agent completed: Unverified until a User either Accepts it (Verified) or Reopens it back to the Delegate. Reopen applies only to an Unverified completion; work still In Review goes back by Send back instead.
_Avoid_: Approval, sign-off, QA

**Send back**:
A User's return of a Ticket In Review to its Delegate and a Started Status, with a Comment saying what is left to do.
_Avoid_: Reject, bounce, Reopen (reserved for Verification)

**Discovered Ticket**:
A Ticket an Agent files for work it noticed outside the scope of the Ticket it was working on, or while working on none. Every Ticket an Agent creates, other than a Sub-Ticket of its own Claimed Ticket, is one. It waits in Backlog until a User delegates it, and may block other Tickets meanwhile.
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
One timestamped entry an Agent Session writes on a Ticket while working: a plan, progress, finding, Question or error. Like every call in the Agent Session, an Activity keeps its Claim alive.
_Avoid_: Log line, event, comment, thought

**Question**:
An Activity in which an Agent asks something of a User, marked **blocking** when the Agent waits for the answer. The first User's Comment reply **answers** it; blocking Questions come first in the Inbox.
_Avoid_: Prompt, request, clarification

**Change**:
One recorded edit an Actor made to a Ticket, such as to its Status, Delegate or Relations, or its creation, shown in the Ticket's timeline. A Change no Actor made, such as an upgrade assigning a delegated Ticket to its Delegate's Owner, is recorded as by Cronk itself (a system Change).
_Avoid_: Event, history entry, field change

**Comment**:
A message any Actor posts on a Ticket or Document, possibly in reply to another Comment or an Activity, or anchored to a passage of a Document. Conversation, as opposed to an Agent's own Activities.
_Avoid_: Reply, note, message, discussion

**Waiting Work**:
A Comment that concerns an Agent: it answers the Agent's Question, @mentions it, or is on a Ticket delegated to it or an Artifact Version it published. A User's rejection of a Decision the Agent proposed, or of a Suggestion it made, with the reason, is Waiting Work too. Listed in the welcome of the Agent's next Agent Session and pushed to its live ones (ADR 0005).
_Avoid_: Notification, wake-up, Inbox (reserved for Users)

**Claim**:
An Agent Session's exclusive, temporary hold on a Ready Ticket while it works on it. A Ticket has at most one live Claim. An Agent changes a Ticket's fields, Status and Relations only from the Agent Session holding its Claim; Comments need none. It ends when the Ticket moves to In Review, Completed or Canceled or the Agent releases it, and lapses when its Agent Session ends.
_Avoid_: Lock, checkout, lease

**Inbox**:
A User's personal list of everything waiting on them: Tickets In Review, Unverified completions, Agent questions, Suggestions, Discovered Tickets and proposed Decisions that concern them.
_Avoid_: Review queue, notifications, to-do

**Triage**:
The shared list of waiting items that have no clear User to go to. Each User sees the items they could act on.
_Avoid_: Unassigned queue, backlog

### Code

**Repository**:
A code repository on an external Git host that a Project lists as holding its code.
_Avoid_: Repo (in the product), codebase, source

**Pull Request**:
A proposed edit to code on a Git host, linked to one or more Tickets. Covers GitLab's merge requests too.
_Avoid_: Merge request, MR, PR (in the product), change (reserved for a Ticket's Changes)

### Knowledge

**Document**:
A piece of written knowledge belonging to a Project or the Workspace, kept as Markdown. Only a User may delete one, since a delete removes it and its Versions for good; an Agent never may, even with Write.
_Avoid_: Page, doc, wiki page, note

**Page tree**:
The nested arrangement of a Project's or the Workspace's Documents, where each Document may sit under another. Reports live with their Ticket, outside it.
_Avoid_: Wiki, folder, hierarchy

**Mention**:
A Ticket, Document, Comment, Term or Decision whose text names a Decision's key (`CRONK-D7`, or `D7` for the Workspace's) or a Term's name, written with its capitalisation as a whole word, outside code and links. The text links to it, and the Decision or Term lists what mentions it under "Mentioned in". Not to be confused with a Comment's @mention of an Agent.
_Avoid_: Reference, backlink

**Linked Document**:
A Document an Actor linked to a Ticket from the Ticket's side, so it is one click away without editing the Document. The Ticket lists it beside its Reports and the Documents that mention its key. Unlike a Relation, it never blocks.
_Avoid_: Relation (reserved for Ticket to Ticket), attachment, reference

**Version**:
One saved state of a Document, Artifact or Guidance, recording which Actor produced it.
_Avoid_: Revision, snapshot, history entry

**Artifact**:
A live, viewable thing built by an Actor, such as an HTML prototype, served in isolation at a stable address. Belongs to a Project or the Workspace, records the Ticket or Agent Session it came from, and can be embedded in many places.
_Avoid_: Prototype (as the general term), app, preview, page

**Attachment**:
A plain file, such as an image, video, PDF or log, attached to a Document, Report, Ticket or Comment. It belongs to that item and is readable by whoever can read it; on a Document it belongs to the Document rather than a Version, so every Version can show it.
_Avoid_: Upload, asset, media, file (as the term)

**Term**:
A glossary entry naming one concept: its canonical name, definition and the words to avoid for it. Belongs to the Workspace or a Project; within a Project, a Project Term replaces any Workspace Term of the same name. Every change saves a Version; only a User may delete one, since a delete removes its Versions for good.
_Avoid_: Glossary entry, definition, word

**Decision**:
A recorded choice with its reasoning and a lifecycle status (proposed, accepted, rejected, deprecated, superseded), which may supersede earlier Decisions. Only Users change its status, and rejecting one takes a reason; accepting a Decision that supersedes another marks the other superseded. An Agent may propose one and refine it while it is proposed; a User then reviews it: the Assignee of the Ticket the Agent held the Claim on (its **source Ticket**), or else the Agent's Owner.
_Avoid_: ADR (in the product), RFC, ruling

### Actors

**User**:
A human who signs in to Cronk. A User an import brought in hasn't **joined** yet: they have no password until an Admin invites them and they accept. An Admin may **deactivate** a User, who can't sign in and whose Agents are refused until reactivated.
_Avoid_: Person, human account

**Invitation**:
A one-time link, valid 7 days, that an Admin creates to let someone join as a User or an imported User set a password. The Admin passes it on themselves until outside-app email arrives.
_Avoid_: Invite code, signup link

**Password reset link**:
A one-time link, valid 7 days like an Invitation, that lets a User who has joined choose a new password. An Admin issues it from the Users page, or the operator from the server when no Admin can sign in, and passes it on. Issuing it stops the User's old password and ends their sign-ins until it is used; their Agents' Sessions keep running.
_Avoid_: Recovery code, password token

**Admin**:
A User who manages the Workspace: its Users, settings and Workspace Guidance. Has Write in every Project, private ones included, and can see every Agent but change only their own.
_Avoid_: Owner (reserved for Agents), superuser

**Member**:
A User without Admin rights. Has the access a Project lists them with, Read or Write; unlisted, they have Write in an **open** Project and no access to a **private** one, which answers as if it didn't exist.
_Avoid_: Collaborator, guest, contributor

**Agent**:
A non-human account that acts in Cronk on behalf of exactly one User. A User may have many Agents active at the same time. A **removed** Agent is refused for good but stays named in history.
_Avoid_: Bot, AI user, integration

**Agent Session**:
One continuous connection of an Agent, from connect until it disconnects or stays silent longer than the silence threshold, or its token, Agent or Owner is revoked, removed or deactivated. Every call in it, and the heartbeat of its open stream of Waiting Work, keeps it going; once ended it never resumes. An Agent changes things only within an Agent Session. Many Agent Sessions of the same Agent may run at once.
_Avoid_: Run, instance, conversation

**Agent Record**:
Everything an Agent did across the Workspace, newest first: the Changes it made, the Activities and Comments it wrote and the Versions it saved. Its Owner sees what they can read now; an Admin sees all of it. Gone once the Agent is removed, though what it did stays on the Tickets and Documents it was on.
_Avoid_: Work (reserved for Waiting Work), history, activity log, feed

**Transcript**:
The verbatim record of a chat between a User and their Agent, uploaded from the Agent's side, that led the Agent to change things in Cronk. Linked to the Agent Sessions it covered and so to everything they did.
_Avoid_: Chat log, conversation, chat history, session log

**Silence threshold**:
How long an Agent Session may go without a call before it ends and its Claims lapse. Set per Workspace, 5 minutes by default.
_Avoid_: Timeout, TTL, lease time

**Owner**:
The User an Agent acts on behalf of and who is accountable for its actions.
_Avoid_: Operator, sponsor, parent

**Actor**:
Either a User or an Agent; whoever performed an action.
_Avoid_: Principal, author (when meaning the doer of any action)

**Guidance**:
Standing instructions Users write for Agents (Admins, for the Workspace's), layered Workspace then Project, handed to every Agent Session when it connects.
_Avoid_: System prompt, rules, AGENTS.md (in the product)

**Agent Webhook**:
An address an Agent may register so Cronk can tell the Agent's own runner that work is waiting for it.
_Avoid_: Trigger, callback, wake-up hook

### Access

**Agent Access**:
The most a Project (or the Workspace) lets Agents do in it: None, Read or Write. An Agent never gets more than its Owner has, or than its token allows.
_Avoid_: AI permissions, bot role, agent scope

**Token**:
The secret an Agent calls the API with, full or read-only, shown once when issued and stored only as a hash. An Agent may hold several; revoking one refuses it at once.
_Avoid_: API key, password, credential (as the term)

**Protected**:
Said of a Document, Term, Decision or Artifact that Agents may read but never edit, regardless of Agent Access. Protecting a Document also protects every Document under it in the page tree, including ones added later.
_Avoid_: Locked, read-only, human-only

**Suggestion**:
A new Version of a Protected item that an Agent proposes, starting from a specific Version and giving its reasoning. It takes effect only when a User accepts it, becoming the item's next Version.
_Avoid_: Proposal, change request, draft
