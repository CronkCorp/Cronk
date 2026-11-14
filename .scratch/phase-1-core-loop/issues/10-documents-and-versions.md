# 10: Documents and Versions

**What to build:** Users can create Documents in a Project or in the Workspace, arranged in a page tree, and edit them in an editor that saves Markdown (ADR 0003). Every save creates a Version recording its Actor. Every write names the Version it is based on and is refused if that is no longer current, returning the current Version. Users can view and restore earlier Versions. Agents read and write Documents through the MCP `documents` tool. (Section replace, comparing Versions and the merge flow follow in ticket 11.)

**Blocked by:** 03 (Users and Project access), 07 (MCP server and Agent Sessions)

**Status:** ready-for-agent

- [ ] Documents belong to a Project or the Workspace and sit in a page tree (create, rename, move, delete)
- [ ] Editor saves Markdown; Ticket references render as links
- [ ] Every save creates an immutable Version with Actor (and Agent Session for Agents)
- [ ] Writes based on an outdated Version are refused with the current Version returned
- [ ] Version list and restore of an earlier Version (restore is itself a new Version)
- [ ] `documents` MCP tool: get, list tree, create, update
- [ ] Access rules (including Agent Access) apply to Documents
- [ ] API tests cover Versions, stale-write refusal and access
