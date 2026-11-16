import { describe, expect, it } from "vitest";
import { agentOf, bucketKeys, delegatedSetup, disposableBucket, joinAs, s3Server, startInstalledCronk, untarGz } from "./harness.js";

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

describe("Serving an Attachment", () => {
  it("shows images, video and audio in the page, but has the browser save anything that could run as a page", async () => {
    const { admin } = await setup();
    const fileOf = async (name: string, type: string) => {
      const id = (await admin.upload(`/api/tickets/CRONK-1/attachments?name=${encodeURIComponent(name)}`, Buffer.from("x"), type)).body.attachment.id;
      return admin.download(`/api/attachments/${id}/file`);
    };

    const image = await fileOf("proxy ip.png", "image/png");
    expect(image.headers["content-disposition"]).toBe(`inline; filename="proxy ip.png"; filename*=UTF-8''proxy%20ip.png`);
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(image.headers["content-security-policy"]).toMatch(/sandbox/);

    for (const [name, type] of [["page.html", "text/html"], ["logo.svg", "image/svg+xml"], ["tool.js", "text/javascript"]]) {
      const res = await fileOf(name!, type!);
      expect(res.headers["content-disposition"], name).toMatch(/^attachment;/);
      expect(res.headers["x-content-type-options"], name).toBe("nosniff");
      expect(res.headers["content-security-policy"], name).toMatch(/sandbox/);
    }
    expect((await fileOf("lockout-repro.mp4", "video/mp4")).headers["content-disposition"]).toMatch(/^inline;/);
    expect((await fileOf("näive.log", "text/plain")).headers["content-disposition"]).toBe(`inline; filename="n_ive.log"; filename*=UTF-8''n%C3%A4ive.log`);
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
    expect(outside.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(outside.body.toString()).error).toMatch(/10 bytes/);

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
    expect((await admin.get("/api/workspace/storage")).body).toEqual({ attachments: { files: 0, bytes: 0 }, artifacts: { files: 0, bytes: 0 } });

    await admin.upload("/api/tickets/CRONK-1/attachments?name=a.txt", Buffer.from("12345"), "text/plain");
    const b = (await admin.upload("/api/tickets/CRONK-1/attachments?name=b.txt", Buffer.from("123"), "text/plain")).body.attachment.id;
    expect((await admin.get("/api/workspace/storage")).body).toEqual({ attachments: { files: 2, bytes: 8 }, artifacts: { files: 0, bytes: 0 } });

    await admin.delete(`/api/attachments/${b}`);
    expect((await admin.get("/api/workspace/storage")).body).toEqual({ attachments: { files: 1, bytes: 5 }, artifacts: { files: 0, bytes: 0 } });

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

describe("Attachments on a Document", () => {
  it("are uploaded, listed and downloaded like a Ticket's, on Project and Workspace Documents", async () => {
    const { admin } = await setup();
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Architecture" })).body.document;

    const res = await admin.upload(`/api/documents/${doc.id}/attachments?name=diagram.png`, png, "image/png");
    expect(res.status).toBe(201);
    expect(res.body.attachment).toMatchObject({
      name: "diagram.png",
      contentType: "image/png",
      size: png.length,
      on: "document",
      documentId: doc.id,
      ticketKey: null,
      commentId: null,
      actor: { kind: "user", name: "Ada" },
    });
    expect((await admin.get(`/api/documents/${doc.id}/attachments`)).body.attachments).toEqual([res.body.attachment]);
    expect((await admin.download(`/api/attachments/${res.body.attachment.id}/file`)).body.equals(png)).toBe(true);

    const handbook = (await admin.post("/api/workspace/documents", { title: "Handbook" })).body.document;
    expect((await admin.upload(`/api/documents/${handbook.id}/attachments?name=logo.png`, png, "image/png")).status).toBe(201);
    expect((await admin.get(`/api/documents/${handbook.id}/attachments`)).body.attachments.map((a: { name: string }) => a.name)).toEqual(["logo.png"]);
  });
});

describe("Access to a Document's Attachments", () => {
  it("follows the Document: unseen in a private Project, read with Read access, attached to only with Write", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    const doc = (await admin.post("/api/projects/SECRET/documents", { title: "Plans" })).body.document;
    const id = (await admin.upload(`/api/documents/${doc.id}/attachments?name=plan.txt`, Buffer.from("secret"), "text/plain")).body.attachment.id;
    const bob = await joinAs(cronk, admin, "bob@example.com");

    expect((await bob.get(`/api/documents/${doc.id}/attachments`)).status).toBe(404);
    expect((await bob.download(`/api/attachments/${id}/file`)).status).toBe(404);
    expect((await bob.upload(`/api/documents/${doc.id}/attachments?name=mine.txt`, Buffer.from("mine"), "text/plain")).status).toBe(404);

    await admin.put(`/api/projects/SECRET/members/${(await bob.get("/api/me")).body.user.id}`, { access: "read" });
    expect((await bob.download(`/api/attachments/${id}/file`)).body.toString()).toBe("secret");
    expect((await bob.upload(`/api/documents/${doc.id}/attachments?name=mine.txt`, Buffer.from("mine"), "text/plain")).status).toBe(403);
    expect((await bob.delete(`/api/attachments/${id}`)).status).toBe(403);
    expect((await admin.get(`/api/documents/${doc.id}/attachments`)).body.attachments).toHaveLength(1);
  });

  it("keeps Agents from attaching to or deleting from a Protected Document", async () => {
    const { cronk, admin } = await setup();
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Architecture" })).body.document;
    const id = (await admin.upload(`/api/documents/${doc.id}/attachments?name=diagram.png`, png, "image/png")).body.attachment.id;
    await admin.post(`/api/documents/${doc.id}/protection`, { protected: true });
    const agent = await agentOf(cronk, admin, "claude-laptop");

    const refused = await agent.upload(`/api/documents/${doc.id}/attachments?name=mine.png`, png, "image/png");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Protected/);
    expect((await agent.delete(`/api/attachments/${id}`)).status).toBe(403);
    expect((await admin.upload(`/api/documents/${doc.id}/attachments?name=ada.png`, png, "image/png")).status).toBe(201);
  });

  it("lets an Agent attach to a Report only while holding its Ticket's Claim", async () => {
    const { admin, session } = await delegatedSetup(1);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "It was the proxy." })).body.report;

    const attached = await agent.upload(`/api/documents/${report.id}/attachments?name=proxy-ip.png`, png, "image/png");
    expect(attached.status).toBe(201);
    expect(attached.body.attachment).toMatchObject({ on: "document", documentId: report.id, ticketKey: "CRONK-1", actor: { kind: "agent", session: { id: agent.sessionId } } });

    await agent.delete("/api/tickets/CRONK-1/claim");
    const unclaimed = await agent.upload(`/api/documents/${report.id}/attachments?name=log.txt`, Buffer.from("log"), "text/plain");
    expect(unclaimed.status).toBe(409);
    expect(unclaimed.body.error).toMatch(/Claim CRONK-1/);
    expect((await admin.upload(`/api/documents/${report.id}/attachments?name=ada.txt`, Buffer.from("ok"), "text/plain")).status).toBe(201);
  });
});

