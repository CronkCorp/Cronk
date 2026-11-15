# PROTOTYPE: Cronk UI directions (#98)

Throwaway. Never merge this branch. It is the primary source for the design direction recorded in `docs/ui.md`.

Open `cronk-ui.html` in a browser. The bar at the top picks a screen, the pill at the bottom (or ← →) cycles its variants; the address hash (`#inbox-b`) names one. All data is fake.

Chosen in #98: App frame A (sidebar), Inbox A (split triage), Ticket A (one timeline + side panel), Document A (margin Comments, split editor, side-by-side merge), Agents A (Agent cards); own component set plus Radix UI headless primitives.

`screenshots.mjs` regenerates the `docs/ui/*.png` screenshots from it with Playwright (paths inside are from the original session; adjust before running).
