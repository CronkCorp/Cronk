# Cronk

A self-hosted platform where humans and AI agents share Tickets, Documents, Terms,
Decisions and Artifacts. See `GLOSSARY.md` for vocabulary and `docs/adr/` for decisions.

- `docs/roadmap.md`: phase scope, what is decided and what is still open for later phases, and the loop each phase follows.
- `docs/testing.md`: how to test; read before writing tests.
- `docs/research/existing-platforms.md`: research on comparable platforms behind the design.

## Agent skills

### Issue tracker

Issues and specs live as local Markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
