import { describe, expect, it } from "vitest";
import { joinAs, startInstalledCronk } from "./harness.js";

describe("Terms", () => {
  it("are created for the Workspace with a name, definition, words to avoid and a group, at Version 1", async () => {
    const { admin } = await startInstalledCronk();

    const created = await admin.post("/api/workspace/terms", {
      name: "Ticket",
      definition: "A unit of work tracked within a Project.",
      avoid: ["Issue", "task"],
      group: "Work",
    });
    expect(created.status).toBe(201);
    expect(created.body.term).toMatchObject({
      projectKey: null,
      name: "Ticket",
      definition: "A unit of work tracked within a Project.",
      avoid: ["Issue", "task"],
      group: "Work",
      version: 1,
      overrides: null,
      overriddenBy: [],
    });

    const got = await admin.get(`/api/terms/${created.body.term.id}`);
    expect(got.status).toBe(200);
    expect(got.body.term).toEqual(created.body.term);
    expect((await admin.get("/api/workspace/terms")).body.terms).toEqual([created.body.term]);
  });

  it("refuse a second Term of the same name in the same place, ignoring case", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." });

    const again = await admin.post("/api/workspace/terms", { name: "  ticket ", definition: "Something else." });
    expect(again.status).toBe(409);
    expect((await admin.get("/api/workspace/terms")).body.terms).toHaveLength(1);
  });
});

describe("a Project Term", () => {
  it("replaces the Workspace Term of the same name within its Project, ignoring case, and both show it", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects", { name: "Website", key: "SITE" });
    const customer = (await admin.post("/api/workspace/terms", { name: "Customer", definition: "A paying organization." })).body.term;
    const ticket = (await admin.post("/api/workspace/terms", { name: "Ticket", definition: "A unit of work." })).body.term;

    const created = await admin.post("/api/projects/CRONK/terms", { name: "customer", definition: "A billing account." });
    expect(created.status).toBe(201);
    const override = created.body.term;
    expect(override).toMatchObject({
      projectKey: "CRONK",
      name: "customer",
      overrides: { id: customer.id, name: "Customer", definition: "A paying organization." },
      overriddenBy: [],
    });

    const inCronk = (await admin.get("/api/projects/CRONK/terms")).body.terms;
    expect(inCronk.map((t: any) => [t.name, t.projectKey])).toEqual([
      ["customer", "CRONK"],
      ["Ticket", null],
    ]);
    const inSite = (await admin.get("/api/projects/SITE/terms")).body.terms;
    expect(inSite.map((t: any) => [t.name, t.projectKey])).toEqual([
      ["Customer", null],
      ["Ticket", null],
    ]);

    const workspaceCustomer = (await admin.get(`/api/terms/${customer.id}`)).body.term;
    expect(workspaceCustomer.overriddenBy).toEqual([{ id: override.id, name: "customer", projectKey: "CRONK" }]);
    expect((await admin.get(`/api/terms/${ticket.id}`)).body.term.overriddenBy).toEqual([]);
  });

  it("is looked up by name, ignoring case, among the Terms that apply in its Project", async () => {
    const { admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/workspace/terms", { name: "Customer", definition: "A paying organization." });
    await admin.post("/api/projects/CRONK/terms", { name: "Customer", definition: "A billing account." });

    const found = await admin.get("/api/projects/CRONK/terms?name=CUSTOMER");
    expect(found.body.terms.map((t: any) => t.definition)).toEqual(["A billing account."]);
    expect((await admin.get("/api/workspace/terms?name=customer")).body.terms.map((t: any) => t.definition)).toEqual(["A paying organization."]);
  });

  it("hides overrides in Projects the reader can't see", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    const customer = (await admin.post("/api/workspace/terms", { name: "Customer", definition: "A paying organization." })).body.term;
    await admin.post("/api/projects/SECRET/terms", { name: "Customer", definition: "A secret account." });
    const member = await joinAs(cronk, admin, "bob@example.com");

    expect((await member.get(`/api/terms/${customer.id}`)).body.term.overriddenBy).toEqual([]);
    expect((await admin.get(`/api/terms/${customer.id}`)).body.term.overriddenBy).toHaveLength(1);
  });
});
