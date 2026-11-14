import { expect, test } from "@playwright/test";

const ada = { email: "ada@example.com", password: "correct horse battery" };

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

// Runs after the test above on the same server, so the installation is already set up.
test("create a Project and a Ticket, move it on the board and see its history", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByLabel("Project name").fill("Cronk");
  await page.getByLabel("Key").fill("cronk");
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("heading", { name: "Cronk" })).toBeVisible();

  await page.getByRole("button", { name: "New Ticket" }).click();
  await page.getByLabel("Title").fill("Add sign-in");
  await page.getByLabel("Description (Markdown)").fill("Users need **access**.");
  await page.getByRole("button", { name: "Create Ticket" }).click();
  await page.getByRole("link", { name: /CRONK-1/ }).click();

  await expect(page.getByRole("heading", { name: "Add sign-in" })).toBeVisible();
  await expect(page.getByTestId("ticket-description").locator("strong")).toHaveText("access");
  await page.getByLabel("Status").selectOption({ label: "In Progress" });
  await expect(page.getByRole("list", { name: "History" })).toContainText("Ada moved it from Backlog to In Progress");

  await page.getByRole("link", { name: "CRONK", exact: true }).click();
  await page.getByRole("link", { name: "Board" }).click();
  await expect(page.getByRole("region", { name: "In Progress" })).toContainText("Add sign-in");
});
