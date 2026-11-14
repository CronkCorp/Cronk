# Testing

How Cronk is tested, in every phase. Background: ADR 0010.

## What a good test is

A test exercises external behaviour only. It calls the HTTP API (or the MCP protocol) as a real User or Agent token would, and asserts on responses and on what later API calls return. It never reaches into database tables, internal modules or private functions, so internals can be refactored freely.

## Seams

1. **HTTP API against a real Postgres (primary).** The application runs in-process against a real, disposable Postgres. Time is read through an injectable clock so lapses and thresholds are testable. Nearly every rule is tested here: access, Claims and concurrency, Status moves, Versions, Inbox contents, search filtering, export/import round trips.
2. **MCP protocol (thin).** A few tests drive a real MCP client against the running server: Agent Session lifecycle, the welcome, mapping of grouped tools onto the API, read-only tokens.
3. **Web UI (smoke only).** A small number of Playwright tests walk the main path (sign in, Inbox, a Ticket). The UI holds no rules, so it gets no further tests.

Do not add lower-level unit seams for rules; test them through the API. New phases add tests at these same seams. Integrations with external systems (Git hosts, webhooks, email) are tested by feeding the API the events those systems send and asserting on the resulting state, without calling the real services.
