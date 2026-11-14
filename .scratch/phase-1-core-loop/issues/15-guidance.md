# 15: Guidance

**What to build:** Users can write Guidance for Agents at Workspace level and per Project, as Markdown. Every Agent Session receives the Workspace Guidance followed by the relevant Project Guidance in its welcome, and can fetch it again through the MCP.

**Blocked by:** 07 (MCP server and Agent Sessions)

**Status:** ready-for-agent

- [ ] Workspace and Project Guidance can be edited by Users with Write access (Admins for Workspace)
- [ ] Guidance changes are versioned with their Actor
- [ ] Welcome includes Workspace then Project Guidance
- [ ] Guidance can be fetched via MCP
- [ ] MCP protocol test checks Guidance in the welcome
