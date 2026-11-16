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
    for (const [path, method] of [["/api/setup", "post"], ["/api/sign-in", "post"], ["/api/invitations/by-token/{token}/accept", "post"], ["/api/health", "get"]] as const) {
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
      // A 204 has no body; a live-update stream answers server-sent events; an export answers an archive, a glossary Markdown;
      // every other success answers JSON with a schema.
      const type = label.endsWith("/events")
        ? "text/event-stream"
        : label.endsWith("/export")
          ? "application/gzip"
          : label.endsWith("/terms/glossary")
            ? "text/markdown"
            : "application/json";
      if (success[0] !== "204") expect(response.content?.[type]?.schema, label).toBeDefined();
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
    const changes = body("/api/tickets/{key}/changes", "get", "200");
    expect(changes.properties.changes.items).toEqual({ $ref: "#/components/schemas/RecordedChange" });
    expect(body("/api/agents", "post", "201").properties.agent).toEqual({ $ref: "#/components/schemas/Agent" });
    expect(body("/api/agents/{id}/record", "get", "200").properties.record.items).toEqual({ $ref: "#/components/schemas/AgentRecordEntry" });
    expect(body("/api/workspace", "get", "200")).toEqual({ $ref: "#/components/schemas/Workspace" });
  });

  it("keeps the old names of the Agent Record and a Ticket's Changes out", async () => {
    const doc = await openapi();
    expect(doc.components.schemas).not.toHaveProperty("AgentWork");
    expect(doc.paths).not.toHaveProperty("/api/agents/{id}/work");
    expect(doc.paths).not.toHaveProperty("/api/tickets/{key}/history");
    expect(doc.components.schemas.RecordedChange.description).toMatch(/^One Change to a Ticket/);
    expect(doc.components.schemas.RecordedChange.description).not.toMatch(/history/i);
  });

  it("describes the errors each operation can answer with the shared error shape", async () => {
    const doc = await openapi();
    const errorBody = { $ref: "#/components/schemas/Error" };
    const staleBody = { $ref: "#/components/schemas/StaleVersion" };
    const staleGuidanceBody = { $ref: "#/components/schemas/StaleGuidance" };
    const staleTermBody = { $ref: "#/components/schemas/StaleTermVersion" };
    const sectionBody = { $ref: "#/components/schemas/SectionRefused" };
    for (const [label, op] of operations(doc)) {
      const errors = Object.keys(op.responses).filter((code) => /^4\d\d$/.test(code));
      // Every operation that needs a sign-in or token can be refused without one, or for an ended Agent Session.
      if (op.security === undefined) expect(errors, label).toEqual(expect.arrayContaining(["401", "410"]));
      // Every operation refuses query parameters it doesn't take.
      expect(errors, label).toContain("400");
      // Every write can be refused for coming from another site.
      if (!label.startsWith("GET ")) expect(errors, label).toContain("403");
      for (const code of errors) {
        expect(op.responses[code].description, `${label} ${code}`).toBeTruthy();
        // A stale save's refusal is the error shape plus the current Version (of a Document, Guidance or a Term);
        // a 409 may also be either the stale shape or the plain error, when a route refuses for both reasons;
        // a refused section heading's is the error shape plus the Document's headings.
        const refusesSections = label === "POST /api/documents/{id}/replace-section" && ["400", "404"].includes(code);
        const allowed =
          code === "409"
            ? [
                errorBody,
                staleBody,
                staleGuidanceBody,
                staleTermBody,
                expect.objectContaining({ anyOf: [staleBody, errorBody] }),
                expect.objectContaining({ anyOf: [staleTermBody, errorBody] }),
              ]
            : refusesSections
              ? [errorBody, sectionBody]
              : [errorBody];
        expect(allowed, `${label} ${code}`).toContainEqual(op.responses[code].content["application/json"].schema);
      }
    }
    const errorsOf = (path: string, method: string) => Object.keys(doc.paths[path][method].responses).filter((c) => c.startsWith("4"));
    expect(errorsOf("/api/tickets/{key}", "get")).toEqual(["400", "401", "404", "410"]);
    expect(errorsOf("/api/projects", "post")).toEqual(["400", "401", "403", "409", "410"]);
    expect(errorsOf("/api/sign-in", "post")).toEqual(["400", "401", "403"]);
    expect(errorsOf("/api/invitations/by-token/{token}", "get")).toEqual(["400", "404"]);
    expect(errorsOf("/api/invitations/by-token/{token}/accept", "post")).toEqual(["400", "403", "404", "409"]);
    // A save is refused as stale, or because an Agent changes a Report without its Ticket's Claim.
    expect(doc.paths["/api/documents/{id}"].patch.responses["409"].content["application/json"].schema).toMatchObject({
      anyOf: [staleBody, errorBody],
    });
    expect(doc.paths["/api/documents/{id}"].delete.responses["409"].content["application/json"].schema).toMatchObject({
      anyOf: [staleBody, errorBody],
    });
    const deleteParams = doc.paths["/api/documents/{id}"].delete.parameters.filter((p: { in: string }) => p.in === "query");
    expect(deleteParams).toEqual([expect.objectContaining({ name: "baseVersion", required: true })]);
  });

  it("says every write an Agent makes needs an Agent Session, and how a script starts and ends one", async () => {
    const doc = await openapi();
    expect(doc.info.description).toContain("POST /api/agent-sessions");
    expect(doc.info.description).toContain("DELETE /api/agent-sessions/current");
    expect(doc.info.description).toMatch(/[Rr]eads? .*without/);
    for (const [label, op] of operations(doc)) {
      // Starting a Session is the one change made outside one; routes anyone may call take no token.
      if (label.startsWith("GET ") || op.security !== undefined || label === "POST /api/agent-sessions") continue;
      expect(op.responses["403"]?.description, label).toMatch(/Agent Session/);
    }
  });

  it("describes the archives imports take", async () => {
    const doc = await openapi();
    for (const path of ["/api/import", "/api/workspace/documents/import", "/api/projects/{key}/documents/import"]) {
      expect(Object.keys(doc.paths[path].post.requestBody.content), path).toEqual(expect.arrayContaining(["application/gzip", "application/x-tar"]));
    }
  });

  it("has no two paths that differ only in the names of their path parameters", async () => {
    const doc = await openapi();
    const shapes = new Map<string, string>();
    for (const path of Object.keys(doc.paths)) {
      const shape = path.replace(/\{[^}]+\}/g, "{}");
      expect(shapes.get(shape), `${path} clashes with ${shapes.get(shape)}`).toBeUndefined();
      shapes.set(shape, path);
    }
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

  it("lists only the query parameters an operation takes", async () => {
    const doc = await openapi();
    const query = (path: string, method: string) =>
      (doc.paths[path][method].parameters ?? []).filter((p: { in: string }) => p.in === "query").map((p: { name: string }) => p.name);
    expect(query("/api/tickets/{key}", "get")).toEqual([]);
    expect(query("/api/projects", "post")).toEqual([]);
    expect(query("/api/projects", "get")).toEqual(["archived"]);
    expect(query("/api/projects/{key}/tickets", "get")).toEqual(["status", "category", "assignee", "delegate", "priority", "label"]);
  });
});
