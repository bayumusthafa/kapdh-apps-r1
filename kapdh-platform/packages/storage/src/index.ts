/**
 * @kapdh/storage — StorageDriver berkas KAPDH (PRD 5.4, ARCHITECTURE §4.2): disk lokal, S3-compatible, dan memori untuk
 * uji. API memilih driver dari env STORAGE_DRIVER lewat {@link createStorageDriver}.
 */
import { StorageConfigError, type StorageDriver } from "./driver.js";
import { LocalDriver } from "./local-driver.js";
import { S3Driver } from "./s3-driver.js";

export * from "./driver.js";
export { LocalDriver } from "./local-driver.js";
export { MemoryDriver } from "./memory-driver.js";
export { S3Driver, type S3DriverConfig } from "./s3-driver.js";

/** Bagian env (packages/config BaseEnv) yang dibutuhkan untuk memilih driver. */
export interface StorageEnv {
  STORAGE_DRIVER: "local" | "s3";
  STORAGE_LOCAL_ROOT: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE: boolean;
}

/** Driver sesuai STORAGE_DRIVER. Validasi kelengkapan S3 sudah dilakukan packages/config; dicek ulang di sini. */
export function createStorageDriver(env: StorageEnv): StorageDriver {
  if (env.STORAGE_DRIVER === "local") return new LocalDriver(env.STORAGE_LOCAL_ROOT);
  if (!env.S3_BUCKET || !env.S3_REGION || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)
    throw new StorageConfigError("STORAGE_DRIVER=s3 membutuhkan S3_BUCKET, S3_REGION dan kredensial");
  return new S3Driver({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
}
