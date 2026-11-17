import type { WaitingWork, Welcome } from "../api-types.js";

/** How the welcome and every tool result name an Agent Session, so a Transcript holding it links to the Session (ADR 0013). */
export const namedSession = (sessionId: string): string => `Agent Session ${sessionId}`;

/** The welcome as the Markdown an MCP client hands its model as the server's instructions. */
export function welcomeText(welcome: Welcome, sessionId: string): string {
  const { agent, workspace, projects } = welcome;
  const lines = [
    `# Welcome to Cronk${workspace ? `, ${workspace.name}` : ""}`,
    "",
    `You are the Agent **${agent.name}**, acting for ${agent.owner.name} in ${namedSession(sessionId)}.`,
    "Cronk holds the Tickets and Documents that Users and Agents share; use the tools, most with an `action`, to work with them.",
    "Look things up with the `search` tool. Claiming a Ticket gives you its parent, Sub-Tickets, related Tickets, Reports, Linked Documents and what mentions it.",
  ];
  if (welcome.readOnly) lines.push("Your token is read-only: you can look things up but not change anything.");
  if (workspace?.guidance.trim()) {
    lines.push("", "## Workspace Guidance", "", "Standing instructions the Users wrote for every Agent. Follow them everywhere.", "", workspace.guidance.trim());
  }
  lines.push("", "## Projects you can see", "");
  if (projects.length === 0) lines.push("None yet.");
  for (const p of projects) lines.push(`- ${p.key}: ${p.name}${p.access === "read" ? " (read only)" : ""}`);
  const guided = projects.filter((p) => p.guidance.trim());
  if (guided.length > 0) {
    lines.push("", "## Project Guidance", "", "When you work in one of these Projects, follow its Guidance on top of the Workspace Guidance.");
    for (const p of guided) lines.push("", `### ${p.key}: ${p.name}`, "", p.guidance.trim());
  }
  lines.push("", "Fetch Guidance again at any time with the `guidance` tool.");
  lines.push(...termLines(welcome));
  lines.push("", "## Your Ready Tickets", "");
  if (welcome.readyTickets.length === 0) lines.push("None right now.");
  else lines.push("Highest Priority first. Use the `tickets` tool's `next` action to Claim the first, or `claim` to Claim one by key.");
  if (welcome.readyTickets.some((t) => t.autonomous)) {
    lines.push(
      "Those marked autonomous are under Autonomous Delegation: when the work is done, write a Report and move the Ticket to a Completed Status " +
        "yourself instead of stopping at In Review; a User verifies it afterwards. Your questions on them never block: record your best guess and carry on.",
    );
  }
  if (welcome.readyTickets.length > 0) lines.push("");
  for (const t of welcome.readyTickets) lines.push(readyLine(t));
  lines.push("", "## Work waiting for you", "");
  if (welcome.waitingWork.length === 0) lines.push("Nothing new since your last Agent Session.");
  else {
    lines.push(
      "Comments that concern you, and rejections of Decisions you proposed and Suggestions you made, since your last Agent Session, oldest first. " +
        "Read the whole conversation with the `comments` tool, a Decision with the `decisions` tool, and a Suggestion with the `suggestions` tool.",
      "",
    );
  }
  for (const w of welcome.waitingWork) lines.push(...waitingLines(w));
  if (!welcome.readOnly) {
    lines.push("", "While you hold a Ticket's Claim, log your plan, progress, findings and errors with the `activities` tool; each Activity keeps your Claim alive.");
  }
  return lines.join("\n");
}

/** Why a Comment waits for the Agent, as the welcome says it. */
const WHY: Record<Exclude<WaitingWork["reason"], "rejected" | "suggestion_rejected">, string> = {
  answer: "answered your question",
  mention: "mentioned you",
  comment: "commented on your delegated Ticket",
  published: "commented on a Version you published",
};

/** One piece of waiting work as welcome lines: where, who and why, then the Comment, or the reason for a rejection, quoted. */
export function waitingLines(work: WaitingWork): string[] {
  const quote = (text: string) => text.trim().split("\n").map((line) => `  > ${line}`);
  if (work.reason === "suggestion_rejected") {
    const { suggestion, ticket } = work;
    const from = ticket ? ` from ${ticket.key}` : "";
    return [
      `- Your Suggestion ${suggestion.id} ${suggestionOn(suggestion.item)}${from}: ${suggestion.rejectedBy.name} rejected it, saying why:`,
      ...quote(suggestion.reason),
    ];
  }
  if (work.reason === "rejected") {
    const { decision, ticket } = work;
    const from = ticket ? `, which you proposed from ${ticket.key}` : ", which you proposed";
    return [`- ${decision.key}: ${decision.title}: ${decision.rejectedBy.name} rejected it${from}, saying why:`, ...quote(decision.reason)];
  }
  const { reason, comment, ticket, document, artifact } = work;
  const where = ticket
    ? `${ticket.key}: ${ticket.title}`
    : artifact
      ? `Artifact “${artifact.title}” (${artifact.id}), Version ${artifact.version}`
      : `Document “${document!.title}” (${document!.id})`;
  const who = comment.actor.kind === "agent" ? `the Agent ${comment.actor.name}` : comment.actor.name;
  return [`- ${where}: ${who} ${WHY[reason]} (Comment ${comment.id})`, ...quote(comment.body)];
}

/** What the welcome says a Suggestion was on: "on the Document “Architecture”", "on CRONK-D3: Postgres", "of a new Document “Backups”". */
function suggestionOn(item: { kind: string; id: string | null; key: string | null; title: string; projectKey: string | null }): string {
  if (item.kind === "decision") return `on ${item.key}: ${item.title}`;
  // A rejected Suggestion of a new Document created none.
  if (item.kind === "document" && item.id === null) return `of a new Document “${item.title}”`;
  if (item.kind === "guidance") return `on ${item.projectKey ?? "the Workspace"}'s Guidance`;
  return `on the ${item.kind === "document" ? "Document" : "Term"} “${item.title}”`;
}

/** One Ready Ticket as a welcome line: its key, title, Status, any Priority, and whether it is autonomous. */
export function readyLine(t: Welcome["readyTickets"][number]): string {
  const autonomous = t.autonomous ? ", autonomous: complete it yourself with a Report" : "";
  return `- ${t.key}: ${t.title} (${t.status.name}${t.priority === "none" ? "" : `, ${t.priority} Priority`}${autonomous})`;
}

/** The welcome's Terms section: the Workspace's Term names, then each Project's own, marking those that replace a Workspace Term. */
function termLines({ workspace, projects }: Welcome): string[] {
  const workspaceNames = new Set((workspace?.terms ?? []).map((n) => n.toLowerCase()));
  const lines: string[] = [];
  if (workspace && workspace.terms.length > 0) lines.push(`- Workspace: ${workspace.terms.join(", ")}`);
  for (const p of projects) {
    if (p.terms.length === 0) continue;
    const names = p.terms.map((n) => (workspaceNames.has(n.toLowerCase()) ? `${n} (replaces the Workspace's)` : n));
    lines.push(`- ${p.key}: ${names.join(", ")}`);
  }
  if (lines.length === 0) return [];
  return [
    "",
    "## Terms",
    "",
    "The glossary's Term names. Use them, and avoid the words each Term lists; within a Project, its own Terms replace the Workspace's of the same name. " +
      "Look a Term up with the `terms` tool. A save that uses a word to avoid still goes through, and its result lists each one with the Term to use.",
    "",
    ...lines,
  ];
}
