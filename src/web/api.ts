/** A thin client for the Cronk HTTP API. The UI holds no rules; the API decides. */

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

export interface Workspace {
  name: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

export const api = {
  setupRequired: () => request<{ required: boolean }>("GET", "/api/setup").then((r) => r.required),
  setup: (input: { email: string; password: string; name: string; workspaceName?: string }) =>
    request<{ user: User }>("POST", "/api/setup", input).then((r) => r.user),
  signIn: (email: string, password: string) =>
    request<{ user: User }>("POST", "/api/sessions", { email, password }).then((r) => r.user),
  signOut: () => request<void>("DELETE", "/api/sessions/current"),
  me: () => request<{ user: User }>("GET", "/api/me").then((r) => r.user),
  workspace: () => request<Workspace>("GET", "/api/workspace"),
  renameWorkspace: (name: string) => request<Workspace>("PATCH", "/api/workspace", { name }),
};
