import type { Readable } from "node:stream";
import {
  type ObjectBody,
  type ObjectStat,
  type PutObjectMeta,
  type StorageDriver,
  StorageObjectNotFoundError,
  type StoredObjectInfo,
} from "./driver.js";

/**
 * Baca-cadangan selama perpindahan storage (PRD 5.4 "copy, checksum, fallback read, cleanup";
 * docs/runbooks/storage-migration.md). Semua tulisan masuk ke driver UTAMA (tujuan baru, mis. S3); bacaan mencoba
 * utama lebih dahulu lalu driver CADANGAN (lokasi lama, mis. disk lokal) bila objek belum tersalin. Penghapusan
 * dijalankan pada keduanya agar berkas yang dihapus (penghapusan akun, discard, cleanup) tidak tertinggal di lokasi
 * lama dan hidup kembali saat kembali ke driver lama (D2, AC F14-6).
 *
 * Hanya dipakai sementara: setelah seluruh objek tersalin dan checksum cocok, cadangan dilepas (env dikosongkan) dan
 * salinan lama dibersihkan sesuai runbook.
 */
export class FallbackReadDriver implements StorageDriver {
  readonly name: StorageDriver["name"];

  constructor(
    readonly primary: StorageDriver,
    readonly fallback: StorageDriver,
  ) {
    this.name = primary.name;
  }

  put(key: string, body: ObjectBody, meta: PutObjectMeta): Promise<StoredObjectInfo> {
    return this.primary.put(key, body, meta);
  }

  async get(key: string): Promise<Readable> {
    try {
      return await this.primary.get(key);
    } catch (error) {
      if (!(error instanceof StorageObjectNotFoundError)) throw error;
      return this.fallback.get(key);
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    return (await this.primary.stat(key)) ?? this.fallback.stat(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.primary.exists(key)) || this.fallback.exists(key);
  }

  async delete(key: string): Promise<void> {
    await this.primary.delete(key);
    await this.fallback.delete(key);
  }

  /**
   * Menutup klien kedua driver saat shutdown (mis. soket keep-alive S3Driver), sehingga API/worker keluar halus selama
   * masa perpindahan dan tidak menunggu SIGKILL kontainer.
   */
  destroy(): void {
    for (const driver of [this.primary, this.fallback]) {
      const closable = driver as Partial<{ destroy: () => void }>;
      if (typeof closable.destroy === "function") closable.destroy();
    }
  }

  /** Salinan selalu ditulis ke driver utama; sumber yang belum tersalin dibaca dari cadangan. */
  async copy(sourceKey: string, targetKey: string): Promise<StoredObjectInfo> {
    if (await this.primary.exists(sourceKey)) return this.primary.copy(sourceKey, targetKey);
    const stat = await this.fallback.stat(sourceKey);
    if (!stat) throw new StorageObjectNotFoundError(sourceKey);
    return this.primary.put(targetKey, await this.fallback.get(sourceKey), {
      contentType: stat.contentType ?? "application/octet-stream",
    });
  }
}
