import { expect, test, type Locator } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  await expect(bob.getByRole("main").getByRole("link", { name: /CRONK/ })).toBeVisible();

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
  // Outside the sign-in forms a button sizes to its label rather than filling its form.
  const register = (await page.getByRole("button", { name: "Register Agent" }).boundingBox())!;
  const agentName = (await page.getByLabel("Agent name").boundingBox())!;
  expect(register.width).toBeLessThan(agentName.width / 2);
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
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText("claude-laptop for Ada created the Ticket");

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
  // The Session goes by a readable two-word name, the same everywhere, with its full id in the tooltip.
  const renamedBy = page.getByRole("list", { name: "Timeline" }).getByRole("listitem").filter({ hasText: "renamed it" });
  await expect(renamedBy).toContainText(/claude-laptop [a-z]+-[a-z]+ for Ada renamed it/);
  await expect(renamedBy.getByTitle(session)).toHaveText(/^[a-z]+-[a-z]+$/);
  const sessionName = (await renamedBy.getByTitle(session).textContent())!;
  await page.getByRole("link", { name: "Agents" }).click();
  const liveSessions = page.getByRole("list", { name: "Live Agent Sessions of claude-laptop" });
  await expect(liveSessions).toContainText(`Live ${sessionName}`);
  await expect(liveSessions.getByTitle(session)).toHaveText(sessionName);
  // Ada delegates the Ticket to her Agent, whose Session Claims it; the Ticket shows both.
  await page.goto(`/tickets/${ticket.key}`);
  await expect(page.getByRole("heading", { name: "Filed and renamed by an Agent" })).toBeVisible();
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

  // The Session hands the Ticket over; it waits in Ada's Inbox with its Report, and new questions arrive there live.
  const agentCall = { authorization: `Bearer ${token}`, "cronk-agent-session": session };
  const statuses = (await (await request.get(`/api/projects/${ticket.key.split("-")[0]}`, { headers: agentCall })).json()).statuses;
  const inReview = statuses.find((s: { category: string }) => s.category === "in_review").id;
  expect((await request.patch(`/api/tickets/${ticket.key}`, { headers: agentCall, data: { statusId: inReview } })).status()).toBe(200);
  await page.getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const inbox = page.getByRole("list", { name: "Inbox" });
  const review = inbox.getByRole("listitem", { name: `Review ${ticket.key}` });
  await expect(review.getByRole("list", { name: `Reports on ${ticket.key}` })).toContainText("What I found");
  await request.post(`/api/tickets/${ticket.key}/activities`, { headers: agentCall, data: { kind: "question", body: "Ship it **today**?", blocking: true } });
  const question = inbox.getByRole("listitem", { name: `Question on ${ticket.key}` });
  await expect(question).toContainText("Blocking question");
  await expect(inbox.getByRole("listitem").first()).toContainText("Ship it today?");
  await question.getByRole("button", { name: "Answer" }).click();
  await question.getByLabel("Answer").fill("Yes.");
  await question.getByRole("button", { name: "Post answer" }).click();
  await expect(question).toHaveCount(0);
  // The Ticket opens from the Inbox.
  await review.getByRole("link", { name: new RegExp(ticket.key) }).click();
  await expect(page.getByRole("heading", { name: "Filed and renamed by an Agent" })).toBeVisible();
  await page.goBack();
  // Ada sends the work back with what is left; it leaves her Inbox, and the Ticket shows why.
  await review.getByRole("button", { name: "Send back" }).click();
  await review.getByLabel("What is left to do").fill("Add a test.");
  await review.getByRole("button", { name: "Send back" }).click();
  await expect(page.getByRole("heading", { name: "Nothing waiting on you" })).toBeVisible();
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
test("see the board, a Ticket and a Document follow changes made elsewhere", async ({ page }) => {
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
});

// Runs after the tests above, so CRONK exists.
test("merge a Guidance edit someone else saved underneath", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("main").getByRole("link", { name: /CRONK/ }).click();
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
  expect(await page.evaluate(() => window.scrollY)).toBe(120);

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

/**
 * Registers an Agent of Ada's with a full token, starts an Agent Session for it, and files a Ticket assigned
 * to Ada and delegated to the Agent. Calls with `agentCall` act as that Agent Session.
 */
async function delegatedTicket(page: import("@playwright/test").Page, request: import("@playwright/test").APIRequestContext, agentName: string, title: string) {
  const { user } = await (await page.request.get("/api/me")).json();
  const { agent } = await (await page.request.post("/api/agents", { data: { name: agentName } })).json();
  const { secret } = await (await page.request.post(`/api/agents/${agent.id}/tokens`, { data: { readOnly: false } })).json();
  const { ticket } = await (await page.request.post("/api/projects/CRONK/tickets", { data: { title } })).json();
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
