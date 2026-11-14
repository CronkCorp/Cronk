import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiCall, Caller } from "./api.js";

/** What the tools need: whether the token is read-only, and a way to call the API as the Agent, within its Session. */
export interface ToolContext {
  readOnly: boolean;
  api: (caller: Caller) => ApiCall;
}

/** Registers Cronk's tools, grouped by resource, each with an `action`. */
export function registerTools(_server: McpServer, _ctx: ToolContext): void {}
