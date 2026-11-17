import { expect, resendOnNetworkChange, test, type Locator } from "./fixtures.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

const ada = { email: "ada@example.com", password: "correct horse battery" };

test("set up a fresh installation, sign out, sign in and see the application shell", async ({ page, baseURL }) => {
  const fontRequests: string[] = [];
  page.on("request", (r) => r.resourceType() === "font" && fontRequests.push(r.url()));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Set up Cronk" })).toBeVisible();
  // The IBM Plex faces come from Cronk's own build, never a CDN, so an offline installation still has them.
  const loadedFaces = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
    });
  await expect.poll(loadedFaces).toContain("IBM Plex Sans");
  await page.locator("body").evaluate((body) => {
    const code = document.createElement("code");
    code.textContent = "CRONK-1";
    body.append(code);
  });
  await expect.poll(loadedFaces).toContain("IBM Plex Mono");
  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) expect(url.startsWith(baseURL!)).toBe(true);
  await page.getByLabel("Workspace name").fill("Acme");
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create Admin account" }).click();
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme");

  await page.getByRole("button", { name: "Ada Admin" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByTestId("workspace-name")).toHaveText("Acme");
  await expect(page.getByRole("heading", { name: "No Projects yet" })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme");
  // The Admin tunes how long a silent Agent Session keeps its Claims.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByLabel("Silence threshold (minutes)")).toHaveValue("5");
  await page.getByLabel("Silence threshold (minutes)").fill("10");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(page.getByLabel("Silence threshold (minutes)")).toHaveValue("10");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/$/);

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
  await pickField(page, "Status", "In Progress");
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText("Ada moved it from Backlog to In Progress");

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
  await page.getByRole("main").getByRole("link", { name: /CRONK/ }).click();

  await page.getByRole("button", { name: "New Ticket" }).click();
  await page.getByLabel("Title").fill("Document sign-in");
  await page.getByLabel("Description (Markdown)").fill("Explains CRONK-1 once it ships.");
  await page.getByRole("button", { name: "Create Ticket" }).click();
  await page.getByRole("link", { name: /CRONK-2/ }).click();

  await pickField(page, "Priority", "High");
  await pickField(page, "Assignee", "Ada");
  // A Label the Project doesn't have yet is added by typing it.
  await page.getByRole("complementary", { name: "Ticket fields" }).getByRole("button", { name: /^Labels/ }).click();
  await page.getByLabel("Filter Labels").fill("docs");
  await page.getByLabel("Filter Labels").press("Enter");
  // Labels picked one right after the other are all kept.
  await page.getByLabel("Filter Labels").fill("sign-in");
  await page.getByLabel("Filter Labels").press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Ticket fields" }).getByRole("button", { name: /^Labels/ })).toContainText("docssign-in");
  await page.getByLabel("Parent").fill("CRONK-1");
  await page.getByRole("button", { name: "Set parent" }).click();
  await expect(page.getByTestId("ticket-parent")).toContainText("CRONK-1");
  await page.getByLabel("Relation").selectOption({ label: "Blocked by" });
  await page.getByLabel("Related Ticket").fill("CRONK-1");
  await page.getByRole("button", { name: "Add relation" }).click();
  await expect(page.getByRole("list", { name: "Blocked by" })).toContainText("Add sign-in");
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText("Ada set the Priority to High");

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
  await page.getByLabel("Filter by Kind").selectOption({ label: "Document" });
  await expect(page.getByText("Nothing found.")).toBeVisible();
  await page.getByLabel("Filter by Kind").selectOption({ label: "Ticket" });
  await page.getByLabel("Filter by Project").selectOption({ label: "Cronk" });
  await results.getByRole("link", { name: /Document sign-in/ }).click();
  await expect(page.getByRole("heading", { name: "Document sign-in" })).toBeVisible();
});

