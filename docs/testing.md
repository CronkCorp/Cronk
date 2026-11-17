# Testing

How Cronk is tested, in every phase. Background: ADR 0010.

## What a good test is

A test exercises external behaviour only. It calls the HTTP API (or the MCP protocol) as a real User or Agent token would, and asserts on responses and on what later API calls return. It never reaches into database tables, internal modules or private functions, so internals can be refactored freely.

## Seams

1. **HTTP API against a real Postgres (primary).** The application runs in-process against a real, disposable Postgres. Time is read through an injectable clock so lapses and thresholds are testable. Nearly every rule is tested here: access, Claims and concurrency, Status moves, Versions, Inbox contents, search filtering, export/import round trips.
2. **MCP protocol (thin).** A few tests drive a real MCP client against the running server: Agent Session lifecycle, the welcome, mapping of grouped tools onto the API, read-only tokens.
3. **Web UI (smoke only).** A small number of Playwright tests walk the main path (sign in, Inbox, a Ticket). The UI holds no rules, so it gets no further tests. `e2e/README.md` says what a smoke test must wait on before it acts or asserts.
4. **Files storage contract (the one lower-level seam).** `test/file-store.test.ts` runs the same contract (put, get, range get, delete, list) against every `FileStore` backend: local disk in a temporary directory, and S3-compatible storage in a bucket of a disposable MinIO, skipped when none can be started. API tests store files on local disk; one Attachments test runs through an S3-configured Cronk.

5. **The reference Transcript hook, as a script.** `test/transcript-hook.test.ts` runs `hooks/claude-code/cronk-transcript.mjs` as Claude Code does: sample chat files from `test/fixtures/claude-code/` in, the expected Markdown out, the same across runs and continuing as a chat grows, then one upload of its output through the API. Answers a real Cronk can't be made to give, such as a refusal the hook must still report, come from a stand-in HTTP server the script uploads to instead. The hook runs on Users' machines, outside Cronk, so the script's command line is its public interface.

Do not add lower-level unit seams for rules; test them through the API. New phases add tests at these same seams. Integrations with external systems (Git hosts, webhooks, email) are tested by feeding the API the events those systems send and asserting on the resulting state, without calling the real services.

Concurrency and database faults are staged through the harness, not by reaching into tables: `terminateConnections` and `interruptQueriesOn` simulate a database blip, `holdRow` holds a row as an updating transaction would, so a request that writes a row referencing it stops mid-transaction until released, and `holdTable` locks a whole table, so every query on it, reads too, waits until released. `holdPushes` holds back every live update the server pushes, as if each change had committed but its push hadn't run yet, until released. `heartbeat` runs the heartbeat of every open live-update stream now, as its 25-second timer would outside tests, so a test can move the clock past the silence threshold in steps while a stream stays open. No real heartbeat timer runs in test instances, so heartbeats happen only where a test calls `heartbeat`. The test still acts and asserts only through the API.

Upgrades of an existing installation are staged the same way: `undoMigration` undoes one migration and forgets it was applied, so the next `restart` applies it again over data the test created through the API. Use it to test a migration that fills new tables from existing data.
