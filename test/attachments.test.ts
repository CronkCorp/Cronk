import { describe, expect, it } from "vitest";
import { startInstalledCronk } from "./harness.js";

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