// Runs after the tests above, so CRONK-1 "Add sign-in" exists and is In Progress.
test("tailor the Project's Statuses and see the board follow them", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("main").getByRole("link", { name: /CRONK/ }).click();
  await page.getByRole("button", { name: "Project actions" }).click();
  await page.getByRole("menuitem", { name: "Project settings" }).click();
  await expect(page).toHaveURL(/view=settings/);
  for (const section of ["Access", "Agent Access", "Statuses", "Guidance"]) {
    await expect(page.getByRole("region", { name: section, exact: true })).toBeVisible();
  }

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

// Runs after the tests above, so Ada exists; archives a Project of its own so later tests keep CRONK.
test("archive a Project from the page head's … menu, through a confirmation", async ({ page }) => {
  await signIn(page);
  await page.request.post("/api/projects", { data: { name: "Attic", key: "ATTIC" } });
  await page.goto("/projects/ATTIC");
  await expect(page.getByRole("heading", { name: "Attic" })).toBeVisible();

  // Archive isn't in the head itself: it waits in the … menu and asks first.
  const head = page.getByTestId("page-head");
  await expect(head.getByRole("button", { name: "Archive Project" })).toHaveCount(0);
  await head.getByRole("button", { name: "Project actions" }).click();
  await page.getByRole("menuitem", { name: "Archive Project" }).click();
  await page.getByRole("dialog", { name: "Archive Attic?" }).getByRole("button", { name: "Archive Project" }).click();
  await expect(page.getByRole("heading", { name: /Attic/ })).toContainText("Archived");
  await page.goto("/archived");
  await expect(page.getByRole("main").getByRole("link", { name: /ATTIC/ })).toBeVisible();
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

  const bobContext = resendOnNetworkChange(await browser.newContext());
  const bob = await bobContext.newPage();
  await bob.goto(link);
  await expect(bob.getByRole("heading", { name: "Join Acme" })).toBeVisible();
  await bob.getByLabel("Your name").fill("Bob");
  await bob.getByLabel("Password").fill("bobs password");
  await bob.getByRole("button", { name: "Join" }).click();
  await expect(bob.getByRole("main").getByRole("link", { name: /CRONK/ })).toBeVisible();

  // The old address of a settings tab opens Project settings at that section.
  await page.goto("/projects/CRONK?view=statuses");
  await expect(page.getByRole("region", { name: "Statuses" })).toBeInViewport();
  await page.goto("/projects/CRONK?view=settings");
  await page.getByRole("button", { name: "Make private" }).click();
  await expect(page.getByRole("heading", { name: /Private/ })).toBeVisible();

  await bob.reload();
  await expect(bob.getByRole("heading", { name: "No Projects yet" })).toBeVisible();
  await bobContext.close();
});

// Runs after the tests above, so Ada and the CRONK Project exist.
test("register an Agent, issue it a token, and see its change in a Ticket's history", async ({ page, request }) => {
  await signIn(page);

  await page.getByRole("link", { name: "Agents" }).click();
  // Registering happens in a dialog opened from the page head.
  await page.getByRole("button", { name: "Register an Agent" }).click();
  const registerDialog = page.getByRole("dialog", { name: "Register an Agent" });
  await registerDialog.getByLabel("Agent name").fill("claude-laptop");
  // Outside the sign-in forms a button sizes to its label rather than filling its form.
  const register = (await registerDialog.getByRole("button", { name: "Register Agent" }).boundingBox())!;
  const agentName = (await registerDialog.getByLabel("Agent name").boundingBox())!;
  expect(register.width).toBeLessThan(agentName.width / 2);
  await registerDialog.getByRole("button", { name: "Register Agent" }).click();
  await expect(registerDialog).toBeHidden();
  const card = page.getByRole("listitem", { name: "claude-laptop" });
  await expect(card).toContainText("Not connected");
  // Tokens are issued in the Manage tokens dialog, which shows a new secret once.
  await card.getByRole("button", { name: "Manage tokens" }).click();
  const tokensDialog = page.getByRole("dialog", { name: "Tokens of claude-laptop" });
  await tokensDialog.getByRole("button", { name: "Issue full token" }).click();
  const token = await tokensDialog.getByLabel("New token").inputValue();
  await expect(tokensDialog.getByRole("button", { name: "Copy" })).toBeVisible();
  // It also shows how a script changes things within an Agent Session, as an Agent must.
  await expect(tokensDialog.getByLabel("Script using an Agent Session")).toHaveValue(/Cronk-Agent-Session/);
  await expect(tokensDialog.getByRole("list", { name: "Tokens of claude-laptop" })).toContainText("Full token");
  await tokensDialog.getByRole("button", { name: "Done" }).click();
  await expect(card).toContainText("1 token: full");
  await card.getByRole("button", { name: "Manage tokens" }).click();
  await expect(tokensDialog.getByLabel("New token")).toHaveCount(0);
  await tokensDialog.getByRole("button", { name: "Done" }).click();

  // Outside an Agent Session an Agent's token only reads.
  const refused = await request.post("/api/projects/CRONK/tickets", { headers: { authorization: `Bearer ${token}` }, data: { title: "No Session" } });
  expect(refused.status()).toBe(403);

  // An Agent Session (one per MCP connection) shows on the Agents page and in the history of what it changed.
  const started = await request.post("/api/agent-sessions", { headers: { authorization: `Bearer ${token}` } });
  expect(started.status()).toBe(201);
  const session = (await started.json()).session.id as string;
  const created = await request.post("/api/projects/CRONK/tickets", {
    headers: { authorization: `Bearer ${token}`, "cronk-agent-session": session },
    data: { title: "Filed by an Agent" },
  });
  expect(created.status()).toBe(201);
  const { ticket } = await created.json();

  await page.goto(`/tickets/${ticket.key}`);
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText(/claude-laptop [a-z]+-[a-z]+ for Ada created the Ticket/);
  // Ada delegates the Ticket to her Agent, whose Session Claims it; the Ticket shows both.
  await page.goto(`/tickets/${ticket.key}`);
  await expect(page.getByTestId("ticket-claim")).toHaveCount(0);
  await pickField(page, "Assignee", "Ada");
  await pickField(page, "Delegate", "claude-laptop");
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline).toContainText("Ada delegated it to claude-laptop");
  const claimed = await request.post(`/api/tickets/${ticket.key}/claim`, {
    headers: { authorization: `Bearer ${token}`, "cronk-agent-session": session },
  });
  expect(claimed.status()).toBe(200);
  // The Claim shows in the side panel as soon as it is made, without a reload.
  await expect(page.getByTestId("ticket-claim")).toContainText(`claude-laptop since`);
  // Holding the Claim, the Session renames the Ticket.
  const renamed = await request.patch(`/api/tickets/${ticket.key}`, {
    headers: { authorization: `Bearer ${token}`, "cronk-agent-session": session },
    data: { title: "Filed and renamed by an Agent" },
  });
  expect(renamed.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Filed and renamed by an Agent" })).toBeVisible();
  // The Session goes by a readable two-word name, the same everywhere, with its full id in the tooltip.
  const renamedBy = page.getByRole("list", { name: "Timeline" }).getByRole("listitem").filter({ hasText: "renamed it" });
  await expect(renamedBy).toContainText(/claude-laptop [a-z]+-[a-z]+ for Ada renamed it/);
  await expect(renamedBy.getByTitle(session)).toHaveText(/^[a-z]+-[a-z]+$/);
  const sessionName = (await renamedBy.getByTitle(session).textContent())!;
  await expect(page.getByTestId("ticket-claim").getByTitle(session)).toHaveText(sessionName);
  await page.getByRole("link", { name: "Agents" }).click();
  const liveSessions = page.getByRole("list", { name: "Live Agent Sessions of claude-laptop" });
  await expect(liveSessions).toContainText(`Live ${sessionName}`);
  await expect(liveSessions.getByTitle(session)).toHaveText(sessionName);
  // The open Agents page shows what the Session works on, and follows it as it releases and Claims again, without a reload.
  // The server notices Agent Session changes every 5 seconds, so these wait a little longer than usual.
  await expect(liveSessions).toContainText(`Working on ${ticket.key}`);
  await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();
  expect((await request.delete(`/api/tickets/${ticket.key}/claim`, { headers: { authorization: `Bearer ${token}`, "cronk-agent-session": session } })).status()).toBe(204);
  await expect(liveSessions).toContainText("Connected, no Claim", { timeout: 10_000 });
  expect((await request.post(`/api/tickets/${ticket.key}/claim`, { headers: { authorization: `Bearer ${token}`, "cronk-agent-session": session } })).status()).toBe(200);
  await expect(liveSessions).toContainText(`Working on ${ticket.key}`, { timeout: 10_000 });
  await page.goto(`/tickets/${ticket.key}`);
  await expect(page.getByTestId("ticket-claim").getByTitle(session)).toHaveText(sessionName);
  // The Session logs Activities and writes a Report; the open Ticket page's timeline shows them as they arrive, without a reload.
  const asked = await request.post(`/api/tickets/${ticket.key}/activities`, {
    headers: { authorization: `Bearer ${token}`, "cronk-agent-session": session },
    data: { kind: "question", body: "Should this use **Postgres**?", blocking: true },
  });
  expect(asked.status()).toBe(201);
  await expect(timeline).toContainText("Blocking question");
  // The timeline shows clock times under a separator for the day, with the exact time in the tooltip.
  await expect(timeline.getByRole("separator").first()).toHaveAccessibleName("Today");
  const askedAt = timeline.getByRole("listitem").filter({ hasText: "Blocking question" }).locator("time").first();
  await expect(askedAt).toHaveText(/^\d\d:\d\d$/);
  await expect(askedAt).toHaveAttribute("title", new RegExp(String(new Date().getFullYear())));
  await expect(timeline.getByRole("strong").filter({ hasText: "Postgres" })).toBeVisible();
  await expect(timeline).toContainText("Waiting for an answer");
  // Ada answers the question in its answer box; the answer shows under it as a Comment.
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

  // New questions arrive in Ada's open Inbox live; then the Session hands the Ticket over, ending its Claim, and it waits there with its Report.
  const agentCall = { authorization: `Bearer ${token}`, "cronk-agent-session": session };
  await page.getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const list = page.getByRole("region", { name: "Inbox items" });
  const detail = page.getByRole("region", { name: "Selected item" });
  await request.post(`/api/tickets/${ticket.key}/activities`, { headers: agentCall, data: { kind: "question", body: "Ship it **today**?", blocking: true } });
  const question = list.getByRole("list", { name: "Blocking" }).getByRole("link", { name: /Ship it today\?/ });
  await expect(question).toContainText(ticket.key);
  await question.click();
  await detail.getByLabel("Answer", { exact: true }).fill("Yes.");
  await detail.getByRole("button", { name: "Post answer" }).click();
  await expect(question).toHaveCount(0);
  const statuses = (await (await request.get(`/api/projects/${ticket.key.split("-")[0]}`, { headers: agentCall })).json()).statuses;
  const inReview = statuses.find((s: { category: string }) => s.category === "in_review").id;
  expect((await request.patch(`/api/tickets/${ticket.key}`, { headers: agentCall, data: { statusId: inReview } })).status()).toBe(200);
  const review = list.getByRole("list", { name: "To review" }).getByRole("link", { name: new RegExp(ticket.key) });
  await expect(review).toContainText("Report: What I found");
  await review.click();
  await expect(detail.getByRole("strong").filter({ hasText: "cache" })).toBeVisible();
  // The Ticket opens from the Inbox.
  await review.click();
  await detail.getByRole("link", { name: "Open Ticket" }).click();
  await expect(page.getByRole("heading", { name: "Filed and renamed by an Agent" })).toBeVisible();
  await page.goBack();
  // Ada sends the work back with what is left; it leaves her Inbox, and the Ticket shows why.
  await detail.getByRole("button", { name: "Send back…" }).click();
  await detail.getByLabel("What is left to do").fill("Add a test.");
  await detail.getByRole("button", { name: "Send back", exact: true }).click();
  await expect(review).toHaveCount(0);
  await page.goto(`/tickets/${ticket.key}`);
  const startedStatus = statuses.find((s: { category: string }) => s.category === "started").name;
  await expect(page.getByRole("complementary", { name: "Ticket fields" }).getByRole("button", { name: /^Status/ })).toContainText(startedStatus);
  // The Comment of a Send back is labelled as one, after the line saying who sent it back.
  await expect(timeline.getByRole("listitem").filter({ hasText: "Add a test." })).toContainText("Sent back");
  await expect(timeline).toContainText(`Ada sent it back: In Review → ${startedStatus}`);
});

// Runs after the tests above, so Ada and the CRONK Project with CRONK-1 exist.
test("write a Document, edit it, and restore an earlier Version", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("main").getByRole("link", { name: /CRONK/ }).click();
  await page.getByRole("link", { name: "Documents" }).last().click();

  await page.getByRole("button", { name: "New Document" }).click();
  await page.getByLabel("Title").fill("Onboarding");
  await page.getByRole("button", { name: "Create Document" }).click();
  // The toolbar formats the selected text, and the preview shows the Markdown as it will read.
  const editor = page.getByLabel("Body (Markdown)");
  await editor.fill("Start with CRONK-1.");
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 5));
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(editor).toHaveValue("**Start** with CRONK-1.");
  await page.getByRole("button", { name: "Heading" }).click();
  await expect(editor).toHaveValue("## **Start** with CRONK-1.");
  await expect(page.getByRole("region", { name: "Preview" }).getByRole("heading", { name: "Start with CRONK-1." })).toBeVisible();
  await page.getByRole("button", { name: "Heading" }).click();
  await expect(editor).toHaveValue("**Start** with CRONK-1.");
  const preview = page.getByRole("region", { name: "Preview" });
  await expect(preview.locator("strong")).toHaveText("Start");
  await expect(preview.getByRole("link", { name: "CRONK-1" })).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();

  const body = page.getByTestId("document-body");
  await expect(body).toContainText("Start with CRONK-1.");
  await expect(body.locator("strong")).toHaveText("Start");
  // What was saved is exactly the Markdown the editor showed.
  const id = new URL(page.url()).pathname.split("/").pop()!;
  expect((await (await page.request.get(`/api/documents/${id}`)).json()).document.body).toBe("**Start** with CRONK-1.");
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

  // Selecting text in the Document offers to comment on it, quoting the Markdown the selection reads from.
  await body.evaluate((el) => {
    const range = document.createRange();
    const reference = el.querySelector("a")!;
    range.setStart(el.querySelector("strong")!, 0);
    range.setEnd(reference, reference.childNodes.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(page.getByLabel("About the passage (optional)")).toHaveValue("**Start** with CRONK-1");
  await expect(page.getByLabel("Comment", { exact: true })).toBeFocused();
  // A Comment anchored to a passage shows the passage it is about.
  await page.getByLabel("Comment", { exact: true }).fill("Which Ticket is this?");
  await page.getByRole("button", { name: "Post Comment" }).click();
  const comments = page.getByRole("list", { name: "Comments" });
  await expect(comments).toContainText("Which Ticket is this?");
  await expect(comments.locator("blockquote")).toHaveText("**Start** with CRONK-1");

  await page.getByRole("link", { name: "Documents", exact: true }).last().click();
  await expect(page.getByRole("list", { name: "Documents" })).toContainText("Onboarding");
});

/** Selects the rendered text inside `root` from `from` in the element matching `startIn` up to `to` in `endIn`. */
const selectText = (root: Locator, startIn: string, from: string, endIn: string, to: string) =>
  root.evaluate(
    (el, { startIn, from, endIn, to }) => {
      const textOf = (selector: string, holding: string) => {
        for (const container of el.querySelectorAll(selector)) {
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) if (walker.currentNode.textContent!.includes(holding)) return walker.currentNode as Text;
        }
        throw new Error(`no text holding ${holding}`);
      };
      const start = textOf(startIn, from);
      const end = textOf(endIn, to);
      const range = document.createRange();
      range.setStart(start, start.data.indexOf(from));
      range.setEnd(end, end.data.indexOf(to) + to.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    },
    { startIn, from, endIn, to },
  );

// Runs after the tests above, so Ada and the CRONK Project exist.
test("comment on passages through soft-wrapped lines, escapes and entities", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("main").getByRole("link", { name: /CRONK/ }).click();
  await page.getByRole("link", { name: "Documents" }).last().click();
  await page.getByRole("button", { name: "New Document" }).click();
  await page.getByLabel("Title").fill("Quoting");
  await page.getByRole("button", { name: "Create Document" }).click();
  await page.getByLabel("Body (Markdown)").fill("> Quoted and\n> wrapped, a\\*b &amp; c.\n\n- Listed and\n  continued.\n\nSee x\\*y in CRONK-1.\n\nWrite &amp;amp;\n\nUnknown &foo; next to x\\*y.\n\nSome **bold a\\*b** text.");
  await page.getByRole("button", { name: "Save" }).click();
  const body = page.getByTestId("document-body");
  await expect(body).toContainText("wrapped, a*b & c.");

  // The selection starts in the first quoted line and ends past an escape and an entity on the next.
  await selectText(body, "blockquote", "and", "blockquote", "b &");
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(page.getByLabel("About the passage (optional)")).toHaveValue("and\n> wrapped, a\\*b &amp;");
  await page.getByLabel("Comment", { exact: true }).fill("Why quote this?");
  await page.getByRole("button", { name: "Post Comment" }).click();
  const comments = page.getByRole("list", { name: "Comments" });
  await expect(comments).toContainText("Why quote this?");

  // A list item's indented continuation line is skipped the same way.
  await selectText(body, "li", "and", "li", "continued");
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(page.getByLabel("About the passage (optional)")).toHaveValue("and\n  continued");

  // Text split around a Ticket reference keeps its place in the Markdown past an escape before it.
  await selectText(body, "p:has(a)", "x*y", "p a", "CRONK-1");
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(page.getByLabel("About the passage (optional)")).toHaveValue("x\\*y in CRONK-1");

  // Text that also reads verbatim elsewhere in its Markdown is still tied to where it came from.
  await selectText(body, "p", "&amp;", "p", "&amp;");
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(page.getByLabel("About the passage (optional)")).toHaveValue("&amp;amp;");

  // Something that only looks like an entity is plain text, character by character.
  await selectText(body, "p", "foo; next", "p", "foo; next");
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(page.getByLabel("About the passage (optional)")).toHaveValue("foo; next");

  // Selecting all of a bold run takes in its markup, even with an escape inside.
  await selectText(body, "strong", "bold", "strong", "a*b");
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(page.getByLabel("About the passage (optional)")).toHaveValue("**bold a\\*b**");
});

