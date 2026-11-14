# 16: Search and context on claim

**What to build:** Users and Agents can search across Tickets, Documents (including Reports) and Comments with Postgres full-text search, filtered by kind and Project, getting an excerpt with each result and only seeing what they may access. Agents use it through an MCP `search` tool. Claiming a Ticket returns its description, parent, Sub-Tickets, related Tickets and linked Documents, so the Agent starts with context.

**Blocked by:** 08 (Delegation, Claims and `next`), 13 (Comments and answering questions)

**Status:** ready-for-agent

- [ ] Full-text search across Tickets, Documents, Reports and Comments
- [ ] Filters by kind and Project; results include an excerpt
- [ ] Results respect all access rules, including Agent Access and private Projects
- [ ] Search box in the UI; `search` MCP tool
- [ ] Claim and `next` responses include parent, Sub-Tickets, related Tickets and linked Documents
- [ ] API tests: search finds content and never leaks inaccessible items
