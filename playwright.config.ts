import { defineConfig, devices } from "@playwright/test";

export const E2E_HOST = "127.0.0.1";
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4173);

// Smoke tests only: the UI holds no rules (see docs/testing.md).
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://${E2E_HOST}:${E2E_PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
