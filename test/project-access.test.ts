import { describe, expect, it } from "vitest";
import { joinAs, startInstalledCronk, type Client } from "./harness.js";

async function userId(client: Client): Promise<string> {
  return (await client.get("/api/me")).body.user.id;
}

const keysOf = (res: { body: { projects: { key: string }[] } }) => res.body.projects.map((p) => p.key);

describe("open and private Projects", () => {
  it("hides a private Project from Members who weren't invited to it", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.post("/api/projects", { name: "Open", key: "OPEN" });
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.post("/api/projects/SECRET/tickets", { title: "Hidden" });

    const madePrivate = await admin.patch("/api/projects/SECRET", { visibility: "private" });
    expect(madePrivate.status).toBe(200);
    expect(madePrivate.body.project).toMatchObject({ visibility: "private" });

    expect(keysOf(await bob.get("/api/projects"))).toEqual(["OPEN"]);
    expect(keysOf(await admin.get("/api/projects"))).toEqual(["OPEN", "SECRET"]);
    for (const res of [
      await bob.get("/api/projects/SECRET"),
      await bob.patch("/api/projects/SECRET", { name: "Mine now" }),
      await bob.get("/api/projects/SECRET/tickets"),
      await bob.post("/api/projects/SECRET/tickets", { title: "Snooping" }),
      await bob.get("/api/tickets/SECRET-1"),
      await bob.patch("/api/tickets/SECRET-1", { title: "Snooped" }),
      await bob.get("/api/tickets/SECRET-1/history"),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await admin.get("/api/tickets/SECRET-1")).body.ticket.title).toBe("Hidden");
  });
});
