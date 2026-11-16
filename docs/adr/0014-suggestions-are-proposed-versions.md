# Suggestions are proposed Versions, merged on accept

An Agent can't edit a Protected item, so it proposes a Suggestion: the item's full new content, the Version it started from and its reasoning, exactly what a version-based edit would send (ADR 0009) but parked until a User accepts it. Accepting it unchanged makes it the item's next Version, credited to the Agent; a User who changes it first makes the Version their own, linked to the Suggestion, so history never credits an Agent with words it didn't write. If the item changed meanwhile, the Suggestion stays open, marked outdated, and accepting it goes through the existing merge flow with the Suggestion's base Version as the common ancestor. One shape covers Documents, Terms, Decisions and Guidance. It also covers adding a Document under a protected branch: the Suggestion names the parent instead of an item and starts from an empty Version 0, so a User reviews it as a diff from nothing, and accepting it creates the Document there at Version 1, credited the same way.

## Considered Options

- **A patch or list of edits**: smaller, but breaks as soon as the item changes and would need its own merge logic.
- **A Comment with suggested text**: no new concept, but nothing records whether it was applied, and the User copies text by hand.
- **Closing outdated Suggestions, or sending them back to the Agent to rebase**: puts the work on an Agent that may no longer have a live Agent Session, when the User accepting it has the context to merge.
