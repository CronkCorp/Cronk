# 07: MCP server and Agent Sessions

**What to build:** Cronk hosts a streamable-HTTP MCP endpoint. An Agent connects with its token; each connection is an Agent Session that ends when the connection closes. On connect the Session receives a welcome. The `tickets` tool offers read actions (list, get). Users can see their Agents' live Agent Sessions in the UI. The MCP server is a thin layer over the HTTP API, applying the same access rules.

**Blocked by:** 06 (Agents and tokens)

**Status:** ready-for-agent

- [ ] MCP endpoint accepts Agent tokens and refuses invalid or revoked ones
- [ ] Connecting creates an Agent Session; disconnecting (or going silent past the silence threshold) ends it
- [ ] Welcome message is returned on connect (extended by later tickets)
- [ ] `tickets` tool with `list` and `get` actions, using the grouped-tool-with-action shape
- [ ] Read-only tokens see only read actions
- [ ] UI lists a User's Agents with their live Agent Sessions
- [ ] History of Agent changes records the Agent Session
- [ ] MCP protocol tests drive a real MCP client against the server
