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

### Upload Transcripts from Claude Code

A Transcript is the chat that led an Agent to change things, kept beside what it changed so reviewers can see what was asked and why (ADR 0013). Cronk never sees the chat itself: a hook on your machine uploads it. The repository ships one for Claude Code, `hooks/claude-code/cronk-transcript.mjs`, a single file with no dependencies that needs Node.js 22. To install it:

1. Copy `hooks/claude-code/cronk-transcript.mjs` somewhere stable, such as `~/.claude/hooks/`.
2. Add it to your Claude Code settings (`~/.claude/settings.json`, or `.claude/settings.local.json` in one project), with the same Agent token the MCP server uses. It mustn't be read-only.

   ```json
   {
     "env": { "CRONK_URL": "http://localhost:3000", "CRONK_TOKEN": "<token>" },
     "hooks": {
       "Stop": [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/cronk-transcript.mjs" }] }],
       "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/cronk-transcript.mjs" }] }]
     }
   }
   ```

Each time Claude finishes answering, and when the chat ends, the hook converts the whole chat to Markdown and uploads it under Claude Code's session id. Cronk keeps only chats in which the Agent changed something, so the hook uploads every chat and stays quiet about the ones Cronk turns down for that; anything else that goes wrong is shown in Claude Code without stopping Claude. To see what it would upload, run `node cronk-transcript.mjs --print <chat.jsonl>` on a chat file from `~/.claude/projects/`.

The conversion includes each subagent's chat inside the main chat's, so a change only a subagent made through Cronk still links the chat: a foreground subagent's chat goes right after its result, and a background subagent's where Claude Code tells the main chat it finished. A subagent resumed after it finished, with another message to it, adds a block for each run where that run finished. A background subagent still running at an upload appears in a later one. The conversion leaves out Claude's reasoning and what Claude Code adds itself (commands' output, notifications and the summary that continues a compacted chat), shows images as `[image]`, and trims a tool call or result over 4,000 characters to its first 3,000 and last 1,000. A chat you rewound keeps the turns you went back on, in the order they happened. Cronk scrubs known secret patterns from what it receives, but only on a best-effort basis: don't rely on it for secrets you paste into a chat.

#### The turn convention

A hook for another client uploads its chat with `PUT /api/transcripts/by-chat/{chatId}` as `text/markdown`, written this way:

- Each turn starts with a `## User` or `## Assistant` line, followed by its text.
- A tool call is a fenced block in the Assistant's turn with the info string `tool-call <tool name>`, holding its input; its result follows as a block with `tool-result`, or `tool-result error` when the tool failed. Each fence is longer than any run of backticks inside it.
- A subagent's chat is a fenced block in the Assistant's turn with the info string `subagent <agent id>`, holding that chat written the same way, its own subagents nested inside it. It goes where the chat that launched the subagent learns it finished. A subagent resumed after it finished has several blocks, one per run, each holding only that run's part of its chat and placed where that run finished.
- Results of Cronk's tools keep their first line, which names the Agent Session: that's how Cronk links the Transcript to what the Session changed.
- The same chat always converts to the same text, and a chat that has grown converts to text that starts with what was uploaded before. Cronk then replaces the stored text; when the new text doesn't continue it, Cronk keeps the old text as well.

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
| `FILES_STORAGE` | `disk`                | Where the files of Attachments and Artifacts are stored: `disk`, or `s3` for any S3-compatible store (see below) |
| `FILES_DIR`     | `data/files`          | With `disk`: directory the files are stored in, relative to the working directory |
| `IMPORT_MAX_BYTES` | `53687091200` (50 GiB) | The most bytes one import of an export may write, counting the temporary copy of a zip archive and every file it stores; past it the import is refused with a 413 |
| `ARTIFACTS_URL` | (none; recommended)   | Address of a hostname of its own that serves Artifacts, e.g. `https://artifacts.cronk.example`; needs `PUBLIC_URL` too |

By default Attachments are files on local disk under `FILES_DIR`, so keep it on a volume that outlives Cronk and back it up with the database: the database records what each file is, the directory holds its bytes. `compose.yaml` keeps it in the `files-data` volume. Each Attachment may be up to 100 MB unless an Admin changes the limit in Workspace settings, where Admins also see how much storage they use; there is no quota. Exports include the files; importing one may write at most `IMPORT_MAX_BYTES` (50 GiB by default), counting a zip archive's temporary copy on local disk as well as the files it stores.

