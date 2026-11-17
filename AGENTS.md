# Cronk

A self-hosted platform where humans and AI agents share Tickets, Documents, Terms,
Decisions and Artifacts. See `GLOSSARY.md` for vocabulary and `docs/adr/` for decisions.

- `docs/roadmap.md`: phase scope, what is decided and what is still open for later phases, and the loop each phase follows.
- `docs/testing.md`: how to write and run tests; read before either.
- `docs/research/existing-platforms.md`: research on comparable platforms behind the design.
- `docs/ui.md`: layout, navigation, tokens, typography and component conventions. Read it before any work that touches the UI (`src/web/`).

## Tool use

Batch independent read-only commands (reading files, `git`, `gh`, `grep`) into one tool call, and read the parts of a large file you need rather than all of it.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `CronkCorp/Cronk`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
