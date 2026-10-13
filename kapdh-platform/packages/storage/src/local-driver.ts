import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertSafeObjectKey,
  HashingStream,
  type ObjectBody,
  type ObjectStat,
  type PutObjectMeta,
  StorageConfigError,
  type StorageDriver,
  StorageObjectNotFoundError,
  type StoredObjectInfo,
  toReadable,
} from "./driver.js";

/**
 * Nama folder yang lazim dilayani web server/CDN secara langsung. Root storage tidak boleh berada di dalamnya agar
 * berkas privat (bukti bayar, ekspor audit) tidak pernah dapat diunduh tanpa pemeriksaan izin API (PRD 2.5, 5.4).
 */
const PUBLIC_SEGMENTS = new Set(["public", "static", "www", "wwwroot", "htdocs", "public_html"]);
/** Folder berkas sementara di dalam root (key tidak pernah diawali titik, jadi tidak bentrok). */
const TMP_DIR = ".tmp";

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function assertNotPublic(path: string): void {
  const segments = path.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  const hit = segments.find((segment) => PUBLIC_SEGMENTS.has(segment));
  if (hit)
    throw new StorageConfigError(
      `STORAGE_LOCAL_ROOT tidak boleh berada di folder publik (${hit}); berkas privat hanya dilayani lewat API`,
    );
}

/**
 * Driver disk lokal (volume `/data/files` di VPS, PRD 5.4). Semua path dikurung di bawah root: key divalidasi
 * {@link assertSafeObjectKey} dan hasil resolve diperiksa ulang tidak keluar root. Penulisan atomik: isi ditulis ke
 * `<root>/.tmp/<uuid>.part` (flush ke disk sebelum ditutup) lalu di-rename ke path akhir pada filesystem yang sama,
 * sehingga pembaca tidak pernah melihat berkas setengah tertulis. Berkas 0600, folder 0700.
 */
export class LocalDriver implements StorageDriver {
  readonly name = "local" as const;
  private readonly root: string;
  private ready: Promise<string> | null = null;

  constructor(root: string) {
    if (!root || !isAbsolute(root)) throw new StorageConfigError("STORAGE_LOCAL_ROOT wajib path absolut");
    this.root = resolve(root);
    assertNotPublic(this.root);
  }

  /** Membuat root + folder sementara sekali, lalu memeriksa path nyata (symlink) tidak menunjuk folder publik. */
  private ensureRoot(): Promise<string> {
    if (!this.ready) {
      this.ready = (async () => {
        await mkdir(join(this.root, TMP_DIR), { recursive: true, mode: 0o700 });
        const real = await realpath(this.root);
        assertNotPublic(real);
        return real;
      })().catch((error: unknown) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  private async pathFor(key: string): Promise<string> {
    assertSafeObjectKey(key);
    const root = await this.ensureRoot();
    const full = resolve(root, ...key.split("/"));
    const rel = relative(root, full);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === TMP_DIR)
      throw new Error("Object key penyimpanan tidak valid");
    return full;
  }

  async put(key: string, body: ObjectBody, meta: PutObjectMeta): Promise<StoredObjectInfo> {
    const target = await this.pathFor(key);
    const root = await this.ensureRoot();
    const temp = join(root, TMP_DIR, `${randomUUID()}.part`);
    const hasher = new HashingStream();
    try {
      await pipeline(
        toReadable(body),
        hasher,
        createWriteStream(temp, { flags: "wx", mode: 0o600, flush: true }),
      );
      await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    return { key, bytes: hasher.bytes, contentType: meta.contentType, sha256: hasher.sha256 };
  }

  async get(key: string): Promise<Readable> {
    const path = await this.pathFor(key);
    try {
      const handle = await open(path, "r");
      return handle.createReadStream();
    } catch (error) {
      if (isNotFound(error) || (error as NodeJS.ErrnoException).code === "EISDIR")
        throw new StorageObjectNotFoundError(key);
      throw error;
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const path = await this.pathFor(key);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      return { key, bytes: info.size, contentType: null, modifiedAt: info.mtime };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = await this.pathFor(key);
    await rm(path, { force: true });
  }

  async copy(sourceKey: string, targetKey: string): Promise<StoredObjectInfo> {
    const source = await this.get(sourceKey);
    return this.put(targetKey, source, { contentType: "application/octet-stream" });
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }
}
