# 01: Walking skeleton

**What to build:** A fresh Cronk installation that starts with one Docker Compose command (application plus Postgres), lets the first person create an account that becomes the Admin, and lets them sign in with email and password to an empty application shell. This ticket also establishes the testing pattern the rest of Phase 1 follows: API tests running the app in-process against a real, disposable Postgres with an injectable clock, and a Playwright smoke test. See the spec (`.scratch/phase-1-core-loop/spec.md`) and ADR 0006.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `docker compose up` starts the application and Postgres; the app is reachable in a browser
- [ ] All configuration comes from environment variables; nothing assumes it runs inside Docker
- [ ] Database schema is created and upgraded by migrations on startup
- [ ] On an installation with no Users, the first account created becomes the Admin; later sign-ups are not open
- [ ] A User can sign in and out with email and password; the Workspace can be named by the Admin
- [ ] API test harness runs against a real Postgres per test run, with an injectable clock
- [ ] Playwright smoke test signs in and sees the application shell
