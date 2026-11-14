# 02: Projects and Tickets

**What to build:** A User can create a Project with a name and a short key, which comes with the default Statuses (one or more per Status Category: Backlog, Unstarted, Started, In Review, Completed, Canceled). Within it they create, view and edit Tickets with Markdown descriptions and keys like `CRONK-1`, change a Ticket's Status, see Tickets as a list and as a board grouped by Status, and see each Ticket's history with the Actor of every change. Projects can be archived.

**Blocked by:** 01 (Walking skeleton)

**Status:** ready-for-agent

- [ ] Creating a Project requires a unique key; it gets the default Statuses
- [ ] Tickets get keys `<PROJECT KEY>-<n>`, numbered in order per Project by the server
- [ ] Ticket title and Markdown description can be created and edited
- [ ] A User can move a Ticket to any Status
- [ ] List view and board view (grouped by Status) of a Project's Tickets
- [ ] Ticket history records every change and the Actor who made it
- [ ] Archived Projects leave the default overview but remain accessible
- [ ] API tests cover key allocation, Status changes and history
