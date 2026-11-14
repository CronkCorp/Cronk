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
  // The Admin tunes how long a silent Agent Session keeps its Claims.
  await page.getByRole("button", { name: "Workspace settings" }).click();
  await expect(page.getByLabel("Silence threshold (minutes)")).toHaveValue("5");
  await page.getByLabel("Silence threshold (minutes)").fill("10");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Workspace settings" }).click();
  await expect(page.getByLabel("Silence threshold (minutes)")).toHaveValue("10");
  await page.getByRole("button", { name: "Cancel" }).click();

  // The API refuses query parameters it doesn't know; the application shell takes any.
  await page.goto("/?utm_source=bookmark");
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

  await page.getByRole("searchbox", { name: "Search" }).fill("shipping");
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results).toContainText("Explains CRONK-1 once it ships.");
  await results.getByRole("link", { name: /Document sign-in/ }).click();
  await expect(page.getByRole("heading", { name: "Document sign-in" })).toBeVisible();
});

// Runs after the tests above, so CRONK-1 "Add sign-in" exists and is In Progress.
test("tailor the Project's Statuses and see the board follow them", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: /CRONK/ }).click();
  await page.getByRole("link", { name: "Statuses" }).click();

  const started = page.getByRole("region", { name: "Started", exact: true });
  await started.getByLabel("New Started Status").fill("In QA");
  await started.getByRole("button", { name: "Add" }).click();
  await expect(started.getByRole("listitem")).toHaveText([/In Progress/, /In QA/]);

  await started.getByRole("button", { name: "Remove In Progress" }).click();
  await started.getByLabel("Move its Tickets to").selectOption({ label: "In QA" });
  await started.getByRole("button", { name: "Remove Status" }).click();
  await expect(started.getByRole("listitem")).toHaveText([/In QA/]);

  await page.getByRole("link", { name: "Board" }).click();
  await expect(page.getByRole("region", { name: "In QA" })).toContainText("Add sign-in");
  await expect(page.getByRole("region", { name: "In Progress" })).toHaveCount(0);
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

// Runs after the tests above, so Ada and the CRONK Project exist.
test("register an Agent, issue it a token, and see its change in a Ticket's history", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByLabel("Agent name").fill("claude-laptop");
  await page.getByRole("button", { name: "Register Agent" }).click();
  await page.getByRole("button", { name: "Issue full token" }).click();
  const token = await page.getByLabel("New token").inputValue();
  await expect(page.getByRole("list", { name: "Tokens of claude-laptop" })).toContainText("Full token");

  const created = await request.post("/api/projects/CRONK/tickets", {
    headers: { authorization: `Bearer ${token}` },
    data: { title: "Filed by an Agent" },
  });
  expect(created.status()).toBe(201);
  const { ticket } = await created.json();

  await page.goto(`/tickets/${ticket.key}`);
  await expect(page.getByRole("list", { name: "History" })).toContainText("claude-laptop (Agent of Ada) created the Ticket");

  // An Agent Session (one per MCP connection) shows on the Agents page and in the history of what it changed.
  const started = await request.post("/api/agent-sessions", { headers: { authorization: `Bearer ${token}` } });
  expect(started.status()).toBe(201);
  const session = (await started.json()).session.id as string;
  const renamed = await request.patch(`/api/tickets/${ticket.key}`, {
    headers: { authorization: `Bearer ${token}`, "cronk-agent-session": session },
    data: { title: "Filed and renamed by an Agent" },
  });
  expect(renamed.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("list", { name: "History" })).toContainText(`claude-laptop (session ${session.slice(0, 4)}, for Ada) renamed it`);
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("list", { name: "Live Agent Sessions of claude-laptop" })).toContainText(`Connected, session ${session.slice(0, 4)}`);
  // Ada delegates the Ticket to her Agent, whose Session Claims it; the Ticket shows both.
  await page.goto(`/tickets/${ticket.key}`);
  await expect(page.getByTestId("ticket-claim")).toHaveText("Not Claimed");
  await page.getByLabel("Assignee").selectOption({ label: "Ada" });
  await page.getByLabel("Delegate").selectOption({ label: "claude-laptop" });
  await expect(page.getByRole("list", { name: "History" })).toContainText("Ada delegated it to claude-laptop");
  const claimed = await request.post(`/api/tickets/${ticket.key}/claim`, {
    headers: { authorization: `Bearer ${token}`, "cronk-agent-session": session },
  });
  expect(claimed.status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId("ticket-claim")).toContainText(`Claimed by claude-laptop (session ${session.slice(0, 4)})`);
  // The Session logs Activities and writes a Report; the open Ticket page's timeline shows them as they arrive, without a reload.
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline).toContainText("Nothing yet.");
  const asked = await request.post(`/api/tickets/${ticket.key}/activities`, {
    headers: { authorization: `Bearer ${token}`, "cronk-agent-session": session },
    data: { kind: "question", body: "Should this use **Postgres**?", blocking: true },
  });
  expect(asked.status()).toBe(201);
  await expect(timeline).toContainText("Blocking question");
  await expect(timeline.getByRole("strong").filter({ hasText: "Postgres" })).toBeVisible();
  await expect(timeline).toContainText("Waiting for an answer");
  // Ada answers the question by replying to it; the answer shows under it as a Comment.
  await timeline.getByRole("button", { name: "Answer" }).click();
  await timeline.getByLabel("Answer", { exact: true }).fill("Yes, **Postgres**.");
  await timeline.getByRole("button", { name: "Post answer" }).click();
  await expect(timeline).toContainText("Answered");
  await expect(timeline.getByRole("list", { name: "Replies" })).toContainText("Yes, Postgres.");
  // A Comment of her own sits in the same timeline, after the question.
  await page.getByLabel("Comment", { exact: true }).fill("Thanks, carry on.");
  await page.getByRole("button", { name: "Post Comment" }).click();
  await expect(timeline.getByRole("listitem").last()).toContainText("Thanks, carry on.");
  const reported = await request.post(`/api/tickets/${ticket.key}/reports`, {
    headers: { authorization: `Bearer ${token}`, "cronk-agent-session": session },
    data: { title: "What I found", body: "It was the **cache**." },
  });
  expect(reported.status()).toBe(201);
  const report = timeline.getByRole("listitem", { name: "Report: What I found" });
  await expect(report.getByRole("strong").filter({ hasText: "cache" })).toBeVisible();
  // The Project's Reports view lists it, and it opens as a Document of the Ticket, outside the page tree.
  await page.getByRole("link", { name: ticket.key.split("-")[0]!, exact: true }).click();
  await page.getByRole("link", { name: "Reports" }).click();
  await page.getByRole("list", { name: "Reports" }).getByRole("link", { name: /What I found/ }).click();
  await expect(page.getByRole("heading", { name: /What I found/ })).toContainText(`Report on ${ticket.key}`);
  await expect(page.getByTestId("document-body")).toContainText("It was the cache.");
});