// Runs after the tests above, so Ada and the CRONK Project exist.
test("see a Comment in the margin beside the passage it is about", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme");
  const intro = "Cronk stores every password as an **Argon2id** hash.\n\n";
  const { document } = await (
    await page.request.post("/api/projects/CRONK/documents", {
      data: { title: "Security notes", body: `${intro.repeat(12)}## Rate limits\n\nFailed sign-ins are limited to five per minute. The limit slides.\n` },
    })
  ).json();
  const passage = "Failed sign-ins are limited to five per minute";
  await page.request.post(`/api/documents/${document.id}/comments`, { data: { body: "Per IP too?", anchor: { passage } } });
  await page.goto(`/documents/${document.id}`);

  // The passage is highlighted in the body, and its Comment's card sits in the margin beside it.
  const highlighted = page.getByTestId("document-body").locator("mark");
  await expect(highlighted).toHaveText(passage);
  const card = page.getByRole("list", { name: "Comments" }).getByRole("listitem").filter({ hasText: "Per IP too?" });
  await expect(card).toBeVisible();
  const passageBox = (await highlighted.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.x).toBeGreaterThan(passageBox.x + passageBox.width);
  expect(Math.abs(cardBox.y - passageBox.y)).toBeLessThan(24);

  // Hovering or focusing either one highlights both.
  await highlighted.hover();
  await expect(highlighted).toHaveClass(/active/);
  await expect(card).toHaveClass(/active/);
  await page.mouse.move(0, 0);
  await expect(highlighted).not.toHaveClass(/active/);
  await card.focus();
  await expect(highlighted).toHaveClass(/active/);

  // On a narrow screen the Comments move under the body.
  await page.setViewportSize({ width: 800, height: 900 });
  const narrowBody = (await page.getByTestId("document-body").boundingBox())!;
  expect((await card.boundingBox())!.y).toBeGreaterThan(narrowBody.y + narrowBody.height);
});

// Runs after the tests above, so Ada and the CRONK Project exist.
test("highlight a repeated passage once, and list passages that can't be placed at the end of the margin", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme");
  const first = "Old wording.\n\nRotate the keys yearly.\n\n```js\njs\n```\n";
  const { document } = await (await page.request.post("/api/projects/CRONK/documents", { data: { title: "Key rotation", body: first } })).json();
  const comment = (body: string, passage: string) => page.request.post(`/api/documents/${document.id}/comments`, { data: { body, anchor: { passage } } });
  await comment("Is this still true?", "Old wording.");
  await page.request.patch(`/api/documents/${document.id}`, { data: { baseVersion: 1, body: `Rotate the keys yearly.\n\n${first.slice(14)}\n## Again\n\nRotate the keys yearly.\n` } });
  // The info string of a code block shows nowhere on the page, so this passage can't be placed.
  await comment("Which language?", "```js");
  await comment("Why yearly?", "Rotate the keys");
  await page.goto(`/documents/${document.id}`);

  // The passage appears twice, but only its first place in the Markdown is highlighted.
  const body = page.getByTestId("document-body");
  await expect(body.locator("mark")).toHaveCount(1);
  await expect(body.locator("p").first().locator("mark")).toHaveText("Rotate the keys");

  // The placed card comes first; the passage that can't be placed and the detached one follow, unhighlighted.
  const cards = page.getByRole("list", { name: "Comments" }).locator("> li");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("Why yearly?");
  await expect(cards.nth(1)).toContainText("Is this still true?");
  await expect(cards.nth(1)).toContainText("No longer in the Document (was in Version 1)");
  await expect(cards.nth(2)).toContainText("Which language?");
  await expect(cards.nth(1).locator("blockquote")).toHaveCSS("text-decoration-line", "line-through");
});

// Runs after the tests above, so Ada and the CRONK Project exist.
test("settle a stale save by using their side of the conflict", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme");
  const original = "## Setup\n\nInstall it.\n\n## Limits\n\nFive per minute.\n";
  const { document } = await (await page.request.post("/api/projects/CRONK/documents", { data: { title: "Rate limits", body: original } })).json();
  await page.goto(`/documents/${document.id}`);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Title").fill("Rate limits per IP");
  await page.getByLabel("Body (Markdown)").fill("## Setup\n\nInstall it.\n\n## Limits\n\nFive per minute, sliding.\n");
  const theirs = "## Setup\n\nInstall it with npm.\n\n## Limits\n\nFive per email and fifty per IP.\n";
  expect((await page.request.patch(`/api/documents/${document.id}`, { data: { baseVersion: 1, body: theirs } })).status()).toBe(200);
  await page.getByRole("button", { name: "Save" }).click();

  // An information banner, under the Document's title, says who saved which Version and what needs a choice.
  await expect(page.getByRole("heading", { name: "Rate limits" })).toBeVisible();
  const banner = page.getByRole("alert");
  await expect(banner).toContainText("Ada saved Version 2 while you were editing");
  await expect(banner).toContainText("1 section needs your choice");
  await expect(banner).toHaveClass(/banner info/);
  // The conflict shows both sides next to each other; the section that merged cleanly is folded.
  const limits = page.getByRole("region", { name: "## Limits" });
  await expect(limits.getByText("Both changed")).toBeVisible();
  const yours = limits.getByRole("region", { name: "Yours" });
  const theirSide = limits.getByRole("region", { name: "Ada, Version 2" });
  await expect(yours).toContainText("Five per minute, sliding.");
  await expect(theirSide).toContainText("Five per email and fifty per IP.");
  expect((await theirSide.boundingBox())!.x).toBeGreaterThan((await yours.boundingBox())!.x);
  const clean = page.getByRole("group", { name: "Merged cleanly" });
  await expect(clean.getByRole("list")).toBeHidden();
  await clean.getByText("Merged cleanly").click();
  await expect(clean).toContainText("+ Install it with npm.");
  await expect(page.getByRole("button", { name: "Discard mine and edit theirs" })).toBeVisible();

  await limits.getByRole("button", { name: "Use theirs" }).click();
  await expect(limits.getByLabel("Keep for ## Limits")).toHaveValue("## Limits\n\nFive per email and fifty per IP.\n");
  await page.getByRole("button", { name: "Use these and keep editing" }).click();
  await expect(page.getByLabel("Body (Markdown)")).toHaveValue(theirs);
  await page.getByRole("button", { name: "Save" }).click();
  // Their body is kept, with the title only this edit changed.
  await expect(page.getByRole("heading", { name: "Rate limits per IP" })).toBeVisible();
  await expect(page.getByTestId("document-body")).toContainText("Five per email and fifty per IP.");
  expect((await (await page.request.get(`/api/documents/${document.id}`)).json()).document.version).toBe(3);
});

// Runs after the tests above, so Ada and the CRONK Project exist.
test("comment on passages of code inside blockquotes and list items", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("main").getByRole("link", { name: /CRONK/ }).click();
  await page.getByRole("link", { name: "Documents" }).last().click();
  await page.getByRole("button", { name: "New Document" }).click();
  await page.getByLabel("Title").fill("Quoted code");
  await page.getByRole("button", { name: "Create Document" }).click();
  await page
    .getByLabel("Body (Markdown)")
    .fill(
      [
        "> ```",
        "> quoted one",
        ">   quoted two",
        "> ```",
        "",
        "- listed",
        "",
        "  ```",
        "  listed one",
        "    listed two",
        "  ```",
        "",
        "- indented",
        "",
        "      indent one",
        "        indent two",
        "",
        "Between.",
        "",
        "> - nested",
        ">",
        ">   ```",
        ">   nested one",
        ">     nested two",
        ">   ```",
        "",
        "- tabbed",
        "",
        "  ```",
        "\ttab one",
        "  tab two",
        "  ```",
      ].join("\n"),
    );
  await page.getByRole("button", { name: "Save" }).click();
  const body = page.getByTestId("document-body");
  await expect(body).toContainText("nested one");
  const passage = page.getByLabel("About the passage (optional)");

  // Across the lines of a fenced code block in a blockquote: the `> ` goes into the passage, the code's own spaces stay.
  await selectText(body, "blockquote > pre", "one", "blockquote > pre", "  quoted");
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(passage).toHaveValue("one\n>   quoted");
  await page.getByLabel("Comment", { exact: true }).fill("Why quote code?");
  await page.getByRole("button", { name: "Post Comment" }).click();
  await expect(page.getByRole("list", { name: "Comments" })).toContainText("Why quote code?");

  // In a list item, past its content indentation.
  await selectText(body, "li pre", "one", "li pre", "  listed");
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(passage).toHaveValue("one\n    listed");

  // An indented code block in a list item.
  await selectText(body, "li pre", "indent one", "li pre", "  indent two");
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(passage).toHaveValue("indent one\n        indent two");

  // A list item inside a blockquote: both prefixes, in order.
  await selectText(body, "blockquote li pre", "one", "blockquote li pre", "  nested");
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  await expect(passage).toHaveValue("one\n>     nested");

  // A tab's width depends on its column, so code indented with one is tied to nothing and offers nothing.
  await selectText(body, "li pre", "tab one", "li pre", "tab two");
  await expect(body).toContainText("tab two");
  await expect(page.getByRole("button", { name: "Comment on this passage" })).toBeHidden();
});

