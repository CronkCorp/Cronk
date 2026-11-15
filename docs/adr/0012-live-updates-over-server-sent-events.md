# Live updates are server-sent events, published in-process

The UI hears about changes as they happen over server-sent events (an `EventSource` per watched topic, such as `GET /api/tickets/{key}/events`), not WebSockets. Updates only flow from server to browser, and every change a browser makes already goes through the HTTP API, so the one-way stream is enough; it is plain HTTP, so the sign-in cookie, the API's access checks, proxies and the browser's own reconnecting all work without anything extra. Events are passed between routes and streams in-process (`src/server/live/`), as Cronk runs as a single server process (ADR 0006, ADR 0008); a route publishes only after its change is committed. A route whose event carries a position a stream can reopen from also `expect`s that position before committing, so a stream catching up meanwhile keeps its `ready` below it until it is published.

A stream checks access when it opens, again before every event it sends and on its heartbeat (every 25 seconds), and ends once the watcher may no longer see the topic, so someone who loses access to a Project never receives another of its updates. Each stream opens with a `ready` event; the UI reloads what it shows on every `ready`, so it catches up on anything it missed while disconnected. An Agent Session's stream of waiting work (`GET /api/agent-sessions/current/events`) has nothing to reload, so it uses the standard server-sent event resume instead: its events carry ids, and a stream reopened with `Last-Event-ID` first sends, behind the same access check, the work it missed that is still waiting.

## Consequences

- Running several Cronk server processes behind one address would need the publishing moved to something they share, such as Postgres `LISTEN`/`NOTIFY`; the routes and streams would not change.
- Each watcher costs an access check per event, which is fine for one server's watchers but would want batching if a topic had very many.
- Other live views (the Inbox, boards) add a topic and publish to it; they reuse the same stream and access re-check.
