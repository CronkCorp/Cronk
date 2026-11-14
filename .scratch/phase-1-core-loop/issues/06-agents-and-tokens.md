# 06: Agents and tokens

**What to build:** A User can register Agents they own (e.g. `claude-laptop`), issue full or read-only tokens for each, and revoke them. Each Project (and the Workspace) has an Agent Access setting of None, Read or Write. The HTTP API accepts Agent tokens, and an Agent's effective access is the lower of its Owner's access and the Agent Access, so it can never exceed its Owner (ADR 0004). History shows changes made by Agents as such. The API is documented with OpenAPI.

**Blocked by:** 03 (Users and Project access)

**Status:** ready-for-agent

- [ ] Users can create, rename and remove their own Agents; Admins can see all Agents
- [ ] Tokens can be issued (full or read-only) and revoked; revoked tokens are refused immediately
- [ ] Deactivating a User stops all their Agents
- [ ] Agent Access (None/Read/Write) can be set per Project and for the Workspace
- [ ] Every API operation applies the capped access for Agent tokens; read-only tokens are refused writes
- [ ] History records the Agent and its Owner for Agent changes
- [ ] OpenAPI description of the API is served
- [ ] API tests: Agent capped by Owner's access, by Agent Access, and by read-only token
