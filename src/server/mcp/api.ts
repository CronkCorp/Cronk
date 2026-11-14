import type { FastifyInstance } from "fastify";
import { AGENT_SESSION_HEADER } from "../context.js";

/** Who the MCP server calls the API as: an Agent's token, within one of its Agent Sessions once there is one. */
export interface Caller {
  token: string;
  sessionId?: string | undefined;
}

export interface ApiResponse {
  status: number;
  body: any;
}

export type ApiCall = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: object) => Promise<ApiResponse>;

/** Calls Cronk's own HTTP API in-process, exactly as the Agent could over the network. */
export async function callApi(app: FastifyInstance, caller: Caller, ...[method, url, body]: Parameters<ApiCall>): Promise<ApiResponse> {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${caller.token}`, ...(caller.sessionId && { [AGENT_SESSION_HEADER]: caller.sessionId }) },
    ...(body && { payload: body }),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}
