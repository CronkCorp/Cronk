// Tests that `test/server-errors.test.ts` runs, to read what the run prints. The first two fail on purpose.
import { expect, it } from "vitest";
import { startInstalledCronk } from "../../harness.js";

it("fails on an answer of 500", async () => {
  const { cronk, admin } = await startInstalledCronk();
  await cronk.failCommitsWriting("projects", async () => {
    expect((await admin.post("/api/projects", { name: "Docs", key: "DOCS" })).status).toBe(201);
  });
});

it("fails on an answer of 400", async () => {
  const { admin } = await startInstalledCronk();
  expect((await admin.post("/api/projects", { name: "Docs" })).status).toBe(201);
});

it("passes on an answer of 500 it provokes", async () => {
  const { cronk, admin } = await startInstalledCronk();
  await cronk.failCommitsWriting("projects", async () => {
    expect((await admin.post("/api/projects", { name: "Docs", key: "DOCS" })).status).toBe(500);
  });
});
