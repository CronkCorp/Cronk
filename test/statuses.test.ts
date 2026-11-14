import { describe, expect, it } from "vitest";
import { startInstalledCronk, type Client } from "./harness.js";

interface Status {
  id: string;
  name: string;
  category: string;
}

async function createProject(client: Client, key: string) {
  const res = await client.post("/api/projects", { name: key, key });
  if (res.status !== 201) throw new Error(`Creating Project ${key} failed: ${JSON.stringify(res.body)}`);
}

async function statuses(client: Client, key = "CRONK"): Promise<Status[]> {
  return (await client.get(`/api/projects/${key}`)).body.statuses;
}

const names = (list: Status[]) => list.map((s) => s.name);

async function statusNamed(client: Client, name: string, key = "CRONK"): Promise<Status> {
  const status = (await statuses(client, key)).find((s) => s.name === name);
  if (!status) throw new Error(`No Status named ${name} in ${key}`);
  return status;
}

describe("Statuses", () => {
  it("can be added to any Status Category, landing last in it", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");

    const added = await admin.post("/api/projects/CRONK/statuses", { name: " In QA ", category: "started" });
    expect(added.status).toBe(201);
    expect(added.body.status).toMatchObject({ name: "In QA", category: "started" });
    await admin.post("/api/projects/CRONK/statuses", { name: "Icebox", category: "backlog" });

    expect(names(await statuses(admin))).toEqual(["Backlog", "Icebox", "Todo", "In Progress", "In QA", "In Review", "Done", "Canceled"]);
  });

  it("need a name no other Status of the Project has, compared without case, and a known Status Category", async () => {
    const { admin } = await startInstalledCronk();
    await createProject(admin, "CRONK");
    await createProject(admin, "WEB");

    const clash = await admin.post("/api/projects/CRONK/statuses", { name: "in progress", category: "in_review" });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/in progress/);
    expect((await admin.post("/api/projects/WEB/statuses", { name: "In QA", category: "started" })).status).toBe(201);
    expect((await admin.post("/api/projects/CRONK/statuses", { name: "In QA", category: "started" })).status).toBe(201);

    expect((await admin.post("/api/projects/CRONK/statuses", { name: "Shipped", category: "deployed" })).status).toBe(400);
    expect((await admin.post("/api/projects/CRONK/statuses", { name: " ", category: "started" })).status).toBe(400);
    expect((await admin.post("/api/projects/NOPE/statuses", { name: "Shipped", category: "completed" })).status).toBe(404);
  });
});