describe("A Document's Attachments across its Versions", () => {
  it("stay with the Document, so an old Version that shows one still can after later saves and restores", async () => {
    const { admin } = await setup();
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Architecture" })).body.document;
    const id = (await admin.upload(`/api/documents/${doc.id}/attachments?name=diagram.png`, png, "image/png")).body.attachment.id;
    await admin.patch(`/api/documents/${doc.id}`, { baseVersion: 1, body: `![diagram](/api/attachments/${id}/file)` });
    await admin.patch(`/api/documents/${doc.id}`, { baseVersion: 2, body: "The diagram is gone from this Version." });
    await admin.post(`/api/documents/${doc.id}/versions/1/restore`, { baseVersion: 3 });

    expect((await admin.get(`/api/documents/${doc.id}/versions/2`)).body.version.body).toContain(`/api/attachments/${id}/file`);
    expect((await admin.get(`/api/documents/${doc.id}/attachments`)).body.attachments.map((a: { id: string }) => a.id)).toEqual([id]);
    expect((await admin.download(`/api/attachments/${id}/file`)).body.equals(png)).toBe(true);
  });
});

describe("Attachments on a Comment", () => {
  it("are attached by whoever posted it, and listed with the Ticket's or Document's Attachments", async () => {
    const { cronk, admin } = await setup();
    const comment = (await admin.post("/api/tickets/CRONK-1/comments", { body: "This is what I see." })).body.comment;

    const res = await admin.upload(`/api/comments/${comment.id}/attachments?name=browser.png`, png, "image/png");
    expect(res.status).toBe(201);
    expect(res.body.attachment).toMatchObject({ on: "comment", commentId: comment.id, ticketKey: "CRONK-1", documentId: null });
    expect((await admin.get("/api/tickets/CRONK-1/attachments")).body.attachments).toEqual([res.body.attachment]);

    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Architecture", body: "Proxy first." })).body.document;
    const onDoc = (await admin.post(`/api/documents/${doc.id}/comments`, { body: "Like this?" })).body.comment;
    const docFile = (await admin.upload(`/api/comments/${onDoc.id}/attachments?name=sketch.png`, png, "image/png")).body.attachment;
    expect(docFile).toMatchObject({ on: "comment", commentId: onDoc.id, documentId: doc.id, ticketKey: null });
    expect((await admin.get(`/api/documents/${doc.id}/attachments`)).body.attachments).toEqual([docFile]);

    const bob = await joinAs(cronk, admin, "bob@example.com");
    const notHis = await bob.upload(`/api/comments/${comment.id}/attachments?name=bob.png`, png, "image/png");
    expect(notHis.status).toBe(403);
    expect((await bob.download(`/api/attachments/${res.body.attachment.id}/file`)).status).toBe(200);
  });

  it("can be deleted by whoever posted the Comment, or by a User with Write, as a moderator", async () => {
    const { cronk, admin } = await setup();
    const agent = await agentOf(cronk, admin, "claude-laptop");
    const its = (await agent.post("/api/tickets/CRONK-1/comments", { body: "Token in this log." })).body.comment;
    const leaked = (await agent.upload(`/api/comments/${its.id}/attachments?name=env.log`, Buffer.from("TOKEN=1"), "text/plain")).body.attachment.id;
    const kept = (await agent.upload(`/api/comments/${its.id}/attachments?name=run.log`, Buffer.from("ok"), "text/plain")).body.attachment.id;
    const other = await agentOf(cronk, admin, "codex");

    expect((await other.delete(`/api/attachments/${kept}`)).status).toBe(403);
    expect((await admin.delete(`/api/attachments/${leaked}`)).status).toBe(204);
    expect((await agent.delete(`/api/attachments/${kept}`)).status).toBe(204);
    expect((await admin.get("/api/tickets/CRONK-1/attachments")).body.attachments).toEqual([]);
  });

  it("follow the Comment's Ticket for who can read them", async () => {
    const { cronk, admin } = await startInstalledCronk();
    await admin.post("/api/projects", { name: "Secret", key: "SECRET" });
    await admin.patch("/api/projects/SECRET", { visibility: "private" });
    await admin.post("/api/projects/SECRET/tickets", { title: "Ticket 1" });
    const comment = (await admin.post("/api/tickets/SECRET-1/comments", { body: "Logs." })).body.comment;
    const id = (await admin.upload(`/api/comments/${comment.id}/attachments?name=log.txt`, Buffer.from("secret"), "text/plain")).body.attachment.id;
    const bob = await joinAs(cronk, admin, "bob@example.com");

    expect((await bob.download(`/api/attachments/${id}/file`)).status).toBe(404);
    expect((await bob.upload(`/api/comments/${comment.id}/attachments?name=x.txt`, Buffer.from("x"), "text/plain")).status).toBe(404);
    expect((await admin.upload(`/api/comments/${crypto.randomUUID()}/attachments?name=x.txt`, Buffer.from("x"), "text/plain")).status).toBe(404);
  });

  it("lets an Agent attach to its own Comments, not its Owner's", async () => {
    const { cronk, admin } = await setup();
    const agent = await agentOf(cronk, admin, "claude-laptop");
    const its = (await agent.post("/api/tickets/CRONK-1/comments", { body: "Recording attached." })).body.comment;
    const ada = (await admin.post("/api/tickets/CRONK-1/comments", { body: "Mine." })).body.comment;

    const attached = await agent.upload(`/api/comments/${its.id}/attachments?name=repro.mp4`, Buffer.from("mp4"), "video/mp4");
    expect(attached.status).toBe(201);
    expect(attached.body.attachment.actor).toMatchObject({ kind: "agent", session: { id: agent.sessionId } });
    expect((await agent.upload(`/api/comments/${ada.id}/attachments?name=x.mp4`, Buffer.from("x"), "video/mp4")).status).toBe(403);
    expect((await admin.upload(`/api/comments/${its.id}/attachments?name=x.png`, png, "image/png")).status).toBe(403);
  });
});

