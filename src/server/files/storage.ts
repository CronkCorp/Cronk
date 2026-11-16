import { S3Store, type S3StorageConfig } from "./s3-store.js";
import { LocalDiskStore, type FileStore } from "./store.js";

/** Files on local disk, under the directory `dir`. */
export interface DiskStorageConfig {
  kind: "disk";
  dir: string;
}

/** Where Cronk keeps the bytes of its files: local disk by default, or an S3-compatible store. */
export type StorageConfig = DiskStorageConfig | S3StorageConfig;

/** The `FileStore` that `config` describes. */
export function createFileStore(config: StorageConfig): FileStore {
  return config.kind === "s3" ? new S3Store(config) : new LocalDiskStore(config.dir);
}
