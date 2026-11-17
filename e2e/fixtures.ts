import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

export { expect, type Locator } from "@playwright/test";

/**
 * Chromium fails a navigation in flight with ERR_NETWORK_CHANGED when the machine's network changes, such as when
 * Docker adds or removes an interface for another worktree's test database. That says nothing about Cronk, so each
 * page of `context` sends such a `goto` or `reload` again, up to twice; any other failure stands.
 * The `page` and `context` of every test get this already; call it on a context a test makes itself.
 */
export function resendOnNetworkChange(context: BrowserContext): BrowserContext {
  const resend = (page: Page) => {
    for (const name of ["goto", "reload"] as const) {
      const navigate = page[name].bind(page) as (...args: unknown[]) => Promise<unknown>;
      page[name] = (async (...args: unknown[]) => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await navigate(...args);
          } catch (err) {
            if (attempt === 3 || !String(err).includes("net::ERR_NETWORK_CHANGED")) throw err;
          }
        }
      }) as never;
    }
  };
  context.pages().forEach(resend);
  context.on("page", resend);
  return context;
}

export const test = base.extend<{ context: BrowserContext; serverUp: void }>({
  context: async ({ context }, use) => {
    await use(resendOnNetworkChange(context));
  },
  // Each test starts once Cronk answers, so one that `global-setup.ts` is starting again after it exited does not fail it too.
  serverUp: [
    async ({ request }, use) => {
      await expect
        .poll(async () => (await request.get("/api/health").catch(() => undefined))?.ok() ?? false, { timeout: 30_000 })
        .toBe(true);
      await use();
    },
    { auto: true },
  ],
});
