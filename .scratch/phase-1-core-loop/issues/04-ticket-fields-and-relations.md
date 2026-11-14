# 04: Ticket fields and relations

**What to build:** Tickets gain Priority (Urgent, High, Medium, Low, None), Labels, a parent (making them Sub-Tickets), and relations to other Tickets: blocks / blocked by and relates to. Users can filter Ticket lists and boards by Status, Status Category, Assignee, Priority and Label. Any `CRONK-12`-style reference in Markdown renders as a link to that Ticket.

**Blocked by:** 02 (Projects and Tickets)

**Status:** ready-for-agent

- [ ] Priority and Labels can be set and changed on a Ticket
- [ ] A Ticket can be given a parent; the parent shows its Sub-Tickets
- [ ] Blocks / blocked-by and relates-to relations can be added and removed, shown on both Tickets
- [ ] A Ticket cannot block itself or create a blocking cycle
- [ ] Filters for Status, Status Category, Assignee, Priority and Label in list and board
- [ ] Ticket references in Markdown render as links
- [ ] API tests cover relations, cycle refusal and filtering
