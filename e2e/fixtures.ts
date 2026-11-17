import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

export { expect, type Locator } from "@playwright/test";

/**
 * Chromium fails a navigation in flight with ERR_NETWORK_CHANGED when the machine's network changes, such as when
 * Docker adds or removes an interface for another worktree's test database. That says nothing about Cronk, so each
 * page of `context` sends such a `goto` or `reload` again, up to twice; any other failure stands.
 * The `page` and `context` of every test get this already; call it on a context a test makes itself.
 */
export function steadyNavigations(context: BrowserContext): BrowserContext {
  const steady = (page: Page) => {
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
  context.pages().forEach(steady);
  context.on("page", steady);
  return context;
}

export const test = base.extend<{ context: BrowserContext; serverUp: void }>({
  context: async ({ context }, use) => {
    await use(steadyNavigations(context));
  },
  // Each test starts once Cronk answers, so one the global setup is starting again (see there) does not fail it too.
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