describe("A Ticket's Files", () => {
  it("list every Attachment on the Ticket, in its Comments and in its Reports, in the order attached", async () => {
    const { admin, session } = await delegatedSetup(1);
    const agent = await session();
    await agent.post("/api/tickets/CRONK-1/claim");
    await admin.upload("/api/tickets/CRONK-1/attachments?name=ticket.png", png, "image/png");
    const comment = (await admin.post("/api/tickets/CRONK-1/comments", { body: "See." })).body.comment;
    await admin.upload(`/api/comments/${comment.id}/attachments?name=comment.png`, png, "image/png");
    const report = (await agent.post("/api/tickets/CRONK-1/reports", { title: "Findings", body: "Done." })).body.report;
    await agent.upload(`/api/documents/${report.id}/attachments?name=report.png`, png, "image/png");
    const onReport = (await admin.post(`/api/documents/${report.id}/comments`, { body: "Thanks." })).body.comment;
    await admin.upload(`/api/comments/${onReport.id}/attachments?name=report-comment.png`, png, "image/png");
    await admin.post("/api/projects/CRONK/tickets", { title: "Ticket 2" });
    await admin.upload("/api/tickets/CRONK-2/attachments?name=elsewhere.png", png, "image/png");

    const files = (await admin.get("/api/tickets/CRONK-1/attachments")).body.attachments;
    expect(files.map((a: { name: string; on: string }) => [a.name, a.on])).toEqual([
      ["ticket.png", "ticket"],
      ["comment.png", "comment"],
      ["report.png", "document"],
      ["report-comment.png", "comment"],
    ]);
  });
});

