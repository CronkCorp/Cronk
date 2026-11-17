# Smoke tests

A few Playwright walks through the main paths (see `docs/testing.md`, seam 3). They run in file order on one worker
against one server and database that `global-setup.ts` starts, so a test may build on what earlier ones made.
There are no retries: a red run must mean a broken change.

## What a test waits on

Act and assert only on state the page has reached, never on how fast a step happened to run:

- **An element, before acting on it.** Locator actions (`click`, `fill`) wait for their element; reach a page through
  what it shows, as `signIn` waits for the sidebar's Project link before the test goes on.
- **A finished save, before the next step relies on it.** Assert what the save shows (a `status` saying "Saved.", the
  new text, the timeline line) before navigating away or changing the same thing through the API. Where the page shows
  nothing for a save (the Diff view choice), start `page.waitForResponse` for its request before the action, then await
  it and check it succeeded.
- **A settled page, before reading a value.** Read values the page computes (`window.scrollY`, sizes, counts) with
  `expect.poll` or a web-first assertion (`toHaveText`, `toHaveCount`), not a one-shot `page.evaluate` or
  `textContent()`: a live update may still be laying out.
- **A live update, through what it changes.** After writing through the API behind a page's back, assert the change
  the page should show; the web-first assertion waits for it to arrive.

Never `waitForTimeout` or another fixed delay.

## What the harness absorbs

Import `test` and `expect` from `./fixtures.js`. Its `page` and `context` send a `goto` or `reload` again when Chromium
fails it with `ERR_NETWORK_CHANGED`, which Docker starting or stopping another worktree's containers causes; the web
client does the same for reads. Wrap a context a test makes itself in `resendOnNetworkChange`. Each test also starts only
once the server answers.

If the server exits mid-run, the global setup says so on the console and starts it again on the same database, up to
three times and only while the port is still free. Its log is kept in `test-results/cronk-server.log`. The test that was
running fails; the ones after it run on their own.
