import { describe, expect, it } from "vitest";
import { startInstalledCronk } from "./harness.js";

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
});