### S3-compatible storage

With `FILES_STORAGE=s3`, Cronk keeps the files in a bucket of an S3-compatible store instead: AWS S3, MinIO, Cloudflare R2 and the like. Everything works the same, downloads of part of a file and exports included. Create the bucket first and give Cronk's keys permission to put, get, delete and list objects in it; keep it private, since Cronk serves every file itself.

| Variable               | Default                          | Meaning                                                       |
| ---------------------- | -------------------------------- | ------------------------------------------------------------- |
| `S3_BUCKET`            | (required)                       | Bucket the files are stored in                                |
| `S3_ENDPOINT`          | AWS S3                           | Address of the store, e.g. `http://minio:9000` or `https://<account>.r2.cloudflarestorage.com` |
| `S3_REGION`            | `us-east-1`                      | The bucket's region; `auto` for R2                            |
| `S3_ACCESS_KEY_ID`     | (the AWS SDK's usual sources)    | Access key; set it together with `S3_SECRET_ACCESS_KEY`. Without both, the `AWS_*` variables, a profile or an instance role are used |
| `S3_SECRET_ACCESS_KEY` | (the AWS SDK's usual sources)    | Secret key                                                    |
| `S3_FORCE_PATH_STYLE`  | `true` with `S3_ENDPOINT`, else `false` | Address the bucket as `endpoint/bucket` rather than `bucket.endpoint`; MinIO needs `true` |

`compose.yaml` passes these through, so with Docker Compose put them in the `.env` file next to it. For example, for a MinIO at `minio.internal`:

```sh
FILES_STORAGE=s3
S3_ENDPOINT=http://minio.internal:9000
S3_BUCKET=cronk
S3_ACCESS_KEY_ID=cronk
S3_SECRET_ACCESS_KEY=…
```

Back the bucket up with the database, as you would `FILES_DIR`. Switching an existing installation between disk and S3 doesn't move its files: copy them across first, keeping their paths (`aws s3 sync data/files s3://cronk --exclude "*~partial"` with the same keys does it, leaving out files half-written when Cronk last stopped).

### The Artifact hostname

Artifacts are pages Agents and Users publish, and their code may be buggy or steered by hostile content an Agent read. Cronk serves them from a second hostname, so the browser keeps them away from the signed-in User's session (ADR 0007):

1. Pick a hostname for them, such as `artifacts.cronk.example`. A separate domain is safest; a subdomain of Cronk's own is fine too.
2. Point it at the same Cronk server, with its own TLS certificate if Cronk is served over HTTPS. Behind a reverse proxy, route both hostnames to Cronk and pass the `Host` header through.
3. Set `ARTIFACTS_URL` to its address, such as `https://artifacts.cronk.example`, and `PUBLIC_URL` to Cronk's, the only site that may frame them. The two must be different hostnames, not only different ports, since browsers send cookies to every port.

That hostname serves Artifacts' files and nothing else, never reads the sign-in cookie, and opens a Version only at a signed address Cronk hands out to whoever may read the Artifact, valid for 12 hours. Every file is served under a strict content policy: the page may load scripts, styles and fonts only from itself and the Workspace's allow-list, and may make no network requests. Without `ARTIFACTS_URL`, Cronk serves Artifacts from its own hostname in the same sandbox, which still gives them an origin of their own but is less safe; set it before Agents publish anything you haven't read.

The allow-list starts with cdnjs, jsDelivr, unpkg and Google Fonts; Admins edit it in Workspace settings. A publish may also declare extra origins for its Version, each with what the page loads from there (scripts, styles, fonts, images, media, or network requests) and why. They apply to that Version only, are shown on the Artifact, and are never carried over to the next. A strict installation can turn declared extras off in Workspace settings: publishes declaring any are then refused, and Versions that declared some are served without them. Nothing a publish declares loosens the sandbox itself.

Each Version of an Artifact may hold 500 files and 25 MB unless an Admin changes the limits in Workspace settings. Artifact files are stored beside Attachments, on disk or in S3, and exports include them.

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

The Files storage contract (`test/file-store.test.ts`) runs against local disk and against a disposable MinIO that the tests start with Testcontainers; set `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID` and `TEST_S3_SECRET_ACCESS_KEY` to use an existing S3-compatible server instead. When neither is available, the S3 tests are skipped.
