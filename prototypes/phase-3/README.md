# PROTOTYPE: Cronk Phase 3 screens

Throwaway. Never merge this branch. It will be the primary source for the Phase 3 screens recorded in `docs/ui.md`.

Open `cronk-phase3.html` in a browser. The bar at the top picks a screen, the pill at the bottom (or ← →) cycles its variants; the address hash (`#ticket-b`) names one. All data is fake. Base CSS comes from `prototype/phase-2-ui`.

Screens:

- **Repositories** (Project settings): A rows + dialog, B guided setup, C health cards.
- **Ticket · Pull Requests**: A side panel group, B cards in the main column, C timeline entries. The Scenario control shows Ready for review, Checks failed (Send back by Cronk), No Report yet, and Merged by a User.
- **Notifications** (Your account): A matrix of events × places, B a card per place, C a row per event. D and E aren't variants: Git host accounts in Your account, and Workspace Webhooks with the SMTP state in Workspace settings.
- **Agent page**: A Agent Webhook and Git host accounts on the card, B one tabbed Connect dialog.
- **Sign-in**: A SSO above the password, B SSO first with the password behind a link. C isn't a variant: the Sign-in section of Workspace settings.
- **Importer**: A a dialog with counts, B a preview page of every issue.

Chosen:

- **Repositories**: C's health cards as the section in Project settings; listing a new one follows B's guided setup (address and token, webhook with a live wait for the ping, what events do).
- **Pull Requests on a Ticket**: both A (side panel group) and B (cards in the main column), as a choice each User makes, kept on the User like the diff view, defaulting to A.
- **Notifications**: A, the matrix of events × places.
- **Agent page**: B, one tabbed Connect dialog for tokens, the Agent Webhook and Git host accounts.
- **Sign-in**: A, SSO above the password form.
- **Importer**: B, a preview page of every issue before importing.
