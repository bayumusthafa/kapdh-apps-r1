import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import {
  assertSafeObjectKey,
  HashingStream,
  hashObject,
  type ObjectBody,
  type ObjectStat,
  type PutObjectMeta,
  sha256Hex,
  StorageConfigError,
  type StorageDriver,
  StorageObjectNotFoundError,
  type StoredObjectInfo,
} from "./driver.js";

export interface S3DriverConfig {
  bucket: string;
  region: string;
  /** Endpoint S3-compatible (MinIO, R2, Wasabi, ...); kosong = AWS S3 standar. */
  endpoint?: string;
  /** Path-style (`https://host/bucket/key`) untuk penyedia yang tidak mendukung virtual-host. */
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Ukuran bagian unggahan multipart untuk body stream (minimum S3 5 MiB). */
const PART_SIZE = 8 * 1024 * 1024;

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function isMissing(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "NoSuchKey" || name === "NotFound" || httpStatus(error) === 404;
}

/**
 * Driver S3-compatible (PRD 5.4; perpindahan saat disk > 60% atau berkas > 20 GB, D9). Bucket wajib privat: berkas
 * dibaca API lalu di-stream ke klien setelah pemeriksaan izin, tidak pernah lewat URL publik bucket.
 *
 * Validasi checksum permintaan memakai mode `WHEN_REQUIRED` agar penyedia S3-compatible yang belum mendukung trailer
 * checksum baru AWS tetap bekerja; integritas isi dijaga sendiri lewat sha256 di tabel `files`.
 */
export class S3Driver implements StorageDriver {
  readonly name = "s3" as const;
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(config: S3DriverConfig, client?: S3Client) {
    if (!config.bucket || !config.region || !config.accessKeyId || !config.secretAccessKey)
      throw new StorageConfigError("Konfigurasi S3 tidak lengkap (S3_BUCKET, S3_REGION, kredensial)");
    this.bucket = config.bucket;
    this.client =
      client ??
      new S3Client({
        region: config.region,
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        forcePathStyle: config.forcePathStyle ?? false,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        maxAttempts: 3,
      });
  }

  async put(key: string, body: ObjectBody, meta: PutObjectMeta): Promise<StoredObjectInfo> {
    assertSafeObjectKey(key);
    if (!(body instanceof Readable)) {
      const data = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: meta.contentType,
          ContentLength: data.byteLength,
        }),
      );
      return { key, bytes: data.byteLength, contentType: meta.contentType, sha256: sha256Hex(data) };
    }
    // Stream (ekspor besar): unggahan multipart bertahap; objek baru terlihat setelah selesai.
    const hasher = new HashingStream();
    body.on("error", (error) => hasher.destroy(error));
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body.pipe(hasher), ContentType: meta.contentType },
      partSize: PART_SIZE,
      queueSize: 2,
      leavePartsOnError: false,
    });
    await upload.done();
    return { key, bytes: hasher.bytes, contentType: meta.contentType, sha256: hasher.sha256 };
  }

  async get(key: string): Promise<Readable> {
    assertSafeObjectKey(key);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = result.Body;
      if (!body) throw new StorageObjectNotFoundError(key);
      return body instanceof Readable ? body : Readable.from(body as AsyncIterable<Uint8Array>);
    } catch (error) {
      if (isMissing(error)) throw new StorageObjectNotFoundError(key);
      throw error;
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    assertSafeObjectKey(key);
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        key,
        bytes: Number(head.ContentLength ?? 0),
        contentType: head.ContentType ?? null,
        modifiedAt: head.LastModified ?? null,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeObjectKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async copy(sourceKey: string, targetKey: string): Promise<StoredObjectInfo> {
    assertSafeObjectKey(sourceKey);
    assertSafeObjectKey(targetKey);
    try {
      // Key hanya [a-z0-9._-/] (assertSafeObjectKey), jadi aman tanpa encoding tambahan.
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: targetKey,
          CopySource: `${this.bucket}/${sourceKey}`,
          MetadataDirective: "COPY",
        }),
      );
    } catch (error) {
      if (isMissing(error)) throw new StorageObjectNotFoundError(sourceKey);
      throw error;
    }
    const head = await this.stat(targetKey);
    if (!head) throw new StorageObjectNotFoundError(targetKey);
    const { sha256 } = await hashObject(this, targetKey);
    return {
      key: targetKey,
      bytes: head.bytes,
      contentType: head.contentType ?? "application/octet-stream",
      sha256,
    };
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  /** Menutup koneksi HTTP klien (shutdown). */
  destroy(): void {
    this.client.destroy();
  }
}