// Runs after the tests above, so CRONK-2 "Document sign-in" and the Document "Onboarding" exist.
test("link a Document to a Ticket from the Ticket's page, then unlink it", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("main").getByRole("link", { name: /CRONK/ }).click();
  await page.getByRole("link", { name: /CRONK-2/ }).click();
  await expect(page.getByRole("heading", { name: "Document sign-in" })).toBeVisible();

  await page.getByLabel("Find a Document to link").fill("Onboarding");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByRole("list", { name: "Documents to link" }).getByRole("button", { name: "Link Onboarding" }).click();
  const documents = page.getByRole("list", { name: "Documents" });
  await expect(documents).toContainText("Onboarding");
  await expect(documents).toContainText("Linked");
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText("Ada linked the Document “Onboarding”");

  await documents.getByRole("button", { name: "Unlink Onboarding" }).click();
  await expect(page.getByRole("list", { name: "Documents" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText("Ada unlinked the Document “Onboarding”");
});

// Runs after the tests above, so CRONK-2 "Document sign-in" exists.
test("see attaching a file and deleting one as change lines, the attached one opening while it is there", async ({ page }) => {
  await signIn(page);
  const attach = async (name: string, data: Buffer, type: string) => {
    const res = await page.request.post(`/api/tickets/CRONK-2/attachments?name=${name}`, { data, headers: { "content-type": type } });
    expect(res.status()).toBe(201);
    return (await res.json()).attachment.id as string;
  };
  await attach("sign-in-flood.log", Buffer.alloc(220 * 1024, "x"), "text/plain");
  const gone = await attach("proxy-ip.png", Buffer.from("89504e470d0a1a0a", "hex"), "image/png");
  expect((await page.request.delete(`/api/attachments/${gone}`)).status()).toBe(204);

  await page.goto("/tickets/CRONK-2");
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline).toContainText("Ada attached sign-in-flood.log (220 KB)");
  await expect(timeline).toContainText("Ada attached proxy-ip.png (8 B)");
  await expect(timeline).toContainText("Ada removed proxy-ip.png");
  // Only a file still on the Ticket opens; a deleted one is its name alone.
  await expect(timeline.getByRole("button", { name: "proxy-ip.png" })).toHaveCount(0);
  await timeline.getByRole("button", { name: "sign-in-flood.log" }).click();
  await expect(page.getByRole("dialog", { name: "sign-in-flood.log" })).toBeVisible();
});

// Runs after the test above, so CRONK holds Documents already.
test("compare two Versions, and merge an edit someone else saved underneath", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("main").getByRole("link", { name: /CRONK/ }).click();
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
test("see the board, a Ticket, a Document and a Decision follow changes made elsewhere", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("main").getByRole("link", { name: /CRONK/ })).toBeVisible();

  // Changes come through the API behind the page's back, as another User or an Agent would make them.
  await page.goto("/projects/CRONK?view=board");
  await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible();
  // Each view that follows changes says it is live.
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const { ticket } = await (await page.request.post("/api/projects/CRONK/tickets", { data: { title: "Arrived live" } })).json();
  await expect(page.getByRole("region", { name: "Backlog" })).toContainText("Arrived live");

  await page.goto(`/tickets/${ticket.key}`);
  await expect(page.getByRole("heading", { name: "Arrived live" })).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await page.request.patch(`/api/tickets/${ticket.key}`, { data: { title: "Renamed live" } });
  await expect(page.getByRole("heading", { name: "Renamed live" })).toBeVisible();
  // A field changed elsewhere shows in the side panel and as a line in the timeline.
  await page.request.patch(`/api/tickets/${ticket.key}`, { data: { priority: "urgent" } });
  await expect(page.getByRole("complementary", { name: "Ticket fields" }).getByRole("button", { name: /^Priority/ })).toContainText("Urgent");
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText("Ada set the Priority to Urgent");
  // On a phone the side panel sits above the timeline, and nothing runs off the side.
  await page.setViewportSize({ width: 375, height: 800 });
  const side = (await page.getByRole("complementary", { name: "Ticket fields" }).boundingBox())!;
  const timelineBox = (await page.getByRole("list", { name: "Timeline" }).boundingBox())!;
  expect(side.y + side.height).toBeLessThanOrEqual(timelineBox.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize({ width: 1280, height: 720 });

  const { document } = await (await page.request.post("/api/projects/CRONK/documents", { data: { title: "Live notes", body: "First." } })).json();
  await page.goto(`/documents/${document.id}`);
  await expect(page.getByTestId("document-body")).toContainText("First.");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await page.request.post(`/api/documents/${document.id}/comments`, { data: { body: "Seen from afar." } });
  await expect(page.getByRole("list", { name: "Comments" })).toContainText("Seen from afar.");
  await page.request.patch(`/api/documents/${document.id}`, { data: { baseVersion: 1, body: "Second." } });
  await expect(page.getByTestId("document-body")).toContainText("Second.");

  // While editing, a newer Version is announced instead of replacing the draft.
  await page.getByRole("button", { name: "Edit" }).click();
  await page.request.patch(`/api/documents/${document.id}`, { data: { baseVersion: 2, body: "Third." } });
  const savedMeanwhile = page.getByRole("status");
  await expect(savedMeanwhile).toContainText("Ada saved Version 3 while you were editing Version 2");
  await savedMeanwhile.getByText("See what they changed").click();
  await expect(savedMeanwhile).toContainText("+ Third.");
  await expect(page.getByLabel("Body (Markdown)")).toHaveValue("Second.");

  // A Decision's page shows a Version saved elsewhere, and while editing announces it instead of replacing the draft.
  const { decision } = await (await page.request.post("/api/projects/CRONK/decisions", { data: { title: "Live decision", body: "First." } })).json();
  await page.goto(`/decisions/${decision.key}`);
  await expect(page.getByTestId("decision-body")).toContainText("First.");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await page.request.patch(`/api/decisions/${decision.key}`, { data: { baseVersion: 1, body: "Second." } });
  await expect(page.getByTestId("decision-body")).toContainText("Second.");
  await page.getByRole("button", { name: "Edit" }).click();
  await page.request.patch(`/api/decisions/${decision.key}`, { data: { baseVersion: 2, body: "Third." } });
  const decisionSavedMeanwhile = page.getByRole("status");
  await expect(decisionSavedMeanwhile).toContainText("Ada saved Version 3 while you were editing Version 2");
  await decisionSavedMeanwhile.getByText("See what they changed").click();
  await expect(decisionSavedMeanwhile).toContainText("+ Third.");
  await expect(page.getByLabel("Body (Markdown)")).toHaveValue("Second.");
});

// Runs after the tests above, so CRONK exists.
test("merge a Guidance edit someone else saved underneath", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("main").getByRole("link", { name: /CRONK/ }).click();
  await page.goto("/projects/CRONK?view=guidance");
  await expect(page.getByRole("region", { name: "Guidance" })).toBeInViewport();
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

// Runs after the tests above, so Ada exists; the Workspace's page tree is still empty.
test("import a folder of Markdown files picked in the browser", async ({ page }) => {
  const picked = await mkdtemp(join(tmpdir(), "cronk-import-"));
  try {
    await mkdir(join(picked, "handbook", "setup"), { recursive: true });
    await writeFile(join(picked, "handbook", "README.md"), "# Handbook\n\nWelcome aboard.");
    await writeFile(join(picked, "handbook", "setup", "install.md"), "# Installing\n\nRun it.");
    await writeFile(join(picked, "handbook", "logo.png"), "not markdown");

    await page.goto("/");
    await page.getByLabel("Email").fill(ada.email);
    await page.getByLabel("Password").fill(ada.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("workspace-name")).toHaveText("Acme");
    await page.goto("/documents");

    await page.getByLabel("Import Markdown folder…").setInputFiles(join(picked, "handbook"));
    const tree = page.getByRole("list", { name: "Documents" });
    await expect(tree).toContainText("Handbook");
    await expect(tree).toContainText("Installing");
    await tree.getByRole("link", { name: "Installing" }).click();
    await expect(page.getByTestId("document-body")).toContainText("Run it.");

    // Deleting asks first; cancelling keeps the Document, confirming removes it from the tree.
    await page.getByRole("button", { name: "Delete" }).click();
    const confirmDelete = page.getByRole("dialog", { name: "Delete Installing?" });
    await expect(confirmDelete).toContainText("and all its Versions");
    await confirmDelete.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmDelete).toHaveCount(0);
    await expect(page.getByTestId("document-body")).toContainText("Run it.");
    await page.getByRole("button", { name: "Delete" }).click();
    await confirmDelete.getByRole("button", { name: "Delete" }).click();
    await expect(tree).toContainText("Handbook");
    await expect(tree).not.toContainText("Installing");
  } finally {
    await rm(picked, { recursive: true, force: true });
  }
});

// Runs after the tests above, so Ada and the CRONK Project exist.
test("find the way around from the sidebar: counts, Projects, Settings and the phone menu", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  await expect(sidebar.getByTestId("workspace-name")).toHaveText("Acme");

  // An archived Project is left out of the sidebar.
  await page.request.post("/api/projects", { data: { name: "Old stuff", key: "OLD" } });
  await page.request.patch("/api/projects/OLD", { data: { archived: true } });

  // An Agent of Ada's connects; its live Agent Session counts once the frame loads again.
  const { agent } = await (await page.request.post("/api/agents", { data: { name: "sidebar-bot" } })).json();
  const { secret } = await (await page.request.post(`/api/agents/${agent.id}/tokens`, { data: { readOnly: false } })).json();
  const asAgent = { authorization: `Bearer ${secret}` };
  const live = async () =>
    ((await (await page.request.get("/api/agents")).json()).agents as { sessions: unknown[] }[]).reduce((n, a) => n + a.sessions.length, 0);
  const before = await live();
  const session = (await (await page.request.post("/api/agent-sessions", { headers: asAgent })).json()).session.id as string;

  // Navigating to a Project from the sidebar marks it, and only it, as the current page.
  await sidebar.getByRole("link", { name: "CRONK Cronk" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cronk");
  await expect(sidebar.locator("[aria-current=page]")).toHaveCount(1);
  await expect(sidebar.getByRole("link", { name: "CRONK Cronk" })).toHaveAttribute("aria-current", "page");
  await expect(sidebar.getByRole("link", { name: /OLD/ })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: /^Agents/ })).toHaveAccessibleName(`Agents ${before + 1} live`);

  // The Inbox count follows a new question without a reload.
  const waiting = (await (await page.request.get("/api/inbox")).json()).items.length as number;
  const inbox = sidebar.getByRole("link", { name: /^Inbox/ });
  await expect(inbox).toHaveAccessibleName(waiting ? `Inbox ${waiting} waiting` : "Inbox");
  const { ticket } = await (await page.request.post("/api/projects/CRONK/tickets", { data: { title: "Asked from the sidebar test" } })).json();
  const me = (await (await page.request.get("/api/me")).json()).user.id as string;
  await page.request.patch(`/api/tickets/${ticket.key}`, { data: { assigneeId: me, delegateId: agent.id } });
  const claimed = await page.request.post(`/api/tickets/${ticket.key}/claim`, { headers: { ...asAgent, "cronk-agent-session": session } });
  expect(claimed.status(), await claimed.text()).toBe(200);
  const asked = await page.request.post(`/api/tickets/${ticket.key}/activities`, {
    headers: { ...asAgent, "cronk-agent-session": session },
    data: { kind: "question", body: "Which way?" },
  });
  expect(asked.status(), await asked.text()).toBe(201);
  await expect(inbox).toHaveAccessibleName(`Inbox ${waiting + 1} waiting`);
  // Answering it elsewhere resolves it, and the count drops back.
  const { activity } = await asked.json();
  await page.request.post(`/api/tickets/${ticket.key}/comments`, { data: { body: "Left.", replyToActivityId: activity.id } });
  await expect(inbox).toHaveAccessibleName(waiting ? `Inbox ${waiting} waiting` : "Inbox");

  // A Ticket page marks its Project; a Document page marks Documents.
  await page.getByRole("main").getByRole("link", { name: new RegExp(ticket.key) }).click();
  await expect(page.getByRole("heading", { name: "Asked from the sidebar test" })).toBeVisible();
  await expect(sidebar.locator("[aria-current=page]")).toHaveCount(1);
  await expect(sidebar.getByRole("link", { name: "CRONK Cronk" })).toHaveAttribute("aria-current", "page");
  const { document } = await (await page.request.post("/api/projects/CRONK/documents", { data: { title: "Sidebar notes", body: "Hi." } })).json();
  await page.goto(`/documents/${document.id}`);
  await expect(page.getByTestId("document-body")).toContainText("Hi.");
  await expect(sidebar.locator("[aria-current=page]")).toHaveCount(1);
  await expect(sidebar.getByRole("link", { name: "Documents" })).toHaveAttribute("aria-current", "page");

  // `/` focuses Search, unless the User is typing in a field.
  await page.locator("body").press("/");
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeFocused();
  await expect(page.getByRole("searchbox", { name: "Search" })).toHaveValue("");

  // Settings has its own address, inside the frame.
  await sidebar.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  await page.getByLabel("Workspace name").fill("Acme Inc");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(sidebar.getByTestId("workspace-name")).toHaveText("Acme Inc");
  await page.getByLabel("Workspace name").fill("Acme");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(sidebar.getByTestId("workspace-name")).toHaveText("Acme");

  // On a phone the sidebar becomes a strip; Projects, Workspace and the User move into a menu, and nothing scrolls sideways.
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/inbox");
  await expect(sidebar.getByRole("link", { name: /^Inbox/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "CRONK Cronk" })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await sidebar.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "CRONK Cronk" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cronk");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

// Runs after the invitation test above, so Bob is a Member.
test("a Member sees no Settings, and /settings does not open for them", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("bob@example.com");
  await page.getByLabel("Password").fill("bobs password");
  await page.getByRole("button", { name: "Sign in" }).click();
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  await expect(sidebar.getByRole("link", { name: "Guidance" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "Users" })).toHaveCount(0);
  await page.goto("/settings");
  await expect(sidebar.getByTestId("workspace-name")).toHaveText("Acme");
  await expect(page.getByRole("heading", { name: "Workspace settings" })).toHaveCount(0);
});

// Runs after the tests above, so Ada and the CRONK Project exist.
test("change a Ticket's Status and Delegate from its side panel and see each as a change line", async ({ page }) => {
  await signIn(page);
  await page.request.post("/api/agents", { data: { name: "panel-bot" } });
  const { ticket } = await (await page.request.post("/api/projects/CRONK/tickets", { data: { title: "Worked from the panel" } })).json();
  await page.goto(`/tickets/${ticket.key}`);

  const panel = page.getByRole("complementary", { name: "Ticket fields" });
  const timeline = page.getByRole("list", { name: "Timeline" });
  // A field is edited in place: its value opens a list that filters as the User types.
  await panel.getByRole("button", { name: /^Status/ }).click();
  await page.getByLabel("Filter Status").fill("revi");
  await expect(page.getByRole("listbox", { name: "Status" }).getByRole("option")).toHaveText(["In Review"]);
  await page.getByRole("option", { name: "In Review" }).click();
  await expect(panel.getByRole("button", { name: /^Status/ })).toContainText("In Review");
  await expect(timeline.getByRole("listitem").filter({ hasText: "moved it" })).toContainText("Ada moved it from Backlog to In Review");

  await pickField(page, "Assignee", "Ada");
  await pickField(page, "Delegate", "panel-bot");
  const delegated = timeline.getByRole("listitem").filter({ hasText: "delegated it" });
  await expect(delegated).toContainText("Ada delegated it to panel-bot");
  // The Delegate named inside the line is shown as an Agent.
  await expect(delegated.locator(".actor.agent")).toHaveText("panel-bot");
  // The Changes are in the one timeline; there is no separate History list.
  await expect(page.getByRole("list", { name: "History" })).toHaveCount(0);
});

// Runs after the tests above, so Ada and the CRONK Project exist.
test("see the Claim card on a Claimed Ticket, and see it go once the Claim is released", async ({ page, request }) => {
  await signIn(page);
  const { ticket, agentCall, session } = await delegatedTicket(page, request, "claim-bot", "Claimed by a bot");
  await page.goto(`/tickets/${ticket.key}`);
  await expect(page.getByRole("heading", { name: "Claimed by a bot" })).toBeVisible();
  await expect(page.getByTestId("ticket-claim")).toHaveCount(0);

  expect((await request.post(`/api/tickets/${ticket.key}/claim`, { headers: agentCall })).status()).toBe(200);
  // The card shows the Agent, its Agent Session, and how long the Claim lasts if the Session stays silent.
  const card = page.getByTestId("ticket-claim");
  await expect(card).toContainText("Claimed");
  await expect(card).toContainText("claim-bot since");
  await expect(card.getByTitle(session)).toHaveText(/^[a-z]+-[a-z]+$/);
  await expect(card.getByRole("meter", { name: "Time until the Claim lapses if silent" })).toHaveAttribute("aria-valuetext", /^(\d+ min )?\d+ s$/);
  await expect(card).toContainText(/Lapses if silent for (\d+ min )?\d+ s more/);

  expect((await request.delete(`/api/tickets/${ticket.key}/claim`, { headers: agentCall })).status()).toBe(204);
  await expect(card).toHaveCount(0);
});

// Runs after the tests above, so Ada and the CRONK Project exist.
test("answer a blocking question in the timeline, where only Comments and questions offer Reply", async ({ page, request }) => {
  await signIn(page);
  const { ticket, agentCall } = await delegatedTicket(page, request, "question-bot", "Asks before it ships");
  expect((await request.post(`/api/tickets/${ticket.key}/claim`, { headers: agentCall })).status()).toBe(200);
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto(`/tickets/${ticket.key}`);
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline).toContainText("Ada delegated it to question-bot");
  await page.evaluate(() => window.scrollTo(0, 120));

  // Entries arrive live, in place, and the page stays where the User is reading.
  const write = (path: string, data: object) => request.post(`/api/tickets/${ticket.key}/${path}`, { headers: agentCall, data });
  await write("activities", { kind: "plan", body: "Count failed sign-ins." });
  await write("reports", { title: "What I found", body: "# Findings\n\nIt was the **cache**." });
  await write("activities", { kind: "question", body: "Per email or per IP?", blocking: true });
  const question = timeline.getByRole("listitem").filter({ hasText: "Per email or per IP?" });
  await expect(question).toContainText("Blocking question");
  // Polled: the page may still be laying out what arrived, and settles where the User was reading.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(120);

  // A Plan offers no Reply; a Report is a card with its headings scaled down and a link to open it.
  const plan = timeline.getByRole("listitem").filter({ hasText: "Count failed sign-ins." });
  await expect(plan).toContainText("Plan");
  await expect(plan.getByRole("button", { name: "Reply" })).toHaveCount(0);
  const report = timeline.getByRole("listitem", { name: "Report: What I found" });
  await expect(report.getByRole("heading", { name: "Findings" })).toHaveCSS("font-size", "14px");
  await expect(report.getByRole("link", { name: "Open Report" })).toHaveAttribute("href", /^\/documents\//);

  // The open question shows its answer box; once answered, it offers Reply instead.
  await expect(question).toContainText("The answer reaches question-bot as Waiting Work.");
  await question.getByLabel("Answer", { exact: true }).fill("Per email.");
  await question.getByRole("button", { name: "Post answer" }).click();
  await expect(question).toContainText("Answered");
  await expect(question.getByRole("list", { name: "Replies" })).toContainText("Per email.");
  await expect(question.getByLabel("Answer", { exact: true })).toHaveCount(0);
  await expect(question.getByRole("button", { name: "Reply" })).toBeVisible();

  // A Comment offers Reply, and its replies sit under it.
  await page.getByLabel("Comment", { exact: true }).fill("Ship per email first.");
  await page.getByRole("button", { name: "Post Comment" }).click();
  const comment = timeline.getByRole("listitem").filter({ hasText: "Ship per email first." });
  await comment.getByRole("button", { name: "Reply" }).click();
  await comment.getByLabel("Reply", { exact: true }).fill("Agreed.");
  await comment.getByRole("button", { name: "Post reply" }).click();
  await expect(comment.getByRole("list", { name: "Replies" })).toContainText("Agreed.");
});

// Runs after the tests above, so Ada exists. Each Inbox test works in a Project of its own, filtered to it.
test("review a Ticket from the Inbox's detail pane: read its Report inline, send it back, then complete the next", async ({ page, request }) => {
  await signIn(page);
  await page.request.post("/api/projects", { data: { name: "Inbox reviews", key: "INR" } });
  const first = await reviewWithReport(page, request, "review-bot-1", "Show Claim expiry", "INR", "It was the **cache**.");
  const second = await reviewWithReport(page, request, "review-bot-2", "Fix stale-save merge", "INR", "Merge keeps **ATX** headings.");

  await page.goto("/inbox?project=INR");
  const list = page.getByRole("region", { name: "Inbox items" });
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(list.getByRole("heading", { name: "To review · 2" })).toBeVisible();
  const reviews = list.getByRole("list", { name: "To review" });
  await expect(reviews.getByRole("link")).toHaveCount(2);
  // The first item is selected until the User picks another; picking one keeps it in the address alongside the filters.
  await expect(detail.getByRole("strong").filter({ hasText: "cache" })).toBeVisible();
  await reviews.getByRole("link", { name: new RegExp(second.key) }).click();
  await expect(page).toHaveURL(/project=INR/);
  await expect(page).toHaveURL(new RegExp(`item=review-${second.key}`));
  await expect(reviews.getByRole("link", { name: new RegExp(second.key) })).toHaveAttribute("aria-current", "true");
  // The Report's full body is rendered inline, and the Ticket's Status is shown; a reload reopens the same item.
  await page.reload();
  await expect(detail.getByRole("strong").filter({ hasText: "ATX" })).toBeVisible();
  await expect(detail).toContainText("In Review");
  await expect(detail.getByRole("link", { name: "Open Ticket" })).toHaveAttribute("href", `/tickets/${second.key}`);

  // S opens Send back, which needs a Comment saying what is left to do.
  await page.locator("body").press("s");
  await expect(detail.getByLabel("What is left to do")).toBeFocused();
  await expect(detail.getByLabel("What is left to do")).toHaveValue("");
  await expect(detail.getByRole("button", { name: "Send back", exact: true })).toBeDisabled();
  await detail.getByLabel("What is left to do").fill("Add a test.");
  await detail.getByRole("button", { name: "Send back", exact: true }).click();
  // It leaves the Inbox, and the item before it is selected, as it was the last.
  await expect(reviews.getByRole("link")).toHaveCount(1);
  await expect(list.getByRole("heading", { name: "To review · 1" })).toBeVisible();
  await expect(detail.getByRole("strong").filter({ hasText: "cache" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`item=review-${first.key}`));
  await page.goto(`/tickets/${second.key}`);
  await expect(page.getByRole("list", { name: "Timeline" }).getByRole("listitem").filter({ hasText: "Add a test." })).toContainText("Sent back");

  // C completes the selected review; with nothing left, the Inbox is a calm empty state rather than an empty split.
  await page.goBack();
  await expect(detail.getByRole("strong").filter({ hasText: "cache" })).toBeVisible();
  await page.locator("body").press("c");
  await expect(page.getByRole("heading", { name: "Nothing waiting on you" })).toBeVisible();
  await expect(detail).toHaveCount(0);
  await page.goto(`/tickets/${first.key}`);
  await expect(page.getByRole("complementary", { name: "Ticket fields" }).getByRole("button", { name: /^Status/ })).toContainText("Done");
});

// Runs after the tests above, so Ada exists.
test("answer a blocking question from the Inbox's detail pane, moving through the groups with the keyboard", async ({ page, request }) => {
  await signIn(page);
  await page.request.post("/api/projects", { data: { name: "Inbox questions", key: "INQ" } });
  await reviewWithReport(page, request, "triage-bot-1", "Show Claim expiry", "INQ", "Done.");
  const { ticket, agentCall } = await delegatedTicket(page, request, "triage-bot-2", "Rate-limit sign-in attempts", "INQ");
  expect((await request.post(`/api/tickets/${ticket.key}/claim`, { headers: agentCall })).status()).toBe(200);
  const ask = (body: string, blocking: boolean) => request.post(`/api/tickets/${ticket.key}/activities`, { headers: agentCall, data: { kind: "question", body, blocking } });
  await ask("Keep the **casing** of the first use?", false);

  await page.goto("/inbox?project=INQ");
  const list = page.getByRole("region", { name: "Inbox items" });
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(list.getByRole("heading", { name: "Questions · 1" })).toBeVisible();
  // A new blocking question arrives live, without a reload, in its own group at the top.
  await ask("Per **email** or per IP?", true);
  await expect(list.getByRole("heading")).toHaveText(["Blocking · 1", "Questions · 1", "To review · 1"]);
  const blocking = list.getByRole("list", { name: "Blocking" }).getByRole("link");
  await expect(blocking).toContainText("Per email or per IP?");
  await expect(page.getByRole("group", { name: "Filters" }).getByRole("button", { name: "Everything 3" })).toBeVisible();

  // J and K move through the list across the groups.
  await blocking.click();
  await expect(detail).toContainText("Blocking question");
  await page.locator("body").press("j");
  await expect(detail.getByRole("strong").filter({ hasText: "casing" })).toBeVisible();
  await page.locator("body").press("j");
  await expect(detail).toContainText("Done.");
  await page.locator("body").press("k");
  await page.locator("body").press("k");
  await expect(detail.getByRole("strong").filter({ hasText: "email" })).toBeVisible();
  await expect(detail).toContainText("triage-bot-2 is waiting");
  await expect(detail).toContainText("The answer reaches triage-bot-2 as Waiting Work.");

  // A focuses the answer box; the shortcuts type into it rather than moving the list.
  await page.locator("body").press("a");
  // Located by its placeholder, as a label's text grows with what is typed in the field inside it.
  const answer = detail.getByPlaceholder("Answer triage-bot-2… (Markdown)");
  await expect(answer).toBeFocused();
  await expect(answer).toHaveValue("");
  await answer.pressSequentially("just email");
  await expect(answer).toHaveValue("just email");
  await expect(blocking).toHaveAttribute("aria-current", "true");
  await detail.getByRole("button", { name: "Post answer" }).click();
  // The answered question leaves the Inbox, and the next item is selected.
  await expect(list.getByRole("list", { name: "Blocking" })).toHaveCount(0);
  await expect(detail.getByRole("strong").filter({ hasText: "casing" })).toBeVisible();
  await page.goto(`/tickets/${ticket.key}`);
  await expect(page.getByRole("list", { name: "Timeline" }).getByRole("list", { name: "Replies" })).toContainText("just email");

  // On a phone the list and the detail stack: picking an item opens it full width, with a way back to the list.
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/inbox?project=INQ");
  await expect(list).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await list.getByRole("link", { name: /casing/ }).click();
  await expect(detail.getByRole("strong").filter({ hasText: "casing" })).toBeVisible();
  await expect(list).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await detail.getByRole("link", { name: "Back to the list" }).click();
  await expect(list).toBeVisible();
});

// Runs after the tests above, so Ada exists.
test("see the selected item marked Resolved elsewhere once it is answered in another page", async ({ page, request }) => {
  await signIn(page);
  await page.request.post("/api/projects", { data: { name: "Inbox elsewhere", key: "INX" } });
  const { ticket, agentCall } = await delegatedTicket(page, request, "elsewhere-bot", "Export Labels in frontmatter", "INX");
  expect((await request.post(`/api/tickets/${ticket.key}/claim`, { headers: agentCall })).status()).toBe(200);
  const ask = (body: string) => request.post(`/api/tickets/${ticket.key}/activities`, { headers: agentCall, data: { kind: "question", body } });
  await ask("Lowercase them all?");
  await ask("Keep the casing?");
  await ask("Sort them too?");

  await page.goto("/inbox?project=INX");
  const list = page.getByRole("region", { name: "Inbox items" });
  const detail = page.getByRole("region", { name: "Selected item" });
  await list.getByRole("link", { name: /Keep the casing\?/ }).click();
  await expect(detail).toContainText("Keep the casing?");

  // Ada answers the same question on the Ticket page, in a second page.
  const other = await page.context().newPage();
  await other.goto(`/tickets/${ticket.key}`);
  const asked = other.getByRole("list", { name: "Timeline" }).getByRole("listitem").filter({ hasText: "Keep the casing?" });
  await asked.getByLabel("Answer", { exact: true }).fill("Keep it.");
  await asked.getByRole("button", { name: "Post answer" }).click();
  await expect(asked).toContainText("Answered");
  await other.close();

  // The list drops it, but the detail pane keeps it, marked and with its actions disabled, linking to the Ticket.
  await expect(list.getByRole("link", { name: /Keep the casing\?/ })).toHaveCount(0);
  await expect(list.getByRole("heading", { name: "Questions · 2" })).toBeVisible();
  await expect(detail.getByRole("status")).toHaveText(/Resolved elsewhere/);
  await expect(detail).toContainText("Keep the casing?");
  await expect(detail.getByRole("button", { name: "Post answer" })).toBeDisabled();
  await expect(detail.getByPlaceholder("Answer elsewhere-bot… (Markdown)")).toBeDisabled();
  await expect(detail.getByRole("link", { name: "Open Ticket" })).toHaveAttribute("href", `/tickets/${ticket.key}`);
  // J moves on to the item that followed it.
  await page.locator("body").press("j");
  await expect(detail).toContainText("Sort them too?");
  await expect(detail.getByRole("status")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Post answer" })).toBeVisible();
});

// Runs after the tests above, so Ada exists. It works in a Project of its own, filtered to it.
test("open a Suggestion from the Inbox, switch to side by side, and accept it", async ({ page, request, browser }) => {
  await signIn(page);
  await page.request.post("/api/projects", { data: { name: "Inbox suggestions", key: "INS" } });
  const { document } = await (await page.request.post("/api/projects/INS/documents", { data: { title: "Sign-in limits", body: "Five per email.\n\nNo per-IP limits.\n" } })).json();
  await page.request.post(`/api/documents/${document.id}/protection`, { data: { protected: true } });
  const { ticket, agentCall } = await delegatedTicket(page, request, "suggest-bot", "Limit per IP too", "INS");
  expect((await request.post(`/api/tickets/${ticket.key}/claim`, { headers: agentCall })).status()).toBe(200);
  const suggested = await request.post("/api/suggestions", {
    headers: agentCall,
    data: { item: { kind: "document", id: document.id }, baseVersion: 1, content: { body: "Five per email.\n\nFifty per IP.\n" }, reasoning: "The proxy passes client IPs now." },
  });
  expect(suggested.status()).toBe(201);

  await page.goto("/inbox?project=INS");
  const list = page.getByRole("region", { name: "Inbox items" });
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(list.getByRole("heading", { name: "Suggestions · 1" })).toBeVisible();
  await list.getByRole("list", { name: "Suggestions" }).getByRole("link", { name: /Sign-in limits/ }).click();
  // The Agent's reasoning, then the Diff against the Version it started from, unified at first.
  await expect(detail).toContainText("The proxy passes client IPs now.");
  await expect(detail).toContainText(`while working on ${ticket.key}`);
  const changes = detail.getByRole("list", { name: "Changes" });
  await expect(changes.locator(".diff-removed")).toHaveText(/No per-IP limits\./);
  await expect(changes.locator(".diff-added")).toHaveText(/Fifty per IP\./);

  // Side by side shows the current Version beside the suggestion, and stays chosen for this User across a reload.
  await detail.getByRole("button", { name: "Side by side" }).click();
  await expect(detail.getByRole("list", { name: "Version 1, current" })).toContainText("No per-IP limits.");
  await expect(detail.getByRole("list", { name: "Suggested by suggest-bot" })).toContainText("Fifty per IP.");
  await page.reload();
  await expect(detail.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "true");
  await expect(detail).toContainText("Version 2 will be credited to suggest-bot, accepted by you.");
  // The choice is kept on the server, so another browser signed in as Ada opens the Diff side by side too.
  const elsewhere = await browser.newContext();
  const other = await elsewhere.newPage();
  await signIn(other);
  await other.goto(page.url());
  const otherDetail = other.getByRole("region", { name: "Selected item" });
  await expect(otherDetail).toContainText("The proxy passes client IPs now.");
  await expect(otherDetail.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "true");
  await expect(otherDetail.getByRole("list", { name: "Suggested by suggest-bot" })).toContainText("Fifty per IP.");
  await elsewhere.close();

  await detail.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nothing waiting on you" })).toBeVisible();
  const { document: saved } = await (await page.request.get(`/api/documents/${document.id}`)).json();
  expect(saved).toMatchObject({ version: 2, body: "Five per email.\n\nFifty per IP.\n" });
});

/** A Ticket delegated to a new Agent, which writes a Report on it and moves it to In Review, so it waits in Ada's Inbox. */
async function reviewWithReport(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  agentName: string,
  title: string,
  project: string,
  report: string,
) {
  const { ticket, agentCall } = await delegatedTicket(page, request, agentName, title, project);
  expect((await request.post(`/api/tickets/${ticket.key}/claim`, { headers: agentCall })).status()).toBe(200);
  expect((await request.post(`/api/tickets/${ticket.key}/reports`, { headers: agentCall, data: { title, body: report } })).status()).toBe(201);
  const { statuses } = await (await request.get(`/api/projects/${project}`, { headers: agentCall })).json();
  const inReview = statuses.find((s: { category: string }) => s.category === "in_review").id;
  expect((await request.patch(`/api/tickets/${ticket.key}`, { headers: agentCall, data: { statusId: inReview } })).status()).toBe(200);
  return ticket as { key: string; title: string };
}

/**
 * Registers an Agent of Ada's with a full token, starts an Agent Session for it, and files a Ticket assigned
 * to Ada and delegated to the Agent. Calls with `agentCall` act as that Agent Session.
 */
async function delegatedTicket(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  agentName: string,
  title: string,
  project = "CRONK",
) {
  const { user } = await (await page.request.get("/api/me")).json();
  const { agent } = await (await page.request.post("/api/agents", { data: { name: agentName } })).json();
  const { secret } = await (await page.request.post(`/api/agents/${agent.id}/tokens`, { data: { readOnly: false } })).json();
  const { ticket } = await (await page.request.post(`/api/projects/${project}/tickets`, { data: { title } })).json();
  await page.request.patch(`/api/tickets/${ticket.key}`, { data: { assigneeId: user.id, delegateId: agent.id } });
  const started = await request.post("/api/agent-sessions", { headers: { authorization: `Bearer ${secret}` } });
  const session = (await started.json()).session.id as string;
  return { ticket, session, agentCall: { authorization: `Bearer ${secret}`, "cronk-agent-session": session } };
}

/** Picks `option` for the Ticket field `field` in the open Ticket's side panel. */
async function pickField(page: import("@playwright/test").Page, field: string, option: string) {
  await page.getByRole("complementary", { name: "Ticket fields" }).getByRole("button", { name: new RegExp(`^${field}`) }).click();
  await page.getByRole("listbox", { name: field }).getByRole("option", { name: option, exact: true }).click();
}

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: /CRONK/ })).toBeVisible();
}

