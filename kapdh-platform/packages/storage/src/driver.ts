import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";

/**
 * Kontrak penyimpanan berkas (PRD 5.4, ARCHITECTURE §4.2). Driver menyediakan put, get (stream), stat, delete, copy
 * dan exists. Object key tidak pernah memuat nama/email pengguna (bentuk `<purpose>/<yyyy>/<mm>/<uuidv7>`, dibentuk
 * FilesService); berkas privat hanya dilayani API setelah pemeriksaan izin, tidak pernah dari folder publik.
 *
 * Driver: {@link MemoryDriver} (uji), {@link LocalDriver} (disk lokal VPS) dan {@link S3Driver} (S3-compatible).
 * Perpindahan storage (PRD 5.4) memakai `copy` lintas driver lewat {@link transferObject} dan mencocokkan sha256.
 */

export type StorageDriverName = "local" | "s3" | "memory";

/** Metadata yang disimpan bersama objek. */
export interface PutObjectMeta {
  /** Tipe MIME hasil deteksi server (magic bytes), bukan dari klien. */
  contentType: string;
}

/** Hasil `put`/`copy`. */
export interface StoredObjectInfo {
  key: string;
  bytes: number;
  contentType: string;
  /** SHA-256 hex isi yang tertulis; dipakai mencocokkan checksum saat migrasi storage (PRD 5.4). */
  sha256: string;
}

/** Hasil `stat`. contentType null bila driver tidak menyimpan metadata (local). */
export interface ObjectStat {
  key: string;
  bytes: number;
  contentType: string | null;
  modifiedAt: Date | null;
}

/** Isi objek untuk `put`: buffer lengkap atau stream (mis. ekspor CSV yang dibangkitkan bertahap). */
export type ObjectBody = Buffer | Uint8Array | Readable;

export interface StorageDriver {
  readonly name: StorageDriverName;
  /**
   * Menyimpan isi lengkap pada key. Pembaca tidak pernah melihat objek setengah tertulis (local: tulis berkas sementara
   * lalu rename atomik; S3: PutObject/multipart selesai baru terlihat). Menimpa key yang sama.
   */
  put(key: string, body: ObjectBody, meta: PutObjectMeta): Promise<StoredObjectInfo>;
  /** Membaca isi sebagai stream. Melempar {@link StorageObjectNotFoundError} bila key tidak ada. */
  get(key: string): Promise<Readable>;
  /** Metadata objek, atau null bila tidak ada. */
  stat(key: string): Promise<ObjectStat | null>;
  /** Menghapus objek; idempoten (tidak galat bila key sudah tidak ada). */
  delete(key: string): Promise<void>;
  /** Menyalin objek ke key baru pada driver yang sama. */
  copy(sourceKey: string, targetKey: string): Promise<StoredObjectInfo>;
  /** true bila objek ada. */
  exists(key: string): Promise<boolean>;
}

export class StorageObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super("Objek penyimpanan tidak ditemukan");
    this.name = "StorageObjectNotFoundError";
  }
}

/** Galat konfigurasi/driver yang aman dicetak (tanpa secret, tanpa isi berkas). */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

/**
 * Object key aman: segmen [a-z0-9._-] dipisah `/`, tanpa `..`, tanpa garis miring di awal/akhir, maksimal 512
 * karakter. Mencegah path traversal pada driver local dan memastikan key tidak memuat data pribadi bebas.
 */
export function assertSafeObjectKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 512 ||
    !/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(key) ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new Error("Object key penyimpanan tidak valid");
}

export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Stream lewat-tembus yang menghitung sha256 dan jumlah byte saat isi ditulis ke driver, tanpa menampung seluruh isi
 * di memori. Nilai {@link HashingStream.sha256} terisi setelah stream selesai.
 */
export class HashingStream extends Transform {
  private readonly hash = createHash("sha256");
  bytes = 0;
  private digest: string | null = null;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.byteLength;
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.digest = this.hash.digest("hex");
    callback();
  }

  get sha256(): string {
    if (this.digest === null) throw new Error("HashingStream belum selesai");
    return this.digest;
  }
}

/** Mengubah body put menjadi Readable (buffer dibungkus satu potongan). */
export function toReadable(body: ObjectBody): Readable {
  if (body instanceof Readable) return body;
  return Readable.from([Buffer.from(body.buffer, body.byteOffset, body.byteLength)]);
}

/** Membaca stream sampai habis (uji dan berkas kecil). */
export async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/** SHA-256 isi objek yang tersimpan (verifikasi checksum migrasi storage, PRD 5.4). */
export async function hashObject(driver: StorageDriver, key: string): Promise<{ sha256: string; bytes: number }> {
  const hasher = createHash("sha256");
  let bytes = 0;
  for await (const chunk of await driver.get(key)) {
    const buffer = chunk as Buffer;
    hasher.update(buffer);
    bytes += buffer.byteLength;
  }
  return { sha256: hasher.digest("hex"), bytes };
}

/**
 * Menyalin satu objek antardriver (perpindahan local → S3, PRD 5.4) dan mencocokkan checksum. Melempar bila sha256
 * tujuan berbeda dari `expectedSha256` (nilai `files.sha256`), sehingga lokasi berkas hanya diperbarui setelah
 * salinan terverifikasi; salinan lama dihapus pemanggil setelah verifikasi dan backup.
 */
export async function transferObject(
  source: StorageDriver,
  target: StorageDriver,
  key: string,
  meta: PutObjectMeta & { expectedSha256: string },
): Promise<StoredObjectInfo> {
  const stored = await target.put(key, await source.get(key), { contentType: meta.contentType });
  if (stored.sha256 !== meta.expectedSha256) {
    await target.delete(key);
    throw new Error("Checksum salinan berkas tidak cocok; salinan dibatalkan");
  }
  return stored;
}
