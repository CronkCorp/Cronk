import type { FastifyInstance } from "fastify";
import { AGENT_SESSION_HEADER } from "../context.js";

/**
 * Who the MCP server calls the API as: an Agent's token, within one of its Agent Sessions once there is one, sent
 * to the host the Agent reached Cronk at, so addresses the API answers with (such as an Artifact's) are ones it can open.
 */
export interface Caller {
  token: string;
  sessionId?: string | undefined;
  host?: string | undefined;
}

/** The API's answer: its status and parsed JSON body (`{ error }` for an error). */
export interface ApiResponse {
  status: number;
  body: any;
}

/** A request body that is a file's bytes rather than JSON, as an upload sends. */
export class FileBody {
  constructor(
    readonly bytes: Buffer,
    readonly contentType: string,
  ) {}
}

/** Calls one API operation as a fixed caller, with a JSON body or a file's bytes. */
export type ApiCall = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: object | FileBody) => Promise<ApiResponse>;

/** The headers that make a request the caller's: its token, and its Agent Session once there is one. */
export function callerHeaders(caller: Caller): Record<string, string> {
  return { authorization: `Bearer ${caller.token}`, ...(caller.sessionId && { [AGENT_SESSION_HEADER]: caller.sessionId }) };
}

/** Calls Cronk's own HTTP API in-process, exactly as the Agent could over the network. */
export async function callApi(app: FastifyInstance, caller: Caller, ...[method, url, body]: Parameters<ApiCall>): Promise<ApiResponse> {
  const file = body instanceof FileBody ? body : undefined;
  const res = await app.inject({
    method,
    url,
    headers: { ...callerHeaders(caller), ...(caller.host && { host: caller.host }), ...(file && { "content-type": file.contentType }) },
    ...(body && { payload: file ? file.bytes : body }),
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