// Runs after the tests above, so Ada and the CRONK Project with CRONK-1 exist.
test("write a Document, edit it, and restore an earlier Version", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: /CRONK/ }).click();
  await page.getByRole("link", { name: "Documents" }).last().click();

  await page.getByRole("button", { name: "New Document" }).click();
  await page.getByLabel("Title").fill("Onboarding");
  await page.getByRole("button", { name: "Create Document" }).click();
  await page.getByLabel("Body (Markdown)").fill("Start with CRONK-1.");
  await page.getByRole("button", { name: "Save" }).click();

  const body = page.getByTestId("document-body");
  await expect(body).toContainText("Start with CRONK-1.");
  await expect(body.getByRole("link", { name: "CRONK-1" })).toHaveAttribute("href", "/tickets/CRONK-1");

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Body (Markdown)").fill("Rewritten.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(body).toContainText("Rewritten.");

  await page.getByRole("button", { name: "Versions" }).click();
  const versions = page.getByRole("list", { name: "Versions" });
  await expect(versions).toContainText("Version 3");
  await versions.getByRole("listitem").filter({ hasText: "Version 2" }).getByRole("button", { name: "Restore" }).click();
  await expect(body).toContainText("Start with CRONK-1.");
  await expect(versions).toContainText("Version 4");
  await expect(versions).toContainText("restored Version 2");

  // A Comment anchored to a passage shows the passage it is about.
  await page.getByLabel("About the passage (optional)").fill("CRONK-1");
  await page.getByLabel("Comment", { exact: true }).fill("Which Ticket is this?");
  await page.getByRole("button", { name: "Post Comment" }).click();
  const comments = page.getByRole("list", { name: "Comments" });
  await expect(comments).toContainText("Which Ticket is this?");
  await expect(comments.locator("blockquote")).toHaveText("CRONK-1");

  await page.getByRole("link", { name: "Documents", exact: true }).last().click();
  await expect(page.getByRole("list", { name: "Documents" })).toContainText("Onboarding");
});

