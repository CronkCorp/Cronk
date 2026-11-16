import type { WaitingWork, Welcome } from "../api-types.js";

/** The welcome as the Markdown an MCP client hands its model as the server's instructions. */
export function welcomeText(welcome: Welcome, sessionId: string): string {
  const { agent, workspace, projects } = welcome;
  const lines = [
    `# Welcome to Cronk${workspace ? `, ${workspace.name}` : ""}`,
    "",
    `You are the Agent **${agent.name}**, acting for ${agent.owner.name} in Agent Session ${sessionId}.`,
    "Cronk holds the Tickets and Documents that Users and Agents share; use the tools, most with an `action`, to work with them.",
    "Look things up with the `search` tool. Claiming a Ticket gives you its parent, Sub-Tickets, related Tickets, Reports, Linked Documents and the Documents that mention it.",
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
  lines.push("", "## Your Ready Tickets", "");
  if (welcome.readyTickets.length === 0) lines.push("None right now.");
  else lines.push("Highest Priority first. Use the `tickets` tool's `next` action to Claim the first, or `claim` to Claim one by key.", "");
  for (const t of welcome.readyTickets) lines.push(readyLine(t));
  lines.push("", "## Work waiting for you", "");
  if (welcome.waitingWork.length === 0) lines.push("Nothing new since your last Agent Session.");
  else lines.push("Comments that concern you, posted since your last Agent Session, oldest first. Read the whole conversation with the `comments` tool.", "");
  for (const w of welcome.waitingWork) lines.push(...waitingLines(w));
  if (!welcome.readOnly) {
    lines.push("", "While you hold a Ticket's Claim, log your plan, progress, findings and errors with the `activities` tool; each Activity keeps your Claim alive.");
  }
  return lines.join("\n");
}

/** Why a Comment waits for the Agent, as the welcome says it. */
const WHY: Record<WaitingWork["reason"], string> = {
  answer: "answered your question",
  mention: "mentioned you",
  comment: "commented on your delegated Ticket",
};

/** One piece of waiting work as welcome lines: where, who and why, then the Comment quoted. */
export function waitingLines({ reason, comment, ticket, document }: WaitingWork): string[] {
  const where = ticket ? `${ticket.key}: ${ticket.title}` : `Document “${document!.title}” (${document!.id})`;
  const who = comment.actor.kind === "agent" ? `the Agent ${comment.actor.name}` : comment.actor.name;
  const quoted = comment.body.trim().split("\n").map((line) => `  > ${line}`);
  return [`- ${where}: ${who} ${WHY[reason]} (Comment ${comment.id})`, ...quoted];
}

/** One Ready Ticket as a welcome line: its key, title, Status and any Priority. */
export function readyLine(t: Welcome["readyTickets"][number]): string {
  return `- ${t.key}: ${t.title} (${t.status.name}${t.priority === "none" ? "" : `, ${t.priority} Priority`})`;
}
