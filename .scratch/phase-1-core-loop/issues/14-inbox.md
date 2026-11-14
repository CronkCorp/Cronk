# 14: Inbox

**What to build:** Each User has an Inbox listing Tickets in an In Review Status for which they are the Assignee, and open questions from Agents they own, with blocking questions pinned first. It can be filtered by kind, Project and Agent, updates live, and lets the User act directly: complete a Ticket, send it back to a Started Status with a Comment, or answer a question.

**Blocked by:** 12 (Reports), 13 (Comments and answering questions)

**Status:** ready-for-agent

- [ ] Inbox shows In Review Tickets where the User is Assignee, with their Reports at hand
- [ ] Inbox shows open questions from the User's Agents, blocking ones first
- [ ] Filters by kind, Project and Agent
- [ ] Actions: complete, send back with a Comment, answer a question
- [ ] Inbox updates live
- [ ] Playwright smoke test extended: sign in, open Inbox, open a Ticket
- [ ] API tests cover Inbox contents per User
