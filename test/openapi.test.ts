import { describe, expect, it } from "vitest";
import { startInstalledCronk } from "./harness.js";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Every operation in the description, as `[label, operation]` pairs. */
function operations(doc: any): [string, any][] {
  return Object.entries(doc.paths).flatMap(([path, item]: [string, any]) =>
    METHODS.filter((m) => item[m]).map((m): [string, any] => [`${m.toUpperCase()} ${path}`, item[m]]),
  );
}

async function openapi() {
  const { cronk } = await startInstalledCronk();
  const res = await cronk.client().get("/api/openapi.json");
  expect(res.status).toBe(200);
  return res.body;
}

describe("the OpenAPI description", () => {
  it("is served to anyone and describes the API, including Agent tokens", async () => {
    const { cronk } = await startInstalledCronk();
    const res = await cronk.client().get("/api/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(["/api/projects", "/api/tickets/{key}", "/api/agents", "/api/agents/{id}/tokens"]),
    );
    expect(res.body.paths["/api/projects/{key}"].patch.requestBody.content["application/json"].schema.properties).toHaveProperty("agentAccess");
    // Routes anyone may call say so; the rest need a sign-in or an Agent token.
    for (const [path, method] of [["/api/setup", "post"], ["/api/sign-in", "post"], ["/api/invitations/{token}/accept", "post"], ["/api/health", "get"]] as const) {
      expect(res.body.paths[path][method].security).toEqual([]);
    }
    expect(res.body.paths["/api/projects"].get.security).toBeUndefined();
    expect(res.body.components.securitySchemes).toMatchObject({ agentToken: { type: "http", scheme: "bearer" } });
  });

  it("describes what every operation answers on success", async () => {
    const doc = await openapi();
    for (const [label, op] of operations(doc)) {
      const success = Object.keys(op.responses ?? {}).filter((code) => /^2\d\d$/.test(code));
      expect(success, label).toHaveLength(1);
      const response = op.responses[success[0]!];
      expect(response.description, label).toBeTruthy();
      // A 204 has no body; every other success answers JSON with a schema.
      if (success[0] !== "204") expect(response.content?.["application/json"]?.schema, label).toBeDefined();
    }
  });

  it("names the shared shapes once and refers to them", async () => {
    const doc = await openapi();
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(["Project", "Ticket", "Status", "RecordedChange", "User", "Agent", "AgentToken", "Workspace", "Error"]),
    );
    const body = (path: string, method: string, code: string) => doc.paths[path][method].responses[code].content["application/json"].schema;
    expect(body("/api/tickets/{key}", "get", "200").properties.ticket).toEqual({ $ref: "#/components/schemas/Ticket" });
    expect(body("/api/projects", "get", "200").properties.projects.items).toEqual({ $ref: "#/components/schemas/Project" });
    expect(body("/api/tickets/{key}/history", "get", "200").properties.changes.items).toEqual({ $ref: "#/components/schemas/RecordedChange" });
    expect(body("/api/agents", "post", "201").properties.agent).toEqual({ $ref: "#/components/schemas/Agent" });
    expect(body("/api/workspace", "get", "200")).toEqual({ $ref: "#/components/schemas/Workspace" });
  });
});
