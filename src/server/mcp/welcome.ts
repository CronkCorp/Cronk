import type { Welcome } from "../api-types.js";

/** The welcome as the Markdown an MCP client hands its model as the server's instructions. */
export function welcomeText(welcome: Welcome, sessionId: string): string {
  const { agent, workspace, projects } = welcome;
  const lines = [
    `# Welcome to Cronk${workspace ? `, ${workspace.name}` : ""}`,
    "",
    `You are the Agent **${agent.name}**, acting for ${agent.owner.name} in Agent Session ${sessionId}.`,
    "Cronk tracks Tickets that Users and Agents share; use the tools, each with an `action`, to work with them.",
  ];
  if (welcome.readOnly) lines.push("Your token is read-only: you can look things up but not change anything.");
  lines.push("", "## Projects you can see", "");
  if (projects.length === 0) lines.push("None yet.");
  for (const p of projects) lines.push(`- ${p.key}: ${p.name}${p.access === "read" ? " (read only)" : ""}`);
  lines.push("", "## Your Ready Tickets", "");
  if (welcome.readyTickets.length === 0) lines.push("None right now.");
  else lines.push("Highest Priority first. Use the `tickets` tool's `next` action to Claim the first, or `claim` to Claim one by key.", "");
  for (const t of welcome.readyTickets) lines.push(`- ${t.key}: ${t.title} (${t.status.name}${t.priority === "none" ? "" : `, ${t.priority} Priority`})`);
  return lines.join("\n");
}
