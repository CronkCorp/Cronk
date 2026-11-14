# Autonomous Agents complete Tickets; Users verify afterwards

By default Agents can move a Ticket no further than In Review. Under an Autonomous Delegation an Agent may complete Tickets so that dependent work unblocks and a long run can continue, but every such completion must carry a Report and stays Unverified until a User Accepts or Reopens it. Agents may file Discovered Tickets for out-of-scope work, but may not work on them until a User delegates them; they may split their own delegated Ticket into Sub-Tickets. This keeps humans in charge of what work gets done while letting Agents work through a large batch without waiting on review at every step.

## Consequences

- A Discovered Ticket that an Agent marks as blocking a queued Ticket halts that part of the autonomous run until a User vets it. This is intended.
