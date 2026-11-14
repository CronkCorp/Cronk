import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PRIORITIES, STATUS_CATEGORIES } from "../../shared/values.js";
import type { ApiCall, ApiResponse, Caller } from "./api.js";

/** What the tools need: whether the token is read-only, and a way to call the API as the Agent, within its Session. */
export interface ToolContext {
  readOnly: boolean;
  api: (caller: Caller) => ApiCall;
}

/** One `action` of a grouped tool: whether it writes, and the API call it maps onto. */
interface Action<Args> {
  description: string;
  writes: boolean;
  run: (api: ApiCall, args: Args) => Promise<ApiResponse> | ApiResponse;
}

/**
 * Registers a tool grouped by resource: one tool whose `action` parameter picks the
 * operation. A read-only token is offered only the actions that don't write.
 */
function registerGroupedTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  tool: { name: string; description: string; parameters: Shape; actions: Record<string, Action<z.infer<z.ZodObject<Shape>>>> },
): void {
  const offered = Object.entries(tool.actions).filter(([, a]) => !(ctx.readOnly && a.writes));
  const names = offered.map(([name]) => name) as [string, ...string[]];
  const actionList = offered.map(([name, a]) => `- \`${name}\`: ${a.description}`).join("\n");
  const inputSchema: z.ZodObject<z.ZodRawShape> = z.object({ action: z.enum(names).describe("What to do"), ...tool.parameters });
  server.registerTool(tool.name, { description: `${tool.description}\n\nActions:\n${actionList}`, inputSchema }, async (input, extra) => {
    const { action, ...args } = input as { action: string };
    const api = ctx.api({ token: extra.authInfo!.token, sessionId: extra.sessionId });
    try {
      return toResult(await tool.actions[action]!.run(api, args as z.infer<z.ZodObject<Shape>>));
    } catch (err) {
      if (err instanceof ToolError) return error(err.message);
      throw err;
    }
  });
}

/** A tool call the Agent got wrong, such as a missing parameter, answered as a tool error. */
class ToolError extends Error {}

function required<T>(value: T | undefined, what: string, action: string): T {
  if (value === undefined) throw new ToolError(`The ${action} action needs ${what}`);
  return value;
}

const error = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** The API's answer as a tool result: its JSON, or its error message. */
function toResult(res: ApiResponse): CallToolResult {
  if (res.status >= 400) return error(res.body?.error ?? `The API answered ${res.status}`);
  return { content: [{ type: "text", text: JSON.stringify(res.body ?? {}) }] };
}

/** A query string repeating each key once per value, as the API's list filters take them. */
function query(params: Record<string, string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, values] of Object.entries(params)) for (const value of values ?? []) search.append(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** Registers Cronk's tools, grouped by resource, each with an `action`. */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerGroupedTool(server, ctx, {
    name: "tickets",
    description: "Tickets: the units of work tracked in a Project, keyed like CRONK-12.",
    parameters: {
      project: z.string().optional().describe("Project key, such as CRONK (list)"),
      key: z.string().optional().describe("Ticket key, such as CRONK-12 (get, claim, release, move, create_sub_ticket)"),
      to: z.string().optional().describe("The Status to move into, by name or id (move)"),
      title: z.string().optional().describe("The new Sub-Ticket's title (create_sub_ticket)"),
      description: z.string().optional().describe("The new Sub-Ticket's Markdown description (create_sub_ticket)"),
      status: z.array(z.string()).optional().describe("Only Tickets in one of these Status ids (list)"),
      category: z.array(z.enum(STATUS_CATEGORIES)).optional().describe("Only Tickets whose Status is in one of these Status Categories (list)"),
      priority: z.array(z.enum(PRIORITIES)).optional().describe("Only Tickets with one of these Priorities (list)"),
      label: z.array(z.string()).optional().describe("Only Tickets with one of these Labels, ignoring case (list)"),
      assignee: z.array(z.string()).optional().describe("Only Tickets assigned to one of these User ids, or `none` for unassigned (list)"),
    },
    actions: {
      list: {
        description: "a Project's Tickets in key order, optionally filtered",
        writes: false,
        run: (api, a) => {
          const project = required(a.project, "a project", "list");
          const filters = query({ status: a.status, category: a.category, priority: a.priority, label: a.label, assignee: a.assignee });
          return api("GET", `/api/projects/${encodeURIComponent(project)}/tickets${filters}`);
        },
      },
      get: {
        description: "one Ticket with its Sub-Tickets and Relations",
        writes: false,
        run: (api, a) => api("GET", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "get"))}`),
      },
      next: {
        description: "Claim your next Ready Ticket (highest Priority, then oldest) and get it; `next` is null when none is Ready",
        writes: true,
        run: (api) => api("POST", "/api/agent-sessions/current/next"),
      },
      claim: {
        description: "Claim a Ticket delegated to you, so no other Agent Session works on it, and get it",
        writes: true,
        run: (api, a) => api("POST", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "claim"))}/claim`),
      },
      release: {
        description: "release your Claim on a Ticket, leaving it delegated to you for another Agent Session",
        writes: true,
        run: (api, a) => api("DELETE", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "release"))}/claim`),
      },
      move: {
        description: "move a Ticket you hold the Claim on into another Status (Unstarted, Started or In Review only)",
        writes: true,
        run: async (api, a) => {
          const key = required(a.key, "a key", "move");
          const to = required(a.to, "a Status to move to", "move");
          const projectKey = key.slice(0, key.lastIndexOf("-"));
          const project = await api("GET", `/api/projects/${encodeURIComponent(projectKey)}`);
          if (project.status >= 400) return project;
          const statuses = project.body.statuses as { id: string; name: string }[];
          const status = statuses.find((s) => s.id === to) ?? statuses.find((s) => s.name.toLowerCase() === to.trim().toLowerCase());
          if (!status) throw new ToolError(`${projectKey.toUpperCase()} has no Status named ${to}; it has ${statuses.map((s) => s.name).join(", ")}`);
          return api("PATCH", `/api/tickets/${encodeURIComponent(key)}`, { statusId: status.id });
        },
      },
      create_sub_ticket: {
        description: "split a Ticket you hold the Claim on: create a Sub-Ticket that stays delegated to you",
        writes: true,
        run: (api, a) => {
          const key = required(a.key, "a key", "create_sub_ticket");
          const title = required(a.title, "a title", "create_sub_ticket");
          return api("POST", `/api/tickets/${encodeURIComponent(key)}/sub-tickets`, { title, ...(a.description !== undefined && { description: a.description }) });
        },
      },
    },
  });
}
