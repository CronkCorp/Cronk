# 13: Comments and answering questions

**What to build:** Any Actor can post threaded Comments on Tickets and Documents; Comments on Documents can be anchored to a passage. A User answers an Agent's question by replying to it. Comments, @mentions of an Agent, and answers to its questions mark work as waiting for that Agent (ADR 0005): it appears in the welcome of its next Agent Session and is pushed to any connected Session. Comments and Activities show together in the Ticket timeline but stay distinct.

**Blocked by:** 09 (Activities and live updates), 10 (Documents and Versions)

**Status:** ready-for-agent

- [ ] Threaded Comments on Tickets and Documents, from Users and Agents
- [ ] Document Comments can anchor to a passage and survive later edits where the passage still exists
- [ ] Replying to a question Activity answers it; the question is marked answered
- [ ] Commenting on a delegated Ticket, @mentioning an Agent, or answering its question marks work waiting for that Agent
- [ ] Welcome includes waiting work; connected Sessions are notified
- [ ] `comments` MCP tool: list, post
- [ ] Timeline shows Comments and Activities interleaved but visually distinct
- [ ] API tests cover answering and waiting-work markers
