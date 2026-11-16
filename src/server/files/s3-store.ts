import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FileTooLarge, KEY, type ByteRange, type FileStore } from "./store.js";

/** Where an S3-compatible store (AWS S3, MinIO, Cloudflare R2, …) keeps Cronk's files, and how to reach it. */
export interface S3StorageConfig {
  kind: "s3";
  bucket: string;
  /** The service's address, such as `http://minio:9000`; AWS S3 itself when left out. */
  endpoint?: string | undefined;
  region: string;
  /** Without keys, the AWS SDK finds credentials as usual: `AWS_*` variables, a profile or an instance role. */
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  /** Address buckets as `endpoint/bucket` rather than `bucket.endpoint`; MinIO and most self-hosted stores need it. */
  forcePathStyle: boolean;
}

/** A `FileStore` in a bucket of an S3-compatible store. An object appears only once wholly uploaded, so a reader never sees half of one. */
export class S3Store implements FileStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      // Checksums only where S3 requires them: several S3-compatible stores refuse the SDK's default ones.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials:
        config.accessKeyId && config.secretAccessKey ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } : undefined,
    });
  }

  private key(key: string): string {
    if (!KEY.test(key)) throw new Error(`Not a file key: ${key}`);
    return key;
  }

  async put(key: string, bytes: Readable | Buffer, opts: { maxBytes?: number } = {}): Promise<number> {
    const Key = this.key(key);
    let size = 0;
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (opts.maxBytes !== undefined && size > opts.maxBytes) done(new FileTooLarge(opts.maxBytes));
        else done(null, chunk);
      },
    });
    const source = Buffer.isBuffer(bytes) ? Readable.from([bytes]) : bytes;
    // Kept so the error of whichever side failed first is the one thrown, `FileTooLarge` included.
    let readError: unknown;
    const reading = pipeline(source, counting).catch((err: unknown) => {
      readError = err;
    });
    // A file is uploaded in parts of 5 MB, so one of any size is never held in memory whole; a failed one leaves no parts.
    const upload = new Upload({ client: this.s3, params: { Bucket: this.bucket, Key, Body: counting } });
    try {
      await upload.done();
    } catch (err) {
      counting.destroy();
      await reading;
      throw readError ?? err;
    }
    await reading;
    if (readError) throw readError;
    return size;
  }

  get(key: string, range?: ByteRange): Readable {
    const Key = this.key(key);
    const out = new PassThrough();
    // A reader that stops early, such as a player seeking elsewhere, ends the request to the store too.
    const abort = new AbortController();
    out.once("close", () => abort.abort());
    this.s3
      .send(new GetObjectCommand({ Bucket: this.bucket, Key, Range: range && `bytes=${range.start}-${range.end}` }), { abortSignal: abort.signal })
      .then(({ Body }) => pipeline(Body as Readable, out))
      .catch((err: unknown) => out.destroy(err as Error));
    return out;
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let ContinuationToken: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${this.key(prefix)}/`, ContinuationToken }));
      for (const { Key } of page.Contents ?? []) if (Key) keys.push(Key);
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return keys.sort();
  }

  async delete(key: string): Promise<void> {
    // S3 answers a delete of a missing object as done.
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
  }
}
