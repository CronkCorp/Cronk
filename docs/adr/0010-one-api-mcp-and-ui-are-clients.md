# One HTTP API; the web UI and the MCP server are thin clients of it

All rules (access, Claims, Status moves, Versions) live behind a single documented HTTP API. The web UI and the MCP server are both clients of that API, so a rule is implemented and tested once, and scripts and CI use the same API with a User or Agent token. The MCP server is hosted by Cronk itself over streamable HTTP, authenticates with a per-Agent token (OAuth may be added later), treats each connection as an Agent Session, and exposes a small set of tools grouped by resource, each with an `action` parameter, to keep Agents' context small.

## Consequences

- Tests target the API against a real Postgres as the primary seam; MCP gets a few protocol tests and the UI a smoke test (see `docs/testing.md`).
- No rule may live only in the UI or only in the MCP layer.
