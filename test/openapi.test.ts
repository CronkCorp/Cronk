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
    const history = body("/api/tickets/{key}/history", "get", "200");
    expect(history.properties.changes.items).toEqual({ $ref: "#/components/schemas/RecordedChange" });
    expect(body("/api/agents", "post", "201").properties.agent).toEqual({ $ref: "#/components/schemas/Agent" });
    expect(body("/api/workspace", "get", "200")).toEqual({ $ref: "#/components/schemas/Workspace" });
  });

  it("describes the errors each operation can answer with the shared error shape", async () => {
    const doc = await openapi();
    const errorBody = { $ref: "#/components/schemas/Error" };
    for (const [label, op] of operations(doc)) {
      const errors = Object.keys(op.responses).filter((code) => /^4\d\d$/.test(code));
      // Every operation that needs a sign-in or token can be refused without one, or for an ended Agent Session.
      if (op.security === undefined) expect(errors, label).toEqual(expect.arrayContaining(["401", "410"]));
      for (const code of errors) {
        expect(op.responses[code].description, `${label} ${code}`).toBeTruthy();
        // An error may carry more fields beside `error`, such as the current Version a stale edit is refused for.
        const schema = op.responses[code].content["application/json"].schema;
        expect(schema.allOf?.[0] ?? schema, `${label} ${code}`).toEqual(errorBody);
      }
    }
    const errorsOf = (path: string, method: string) => Object.keys(doc.paths[path][method].responses).filter((c) => c.startsWith("4"));
    expect(errorsOf("/api/tickets/{key}", "get")).toEqual(["401", "404", "410"]);
    expect(errorsOf("/api/projects", "post")).toEqual(["400", "401", "403", "409", "410"]);
    expect(errorsOf("/api/sign-in", "post")).toEqual(["400", "401", "403"]);
    expect(errorsOf("/api/invitations/{token}", "get")).toEqual(["404"]);
  });

  it("declares and describes every path parameter", async () => {
    const doc = await openapi();
    for (const [label, op] of operations(doc)) {
      const names = [...label.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = (op.parameters ?? []).filter((p: { in: string }) => p.in === "path");
      expect(declared.map((p: { name: string }) => p.name).sort(), label).toEqual(names.sort());
      for (const param of declared) {
        expect(param.required, `${label} ${param.name}`).toBe(true);
        expect(param.description, `${label} ${param.name}`).toBeTruthy();
        expect(param.schema?.type, `${label} ${param.name}`).toBe("string");
      }
    }
  });
});
