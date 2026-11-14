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

// Runs after the tests above, so CRONK-1 "Add sign-in" exists and is In Progress.
test("set a Ticket's fields and relations, follow a Ticket reference and filter the Project", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: /CRONK/ }).click();

  await page.getByRole("button", { name: "New Ticket" }).click();
  await page.getByLabel("Title").fill("Document sign-in");
  await page.getByLabel("Description (Markdown)").fill("Explains CRONK-1 once it ships.");
  await page.getByRole("button", { name: "Create Ticket" }).click();
  await page.getByRole("link", { name: /CRONK-2/ }).click();

  await page.getByLabel("Priority").selectOption({ label: "High" });
  await page.getByLabel("Assignee").selectOption({ label: "Ada" });
  await page.getByLabel("Add Label").fill("docs");
  await page.getByLabel("Add Label").press("Enter");
  await expect(page.getByRole("list", { name: "Labels" })).toContainText("docs");
  await page.getByLabel("Parent").fill("CRONK-1");
  await page.getByRole("button", { name: "Set parent" }).click();
  await expect(page.getByTestId("ticket-parent")).toContainText("CRONK-1");
  await page.getByLabel("Relation").selectOption({ label: "Blocked by" });
  await page.getByLabel("Related Ticket").fill("CRONK-1");
  await page.getByRole("button", { name: "Add relation" }).click();
  await expect(page.getByRole("list", { name: "Blocked by" })).toContainText("Add sign-in");
  await expect(page.getByRole("list", { name: "History" })).toContainText("Ada set the Priority to High");

  await page.getByTestId("ticket-description").getByRole("link", { name: "CRONK-1" }).click();
  await expect(page.getByRole("heading", { name: "Add sign-in" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Sub-Tickets" })).toContainText("Document sign-in");
  await expect(page.getByRole("list", { name: "Blocks" })).toContainText("Document sign-in");

  await page.getByRole("link", { name: "CRONK", exact: true }).click();
  await page.getByLabel("Filter by Priority").selectOption({ label: "High" });
  await expect(page.getByRole("list", { name: "Tickets" })).toContainText("Document sign-in");
  await expect(page.getByRole("list", { name: "Tickets" })).not.toContainText("Add sign-in");
  await page.getByRole("link", { name: "Board" }).click();
  await expect(page.getByLabel("Filter by Priority")).toHaveValue("high");
  await expect(page.getByRole("region", { name: "Backlog" })).toContainText("Document sign-in");
  await expect(page.getByRole("region", { name: "In Progress" })).not.toContainText("Add sign-in");
  await page.getByLabel("Filter by Label").selectOption({ label: "docs" });
  await page.getByLabel("Filter by Status Category").selectOption({ label: "Completed" });
  await expect(page.getByText("No Tickets match these filters")).toBeVisible();
});

// Runs after the tests above, so Ada and the CRONK Project exist.
test("invite a Member, who joins from the link and loses sight of the Project once it is private", async ({ page, browser }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByRole("link", { name: "Users" }).click();
  await page.getByLabel("Email").fill("bob@example.com");
  await page.getByRole("button", { name: "Invite" }).click();
  const link = await page.getByLabel("Invitation link").inputValue();

  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await bob.goto(link);
  await expect(bob.getByRole("heading", { name: "Join Acme" })).toBeVisible();
  await bob.getByLabel("Your name").fill("Bob");
  await bob.getByLabel("Password").fill("bobs password");
  await bob.getByRole("button", { name: "Join" }).click();
  await expect(bob.getByRole("link", { name: /CRONK/ })).toBeVisible();

  await page.goto("/projects/CRONK");
  await page.getByRole("button", { name: "Access" }).click();
  await page.getByRole("button", { name: "Make private" }).click();
  await expect(page.getByRole("heading", { name: /Private/ })).toBeVisible();

  await bob.reload();
  await expect(bob.getByRole("heading", { name: "No Projects yet" })).toBeVisible();
  await bobContext.close();
});
