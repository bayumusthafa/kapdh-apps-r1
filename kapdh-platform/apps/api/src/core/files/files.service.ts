import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { BaseEnv } from "@kapdh/config";
import { files, sessions, users } from "@kapdh/database";
import { type ObjectBody, sha256Hex, type StorageDriver, StorageObjectNotFoundError } from "@kapdh/storage";
import { and, asc, count, eq, gt, isNotNull, isNull, lt, lte, min, ne } from "drizzle-orm";
import type { Readable } from "node:stream";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../adapters/clock.js";
import { ADVISORY_LOCK_NAMESPACES, advisoryXactLockFor } from "../db/locks.js";
import { afterCommit, assertCommitAware, withTx } from "../db/tx.js";
import type { Db, DbOrTx, Tx } from "../db/types.js";
import { AppException, fieldError, forbidden, notFound, rateLimited } from "../errors/app-exception.js";
import type { AuthContext } from "../guards/auth-context.js";
import { JobRegistry } from "../jobs/job-registry.js";
import { safeError } from "../logging/safe-error.js";
import { assertMemberAccess } from "../membership/access.js";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { CLOCK, DB, ENV, ROOT_LOGGER, STORAGE } from "../tokens.js";
import { type FileAccessPolicy, FilePolicies, type FileRow, type FileViewer } from "./access-policy.js";
import {
  deriveFileUrlKey,
  FILE_URL_DEFAULT_TTL_SECONDS,
  type FileTokenClaims,
  type FileTokenSubject,
  signFileToken,
  verifyFileToken,
} from "./file-token.js";
import { FileRejectedError, inspectUpload } from "./inspect.js";
import {
  FILE_PURPOSE_SPECS,
  FILE_PURPOSES,
  type FilePurpose,
  isFilePurpose,
  TEMP_FILE_MAX_AGE_MS,
  UPLOAD_QUOTA,
  UPLOAD_QUOTA_WINDOW_MS,
} from "./purposes.js";

/** Batas percobaan unggah (termasuk yang gagal validasi) per pengguna per jam, melindungi CPU dekode gambar. */
const UPLOAD_ATTEMPTS_PER_HOUR = 30;
/** Jumlah berkas maksimum per eksekusi job pembersihan. */
const CLEANUP_BATCH = 200;
/** Interval job files.cleanup-temp (ARCHITECTURE §4.8: per jam). */
export const FILES_CLEANUP_EVERY_MS = 3600_000;

/** Pengunggah = AuthContext request (sesi mobile anggota atau sesi admin). */
export type FileUploader = Pick<AuthContext, "userId" | "audience" | "permissions" | "effectiveStatus">;

export interface UploadInput {
  uploader: FileUploader;
  /** Nilai field `purpose` mentah dari klien; divalidasi di sini. */
  purpose: unknown;
  data: Buffer;
  filename?: string | null;
  declaredMime?: string | null;
}

export interface FileUrl {
  url: string;
  /** null untuk berkas publik (URL tetap). */
  expiresAt: Date | null;
}

export interface FileContent {
  file: FileRow;
  body: Readable;
}

