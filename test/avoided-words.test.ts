import { describe, expect, it } from "vitest";
import { delegatedSetup } from "./harness.js";

/** Ada's CRONK with one Ticket delegated to claude-laptop, a Workspace Term Ticket avoiding "issue" and "work item", and an Agent Session holding CRONK-1's Claim. */
async function claimedWithTerms() {
  const setup = await delegatedSetup();
  const ticketTerm = (await setup.admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work.", avoid: ["issue", "work item"] })).body.term;
  const agent = await setup.session();
  await agent.post("/api/tickets/CRONK-1/claim");
  return { ...setup, agent, ticketTerm };
}

describe("an Agent's save with a word a Term says to avoid", () => {
  it("succeeds and lists each avoided word with its Term and position", async () => {
    const { agent, ticketTerm } = await claimedWithTerms();

    const written = await agent.post("/api/tickets/CRONK-1/reports", { title: "Fixed the Issue", body: "Done.\n\nThat work item and this issue are closed." });
    expect(written.status).toBe(201);
    expect(written.body.report.body).toBe("Done.\n\nThat work item and this issue are closed.");
    const term = { id: ticketTerm.id, name: "Ticket" };
    expect(written.body.avoidedWords).toEqual([
      { field: "title", word: "Issue", line: 1, column: 11, term },
      { field: "body", word: "work item", line: 3, column: 6, term },
      { field: "body", word: "issue", line: 3, column: 25, term },
    ]);
  });
});

describe("words a Term says to avoid", () => {
  it("count only in prose: code spans, fenced code, block quotes and raw HTML are left out", async () => {
    const { agent } = await claimedWithTerms();
    const body = [
      "Use `issue` here.",
      "",
      "```",
      "an issue in code",
      "```",
      "",
      "~~~ts",
      "const issue = 1;",
      "~~~",
      "",
      "> The customer wrote: an issue.",
      "",
      "<div>issue</div>",
      "",
      "A real *issue*, not an issues list or a non-issue_x.",
    ].join("\n");

    const created = await agent.post("/api/projects/CRONK/documents", { title: "Notes", body });
    expect(created.status).toBe(201);
    expect(created.body.avoidedWords.map((w: any) => [w.word, w.line, w.column])).toEqual([["issue", 15, 9]]);
  });

  it("match whole words and phrases ignoring case and line breaks, leaving out a note in parentheses", async () => {
    const { admin, agent } = await claimedWithTerms();
    const assignee = (await admin.post("/api/workspace/terms", { name: "Assignee", definition: "The User accountable.", avoid: ["Owner (reserved for Agents)"] })).body.term;

    const commented = await agent.post("/api/tickets/CRONK-1/comments", { body: "The OWNER said this Work\nItem is an owners' thing, not ownership." });
    expect(commented.body.avoidedWords).toEqual([
      { field: "body", word: "OWNER", line: 1, column: 5, term: { id: assignee.id, name: "Assignee" } },
      { field: "body", word: "Work\nItem", line: 1, column: 21, term: expect.objectContaining({ name: "Ticket" }) },
    ]);
  });

  it("are read through emphasis and links, as the words show once rendered", async () => {
    const { agent } = await claimedWithTerms();

    const commented = await agent.post("/api/tickets/CRONK-1/comments", { body: "A work *item*, an *issu*e and a [link to an issue](https://example.com/issue), all re**issue**d." });
    expect(commented.body.avoidedWords.map((w: any) => [w.word, w.column])).toEqual([
      ["work *item", 3],
      ["issu*e", 20],
      ["issue", 45],
    ]);
  });

  it("are those of the Terms that apply where the text is saved: a Project Term replaces the Workspace Term of the same name", async () => {
    const { admin, agent, ticketTerm } = await claimedWithTerms();
    const projectTicket = (await admin.post("/api/projects/CRONK/terms", { name: "ticket", definition: "A card on the board.", avoid: ["card"] })).body.term;
    const text = { title: "Plan", body: "Each issue is a card." };

    const inWorkspace = await agent.post("/api/workspace/documents", text);
    expect(inWorkspace.status).toBe(201);
    expect(inWorkspace.body.avoidedWords).toEqual([{ field: "body", word: "issue", line: 1, column: 6, term: { id: ticketTerm.id, name: "Ticket" } }]);

    const inCronk = (await agent.post("/api/projects/CRONK/documents", { title: "Plan" })).body.document;
    const updated = await agent.patch(`/api/documents/${inCronk.id}`, { baseVersion: 1, body: text.body });
    expect(updated.status).toBe(200);
    expect(updated.body.document.body).toBe(text.body);
    expect(updated.body.avoidedWords).toEqual([{ field: "body", word: "card", line: 1, column: 17, term: { id: projectTicket.id, name: "ticket" } }]);
  });
});

describe("the hint", () => {
  it("comes with every save of text: Comments, Activities and Ticket fields", async () => {
    const { admin, agent, ticketTerm } = await claimedWithTerms();
    const term = { id: ticketTerm.id, name: "Ticket" };
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Guide" })).body.document;
    const hint = (field: string, column: number) => [{ field, word: "issue", line: 1, column, term }];

    const onTicket = await agent.post("/api/tickets/CRONK-1/comments", { body: "An issue here." });
    expect(onTicket.status).toBe(201);
    expect(onTicket.body.avoidedWords).toEqual(hint("body", 4));
    expect((await agent.post(`/api/documents/${doc.id}/comments`, { body: "One issue." })).body.avoidedWords).toEqual(hint("body", 5));

    const logged = await agent.post("/api/tickets/CRONK-1/activities", { kind: "progress", body: "Fixing the issue." });
    expect(logged.status).toBe(201);
    expect(logged.body.avoidedWords).toEqual(hint("body", 12));

    const split = await agent.post("/api/tickets/CRONK-1/sub-tickets", { title: "Smaller issue", description: "No issue." });
    expect(split.status).toBe(201);
    expect(split.body.avoidedWords).toEqual([...hint("title", 9), ...hint("description", 4)]);

    const edited = await agent.patch("/api/tickets/CRONK-1", { description: "Still an issue.", priority: "high" });
    expect(edited.status).toBe(200);
    expect(edited.body.avoidedWords).toEqual(hint("description", 10));
    expect((await agent.patch("/api/tickets/CRONK-1", { priority: "low" })).body.avoidedWords).toEqual([]);

    const created = await admin.post("/api/projects/CRONK/tickets", { title: "An issue" });
    expect(created.status).toBe(201);
    expect(created.body.avoidedWords).toEqual(hint("title", 4));
  });
});

describe("replacing a section", () => {
  it("lists the avoided words of the new section, placed in the body sent", async () => {
    const { admin, agent } = await claimedWithTerms();
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Guide", body: "# Guide\n\n## Setup\n\nOld." })).body.document;

    const replaced = await agent.post(`/api/documents/${doc.id}/replace-section`, { baseVersion: 1, heading: "Setup", body: "Open an\nissue." });
    expect(replaced.status).toBe(200);
    expect(replaced.body.avoidedWords.map((w: any) => [w.field, w.word, w.line, w.column])).toEqual([["body", "issue", 2, 1]]);
  });
});

describe("an Agent's proposed Decision with a word a Term says to avoid", () => {
  it("is saved, listing the words in its title and body, when proposed and when refined", async () => {
    const { admin, agent, ticketTerm } = await claimedWithTerms();
    const term = { id: ticketTerm.id, name: "Ticket" };

    const proposed = await agent.post("/api/projects/CRONK/decisions", { title: "One issue per change", body: "Each work item is one change." });
    expect(proposed.status).toBe(201);
    expect(proposed.body.avoidedWords).toEqual([
      { field: "title", word: "issue", line: 1, column: 5, term },
      { field: "body", word: "work item", line: 1, column: 6, term },
    ]);
    const workspace = await agent.post("/api/workspace/decisions", { title: "Fine words", body: "Each Ticket is one change." });
    expect(workspace.body.avoidedWords).toEqual([]);

    const refined = await agent.patch("/api/decisions/CRONK-D1", { baseVersion: 1, body: "Each issue is one change." });
    expect(refined.body.avoidedWords).toEqual([{ field: "body", word: "issue", line: 1, column: 6, term }]);
    expect((await admin.get("/api/decisions/CRONK-D1")).body.decision.body).toBe("Each issue is one change.");
  });
});
