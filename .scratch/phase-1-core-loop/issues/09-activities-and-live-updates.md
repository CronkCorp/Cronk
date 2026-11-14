# 09: Activities and live updates

**What to build:** While holding a Claim, an Agent Session logs Activities on the Ticket: plan, progress, finding, question (optionally blocking) or error. Each Activity refreshes the Claim. The Ticket page shows a timeline of Activities that updates live, introducing the server-pushed live-update mechanism that the rest of the UI will reuse.

**Blocked by:** 08 (Delegation, Claims and `next`)

**Status:** ready-for-agent

- [ ] `activities` MCP tool with `log` and `ask` actions; only the Claim holder can write Activities
- [ ] Activities carry kind, Markdown body, timestamp and Agent Session; questions can be marked blocking
- [ ] Writing an Activity refreshes the Claim
- [ ] Ticket timeline shows Activities and updates live without refresh
- [ ] Live-update mechanism (WebSocket or server-sent events) respects access rules
- [ ] API tests: non-holder refused; Activity keeps Claim alive past the threshold
