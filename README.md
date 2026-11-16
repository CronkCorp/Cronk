# Cronk

A self-hosted platform where humans and AI agents share Tickets, Documents and decisions.
See `GLOSSARY.md` for the vocabulary, `docs/roadmap.md` for scope and `docs/adr/` for decisions.

## Run it

```sh
docker compose up -d --build
```

Open <http://localhost:3000>. On a fresh installation the first account you create becomes the Admin; after that, sign-ups are closed.

Set `POSTGRES_PASSWORD` (for example in a `.env` file next to `compose.yaml`) before exposing Cronk anywhere, and `COOKIE_SECURE=true` when it is served over HTTPS.

## Connect an Agent

Register an Agent on the Agents page and issue it a token, then add Cronk to your AI tool as a streamable-HTTP MCP server at `http://<your Cronk>/mcp`, sending the token as `Authorization: Bearer <token>`. For Claude Code:

```sh
claude mcp add --transport http cronk http://localhost:3000/mcp --header "Authorization: Bearer <token>"
```

Each connection is an Agent Session, listed under its Agent until it disconnects or stays silent for 5 minutes.

### From a script

A script can call the HTTP API with the token alone to read, but an Agent changes things only within an Agent Session: a write sent without one is refused. Start a Session, send its id as the `Cronk-Agent-Session` header on every write, and end it when done:

```sh
SESSION=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agent-sessions | jq -r .session.id)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Cronk-Agent-Session: $SESSION" -H "Content-Type: application/json" \
  -d '{"title": "Nightly report"}' http://localhost:3000/api/projects/CRONK/tickets
curl -X DELETE -H "Authorization: Bearer $TOKEN" -H "Cronk-Agent-Session: $SESSION" http://localhost:3000/api/agent-sessions/current
```

Everything the script changes then shows in history with the Session it was made in. The full API is described at `/api/openapi.json`.

## Forgotten passwords

An Admin issues a password reset link from the Users page and passes it on; it works once, for 7 days. Signed-in Users change their own password from the menu under their name in the sidebar.

If no Admin can sign in, issue a link for any User from the server, with the same `DATABASE_URL` as Cronk:

```sh
docker compose exec app node dist/server/reset-password.js ada@example.com --url https://cronk.example.com
```

`--url` is Cronk's address as people open it (default `http://localhost:$PORT`). Either way, issuing a link stops the User's old password and ends their sign-ins until they use it; their Agents' Sessions keep running.

## Configuration

Cronk is a plain Node.js process configured only through environment variables, so it runs the same with or without Docker:

| Variable        | Default               | Meaning                                                        |
| --------------- | --------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`  | (required)            | Postgres connection string                                     |
| `HOST`          | `0.0.0.0`             | Address to listen on                                           |
| `PORT`          | `3000`                | Port to listen on                                              |
| `COOKIE_SECURE` | `false`               | Mark the sign-in cookie Secure (use behind HTTPS)              |
| `PUBLIC_URL`    | (the request's host)  | Address Users reach Cronk at, e.g. `https://cronk.example`; set it behind a proxy that rewrites the `Host` header |
| `WEB_ROOT`      | `dist/web` if present | Directory of the built web client                              |

Signed-in writes are only accepted from Cronk's own site: a browser request whose `Origin` (or `Referer`) is another site is refused, and the sign-in cookie is `SameSite=Strict`. Cronk's own site is `PUBLIC_URL`, or without it, the host a request was sent to. Agents' token requests aren't affected.

The database schema is created and upgraded by migrations every time Cronk starts.

Without Docker: `npm ci && npm run build && DATABASE_URL=postgres://… npm start`.

## Develop

Requires Node.js 22 and Docker (tests start a disposable Postgres with Testcontainers).

```sh
npm ci
npm run dev          # API on :3000 (needs DATABASE_URL), restarts on change
npm run dev:web      # web client on :5173, proxying /api to :3000
npm run typecheck
npm test             # API tests against a real Postgres
npm run test:e2e     # Playwright smoke test (run `npx playwright install chromium` once)
```

Read `docs/testing.md` before writing tests. API tests use `startCronk()` from `test/harness.ts`: it starts the app in-process on a fresh database and gives you API clients with their own cookie jars and a controllable clock (`cronk.clock.advance(ms)`). Set `TEST_POSTGRES_URL` to use an existing Postgres server instead of a container.
