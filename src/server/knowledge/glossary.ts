import type { TermFields } from "./terms.js";

/**
 * A place's Terms as a `GLOSSARY.md`: a heading naming the place, Terms without a group first, then each
 * group under its own heading, both by name; each Term as its bold name, its definition and the words to avoid.
 */
export function glossaryMarkdown(title: string, intro: string | null, terms: TermFields[]): string {
  const byName = (a: TermFields, b: TermFields) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name);
  const entry = (t: TermFields) => [`**${t.name}**:`, t.definition.trim(), ...(t.avoid.length > 0 ? [`_Avoid_: ${t.avoid.join(", ")}`] : [])].join("\n");
  const blocks = [`# ${title}`];
  if (intro) blocks.push(intro);
  blocks.push(...terms.filter((t) => t.group === null).sort(byName).map(entry));
  const groups = [...new Set(terms.flatMap((t) => (t.group === null ? [] : [t.group])))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const group of groups) blocks.push(`## ${group}`, ...terms.filter((t) => t.group === group).sort(byName).map(entry));
  return `${blocks.join("\n\n")}\n`;
}

/** The title and introduction of a place's `GLOSSARY.md`: the Workspace's by its name, a Project's by its key, saying its Terms replace the Workspace's. */
export const glossaryHeading = (place: { workspaceName: string } | { projectKey: string }): { title: string; intro: string | null } =>
  "projectKey" in place
    ? { title: `${place.projectKey} glossary`, intro: `Within ${place.projectKey}, these Terms replace the Workspace's of the same name.` }
    : { title: `${place.workspaceName} glossary`, intro: null };