// Runs after the test above, so CRONK holds Documents already.
test("compare two Versions, and merge an edit someone else saved underneath", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: /CRONK/ }).click();
  await page.getByRole("link", { name: "Documents" }).last().click();
  await page.getByRole("button", { name: "New Document" }).click();
  await page.getByLabel("Title").fill("Runbook");
  await page.getByRole("button", { name: "Create Document" }).click();
  await page.getByLabel("Body (Markdown)").fill("## Setup\n\nInstall it.\n\n## Usage\n\nRun it.\n");
  await page.getByRole("button", { name: "Save" }).click();
  const body = page.getByTestId("document-body");
  await expect(body).toContainText("Run it.");
  const id = new URL(page.url()).pathname.split("/").pop()!;
  /** Saves `text` as the next Version behind the editor's back, as another User or an Agent would. */
  const saveUnderneath = async (text: string) => {
    const { document } = await (await page.request.get(`/api/documents/${id}`)).json();
    expect((await page.request.patch(`/api/documents/${id}`, { data: { baseVersion: document.version, body: text } })).status()).toBe(200);
  };

  // Edits to different sections merge on their own.
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Body (Markdown)").fill("## Setup\n\nInstall it with npm.\n\n## Usage\n\nRun it.\n");
  await saveUnderneath("## Setup\n\nInstall it.\n\n## Usage\n\nRun it daily.\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("merged into yours");
  await expect(page.getByLabel("Body (Markdown)")).toHaveValue("## Setup\n\nInstall it with npm.\n\n## Usage\n\nRun it daily.\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(body).toContainText("Install it with npm.");
  await expect(body).toContainText("Run it daily.");

  // Edits to the same section wait for the User to choose.
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Body (Markdown)").fill("## Setup\n\nInstall it with npm.\n\n## Usage\n\nRun it hourly.\n");
  await saveUnderneath("## Setup\n\nInstall it with npm.\n\n## Usage\n\nRun it weekly.\n");
  await page.getByRole("button", { name: "Save" }).click();
  const usage = page.getByRole("region", { name: "## Usage" });
  await expect(usage.getByLabel("Keep for ## Usage")).toHaveValue("## Usage\n\nRun it hourly.\n");
  // Leaving the resolver keeps the draft; saving it again is refused and merges again.
  await page.getByRole("button", { name: "Back to my draft" }).click();
  await expect(page.getByLabel("Body (Markdown)")).toHaveValue("## Setup\n\nInstall it with npm.\n\n## Usage\n\nRun it hourly.\n");
  await expect(page.getByRole("alert")).toContainText("Your draft is still behind theirs");
  // While the save is in flight, the draft can't be changed under it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/documents/${id}`, async (route) => {
    if (route.request().method() === "PATCH") await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Title")).toBeDisabled();
  await expect(page.getByLabel("Body (Markdown)")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Discard mine and edit theirs" })).toBeDisabled();
  release();
  await expect(usage.getByLabel("Keep for ## Usage")).toHaveValue("## Usage\n\nRun it hourly.\n");
  await usage.getByRole("button", { name: "Use both" }).click();
  await expect(usage.getByLabel("Keep for ## Usage")).toHaveValue("## Usage\n\nRun it hourly.\n\nRun it weekly.\n");
  await page.getByRole("button", { name: "Use these and keep editing" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(body).toContainText("Run it hourly.");
  await expect(body).toContainText("Run it weekly.");

  await page.getByRole("button", { name: "Versions" }).click();
  await page.getByLabel("Compare").selectOption({ label: "Version 2" });
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const changes = page.getByRole("list", { name: /Changes from Version 2 to Version 6/ });
  await expect(changes).toContainText("- Install it.");
  await expect(changes).toContainText("+ Run it weekly.");
});

// Runs after the tests above, so CRONK exists.
test("merge a Guidance edit someone else saved underneath", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: /CRONK/ }).click();
  await page.getByRole("navigation", { name: "View" }).getByRole("link", { name: "Guidance" }).click();
  await page.getByRole("button", { name: "Edit Guidance" }).click();
  await page.getByLabel("Guidance (Markdown)").fill("## Style\n\nWrite tests first.\n\n## Tools\n\nUse npm.\n");
  await page.getByRole("button", { name: "Save" }).click();
  const guidance = page.getByTestId("guidance");
  await expect(guidance).toContainText("Use npm.");

  // Edits to different sections merge on their own, onto the Version saved underneath.
  await page.getByRole("button", { name: "Edit Guidance" }).click();
  await page.getByLabel("Guidance (Markdown)").fill("## Style\n\nWrite tests first, always.\n\n## Tools\n\nUse npm.\n");
  const { guidance: current } = await (await page.request.get("/api/projects/CRONK/guidance")).json();
  const underneath = { markdown: "## Style\n\nWrite tests first.\n\n## Tools\n\nUse pnpm.\n", baseVersion: current.version };
  expect((await page.request.put("/api/projects/CRONK/guidance", { data: underneath })).status()).toBe(200);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("merged into yours");
  await expect(page.getByLabel("Guidance (Markdown)")).toHaveValue("## Style\n\nWrite tests first, always.\n\n## Tools\n\nUse pnpm.\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(guidance).toContainText("Write tests first, always.");
  await expect(guidance).toContainText("Use pnpm.");

  // Leaving a conflict keeps the draft; saving it again is refused and merges again.
  await page.getByRole("button", { name: "Edit Guidance" }).click();
  const draft = "## Style\n\nWrite tests first, always.\n\n## Tools\n\nUse pnpm and tsc.\n";
  await page.getByLabel("Guidance (Markdown)").fill(draft);
  const { guidance: latest } = await (await page.request.get("/api/projects/CRONK/guidance")).json();
  const clashing = { markdown: "## Style\n\nWrite tests first, always.\n\n## Tools\n\nUse pnpm and vitest.\n", baseVersion: latest.version };
  expect((await page.request.put("/api/projects/CRONK/guidance", { data: clashing })).status()).toBe(200);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Back to my draft" }).click();
  await expect(page.getByLabel("Guidance (Markdown)")).toHaveValue(draft);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("region", { name: "## Tools" }).getByRole("button", { name: "Use both" }).click();
  await page.getByRole("button", { name: "Use these and keep editing" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(guidance).toContainText("Use pnpm and tsc.");
  await expect(guidance).toContainText("Use pnpm and vitest.");
});
