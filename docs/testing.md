# Testing

How Cronk is tested, in every phase. Background: ADR 0010.

## Running tests

Every command's output lands in the agent's context, so keep each run small and its output short:

- While working, run the one file you are changing: `npx vitest run test/<file>.test.ts --reporter=agent`, adding `-t "<test name>"` for a single test. The `agent` reporter prints only failures and the summary.
- `npm run test:e2e` rebuilds the web client every run. For a series of smoke runs, run `npm run build:web` once, then `npx playwright test -g "<test name>" --reporter=line -x`, and rebuild only after changing `src/web/`. The server runs from source, so server changes need no rebuild.
- Run `npm run check` once, before opening the PR.

## What a good test is

A test exercises external behaviour only. It calls the HTTP API (or the MCP protocol) as a real User or Agent token would, and asserts on responses and on what later API calls return. It never reaches into database tables, internal modules or private functions, so internals can be refactored freely.

## Seams

1. **HTTP API against a real Postgres (primary).** The application runs in-process against a real, disposable Postgres. Time is read through an injectable clock so lapses and thresholds are testable. Nearly every rule is tested here: access, Claims and concurrency, Status moves, Versions, Inbox contents, search filtering, export/import round trips.
2. **MCP protocol (thin).** A few tests drive a real MCP client against the running server: Agent Session lifecycle, the welcome, mapping of grouped tools onto the API, read-only tokens.
3. **Web UI (smoke only).** A small number of Playwright tests walk the main path (sign in, Inbox, a Ticket). The UI holds no rules, so it gets no further tests. `e2e/README.md` says what a smoke test must wait on before it acts or asserts.
4. **Files storage contract (the one lower-level seam).** `test/file-store.test.ts` runs the same contract (put, get, range get, size, move, delete, list) against every `FileStore` backend: local disk in a temporary directory, and S3-compatible storage in a bucket of a disposable MinIO. Outside CI those cases are skipped when no MinIO can be started; in CI the run fails instead. API tests store files on local disk; one Attachments test runs through an S3-configured Cronk.

5. **The reference Transcript hook, as a script.** `test/transcript-hook.test.ts` runs `hooks/claude-code/cronk-transcript.mjs` as Claude Code does: sample chat files from `test/fixtures/claude-code/` in, the expected Markdown out, the same across runs and continuing as a chat grows, then one upload of its output through the API. Answers a real Cronk can't be made to give, such as a refusal the hook must still report, come from a stand-in HTTP server the script uploads to instead. The hook runs on Users' machines, outside Cronk, so the script's command line is its public interface.

Do not add lower-level unit seams for rules; test them through the API. New phases add tests at these same seams. Integrations with external systems (Git hosts, webhooks, email) are tested by feeding the API the events those systems send and asserting on the resulting state, without calling the real services.

Concurrency and database faults are staged through the harness, not by reaching into tables: `terminateConnections` and `interruptQueriesOn` simulate a database blip, `holdRow` holds a row as an updating transaction would, so a request that writes a row referencing it stops mid-transaction until released, and `holdTable` locks a whole table, so every query on it, reads too, waits until released. `holdPushes` holds back every live update the server pushes, as if each change had committed but its push hadn't run yet, until released. `heartbeat` runs the heartbeat of every open live-update stream now, as its 25-second timer would outside tests, so a test can move the clock past the silence threshold in steps while a stream stays open. No real heartbeat timer runs in test instances, so heartbeats happen only where a test calls `heartbeat`. `lookForLapses` looks for lapsed Claims now, as the server does on its own every `lapseCheckMs` (50 ms in tests), and waits until it is done, so a test can know the server has looked since the clock last moved without waiting on real time. `holdLookBetweenReads` starts such a look and holds it after its first read of the Tickets, before its next, until released, so a test can commit a change (lowering the silence threshold, say) in the middle of a look; a test using it starts Cronk with a long `lapseCheckMs`, so the look held is the one it started. `queriesOn` counts the queries naming a table that the server sends while a request runs, so a test can show a listing takes a fixed number of queries however many items it holds, by comparing the counts for few items and many. `queries` counts every query the server sends while a request runs, whatever it names; the server's own looks for lapsed Claims count too, so a test using it starts Cronk with a long `lapseCheckMs`. The test still acts and asserts only through the API.

Upgrades of an existing installation are staged the same way: `undoMigration` undoes one migration and forgets it was applied, so the next `restart` applies it again over data the test created through the API. Use it to test a migration that fills new tables from existing data.

Memory a request holds is measured from the test process, since the server runs in it: `test/streamed-export-import.test.ts` samples `process.memoryUsage().arrayBuffers` while an export or import runs. That figure also counts Buffers that are garbage but not yet collected, and how late the collector runs varies with the Node version and the machine's load, so such a test collects garbage before taking its baseline. `vitest.config.ts` runs the files listed in `memoryMeasuringFiles` with `--expose-gc` in a project of their own; add a file there before measuring memory in it. Keep each bound below the size that would mean the thing measured was held whole, and don't raise it to absorb collector lag.
