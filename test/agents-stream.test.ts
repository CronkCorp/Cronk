import { describe, expect, it } from "vitest";
import { joinAs, projectWithTickets, registerAgent, startInstalledCronk, startSession, type EventStream } from "./harness.js";

/** Long enough for the lapse watcher, which looks every 50ms in tests, to look several times. */
const SEVERAL_LOOKS_MS = 400;

/** Fails unless the stream stays quiet for several looks. */
const expectQuiet = (stream: EventStream) => expect(stream.next(SEVERAL_LOOKS_MS)).rejects.toThrow("No server-sent event came in time");

async function opened(stream: Promise<EventStream>): Promise<EventStream> {
  const s = await stream;
  expect(s.status).toBe(200);
  expect((await s.next())?.event).toBe("ready");
  return s;
}

describe("The Agents stream", () => {
  it("tells the Owner, and nobody else, when one of their Agent Sessions connects", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const claude = await registerAgent(bob, "claude-laptop");
    const bobs = await opened(bob.events("/api/agents/events"));
    const adas = await opened(admin.events("/api/agents/events"));

    await startSession(cronk, claude.secret);
    expect(await bobs.next()).toEqual({ event: "changed", data: {} });
    await expectQuiet(adas);
  });

  it("tells the Owner when an Agent Session Claims, releases, calls, ends or falls silent", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await projectWithTickets(admin, "CRONK", 1);
    const claude = await registerAgent(admin, "claude-laptop");
    const adaId = (await admin.get("/api/me")).body.user.id;
    await admin.patch("/api/tickets/CRONK-1", { assigneeId: adaId, delegateId: claude.agentId });
    const threshold = (await admin.get("/api/workspace")).body.silenceThresholdSeconds * 1000;
    const stream = await opened(admin.events("/api/agents/events"));
    const changed = { event: "changed", data: {} };

    const agent = await startSession(cronk, claude.secret);
    expect(await stream.next()).toEqual(changed);
    expect((await agent.post("/api/tickets/CRONK-1/claim")).status).toBe(200);
    expect(await stream.next()).toEqual(changed);
    expect((await agent.delete("/api/tickets/CRONK-1/claim")).status).toBe(204);
    expect(await stream.next()).toEqual(changed);
    cronk.clock.advance(60_000);
    await agent.get("/api/agent-sessions/current");
    expect(await stream.next()).toEqual(changed);
    await agent.delete("/api/agent-sessions/current");
    expect(await stream.next()).toEqual(changed);

    await startSession(cronk, claude.secret);
    expect(await stream.next()).toEqual(changed);
    await expectQuiet(stream);
    cronk.clock.advance(threshold + 1000);
    expect(await stream.next()).toEqual(changed);
    await expectQuiet(stream);
  });

  it("tells the Owner once per look, however many of their Agent Sessions changed", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const threshold = (await admin.get("/api/workspace")).body.silenceThresholdSeconds * 1000;
    for (const name of ["claude-laptop", "codex-ci"]) {
      const agent = await registerAgent(admin, name);
      await startSession(cronk, agent.secret);
      await startSession(cronk, agent.secret);
    }
    await new Promise((resolve) => setTimeout(resolve, SEVERAL_LOOKS_MS));
    const stream = await opened(admin.events("/api/agents/events"));

    cronk.clock.advance(threshold + 1000);
    expect(await stream.next()).toEqual({ event: "changed", data: {} });
    await expectQuiet(stream);
  });

  it("is refused to Agents", async () => {
    const { cronk, admin } = await startInstalledCronk();
    const claude = await registerAgent(admin, "claude-laptop");
    expect((await cronk.client(claude.secret).events("/api/agents/events")).status).toBe(403);
  });
});
