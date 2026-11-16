import { describe, expect, it } from "vitest";
import { delegatedSetup, joinAs, startInstalledCronk } from "./harness.js";

/** Ada, the Admin, with the Project CRONK holding CRONK-1. */
async function setup() {
  const { cronk, admin } = await startInstalledCronk();
  await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
  await admin.post("/api/projects/CRONK/tickets", { title: "Ticket 1" });
  return { cronk, admin };
}

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("Attachments on a Ticket", () => {
  it("are uploaded, listed with their name, type, size and who attached them, and downloaded as uploaded", async () => {
    const { admin } = await setup();

    const res = await admin.upload("/api/tickets/cronk-1/attachments?name=proxy-ip.png", png, "image/png");
    expect(res.status).toBe(201);
    expect(res.body.attachment).toMatchObject({
      name: "proxy-ip.png",
      contentType: "image/png",
      size: png.length,
      ticketKey: "CRONK-1",
      actor: { kind: "user", name: "Ada" },
    });

    const listed = await admin.get("/api/tickets/CRONK-1/attachments");
    expect(listed.status).toBe(200);
    expect(listed.body.attachments).toEqual([res.body.attachment]);

    const file = await admin.download(`/api/attachments/${res.body.attachment.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.body.equals(png)).toBe(true);
  });
});

describe("Downloading part of an Attachment", () => {
  const video = Buffer.from("0123456789");

  /** Ada with a 10-byte video attached to CRONK-1; answers its download address. */
  async function withVideo() {
    const { admin } = await setup();
    const id = (await admin.upload("/api/tickets/CRONK-1/attachments?name=repro.mp4", video, "video/mp4")).body.attachment.id;
    return { admin, file: `/api/attachments/${id}/file` };
  }

  it("answers the range asked for, so a player can seek", async () => {
    const { admin, file } = await withVideo();

    const whole = await admin.download(file);
    expect(whole.headers["accept-ranges"]).toBe("bytes");

    const middle = await admin.download(file, { range: "bytes=2-5" });
    expect(middle.status).toBe(206);
    expect(middle.headers["content-range"]).toBe("bytes 2-5/10");
    expect(middle.headers["content-type"]).toBe("video/mp4");
    expect(middle.body.toString()).toBe("2345");

    expect((await admin.download(file, { range: "bytes=7-" })).body.toString()).toBe("789");
    expect((await admin.download(file, { range: "bytes=-3" })).body.toString()).toBe("789");
    const pastEnd = await admin.download(file, { range: "bytes=8-100" });
    expect(pastEnd.headers["content-range"]).toBe("bytes 8-9/10");
    expect(pastEnd.body.toString()).toBe("89");
  });

  it("refuses a range outside the file, and sends the whole file for a range it doesn't read", async () => {
    const { admin, file } = await withVideo();

    const outside = await admin.download(file, { range: "bytes=10-12" });
    expect(outside.status).toBe(416);
    expect(outside.headers["content-range"]).toBe("bytes */10");

    const several = await admin.download(file, { range: "bytes=0-1,4-5" });
    expect(several.status).toBe(200);
    expect(several.body.toString()).toBe("0123456789");
  });
});

describe("The Attachment size limit", () => {
  const MB = 1024 * 1024;

  it("is 100 MB by default and set per Workspace by an Admin; a larger file is refused and nothing is kept", async () => {
    const { cronk, admin } = await setup();
    expect((await admin.get("/api/workspace")).body.attachmentMaxBytes).toBe(100 * MB);

    const changed = await admin.patch("/api/workspace", { attachmentMaxBytes: MB });
    expect(changed.status).toBe(200);
    expect(changed.body.attachmentMaxBytes).toBe(MB);
    const member = await joinAs(cronk, admin, "bob@example.com");
    expect((await member.patch("/api/workspace", { attachmentMaxBytes: 2 * MB })).status).toBe(403);

    const tooLarge = await admin.upload("/api/tickets/CRONK-1/attachments?name=big.bin", Buffer.alloc(MB + 1), "application/octet-stream");
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error).toMatch(/1 MB/);
    expect((await admin.get("/api/tickets/CRONK-1/attachments")).body.attachments).toEqual([]);
    expect((await admin.get("/api/workspace/storage")).body.attachments).toEqual({ files: 0, bytes: 0 });

    const fits = await admin.upload("/api/tickets/CRONK-1/attachments?name=fits.bin", Buffer.alloc(MB), "application/octet-stream");
    expect(fits.status).toBe(201);
  });
});

describe("Storage used", () => {
  it("shows Admins how many Attachments the Workspace holds and how much space their files take", async () => {
    const { cronk, admin } = await setup();
    expect((await admin.get("/api/workspace/storage")).body).toEqual({ attachments: { files: 0, bytes: 0 } });

    await admin.upload("/api/tickets/CRONK-1/attachments?name=a.txt", Buffer.from("12345"), "text/plain");
    const b = (await admin.upload("/api/tickets/CRONK-1/attachments?name=b.txt", Buffer.from("123"), "text/plain")).body.attachment.id;
    expect((await admin.get("/api/workspace/storage")).body).toEqual({ attachments: { files: 2, bytes: 8 } });

    await admin.delete(`/api/attachments/${b}`);
    expect((await admin.get("/api/workspace/storage")).body).toEqual({ attachments: { files: 1, bytes: 5 } });

    const member = await joinAs(cronk, admin, "bob@example.com");
    expect((await member.get("/api/workspace/storage")).status).toBe(403);
  });
});

describe("Deleting an Attachment", () => {
  it("removes it from the Ticket and its file from download", async () => {
    const { admin } = await setup();
    const id = (await admin.upload("/api/tickets/CRONK-1/attachments?name=proxy-ip.png", png, "image/png")).body.attachment.id;

    expect((await admin.delete(`/api/attachments/${id}`)).status).toBe(204);
    expect((await admin.get("/api/tickets/CRONK-1/attachments")).body.attachments).toEqual([]);
    expect((await admin.download(`/api/attachments/${id}/file`)).status).toBe(404);
    expect((await admin.delete(`/api/attachments/${id}`)).status).toBe(404);
  });

  it("needs Write on the Ticket, and an Agent its Claim", async () => {
    const { cronk, admin, session } = await delegatedSetup(1);
    const id = (await admin.upload("/api/tickets/CRONK-1/attachments?name=proxy-ip.png", png, "image/png")).body.attachment.id;
    await admin.patch("/api/projects/CRONK", { visibility: "private" });
    const bob = await joinAs(cronk, admin, "bob@example.com");
    await admin.put(`/api/projects/CRONK/members/${(await bob.get("/api/me")).body.user.id}`, { access: "read" });
    const agent = await session();

    expect((await bob.delete(`/api/attachments/${id}`)).status).toBe(403);
    expect((await agent.delete(`/api/attachments/${id}`)).status).toBe(409);
    await agent.post("/api/tickets/CRONK-1/claim");
    expect((await agent.delete(`/api/attachments/${id}`)).status).toBe(204);
  });
});

describe("Attachment access", () => {
  /** Ada with an Attachment on SECRET-1, in a private Project, and Bob, a Member not in it. */
  async function privateSetup() {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.post("/api/projects/SECRET/tickets", { title: "Ticket 1" });
    const id = (await admin.upload("/api/tickets/SECRET-1/attachments?name=notes.txt", Buffer.from("secret"), "text/plain")).body.attachment.id;
    const bob = await joinAs(cronk, admin, "bob@example.com");
    const bobId = (await bob.get("/api/me")).body.user.id;
    return { admin, bob, bobId, id };
  }

  it("follows the Ticket: whoever can't read it can't list, download or even find its Attachments", async () => {
    const { bob, id } = await privateSetup();

    expect((await bob.get("/api/tickets/SECRET-1/attachments")).status).toBe(404);
    const file = await bob.download(`/api/attachments/${id}/file`);
    expect(file.status).toBe(404);
    expect(file.body.toString()).not.toContain("secret\"");
  });

  it("lets Read access download but not attach", async () => {
    const { admin, bob, bobId, id } = await privateSetup();
    await admin.put(`/api/projects/SECRET/members/${bobId}`, { access: "read" });

    expect((await bob.download(`/api/attachments/${id}/file`)).body.toString()).toBe("secret");
    expect((await bob.get("/api/tickets/SECRET-1/attachments")).body.attachments).toHaveLength(1);
    const refused = await bob.upload("/api/tickets/SECRET-1/attachments?name=mine.txt", Buffer.from("mine"), "text/plain");
    expect(refused.status).toBe(403);
    expect((await admin.get("/api/tickets/SECRET-1/attachments")).body.attachments).toHaveLength(1);
  });

  it("lets an Agent attach only while holding the Ticket's Claim, and records its Agent Session", async () => {
    const { admin, claude, session } = await delegatedSetup(1);
    const agent = await session();

    const unclaimed = await agent.upload("/api/tickets/CRONK-1/attachments?name=log.txt", Buffer.from("log"), "text/plain");
    expect(unclaimed.status).toBe(409);
    expect(unclaimed.body.error).toMatch(/Claim CRONK-1/);

    await agent.post("/api/tickets/CRONK-1/claim");
    const attached = await agent.upload("/api/tickets/CRONK-1/attachments?name=log.txt", Buffer.from("log"), "text/plain");
    expect(attached.status).toBe(201);
    expect(attached.body.attachment.actor).toMatchObject({ kind: "agent", id: claude.agentId, owner: { name: "Ada" }, session: { id: agent.sessionId } });
    expect((await admin.get("/api/tickets/CRONK-1/attachments")).body.attachments.map((a: { name: string }) => a.name)).toEqual(["log.txt"]);
  });
});
