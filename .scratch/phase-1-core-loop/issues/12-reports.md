# 12: Reports

**What to build:** An Agent Session holding a Claim can write a Report: a Document attached to the Ticket, kept out of the page tree. An Agent's move into an In Review Status is refused unless the Ticket has a Report written during the current Claim. Reports appear in the Ticket timeline and in a Project-wide Reports view.

**Blocked by:** 09 (Activities and live updates), 10 (Documents and Versions)

**Status:** ready-for-agent

- [ ] `documents` MCP tool gains `write_report` for the Claimed Ticket; a Ticket may have several Reports
- [ ] Reports are Documents (Versions, Markdown) but never appear in the page tree
- [ ] Agent move to In Review without a Report from the current Claim is refused with a clear message
- [ ] Releasing a Claim needs no Report
- [ ] Reports show in the Ticket timeline and in a Project Reports view
- [ ] API tests cover the In Review refusal and its success path