/** Object key tanpa PII (PRD 5.4): `<purpose>/<yyyy>/<mm>/<uuidv7>` (tahun/bulan UTC). */
export function objectKeyFor(purpose: FilePurpose, at: Date, id: string): string {
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${purpose}/${at.getUTCFullYear()}/${month}/${id}`;
}

/**
 * Layanan berkas core (ARCHITECTURE §4.2; PRD 2.5, 5.4; N-10). Modul domain memakai:
 * - `upload` (POST /files dan unggahan modul seperti media konten),
 * - `attach(tx, fileId, ownerUserId, purpose)` saat berkas dipakai objek (bukti bayar, avatar, cover),
 * - `discard(tx, fileId)` saat berkas diganti/dihapus,
 * - `registerAccessPolicy(purpose, policy)` di onModuleInit untuk aturan baca berkas privat,
 * - `signedUrl(file, viewer)` / `publicUrl(fileId)` untuk menyematkan URL di payload,
 * - `storeGenerated` untuk berkas buatan sistem (ekspor audit).
 * Berkas baru berstatus `pending` sampai objek tersimpan, lalu `ready`; yang tidak terlampir > 24 jam dihapus job
 * `files.cleanup-temp`.
 */
@Injectable()
export class FilesService implements OnModuleInit {
  private readonly policies = new Map<FilePurpose, FileAccessPolicy[]>();
  private readonly urlKey: Uint8Array;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: BaseEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORAGE) private readonly storageDriver: StorageDriver | null,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly rateLimits: RateLimitService,
    private readonly jobs: JobRegistry,
  ) {
    this.urlKey = deriveFileUrlKey(env.FILE_URL_SECRET);
    // Kebijakan bawaan core (PRD 2.3): pemilik, ditambah izin pengurus yang relevan. Modul menambah aturan lain
    // (anggota room untuk chat_image, direktori untuk avatar, dsb.).
    const owner = FilePolicies.owner();
    this.registerAccessPolicy("avatar", owner);
    this.registerAccessPolicy("avatar", FilePolicies.adminPermission("members.read"));
    this.registerAccessPolicy("chat_image", owner);
    this.registerAccessPolicy("payment_proof", owner);
    this.registerAccessPolicy("payment_proof", FilePolicies.adminPermission("payments.read"));
    this.registerAccessPolicy("adjustment_evidence", FilePolicies.adminPermission("payments.read"));
    this.registerAccessPolicy("audit_export", FilePolicies.allOf(owner, FilePolicies.adminPermission("audit.export")));
  }

  onModuleInit(): void {
    this.jobs.registerScheduled({
      name: "files.cleanup-temp",
      everyMs: FILES_CLEANUP_EVERY_MS,
      run: async (now, job) => {
        const result = await this.cleanup(now);
        if (result.deleted > 0 || result.failed > 0) job.logger.info(result, "pembersihan berkas selesai");
        if (result.failed > 0) throw new Error(`${result.failed} berkas gagal dibersihkan; diulang pada jadwal berikut`);
      },
    });
  }

  private get storage(): StorageDriver {
    if (!this.storageDriver) throw new Error("STORAGE belum dikonfigurasi");
    return this.storageDriver;
  }

  /** Nilai kolom files.storage_driver (CHECK local|s3); driver memori uji dicatat sebagai local. */
  private get driverName(): "local" | "s3" {
    return this.storage.name === "s3" ? "s3" : "local";
  }

  // ---------------------------------------------------------------------------------------------------- unggah

  /**
   * Validasi purpose dan hak pengunggah, batas percobaan, kuota N-10 (dikunci per pengguna+purpose sehingga unggahan
   * bersamaan tidak melewati 10), pemeriksaan isi (magic bytes, ukuran, dekode aman, EXIF dibuang), lalu simpan.
   * Galat: 400 VALIDATION_ERROR (purpose), 403, 413/415/422 FILE_INVALID, 429 RATE_LIMITED.
   */
  async upload(input: UploadInput): Promise<FileRow> {
    const spec = this.uploadSpec(input.purpose);
    this.assertUploader(spec.purpose, input.uploader);
    const userId = input.uploader.userId;
    await this.rateLimits.consumeOrThrow(
      `files-upload:${userId}`,
      UPLOAD_ATTEMPTS_PER_HOUR,
      3600_000,
      "Terlalu banyak percobaan unggah. Coba lagi nanti.",
    );
    // Cek awal tanpa kunci agar pengguna yang sudah mencapai kuota tidak memakai CPU dekode gambar.
    await this.assertQuota(this.db, userId, spec.purpose, this.clock.now());

    let processed;
    try {
      processed = await inspectUpload({
        data: input.data,
        spec,
        filename: input.filename,
        declaredMime: input.declaredMime,
      });
    } catch (error) {
      if (error instanceof FileRejectedError) throw new AppException(error.status, "FILE_INVALID", error.message);
      throw error;
    }

    const now = this.clock.now();
    const id = uuidv7();
    const objectKey = objectKeyFor(spec.purpose, now, id);
    await withTx(this.db, async (tx) => {
      await advisoryXactLockFor(tx, ADVISORY_LOCK_NAMESPACES.fileQuota, `${userId}:${spec.purpose}`);
      await this.assertQuota(tx, userId, spec.purpose, now);
      await tx.insert(files).values({
        id,
        ownerUserId: userId,
        purpose: spec.purpose,
        storageDriver: this.driverName,
        objectKey,
        mime: processed.mime,
        bytes: processed.data.byteLength,
        sha256: sha256Hex(processed.data),
        visibility: spec.visibility,
        status: "pending",
        width: processed.width,
        height: processed.height,
        createdAt: now,
        updatedAt: now,
      });
    });

    try {
      await this.storage.put(objectKey, processed.data, { contentType: processed.mime });
    } catch (error) {
      this.logger.error({ error: safeError(error), file_id: id }, "penyimpanan berkas gagal");
      await this.db
        .update(files)
        .set({ status: "failed", updatedAt: this.clock.now() })
        .where(and(eq(files.id, id), eq(files.status, "pending")));
      await this.storage.delete(objectKey).catch(() => undefined);
      throw new AppException(500, "INTERNAL_ERROR", "Berkas gagal disimpan. Coba lagi beberapa saat lagi.");
    }
    const [ready] = await this.db
      .update(files)
      .set({ status: "ready", updatedAt: this.clock.now() })
      .where(and(eq(files.id, id), eq(files.status, "pending")))
      .returning();
    if (!ready) throw new Error("Berkas berubah status selama unggahan");
    return ready;
  }

  private uploadSpec(purpose: unknown) {
    if (!isFilePurpose(purpose) || FILE_PURPOSE_SPECS[purpose].uploader === "system")
      throw fieldError("purpose", "Purpose berkas tidak valid.");
    return FILE_PURPOSE_SPECS[purpose];
  }

  /** Purpose anggota hanya untuk sesi mobile dengan effective_status sesuai; purpose pengurus butuh izin. */
  private assertUploader(purpose: FilePurpose, uploader: FileUploader): void {
    const spec = FILE_PURPOSE_SPECS[purpose];
    if (spec.uploader === "member") {
      if (uploader.audience !== "mobile") throw forbidden("Jenis berkas ini hanya dapat diunggah anggota.");
      assertMemberAccess(spec.memberAccess ?? "nonsuspended", uploader.effectiveStatus ?? "unverified");
      return;
    }
    if (
      uploader.audience !== "admin" ||
      !(spec.permissions ?? []).every((permission) => uploader.permissions.has(permission))
    )
      throw forbidden("Anda tidak memiliki izin mengunggah berkas jenis ini.");
  }

  /** N-10: unggahan berhasil (selain `failed`) per purpose dalam 24 jam bergulir menurut Clock. */
  private async assertQuota(db: DbOrTx, userId: string, purpose: FilePurpose, now: Date): Promise<void> {
    const since = new Date(now.getTime() - UPLOAD_QUOTA_WINDOW_MS);
    const [row] = await db
      .select({ used: count(), oldest: min(files.createdAt) })
      .from(files)
      .where(
        and(
          eq(files.ownerUserId, userId),
          eq(files.purpose, purpose),
          gt(files.createdAt, since),
          ne(files.status, "failed"),
        ),
      );
    if (Number(row?.used ?? 0) < UPLOAD_QUOTA) return;
    const oldest = row?.oldest ?? now;
    const waitMs = oldest.getTime() + UPLOAD_QUOTA_WINDOW_MS - now.getTime();
    throw rateLimited(
      Math.ceil(waitMs / 1000),
      `Batas ${UPLOAD_QUOTA} unggahan per 24 jam untuk jenis berkas ini tercapai. Coba lagi nanti.`,
    );
  }

  // ------------------------------------------------------------------------------------------ siklus hidup

  /**
   * Menandai berkas dipakai objek domain (bukti bayar, avatar, cover, ...) di dalam transaksi pemanggil. Berkas wajib
   * milik `ownerUserId`, ber-purpose sama, `ready`, dan belum pernah dilampirkan (satu berkas = satu objek). Galat
   * 400 VALIDATION_ERROR pada field `field` (bawaan `file_id`).
   */
  async attach(
    tx: DbOrTx,
    fileId: string,
    ownerUserId: string,
    purpose: FilePurpose,
    options: { field?: string } = {},
  ): Promise<FileRow> {
    const now = this.clock.now();
    const [attached] = await tx
      .update(files)
      .set({ attachedAt: now, updatedAt: now })
      .where(
        and(
          eq(files.id, fileId),
          eq(files.ownerUserId, ownerUserId),
          eq(files.purpose, purpose),
          eq(files.status, "ready"),
          isNull(files.attachedAt),
        ),
      )
      .returning();
    if (!attached)
      throw fieldError(
        options.field ?? "file_id",
        "Berkas tidak ditemukan, belum selesai diunggah, berbeda jenis, atau sudah dipakai.",
      );
    return attached;
  }

  /**
   * Menghapus berkas yang diganti/tidak dipakai lagi: baris langsung `deleted` (tidak lagi dilayani) dan objek dihapus
   * setelah commit. Kegagalan hapus objek dicatat; pembersihan yang wajib terjamin (penghapusan akun) memakai
   * {@link deleteNow}. Wajib tx dari withTx.
   */
  async discard(tx: Tx, fileId: string): Promise<boolean> {
    assertCommitAware(tx, "FilesService.discard");
    const now = this.clock.now();
    const [row] = await tx
      .update(files)
      .set({ status: "deleted", deletedAt: now, updatedAt: now })
      .where(and(eq(files.id, fileId), ne(files.status, "deleted")))
      .returning({ objectKey: files.objectKey });
    if (!row) return false;
    afterCommit(() =>
      this.storage.delete(row.objectKey).catch((error: unknown) => {
        this.logger.warn({ error: safeError(error), file_id: fileId }, "objek berkas gagal dihapus setelah discard");
      }),
    );
    return true;
  }

  /**
   * Menghapus objek lalu menandai baris `deleted` dalam satu transaksi dengan baris terkunci; galat storage
   * dilempar (baris tetap, pemanggil/job mengulang). `onlyIf` membatasi ke berkas sementara kedaluwarsa (job cleanup).
   */
  async deleteNow(fileId: string, onlyIf?: "unattached-expired" | "expired"): Promise<boolean> {
    return withTx(this.db, async (tx) => {
      const [row] = await tx.select().from(files).where(eq(files.id, fileId)).for("update");
      if (!row || row.status === "deleted") return false;
      const now = this.clock.now();
      if (onlyIf === "unattached-expired" && (row.attachedAt || row.createdAt.getTime() > now.getTime() - TEMP_FILE_MAX_AGE_MS))
        return false;
      if (onlyIf === "expired" && !(row.expiresAt && row.expiresAt <= now)) return false;
      await this.storage.delete(row.objectKey);
      await tx
        .update(files)
        .set({ status: "deleted", deletedAt: now, updatedAt: now })
        .where(eq(files.id, fileId));
      return true;
    });
  }

  /**
   * Job `files.cleanup-temp` (ARCHITECTURE §4.8, PRD 2.5): unggahan yang tidak terlampir ke objek > 24 jam dan berkas
   * dengan expires_at lewat (ekspor audit, AC F17-4) dihapus objek + barisnya. Per berkas satu transaksi dengan baris
   * terkunci, sehingga `attach` bersamaan tidak dapat memakai berkas yang sedang dihapus.
   */
  async cleanup(now: Date = this.clock.now()): Promise<{ deleted: number; failed: number }> {
    const cutoff = new Date(now.getTime() - TEMP_FILE_MAX_AGE_MS);
    const temp = await this.db
      .select({ id: files.id })
      .from(files)
      .where(and(isNull(files.attachedAt), ne(files.status, "deleted"), lt(files.createdAt, cutoff)))
      .orderBy(asc(files.createdAt))
      .limit(CLEANUP_BATCH);
    const expired = await this.db
      .select({ id: files.id })
      .from(files)
      .where(and(isNotNull(files.expiresAt), ne(files.status, "deleted"), lte(files.expiresAt, now)))
      .orderBy(asc(files.expiresAt))
      .limit(CLEANUP_BATCH);
    let deleted = 0;
    let failed = 0;
    const work: [string, "unattached-expired" | "expired"][] = [
      ...temp.map((row) => [row.id, "unattached-expired"] as [string, "unattached-expired"]),
      ...expired.map((row) => [row.id, "expired"] as [string, "expired"]),
    ];
    for (const [id, condition] of work) {
      try {
        if (await this.deleteNow(id, condition)) deleted++;
      } catch (error) {
        failed++;
        this.logger.warn({ error: safeError(error), file_id: id }, "berkas gagal dibersihkan");
      }
    }
    return { deleted, failed };
  }

  /**
   * Berkas buatan sistem (purpose `uploader: system`, mis. ekspor audit CSV): langsung `ready` + terlampir, dengan
   * kedaluwarsa opsional. Dipanggil job worker; objek ditulis lebih dulu lalu baris dicatat.
   */
  async storeGenerated(input: {
    ownerUserId: string | null;
    purpose: FilePurpose;
    mime: string;
    body: ObjectBody;
    expiresAt?: Date | null;
  }): Promise<FileRow> {
    const spec = FILE_PURPOSE_SPECS[input.purpose];
    if (spec.uploader !== "system") throw new Error(`Purpose ${input.purpose} bukan berkas buatan sistem`);
    const now = this.clock.now();
    const id = uuidv7();
    const objectKey = objectKeyFor(input.purpose, now, id);
    const stored = await this.storage.put(objectKey, input.body, { contentType: input.mime });
    try {
      const [row] = await this.db
        .insert(files)
        .values({
          id,
          ownerUserId: input.ownerUserId,
          purpose: input.purpose,
          storageDriver: this.driverName,
          objectKey,
          mime: input.mime,
          bytes: stored.bytes,
          sha256: stored.sha256,
          visibility: spec.visibility,
          status: "ready",
          attachedAt: now,
          expiresAt: input.expiresAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return row!;
    } catch (error) {
      await this.storage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------------ akses baca

  /**
   * Menambah kebijakan baca berkas privat untuk purpose (digabung OR dengan kebijakan bawaan dan modul lain).
   * Dipanggil modul di onModuleInit, mis. chat: anggota room boleh membuka chat_image di room itu.
   */
  registerAccessPolicy(purpose: FilePurpose, policy: FileAccessPolicy): void {
    if (!(FILE_PURPOSES as readonly string[]).includes(purpose)) throw new Error(`Purpose tidak dikenal: ${purpose}`);
    const list = this.policies.get(purpose) ?? [];
    list.push(policy);
    this.policies.set(purpose, list);
  }

  /** true bila penampil boleh membuka berkas (publik selalu boleh). */
  async canAccess(file: FileRow, viewer: FileViewer, db: DbOrTx = this.db): Promise<boolean> {
    if (file.visibility === "public") return true;
    for (const policy of this.policies.get(file.purpose as FilePurpose) ?? [])
      if (await policy({ file, viewer, db })) return true;
    return false;
  }

  /**
   * GET /files/{fileId}/access: kebijakan diperiksa lebih dulu (TTL tidak menggantikan otorisasi, PRD 5.4), lalu URL
   * bertanda tangan <= 10 menit terikat berkas + purpose + penampil. Berkas yang tidak ada, belum siap, atau tidak
   * boleh dibuka → 404 (N-09). Berkas publik → URL publik tetap.
   */
  async accessFor(fileId: string, viewer: FileViewer, options: { ttlSeconds?: number } = {}): Promise<FileUrl> {
    const [file] = await this.db.select().from(files).where(eq(files.id, fileId)).limit(1);
    if (!file || file.status !== "ready") throw notFound("Berkas tidak ditemukan.");
    if (file.visibility === "public") return { url: this.publicUrl(file.id), expiresAt: null };
    if (!(await this.canAccess(file, viewer))) throw notFound("Berkas tidak ditemukan.");
    return this.signedUrl(file, { userId: viewer.userId, sessionId: viewer.sessionId }, options);
  }

  /**
   * URL untuk disematkan di payload oleh modul yang SUDAH memastikan penampil berhak (mis. avatar lawan bicara chat,
   * foto anggota aktif pada verifikasi KTA publik dengan `viewer` null). Berkas publik → URL publik.
   */
  async signedUrl(
    file: Pick<FileRow, "id" | "purpose" | "visibility">,
    viewer: FileTokenSubject | null,
    options: { ttlSeconds?: number } = {},
  ): Promise<FileUrl> {
    if (file.visibility === "public") return { url: this.publicUrl(file.id), expiresAt: null };
    const { token, expiresAt } = await signFileToken(
      this.urlKey,
      {
        fileId: file.id,
        purpose: file.purpose as FilePurpose,
        userId: viewer?.userId ?? null,
        sessionId: viewer?.sessionId ?? null,
      },
      this.clock.now(),
      options.ttlSeconds ?? FILE_URL_DEFAULT_TTL_SECONDS,
    );
    return { url: `${this.env.API_PUBLIC_URL}/api/v1/files/content/${token}`, expiresAt };
  }

  /** URL tetap berkas publik (cover berita/event, banner). */
  publicUrl(fileId: string): string {
    return `${this.env.API_PUBLIC_URL}/api/v1/files/public/${fileId}`;
  }

  /**
   * GET /files/content/{token}: token sah dan belum kedaluwarsa, berkas `ready` dengan purpose yang sama, dan bila
   * terikat sesi: sesi belum dicabut/kedaluwarsa dan akun masih aktif (logout/suspend memutus URL yang beredar).
   * Selain itu 404.
   */
  async openContent(token: string): Promise<FileContent> {
    const now = this.clock.now();
    const claims = await verifyFileToken(this.urlKey, token, now);
    if (!claims) throw notFound("Tautan berkas tidak berlaku. Buka ulang dari aplikasi.");
    const [file] = await this.db.select().from(files).where(eq(files.id, claims.fileId)).limit(1);
    if (!file || file.status !== "ready" || file.purpose !== claims.purpose)
      throw notFound("Tautan berkas tidak berlaku. Buka ulang dari aplikasi.");
    if (claims.sessionId && !(await this.sessionStillValid(claims, now)))
      throw notFound("Tautan berkas tidak berlaku. Buka ulang dari aplikasi.");
    return { file, body: await this.readObject(file) };
  }

  /** GET /files/public/{fileId}: hanya berkas `ready` bervisibilitas publik. */
  async openPublic(fileId: string): Promise<FileContent> {
    const [file] = await this.db.select().from(files).where(eq(files.id, fileId)).limit(1);
    if (!file || file.status !== "ready" || file.visibility !== "public") throw notFound("Berkas tidak ditemukan.");
    return { file, body: await this.readObject(file) };
  }

  private async readObject(file: FileRow): Promise<Readable> {
    try {
      return await this.storage.get(file.objectKey);
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        this.logger.error({ file_id: file.id }, "objek berkas ready tidak ditemukan di storage");
        throw notFound("Berkas tidak ditemukan.");
      }
      throw error;
    }
  }

  private async sessionStillValid(claims: FileTokenClaims, now: Date): Promise<boolean> {
    if (!claims.userId || !claims.sessionId) return false;
    const [row] = await this.db
      .select({ revokedAt: sessions.revokedAt, expiresAt: sessions.expiresAt, userStatus: users.status })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, claims.sessionId), eq(sessions.userId, claims.userId)))
      .limit(1);
    return !!row && !row.revokedAt && row.expiresAt > now && row.userStatus === "active";
  }
}
