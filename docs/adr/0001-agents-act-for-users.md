# Agents act for a User; Users stay accountable for Tickets

Every Agent is a persistent account owned by exactly one User, and each connection runs as an Agent Session under it, so history can tell parallel runs apart. A Ticket's Assignee is always a User; an Agent can only be the Ticket's Delegate (one of the Assignee's own Agents), and must hold an exclusive Claim through one Agent Session before working on it. We chose this over letting Agents be Assignees, so that accountability always rests with a human and so that two parallel Agent Sessions cannot work the same Ticket.

## Considered Options

- **Agent as plain Assignee**: simplest, but leaves no accountable human and no way to tell parallel runs of the same Agent apart.
- **Agent acts as its User's identity**: no separate account, but history can't tell a User's own edits from their Agents', and human-only areas can't be enforced.
