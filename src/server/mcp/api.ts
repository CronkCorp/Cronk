import type { FastifyInstance } from "fastify";
import { AGENT_SESSION_HEADER } from "../context.js";

/** Who the MCP server calls the API as: an Agent's token, within one of its Agent Sessions once there is one. */
export interface Caller {
  token: string;
  sessionId?: string | undefined;
}

/** The API's answer: its status and parsed JSON body (`{ error }` for an error). */
export interface ApiResponse {
  status: number;
  body: any;
}

/** Calls one API operation as a fixed caller. */
export type ApiCall = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: object) => Promise<ApiResponse>;

/** Calls Cronk's own HTTP API in-process, exactly as the Agent could over the network. */
export async function callApi(app: FastifyInstance, caller: Caller, ...[method, url, body]: Parameters<ApiCall>): Promise<ApiResponse> {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${caller.token}`, ...(caller.sessionId && { [AGENT_SESSION_HEADER]: caller.sessionId }) },
    ...(body && { payload: body }),
  });
  return { status: res.statusCode, body: parseBody(res.body) };
}

/** The body as JSON; anything else (never expected from the API) as an error carrying the text. */
function parseBody(text: string): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
