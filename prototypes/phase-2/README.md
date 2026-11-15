# PROTOTYPE: Cronk Phase 2 screens

Throwaway. Never merge this branch. It is the primary source for the Phase 2 screens recorded in `docs/ui.md`.

Open `cronk-phase2.html` in a browser. The bar at the top picks a screen, the pill at the bottom (or ← →) cycles its variants; the address hash (`#triage-b`) names one. All data is fake. Base CSS comes from the #98 prototype.

Chosen:

- **Suggestion review**: A, a unified diff with a Unified / Side by side switch (B), remembered per User. "Edit and accept…" opens C's editor.
- **Reopen**: A, a dialog with a choice per dependent.
- **Triage**: A, the Inbox's split view.
- **Terms**: A as the page; B's detail as the page for a single Term.
- **Decisions**: A, a register with inline "→ superseded by" pointers, linking to a full Decision page.
- **Artifact**: A, full bleed with a comment drawer; Versions and "Embedded in" sit in the Version menu.
- **Ticket Attachments**: both. Thumbnails under the description for the Ticket's own Attachments, and a Files section in the sticky side panel for every file and Artifact on the Ticket.
- **Navigation**: Terms and Decisions are top-level sidebar items with a Workspace / Project scope switch.

`shots.mjs` regenerates the `docs/ui/phase-2-*.png` screenshots with Playwright: `node shots.mjs <abs path to cronk-phase2.html> <out dir>`.