describe("Deleting a Document", () => {
  it("deletes its Attachments and those in its Comments, and frees their storage", async () => {
    const { admin } = await setup();
    const doc = (await admin.post("/api/projects/CRONK/documents", { title: "Scratch" })).body.document;
    const own = (await admin.upload(`/api/documents/${doc.id}/attachments?name=a.txt`, Buffer.from("12345"), "text/plain")).body.attachment.id;
    const comment = (await admin.post(`/api/documents/${doc.id}/comments`, { body: "Note." })).body.comment;
    const inComment = (await admin.upload(`/api/comments/${comment.id}/attachments?name=b.txt`, Buffer.from("123"), "text/plain")).body.attachment.id;
    await admin.upload("/api/tickets/CRONK-1/attachments?name=kept.txt", Buffer.from("12"), "text/plain");

    expect((await admin.delete(`/api/documents/${doc.id}?baseVersion=1`)).status).toBe(204);
    expect((await admin.download(`/api/attachments/${own}/file`)).status).toBe(404);
    expect((await admin.download(`/api/attachments/${inComment}/file`)).status).toBe(404);
    expect((await admin.get("/api/workspace/storage")).body.attachments).toEqual({ files: 1, bytes: 2 });
  });
});

describe.skipIf(!s3Server())("Attachments in S3-compatible storage", () => {
  it("are kept in the configured bucket and behave as on local disk: downloads, ranges, exports, imports and deletes", async () => {
    const storage = await disposableBucket();
    const { admin } = await startInstalledCronk("Acme", { storage });
    await admin.post("/api/projects", { name: "Cronk", key: "CRONK" });
    await admin.post("/api/projects/CRONK/tickets", { title: "Ticket 1" });

    const id = (await admin.upload("/api/tickets/CRONK-1/attachments?name=repro.mp4", Buffer.from("0123456789"), "video/mp4")).body.attachment.id;
    expect(await bucketKeys(storage)).toHaveLength(1);

    expect((await admin.download(`/api/attachments/${id}/file`)).body.toString()).toBe("0123456789");
    const middle = await admin.download(`/api/attachments/${id}/file`, { range: "bytes=2-5" });
    expect(middle.status).toBe(206);
    expect(middle.headers["content-range"]).toBe("bytes 2-5/10");
    expect(middle.body.toString()).toBe("2345");
    const exported = (await admin.download("/api/projects/CRONK/export")).body;
    expect((await untarGz(exported))["projects/CRONK/tickets/CRONK-1.attachments/1-repro.mp4"]).toBe("0123456789");

    const elsewhereStorage = await disposableBucket();
    const elsewhere = await startInstalledCronk("Elsewhere", { storage: elsewhereStorage });
    expect((await elsewhere.admin.upload("/api/import", exported)).status).toBe(201);
    const [imported] = (await elsewhere.admin.get("/api/tickets/CRONK-1/attachments")).body.attachments;
    expect((await elsewhere.admin.download(`/api/attachments/${imported.id}/file`)).body.toString()).toBe("0123456789");
    expect(await bucketKeys(elsewhereStorage)).toHaveLength(1);

    expect((await admin.delete(`/api/attachments/${id}`)).status).toBe(204);
    expect(await bucketKeys(storage)).toEqual([]);
  });
});
