import { Readable } from "node:stream";
import {
  assertSafeObjectKey,
  type ObjectBody,
  type ObjectStat,
  type PutObjectMeta,
  readAll,
  sha256Hex,
  type StorageDriver,
  StorageObjectNotFoundError,
  type StoredObjectInfo,
} from "./driver.js";

type Operation = "put" | "get" | "stat" | "delete" | "copy" | "exists";

/**
 * Driver memori untuk uji (bukan production). Menyediakan injeksi kegagalan per operasi agar uji dapat membuktikan
 * perilaku saat storage gagal (readiness 503, unggahan berstatus failed, job cleanup diulang).
 */
export class MemoryDriver implements StorageDriver {
  readonly name = "memory" as const;
  private readonly objects = new Map<string, { body: Buffer; info: StoredObjectInfo; modifiedAt: Date }>();
  private readonly failures = new Map<Operation, number>();

  /** Operasi `operation` berikutnya (sebanyak `times`) melempar galat. */
  failNext(operation: Operation, times = 1): void {
    this.failures.set(operation, (this.failures.get(operation) ?? 0) + times);
  }

  private maybeFail(operation: Operation): void {
    const left = this.failures.get(operation) ?? 0;
    if (left > 0) {
      this.failures.set(operation, left - 1);
      throw new Error(`Kegagalan storage tiruan (${operation})`);
    }
  }

  async put(key: string, body: ObjectBody, meta: PutObjectMeta): Promise<StoredObjectInfo> {
    assertSafeObjectKey(key);
    const data = body instanceof Readable ? await readAll(body) : Buffer.from(body);
    this.maybeFail("put");
    const info: StoredObjectInfo = {
      key,
      bytes: data.byteLength,
      contentType: meta.contentType,
      sha256: sha256Hex(data),
    };
    this.objects.set(key, { body: data, info, modifiedAt: new Date() });
    return { ...info };
  }

  async get(key: string): Promise<Readable> {
    assertSafeObjectKey(key);
    this.maybeFail("get");
    const object = this.objects.get(key);
    if (!object) throw new StorageObjectNotFoundError(key);
    return Readable.from([Buffer.from(object.body)]);
  }

  async stat(key: string): Promise<ObjectStat | null> {
    assertSafeObjectKey(key);
    this.maybeFail("stat");
    const object = this.objects.get(key);
    return object
      ? {
          key,
          bytes: object.info.bytes,
          contentType: object.info.contentType,
          modifiedAt: object.modifiedAt,
        }
      : null;
  }

  async delete(key: string): Promise<void> {
    assertSafeObjectKey(key);
    this.maybeFail("delete");
    this.objects.delete(key);
  }

  async copy(sourceKey: string, targetKey: string): Promise<StoredObjectInfo> {
    assertSafeObjectKey(sourceKey);
    assertSafeObjectKey(targetKey);
    this.maybeFail("copy");
    const object = this.objects.get(sourceKey);
    if (!object) throw new StorageObjectNotFoundError(sourceKey);
    return this.put(targetKey, object.body, { contentType: object.info.contentType });
  }

  async exists(key: string): Promise<boolean> {
    assertSafeObjectKey(key);
    this.maybeFail("exists");
    return this.objects.has(key);
  }

  /** Untuk uji: isi objek, atau undefined. */
  contents(key: string): Buffer | undefined {
    const object = this.objects.get(key);
    return object ? Buffer.from(object.body) : undefined;
  }

  /** Untuk uji: semua key yang tersimpan (terurut). */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  /** Untuk uji: kosongkan semua objek dan kegagalan terjadwal. */
  clear(): void {
    this.objects.clear();
    this.failures.clear();
  }
}
