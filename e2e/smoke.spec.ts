import { expect, test } from "@playwright/test";

test("set up a fresh installation, sign out, sign in and see the application shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Set up Cronk" })).toBeVisible();
  await page.getByLabel("Workspace name").fill("Acme");
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create Admin account" }).click();
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByTestId("workspace-name")).toHaveText("Acme");
  await expect(page.getByRole("heading", { name: "No Projects yet" })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme");
});
