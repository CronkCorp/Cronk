import { describe, expect, it } from "vitest";
import { ada as admin, startCronk, startInstalledCronk } from "./harness.js";

describe("the Workspace", () => {
  it("takes the name given at setup, and the Admin can rename it", async () => {
    const cronk = await startCronk();
    const browser = cronk.client();
    await browser.post("/api/setup", { ...admin, workspaceName: "Acme" });
    expect((await browser.get("/api/workspace")).body).toEqual({ name: "Acme", agentAccess: "write", silenceThresholdSeconds: 300, transcriptMaxBytes: 10485760 });

    const renamed = await browser.patch("/api/workspace", { name: "  Acme Labs " });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ name: "Acme Labs", agentAccess: "write", silenceThresholdSeconds: 300, transcriptMaxBytes: 10485760 });
    expect((await browser.get("/api/workspace")).body).toEqual({ name: "Acme Labs", agentAccess: "write", silenceThresholdSeconds: 300, transcriptMaxBytes: 10485760 });
  });

  it("gets a default name when setup gives none", async () => {
    const cronk = await startCronk();
    const browser = cronk.client();
    await browser.post("/api/setup", admin);
    expect((await browser.get("/api/workspace")).body).toEqual({ name: "Cronk", agentAccess: "write", silenceThresholdSeconds: 300, transcriptMaxBytes: 10485760 });
  });

  it("refuses a blank name", async () => {
    const { admin } = await startInstalledCronk();
    expect((await admin.patch("/api/workspace", { name: "   " })).status).toBe(400);
  });

  it("is only shown to signed-in Users", async () => {
    const { cronk } = await startInstalledCronk();
    const stranger = cronk.client();
    expect((await stranger.get("/api/workspace")).status).toBe(401);
    expect((await stranger.patch("/api/workspace", { name: "Pwned" })).status).toBe(401);
  });
});