// Runs after the tests above, so Ada and CRONK exist.
test("see a Ticket's Priority, Assignee and Delegate on the Project's list and board", async ({ page, request }) => {
  await signIn(page);
  const { ticket } = await delegatedTicket(page, request, "people-bot", "Shows who has it");
  await page.request.patch(`/api/tickets/${ticket.key}`, { data: { priority: "high" } });

  await page.goto("/projects/CRONK");
  const row = page.getByRole("list", { name: "Tickets" }).getByRole("link", { name: /Shows who has it/ });
  await expect(row.getByText("High", { exact: true })).toBeVisible();
  await expect(row.getByRole("img", { name: "Delegate: people-bot" })).toBeVisible();
  await expect(row.getByRole("img", { name: "Assignee: Ada" })).toBeVisible();

  await page.getByRole("link", { name: "Board" }).click();
  const card = page.getByRole("region", { name: "Backlog" }).getByRole("link", { name: /Shows who has it/ });
  await expect(card.getByText("High", { exact: true })).toBeVisible();
  await expect(card.getByRole("img", { name: "Delegate: people-bot" })).toBeVisible();
  await expect(card.getByRole("img", { name: "Assignee: Ada" })).toBeVisible();
});

// Runs after the tests above, so Ada exists; uses a Project of its own with the six Statuses a Project starts with.
test("fit the board on a 1280px screen, with Completed and Canceled columns collapsed until opened", async ({ page }) => {
  await signIn(page);
  await page.request.post("/api/projects", { data: { name: "Fit", key: "FIT" } });
  const { statuses } = await (await page.request.get("/api/projects/FIT")).json();
  const done = statuses.find((s: { name: string }) => s.name === "Done");
  const { ticket } = await (await page.request.post("/api/projects/FIT/tickets", { data: { title: "Shipped already" } })).json();
  await page.request.patch(`/api/tickets/${ticket.key}`, { data: { statusId: done.id } });
  await page.request.post("/api/projects/FIT/tickets", { data: { title: "Still to do" } });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/projects/FIT?view=board");
  const board = page.getByRole("group", { name: "Board" });
  for (const name of ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"]) {
    await expect(board.getByRole("region", { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
  expect(await board.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(board.getByRole("region", { name: "Backlog" })).toContainText("Still to do");

  const doneColumn = board.getByRole("region", { name: "Done", exact: true });
  const open = doneColumn.getByRole("button", { name: "Done, 1 Ticket" });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await expect(doneColumn).not.toContainText("Shipped already");
  await expect(board.getByRole("region", { name: "Canceled" }).getByRole("button", { name: "Canceled, 0 Tickets" })).toBeVisible();
  await open.click();
  await expect(doneColumn).toContainText("Shipped already");
});

// Runs after the tests above, so Ada and CRONK exist.
test("open Terms from a Project, override a Workspace Term there and edit it", async ({ page }) => {
  await signIn(page);
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  await sidebar.getByRole("link", { name: "Terms" }).click();
  await page.getByRole("button", { name: "New Term" }).click();
  await page.getByLabel("Name").fill("Customer");
  await page.getByLabel("Definition").fill("A paying organization.");
  await page.getByRole("button", { name: "Create Term" }).click();
  await expect(page.getByRole("heading", { name: "Customer" })).toBeVisible();

  // From a Project, the Terms page starts on that Project.
  await sidebar.getByRole("link", { name: /CRONK/ }).click();
  await sidebar.getByRole("link", { name: "Terms" }).click();
  await expect(page.getByRole("navigation", { name: "Scope" }).getByRole("link", { name: "CRONK" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "New Term" }).click();
  await page.getByLabel("Name").fill("customer");
  await page.getByLabel("Definition").fill("A billing account.");
  await page.getByLabel("Words to avoid, separated by commas").fill("Client, account");
  await page.getByRole("button", { name: "Create Term" }).click();
  await expect(page.getByRole("status")).toContainText("Overrides the Workspace Term Customer");

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Definition").fill("A billing account: who pays.");
  await page.getByRole("button", { name: "Save as Version 2" }).click();
  await expect(page.getByRole("list", { name: "Versions" }).getByRole("listitem")).toHaveCount(2);

  await page.getByRole("main").getByRole("link", { name: "Terms" }).click();
  await page.getByLabel("Filter Terms and words to avoid").fill("client");
  await expect(page.getByRole("main")).toContainText("A billing account: who pays.");
});

test("comment on an Artifact's Version from the drawer beside it, and see a reply arrive live", async ({ page, request }) => {
  await signIn(page);
  await page.request.post("/api/projects", { data: { name: "Artifact comments", key: "ARC" } });
  const { agentCall } = await delegatedTicket(page, request, "artifact-bot", "Show the limits", "ARC");
  const published = await request.post("/api/projects/ARC/artifacts?title=Limits", {
    headers: { ...agentCall, "content-type": "application/gzip" },
    data: await tarGz({ "index.html": "<h1>Limits</h1>" }),
  });
  expect(published.status()).toBe(201);
  const { artifact } = await published.json();

  await page.goto(`/artifacts/${artifact.id}`);
  const drawer = page.getByRole("complementary", { name: "Comments on this Artifact" });
  await expect(drawer.getByText("Live")).toBeVisible();
  await drawer.getByRole("textbox", { name: "Comment on Version 1" }).fill("Can it show the limit as a line?");
  await drawer.getByRole("button", { name: "Comment", exact: true }).click();
  const posted = drawer.getByRole("listitem").filter({ hasText: "Can it show the limit as a line?" });
  await expect(posted).toContainText("on Version 1");
  await expect(page.getByRole("button", { name: "Comments 1" })).toBeVisible();

  // The Agent that published it answers from elsewhere; the drawer shows it without a reload.
  const { comments } = await (await page.request.get(`/api/artifacts/${artifact.id}/comments`)).json();
  await request.post(`/api/artifacts/${artifact.id}/comments`, { headers: agentCall, data: { body: "Added the line.", replyToCommentId: comments[0].id } });
  await expect(drawer.getByText("Added the line.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Comments 2" })).toBeVisible();

  // The button closes the drawer.
  await page.getByRole("button", { name: "Comments 2" }).click();
  await expect(drawer).toBeHidden();

  // A search finds the Comment, and its result opens the Artifact.
  await page.getByRole("searchbox", { name: "Search" }).fill("limit line");
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await page.getByRole("list", { name: "Search results" }).getByRole("link", { name: /On Limits/ }).click();
  await expect(page).toHaveURL(`/artifacts/${artifact.id}`);

  // The Agents page lists the publish and the reply among what the Agent did, each opening the Artifact at its Version.
  await page.goto("/agents");
  const card = page.getByRole("listitem", { name: "artifact-bot" });
  await card.getByRole("button", { name: "Show what it did" }).click();
  const record = card.getByRole("list", { name: "What artifact-bot did" });
  await expect(record.getByRole("listitem").filter({ hasText: "commented on Limits (Version 1)" })).toBeVisible();
  await record.getByRole("listitem").filter({ hasText: "published Version 1 of Limits" }).getByRole("link", { name: "Limits" }).click();
  await expect(page).toHaveURL(`/artifacts/${artifact.id}?version=1`);
});

// Runs after the tests above, so Ada exists; the Workspace allows extra origins, as a fresh one does.
test("declare an extra origin when publishing an Artifact from the dialog, and see it on the Artifact's page", async ({ page }) => {
  const picked = await mkdtemp(join(tmpdir(), "cronk-artifact-"));
  try {
    await writeFile(join(picked, "index.html"), "<h1>Charts</h1>");
    await signIn(page);
    await page.goto("/artifacts");
    await page.getByRole("button", { name: "Publish Artifact" }).click();
    const dialog = page.getByRole("dialog", { name: "Publish an Artifact" });
    await dialog.getByLabel("Title").fill("Charts");
    await dialog.getByLabel("Choose folder…").setInputFiles(picked);

    // A row can be added and removed again.
    const rows = dialog.getByRole("list", { name: "Extra origins" }).getByRole("listitem");
    await dialog.getByRole("button", { name: "Add origin" }).click();
    await dialog.getByRole("button", { name: "Add origin" }).click();
    await expect(rows).toHaveCount(2);
    await rows.nth(1).getByRole("button", { name: "Remove" }).click();
    await expect(rows).toHaveCount(1);

    // A malformed origin is refused by the API; its message shows and the row stays as typed.
    const row = rows.first();
    await row.getByRole("textbox", { name: "Origin" }).fill("cdn.example.com");
    await row.getByRole("checkbox", { name: "scripts" }).check();
    await row.getByRole("checkbox", { name: "network requests" }).check();
    await row.getByRole("textbox", { name: "Reason" }).fill("Loads the charting library");
    await dialog.getByRole("button", { name: "Publish" }).click();
    await expect(dialog.getByRole("alert")).toContainText("must be a bare http or https origin");
    await expect(row.getByRole("textbox", { name: "Origin" })).toHaveValue("cdn.example.com");
    await expect(row.getByRole("checkbox", { name: "scripts" })).toBeChecked();

    await row.getByRole("textbox", { name: "Origin" }).fill("https://cdn.example.com");
    await dialog.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("heading", { name: "Charts" })).toBeVisible();
    await page.getByRole("button", { name: /1 extra origin/ }).click();
    const declared = page.getByRole("list", { name: "Extra origins" });
    await expect(declared).toContainText("https://cdn.example.com");
    await expect(declared).toContainText("for scripts, network requests");
    await expect(declared).toContainText("Loads the charting library");
    await page.keyboard.press("Escape");

    // A new Version's dialog starts empty although the shown Version declared one; published so, it declares none.
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Publish new Version…" }).click();
    const next = page.getByRole("dialog", { name: "Publish Version 2 of Charts" });
    await expect(next.getByRole("button", { name: "Add origin" })).toBeVisible();
    await expect(next.getByRole("list", { name: "Extra origins" }).getByRole("listitem")).toHaveCount(0);
    await next.getByLabel("Choose folder…").setInputFiles(picked);
    const sent = page.waitForRequest((r) => r.method() === "POST" && /\/api\/artifacts\/[^/]+\/versions/.test(r.url()));
    await next.getByRole("button", { name: "Publish" }).click();
    expect(new URL((await sent).url()).searchParams.has("extraOrigins")).toBe(false);
    await expect(next).toBeHidden();
    await expect(page.getByRole("button", { name: /Version 2/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /extra origin/ })).toHaveCount(0);

    // Where the Workspace doesn't allow extra origins, the section is gone and publishing still works.
    await page.request.patch("/api/workspace", { data: { artifactExtraOriginsAllowed: false } });
    try {
      await page.goto("/artifacts");
      await page.getByRole("button", { name: "Publish Artifact" }).click();
      await expect(dialog.getByLabel("Title")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Add origin" })).toHaveCount(0);
      await dialog.getByLabel("Title").fill("Plain charts");
      await dialog.getByLabel("Choose folder…").setInputFiles(picked);
      await dialog.getByRole("button", { name: "Publish" }).click();
      await expect(page.getByRole("heading", { name: "Plain charts" })).toBeVisible();
    } finally {
      await page.request.patch("/api/workspace", { data: { artifactExtraOriginsAllowed: true } });
    }
  } finally {
    await rm(picked, { recursive: true, force: true });
  }
});

test("preview an Artifact embedded in a Document while editing it, but only a link in a Decision", async ({ page }) => {
  await signIn(page);
  await page.request.post("/api/projects", { data: { name: "Embed preview", key: "EMB" } });
  const published = await page.request.post("/api/projects/EMB/artifacts?title=Limits", {
    headers: { "content-type": "application/gzip" },
    data: await tarGz({ "index.html": "<h1>Limits</h1>" }),
  });
  expect(published.status()).toBe(201);
  const { artifact } = await published.json();

  // Before saving, the preview shows the Artifact where the saved Document would: its address alone on a line.
  const doc = (await (await page.request.post("/api/projects/EMB/documents", { data: { title: "Limits notes", body: "Notes." } })).json()).document;
  await page.goto(`/documents/${doc.id}`);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Body (Markdown)").fill(`The dashboard:\n\n${artifact.versionUrl}\n\nAlso at ${artifact.url} in a sentence.`);
  const preview = page.getByRole("region", { name: "Preview" });
  await expect(preview.locator("iframe[title='Limits, Version 1']")).toBeVisible();
  await expect(preview.locator(".artifact-embed")).toHaveCount(1);
  await expect(preview.getByRole("link", { name: artifact.url })).toBeVisible();

  // A Decision doesn't embed Artifacts, so its preview keeps the address a link, as its saved view does.
  const decision = (await (await page.request.post("/api/projects/EMB/decisions", { data: { title: "Show limits", body: "Limit sign-ins." } })).json()).decision;
  await page.goto(`/decisions/${decision.key}`);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Body (Markdown)").fill(`Evidence:\n\n${artifact.versionUrl}`);
  await expect(preview.getByRole("link", { name: artifact.versionUrl })).toBeVisible();
  await expect(preview.locator(".artifact-embed")).toHaveCount(0);
});

/** A gzipped tar archive holding `files`, path to text, as publishing an Artifact takes. */
async function tarGz(files: Record<string, string>): Promise<Buffer> {
  const pack = tar.pack();
  for (const [name, text] of Object.entries(files)) pack.entry({ name }, text);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk as Uint8Array));
  return gzipSync(Buffer.concat(chunks));
}

test("download a Project's Decisions as docs/adr from its register", async ({ page }) => {
  await signIn(page);
  await page.request.post("/api/projects", { data: { name: "Decision export", key: "ADR" } });
  await page.request.post("/api/projects/ADR/decisions", { data: { title: "Limits in the API", body: "Limit sign-ins." } });

  await page.goto("/decisions?project=ADR");
  const head = page.locator(".page-head .actions");
  // Export comes before New Decision, the primary action, last.
  await expect(head.getByRole("link").or(head.getByRole("button")).last()).toHaveText("New Decision");
  const downloading = page.waitForEvent("download");
  await head.getByRole("link", { name: "Export docs/adr" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^cronk-ADR-adr-.*\.tar\.gz$/);
});

/** The bytes of a PNG file, enough for its type to be told. */
const png = [...Buffer.from("89504e470d0a1a0a", "hex")];

/**
 * Pastes `files` into the element `target` matches, as the clipboard would hand them over. Answers whether the paste's
 * default was left alone, as `dispatchEvent` does.
 */
const pasteFiles = (target: Locator, files: { name: string; type: string; bytes: number[] }[], text?: string) =>
  target.evaluate(
    (el, { files, text }) => {
      const data = new DataTransfer();
      for (const f of files) data.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
      if (text !== undefined) data.setData("text/plain", text);
      return el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { files, text },
  );

test("paste an image into a Document's editor, and see it in the rendered body and in the earlier Version", async ({ page }) => {
  await signIn(page);
  const created = await page.request.post("/api/workspace/documents", { data: { title: "Sign-in flow", body: "Before.\n\nAfter." } });
  const id = (await created.json()).document.id as string;
  await page.goto(`/documents/${id}`);
  await page.getByRole("button", { name: "Edit" }).click();

  // Pasting a file uploads it and puts its Markdown where the cursor is; undo (Ctrl/Cmd+Z) takes the Markdown out again.
  const editor = page.getByLabel("Body (Markdown)");
  await editor.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(8, 8);
  });
  await pasteFiles(editor, [{ name: "flow.png", type: "image/png", bytes: png }]);
  await expect(editor).toHaveValue(/^Before\.\n!\[flow\.png\]\(\/api\/attachments\/[0-9a-f-]+\/file\)\nAfter\.$/);
  const embedded = (await editor.inputValue()).split("\n")[1]!;
  // Attached once, by the editor, not again by the page.
  await expect(page.getByRole("region", { name: "Attachments" }).getByRole("button", { name: "Open flow.png" })).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toHaveValue("Before.\n\nAfter.");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editor).toHaveValue(`Before.\n${embedded}\nAfter.`);
  // A paste that carries text too, as a copy from a spreadsheet does, is the text's to paste: nothing is attached.
  await pasteFiles(editor, [{ name: "cells.png", type: "image/png", bytes: png }], "A1\tB1");
  await page.getByRole("button", { name: "Save" }).click();

  const body = page.getByTestId("document-body");
  await expect(body.getByRole("img", { name: "flow.png" })).toBeVisible();
  expect((await (await page.request.get(`/api/documents/${id}/attachments`)).json()).attachments).toHaveLength(1);
  // Saved again without it, the earlier Version still shows it.
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Body (Markdown)").fill("Rewritten.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(body).toContainText("Rewritten.");
  await page.getByRole("button", { name: "Versions" }).click();
  await page.getByRole("list", { name: "Versions" }).getByRole("listitem").filter({ hasText: "Version 2" }).getByRole("button", { name: "View" }).click();
  await expect(page.getByLabel("Version 2").getByRole("img", { name: "flow.png" })).toBeVisible();
});

test("insert an attached video from its thumbnail while editing, and play it in the rendered body and the earlier Version", async ({ page }) => {
  await signIn(page);
  const created = await page.request.post("/api/workspace/documents", { data: { title: "Demo reel", body: "Watch:" } });
  const id = (await created.json()).document.id as string;
  const attach = async (name: string, data: Buffer, type: string) => {
    const res = await page.request.post(`/api/documents/${id}/attachments?name=${name}`, { data, headers: { "content-type": type } });
    expect(res.status()).toBe(201);
    return (await res.json()).attachment.id as string;
  };
  const video = await attach("demo.mp4", Buffer.alloc(2048), "video/mp4");
  await attach("still.png", Buffer.from("89504e470d0a1a0a", "hex"), "image/png");
  await page.goto(`/documents/${id}`);
  const thumbnails = page.getByRole("region", { name: "Attachments" });
  await expect(thumbnails.getByRole("button", { name: "Open demo.mp4" })).toBeVisible();
  // "Insert" is only there while the editor is open.
  await expect(thumbnails.getByRole("button", { name: "Insert demo.mp4" })).toHaveCount(0);

  await page.getByRole("button", { name: "Edit" }).click();
  const editor = page.getByLabel("Body (Markdown)");
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await editor.press("Enter");
  await thumbnails.getByRole("button", { name: "Insert demo.mp4" }).click();
  await editor.press("Enter");
  await thumbnails.getByRole("button", { name: "Insert still.png" }).click();
  await expect(editor).toHaveValue(new RegExp(`^Watch:\\n!\\[demo\\.mp4\\]\\(/api/attachments/${video}/file\\)\\n!\\[still\\.png\\]\\(/api/attachments/[0-9a-f-]+/file\\)$`));
  await expect(page.getByRole("region", { name: "Preview" }).locator("video")).toHaveAttribute("controls", "");
  await page.getByRole("button", { name: "Save" }).click();

  // An embedded video plays in place; an embedded image is still an image.
  const body = page.getByTestId("document-body");
  const player = body.locator("video");
  await expect(player).toHaveAttribute("src", `/api/attachments/${video}/file`);
  await expect(player).toHaveAttribute("controls", "");
  await expect(body.getByRole("img", { name: "demo.mp4" })).toHaveCount(0);
  await expect(body.getByRole("img", { name: "still.png" })).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Body (Markdown)").fill("Cut.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(body).toContainText("Cut.");
  await page.getByRole("button", { name: "Versions" }).click();
  await page.getByRole("list", { name: "Versions" }).getByRole("listitem").filter({ hasText: "Version 2" }).getByRole("button", { name: "View" }).click();
  await expect(page.getByLabel("Version 2").locator("video")).toHaveAttribute("src", `/api/attachments/${video}/file`);
  await expect(page.getByLabel("Version 2").getByRole("img", { name: "still.png" })).toBeVisible();
});

test("paste a spreadsheet's cells into a Ticket's Comment box as text, while a pasted image alone still attaches", async ({ page }) => {
  await signIn(page);
  const { ticket } = await (await page.request.post("/api/projects/CRONK/tickets", { data: { title: "Pasted into" } })).json();
  const attachments = async () => (await (await page.request.get(`/api/tickets/${ticket.key}/attachments`)).json()).attachments as { name: string }[];
  await page.goto(`/tickets/${ticket.key}`);
  const box = page.getByLabel("Comment", { exact: true });

  // Text with an image beside it, as a copy from a spreadsheet carries, is the field's to paste: nothing is attached.
  expect(await pasteFiles(box, [{ name: "cells.png", type: "image/png", bytes: png }], "A1\tB1")).toBe(true);
  // An image alone, which a Comment box can't take, still attaches to the Ticket, in the box or outside any field.
  expect(await pasteFiles(box, [{ name: "shot.png", type: "image/png", bytes: png }])).toBe(false);
  const files = page.getByRole("region", { name: "Attachments" });
  await expect(files.getByRole("button", { name: "Open shot.png" })).toBeVisible();
  expect(await pasteFiles(page.locator("body"), [{ name: "page.png", type: "image/png", bytes: png }])).toBe(false);
  await expect(files.getByRole("button", { name: "Open page.png" })).toBeVisible();
  expect((await attachments()).map((a) => a.name).sort()).toEqual(["page.png", "shot.png"]);
});

test("paste a spreadsheet's cells into a Document's passage Comment as text, attaching nothing", async ({ page }) => {
  await signIn(page);
  const created = await page.request.post("/api/workspace/documents", { data: { title: "Pasted figures", body: "Sign-ins fell by half." } });
  const id = (await created.json()).document.id as string;
  await page.goto(`/documents/${id}`);
  await page.getByTestId("document-body").evaluate((el) => getSelection()!.selectAllChildren(el.querySelector("p")!));
  await page.getByRole("button", { name: "Comment on this passage" }).click();
  const box = page.getByLabel("Comment", { exact: true });
  await expect(box).toBeFocused();

  expect(await pasteFiles(box, [{ name: "cells.png", type: "image/png", bytes: png }], "A1\tB1")).toBe(true);
  // An image pasted alone attaches to the Document, so the earlier paste had its chance to as well.
  expect(await pasteFiles(box, [{ name: "chart.png", type: "image/png", bytes: png }])).toBe(false);
  await expect(page.getByRole("region", { name: "Attachments" }).getByRole("button", { name: "Open chart.png" })).toBeVisible();
  const { attachments } = await (await page.request.get(`/api/documents/${id}/attachments`)).json();
  expect(attachments.map((a: { name: string }) => a.name)).toEqual(["chart.png"]);
});
