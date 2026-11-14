# 08: Delegation, Claims and `next`

**What to build:** A User can set themselves or another User as a Ticket's Assignee and one of the Assignee's own Agents as its Delegate (ADR 0001). An Agent Session can ask for `next`, which atomically Claims the highest-Priority, oldest Ready Ticket for its Agent, or Claim a specific delegated Ticket, and release it. Claims lapse when the Session is silent beyond the Workspace's silence threshold (default 5 minutes, configurable), keeping the Delegate. Agent Sessions holding a Claim can move the Ticket into Unstarted, Started and In Review Statuses but never Completed or Canceled, and can create Sub-Tickets that inherit Assignee and Delegate. The welcome lists the Agent's Ready Tickets.

**Blocked by:** 04 (Ticket fields and relations), 07 (MCP server and Agent Sessions)

**Status:** ready-for-agent

- [ ] Assignee must be a User; Delegate must be an Agent owned by the Assignee; changing Assignee clears a foreign Delegate
- [ ] Ready = delegated to the Agent, not Completed/Canceled, no unfinished blocker, no live Claim
- [ ] `next` Claims atomically by Priority then age; concurrent `next` calls never return the same Ticket
- [ ] Claiming a Ticket with a live Claim is refused; release frees it
- [ ] Any tool call from the Session refreshes its Claim; Claims lapse after the silence threshold (tested via injected clock)
- [ ] Admin can set the silence threshold for the Workspace
- [ ] Agent moves into Completed or Canceled Statuses are refused; Users may move anywhere
- [ ] Claim holder can create Sub-Tickets of the Claimed Ticket
- [ ] `tickets` MCP tool gains `next`, `claim`, `release`, status update and sub-ticket actions; welcome lists Ready Tickets
- [ ] UI shows Assignee, Delegate and current Claim on a Ticket
- [ ] API tests cover all rules above, including concurrency
