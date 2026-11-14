# Cronk

A self-hosted platform where humans and AI agents share Tickets, Documents and decisions.
See `GLOSSARY.md` for the vocabulary, `docs/roadmap.md` for scope and `docs/adr/` for decisions.

## Run it

```sh
docker compose up -d --build
```

Open <http://localhost:3000>. On a fresh installation the first account you create becomes the Admin; after that, sign-ups are closed.

Set `POSTGRES_PASSWORD` (for example in a `.env` file next to `compose.yaml`) before exposing Cronk anywhere, and `COOKIE_SECURE=true` when it is served over HTTPS.

## Configuration

Cronk is a plain Node.js process configured only through environment variables, so it runs the same with or without Docker:

| Variable        | Default               | Meaning                                                        |
| --------------- | --------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`  | (required)            | Postgres connection string                                     |
| `HOST`          | `0.0.0.0`             | Address to listen on                                           |
| `PORT`          | `3000`                | Port to listen on                                              |
| `COOKIE_SECURE` | `false`               | Mark the sign-in cookie Secure (use behind HTTPS)              |
| `WEB_ROOT`      | `dist/web` if present | Directory of the built web client                              |

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
