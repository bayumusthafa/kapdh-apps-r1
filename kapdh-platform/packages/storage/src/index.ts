/**
 * @kapdh/storage — StorageDriver berkas KAPDH (PRD 5.4, ARCHITECTURE §4.2): disk lokal, S3-compatible, dan memori untuk
 * uji. API memilih driver dari env STORAGE_DRIVER lewat {@link createStorageDriver}.
 */
import { resolve } from "node:path";
import { StorageConfigError, type StorageDriver } from "./driver.js";
import { FallbackReadDriver } from "./fallback-driver.js";
import { LocalDriver } from "./local-driver.js";
import { S3Driver } from "./s3-driver.js";

export * from "./driver.js";
export { FallbackReadDriver } from "./fallback-driver.js";
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
  /**
   * Folder disk lama sebagai baca-cadangan selama perpindahan local -> S3 (PRD 5.4, docs/runbooks/storage-migration.md).
   * Hanya berlaku bersama STORAGE_DRIVER=s3; kosongkan setelah seluruh objek tersalin dan terverifikasi.
   */
  STORAGE_FALLBACK_LOCAL_ROOT?: string;
}

/**
 * Driver sesuai STORAGE_DRIVER (S3 dengan baca-cadangan disk lama bila STORAGE_FALLBACK_LOCAL_ROOT diisi). Validasi kelengkapan S3 sudah dilakukan packages/config; dicek ulang di sini.
 * STORAGE_LOCAL_ROOT relatif (mis. `./.data/files` di .env.example) diselesaikan dari folder kerja proses (`cwd`,
 * bawaan process.cwd()) di SATU tempat ini, sehingga API, worker dan CLI memakai folder yang sama; LocalDriver sendiri
 * tetap hanya menerima path absolut.
 */
export function createStorageDriver(env: StorageEnv, options: { cwd?: string } = {}): StorageDriver {
  if (env.STORAGE_DRIVER === "local") {
    const root = env.STORAGE_LOCAL_ROOT.trim();
    if (!root) throw new StorageConfigError("STORAGE_LOCAL_ROOT wajib diisi");
    return new LocalDriver(resolve(options.cwd ?? process.cwd(), root));
  }
  if (!env.S3_BUCKET || !env.S3_REGION || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)
    throw new StorageConfigError("STORAGE_DRIVER=s3 membutuhkan S3_BUCKET, S3_REGION dan kredensial");
  const s3 = new S3Driver({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
  const fallbackRoot = env.STORAGE_FALLBACK_LOCAL_ROOT?.trim();
  return fallbackRoot
    ? new FallbackReadDriver(s3, new LocalDriver(resolve(options.cwd ?? process.cwd(), fallbackRoot)))
    : s3;
}
