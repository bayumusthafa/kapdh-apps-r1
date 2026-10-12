import { createHash } from "node:crypto";
import { Readable } from "node:stream";

/**
 * Kontrak penyimpanan berkas (PRD 5.4, ARCHITECTURE §4.2). Driver menyediakan put, read, stat, delete, copy, dan
 * akses bertanda tangan. Object key tidak pernah memuat nama/email pengguna; berkas privat hanya dilayani setelah
 * pemeriksaan izin oleh API (FilesService), dan TTL URL tidak menggantikan otorisasi.
 *
 * Driver: `memory` (uji), `local` dan `s3` (S3-compatible) dibangun pada tahap core-api 2 bersama FilesService.
 */

export type StorageDriverName = "local" | "s3" | "memory";

export interface StoredObjectInfo {
  key: string;
  bytes: number;
  contentType: string;
  /** SHA-256 hex isi berkas, dipakai saat migrasi storage untuk mencocokkan checksum (PRD 5.4). */
  sha256: string;
}

export interface PutObjectOptions {
  contentType: string;
}

export interface SignedReadOptions {
  /** Masa berlaku URL dalam detik; maksimal 600 (10 menit, PRD 5.4). */
  expiresInSeconds: number;
  disposition?: "inline" | "attachment";
  /** Nama unduhan yang aman (tanpa data pribadi), mis. `bukti-pembayaran.pdf`. */
  filename?: string;
}

/** Batas masa berlaku URL bertanda tangan (PRD 5.4). */
export const MAX_SIGNED_URL_SECONDS = 600;

export interface StorageDriver {
  readonly name: StorageDriverName;
  /** Menyimpan isi lengkap. Menimpa key yang sama secara atomik bagi pembaca. */
  put(key: string, body: Buffer | Uint8Array, options: PutObjectOptions): Promise<StoredObjectInfo>;
  /** Membaca isi sebagai stream. Melempar {@link StorageObjectNotFoundError} bila key tidak ada. */
  read(key: string): Promise<Readable>;
  /** Metadata objek, atau null bila tidak ada. */
  stat(key: string): Promise<StoredObjectInfo | null>;
  /** Menghapus objek; idempoten (tidak galat bila key sudah tidak ada). */
  delete(key: string): Promise<void>;
  /** Menyalin objek ke key baru (perpindahan storage, PRD 5.4). */
  copy(sourceKey: string, targetKey: string): Promise<StoredObjectInfo>;
  /**
   * URL baca bertanda tangan dari penyedia (S3 presigned), atau null bila driver tidak dapat menandatangani
   * (local/memory): API kemudian melayani berkas lewat rute bertoken miliknya sendiri.
   */
  signedReadUrl(key: string, options: SignedReadOptions): Promise<string | null>;
}

export class StorageObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super("Objek penyimpanan tidak ditemukan");
    this.name = "StorageObjectNotFoundError";
  }
}

/**
 * Object key aman: segmen [a-z0-9._-] dipisah `/`, tanpa `..`, tanpa garis miring di awal/akhir, maksimal 512
 * karakter. Mencegah path traversal pada driver local dan memastikan key tidak memuat data pribadi bebas.
 */
export function assertSafeObjectKey(key: string): void {
  if (
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

/** Driver memori untuk uji (tidak untuk production). */
export class MemoryStorage implements StorageDriver {
  readonly name = "memory" as const;
  private readonly objects = new Map<string, { body: Buffer; info: StoredObjectInfo }>();

  async put(key: string, body: Buffer | Uint8Array, options: PutObjectOptions): Promise<StoredObjectInfo> {
    assertSafeObjectKey(key);
    const copy = Buffer.from(body);
    const info: StoredObjectInfo = {
      key,
      bytes: copy.byteLength,
      contentType: options.contentType,
      sha256: sha256Hex(copy),
    };
    this.objects.set(key, { body: copy, info });
    return { ...info };
  }

  async read(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (!object) throw new StorageObjectNotFoundError(key);
    return Readable.from([Buffer.from(object.body)]);
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    const object = this.objects.get(key);
    return object ? { ...object.info } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async copy(sourceKey: string, targetKey: string): Promise<StoredObjectInfo> {
    const object = this.objects.get(sourceKey);
    if (!object) throw new StorageObjectNotFoundError(sourceKey);
    return this.put(targetKey, object.body, { contentType: object.info.contentType });
  }

  async signedReadUrl(): Promise<string | null> {
    return null;
  }

  /** Untuk uji: isi objek, atau undefined. */
  contents(key: string): Buffer | undefined {
    const object = this.objects.get(key);
    return object ? Buffer.from(object.body) : undefined;
  }

  /** Untuk uji: semua key yang tersimpan. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}
