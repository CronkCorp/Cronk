import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

const DATABASE_URL = "postgres://cronk:secret@localhost:5432/cronk";

describe("Configuring where files are stored", () => {
  it("keeps them on local disk by default, under FILES_DIR", () => {
    expect(loadConfig({ DATABASE_URL }).storage).toEqual({ kind: "disk", dir: resolve("data/files") });
    expect(loadConfig({ DATABASE_URL, FILES_STORAGE: "disk", FILES_DIR: "/srv/cronk/files" }).storage).toEqual({ kind: "disk", dir: "/srv/cronk/files" });
  });

  it("selects an S3-compatible store, addressing a self-hosted one by path", () => {
    const env = {
      DATABASE_URL,
      FILES_STORAGE: "s3",
      S3_BUCKET: "cronk-files",
      S3_ENDPOINT: "http://minio:9000",
      S3_ACCESS_KEY_ID: "cronk",
      S3_SECRET_ACCESS_KEY: "secret",
    };
    expect(loadConfig(env).storage).toEqual({
      kind: "s3",
      bucket: "cronk-files",
      endpoint: "http://minio:9000",
      region: "us-east-1",
      accessKeyId: "cronk",
      secretAccessKey: "secret",
      forcePathStyle: true,
    });
    expect(loadConfig({ ...env, S3_REGION: "auto", S3_FORCE_PATH_STYLE: "false" }).storage).toMatchObject({ region: "auto", forcePathStyle: false });
  });

  it("reaches AWS S3 itself without an endpoint, with credentials found the AWS way when no keys are given", () => {
    expect(loadConfig({ DATABASE_URL, FILES_STORAGE: "s3", S3_BUCKET: "cronk-files", S3_REGION: "eu-west-1" }).storage).toEqual({
      kind: "s3",
      bucket: "cronk-files",
      endpoint: undefined,
      region: "eu-west-1",
      accessKeyId: undefined,
      secretAccessKey: undefined,
      forcePathStyle: false,
    });
  });

  it("refuses an unknown kind of storage, S3 without a bucket, and only one of the two keys", () => {
    expect(() => loadConfig({ DATABASE_URL, FILES_STORAGE: "ftp" })).toThrow(/FILES_STORAGE must be "disk" or "s3"/);
    expect(() => loadConfig({ DATABASE_URL, FILES_STORAGE: "s3" })).toThrow(/S3_BUCKET is required/);
    expect(() => loadConfig({ DATABASE_URL, FILES_STORAGE: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "cronk" })).toThrow(/S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
    expect(() => loadConfig({ DATABASE_URL, FILES_STORAGE: "s3", S3_BUCKET: "b", S3_FORCE_PATH_STYLE: "yes" })).toThrow(/S3_FORCE_PATH_STYLE must be "true" or "false"/);
  });
});
