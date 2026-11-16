import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { S3Store } from "../src/server/files/s3-store.js";
import { FileTooLarge, LocalDiskStore, type FileStore } from "../src/server/files/store.js";
import { disposableBucket, s3Server } from "./harness.js";

/**
 * The storage contract every Files backend keeps, the one lower-level seam (see docs/testing.md),
 * so local disk and S3-compatible storage behave the same behind Attachments, ranges and exports.
 */
function storageContract(name: string, open: () => Promise<FileStore>, skip = false) {
  describe.skipIf(skip)(`${name} storage`, () => {
    it("gives back the bytes a file was stored with, and says how many it stored", async () => {
      const store = await open();

      expect(await store.put("attachments/a1", Buffer.from("hello, world"))).toBe(12);

      expect((await read(store.get("attachments/a1"))).toString()).toBe("hello, world");
    });

    it("gives back only the bytes of a range, both ends included", async () => {
      const store = await open();
      await store.put("attachments/a1", Buffer.from("hello, world"));

      expect((await read(store.get("attachments/a1", { start: 7, end: 11 }))).toString()).toBe("world");
      expect((await read(store.get("attachments/a1", { start: 0, end: 0 }))).toString()).toBe("h");
    });

    it("stores a file streamed to it, replacing the one stored before under the same key", async () => {
      const store = await open();
      await store.put("attachments/a1", Buffer.from("old"));

      const size = await store.put("attachments/a1", Readable.from([Buffer.from("new "), Buffer.from("bytes")]));

      expect(size).toBe(9);
      expect((await read(store.get("attachments/a1"))).toString()).toBe("new bytes");
    });

    it("refuses a file growing past the most it was told to take, storing nothing and keeping the file stored before", async () => {
      const store = await open();
      await store.put("attachments/a1", Buffer.from("kept"));

      const tooLarge = Readable.from([Buffer.alloc(6), Buffer.alloc(6)]);
      await expect(store.put("attachments/a1", tooLarge, { maxBytes: 10 })).rejects.toThrow(FileTooLarge);
      await expect(store.put("attachments/a2", Buffer.alloc(11), { maxBytes: 10 })).rejects.toThrow(FileTooLarge);

      expect((await read(store.get("attachments/a1"))).toString()).toBe("kept");
      await expect(read(store.get("attachments/a2"))).rejects.toThrow();
      expect(await store.put("attachments/a3", Buffer.alloc(10), { maxBytes: 10 })).toBe(10);
    });

    it("stores a file of many megabytes streamed in, and refuses one many megabytes past the limit, storing nothing", async () => {
      const store = await open();
      const MB = 1024 * 1024;
      const megabytes = (n: number) => Readable.from(Array.from({ length: n }, (_, i) => Buffer.alloc(MB, i)));

      expect(await store.put("attachments/large", megabytes(12), { maxBytes: 12 * MB })).toBe(12 * MB);
      const stored = await read(store.get("attachments/large", { start: 11 * MB - 1, end: 11 * MB }));
      expect([...stored]).toEqual([10, 11]);

      await expect(store.put("attachments/larger", megabytes(13), { maxBytes: 12 * MB })).rejects.toThrow(FileTooLarge);
      expect(await store.list("attachments")).toEqual(["attachments/large"]);
    });

    it("moves a file to another key, replacing the file there, and fails moving a key with no file", async () => {
      const store = await open();
      await store.put("imports/x/1", Buffer.from("moved"));
      await store.put("attachments/a2", Buffer.from("replaced"));

      await store.move("imports/x/1", "attachments/a1");
      await store.move("attachments/a1", "attachments/a2");

      expect((await read(store.get("attachments/a2"))).toString()).toBe("moved");
      expect(await store.list("imports")).toEqual([]);
      expect(await store.list("attachments")).toEqual(["attachments/a2"]);
      await expect(store.move("imports/x/missing", "attachments/a3")).rejects.toThrow();
      expect(await store.list("attachments")).toEqual(["attachments/a2"]);
    });

    it("removes a file, and does nothing removing one that isn't there", async () => {
      const store = await open();
      await store.put("attachments/a1", Buffer.from("gone"));
      await store.put("attachments/a2", Buffer.from("stays"));

      await store.delete("attachments/a1");
      await store.delete("attachments/never");

      await expect(read(store.get("attachments/a1"))).rejects.toThrow();
      expect((await read(store.get("attachments/a2"))).toString()).toBe("stays");
    });

    it("lists the keys of the files under a folder, deepest included, in order", async () => {
      const store = await open();
      expect(await store.list("artifacts")).toEqual([]);
      for (const key of ["attachments/b", "attachments/a", "artifacts/v1/index.html", "artifacts/v1/css/site.css", "attachmentsish/c"]) {
        await store.put(key, Buffer.from(key));
      }
      await store.delete("attachments/b");

      expect(await store.list("attachments")).toEqual(["attachments/a"]);
      expect(await store.list("artifacts")).toEqual(["artifacts/v1/css/site.css", "artifacts/v1/index.html"]);
      expect(await store.list("artifacts/v1/css")).toEqual(["artifacts/v1/css/site.css"]);
    });

    it("fails reading a key with no file", async () => {
      const store = await open();

      await expect(read(store.get("attachments/missing"))).rejects.toThrow();
    });
  });
}

/** All the bytes `stream` gives, or its error. */
async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

storageContract("Local disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cronk-store-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return new LocalDiskStore(dir);
});

storageContract("S3-compatible", async () => new S3Store(await disposableBucket()), !s3Server());

describe.skipIf(!s3Server())("S3-compatible storage failing", () => {
  it("names the store's own error when an upload fails partway, not the stream it stopped reading", async () => {
    const store = new S3Store({ ...(await disposableBucket()), bucket: "cronk-no-such-bucket" });
    const MB = 1024 * 1024;

    const upload = store.put("attachments/a1", Readable.from(Array.from({ length: 12 }, () => Buffer.alloc(MB))));

    await expect(upload).rejects.toThrow(/bucket/i);
  });
});
