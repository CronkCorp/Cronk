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
  return lines.join("\n");
}
