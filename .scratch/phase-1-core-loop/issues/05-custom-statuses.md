# 05: Custom Statuses

**What to build:** Each Project can tailor its workflow: add, rename, reorder and remove Statuses, as long as every Status belongs to exactly one of the fixed Status Categories and each Category keeps at least one Status. Removing a Status in use asks where its Tickets should move.

**Blocked by:** 02 (Projects and Tickets)

**Status:** ready-for-agent

- [ ] Statuses can be added to any Status Category, renamed and reordered
- [ ] A Status can be removed only after its Tickets are moved to another Status
- [ ] The last Status of a Status Category cannot be removed
- [ ] Board columns follow the Project's Statuses
- [ ] API tests cover the constraints above
