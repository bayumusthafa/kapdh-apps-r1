import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { BaseEnv } from "@kapdh/config";
import { type components, PERMISSION_VALUES, type Permission } from "@kapdh/contracts";
import { adminPermissions, admins, files, sessions, users } from "@kapdh/database";
import { type ObjectBody, sha256Hex, type StorageDriver, StorageObjectNotFoundError } from "@kapdh/storage";
import { and, asc, count, eq, gt, isNotNull, isNull, lt, lte, min, ne, sql } from "drizzle-orm";
import type { Readable } from "node:stream";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../adapters/clock.js";
import { ADVISORY_LOCK_NAMESPACES, advisoryXactLockFor } from "../db/locks.js";
import { rows } from "../db/rows.js";
import { afterCommit, assertCommitAware, withTx } from "../db/tx.js";
import type { Db, DbOrTx, Tx } from "../db/types.js";
import { AppException, fieldError, forbidden, notFound, rateLimited } from "../errors/app-exception.js";
import type { AuthContext } from "../guards/auth-context.js";
import { JobRegistry } from "../jobs/job-registry.js";
import { safeError } from "../logging/safe-error.js";
import { assertMemberAccess, memberAccessAllows } from "../membership/access.js";
import { MembershipKernel } from "../membership/membership.kernel.js";
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
  type FilePurposeSpec,
  type FileVisibility,
  isFilePurpose,
  maxStreamBytesFor,
  TEMP_FILE_MAX_AGE_MS,
  UPLOAD_QUOTA,
  UPLOAD_QUOTA_WINDOW_MS,
} from "./purposes.js";

/**
 * Kunci daftar id berkas di `reports.evidence` (jsonb) yang ditahan selama laporan disimpan (PRD 3.12, D2; kontrak C6).
 * Ditulis modul moderation saat bukti dicatat; dibaca {@link FilesService.isRetainedAsEvidence}.
 */
export const REPORT_EVIDENCE_FILE_IDS_KEY = "file_ids";

/** Batas percobaan unggah (termasuk yang gagal validasi) per pengguna per jam, melindungi CPU dekode gambar. */
export const UPLOAD_ATTEMPTS_PER_HOUR = 30;
/** Jumlah berkas maksimum per eksekusi job pembersihan. */
const CLEANUP_BATCH = 200;
/** Interval job files.cleanup-temp (ARCHITECTURE §4.8: per jam). */
export const FILES_CLEANUP_EVERY_MS = 3600_000;

/** Pengunggah = AuthContext request (sesi mobile anggota atau sesi admin). */
export type FileUploader = Pick<AuthContext, "userId" | "audience" | "permissions" | "effectiveStatus">;

/** Hasil tahap pertama unggahan: purpose sah, pengunggah berhak, kuota belum habis, batas byte stream. */
export interface UploadTicket {
  readonly spec: FilePurposeSpec;
  readonly uploaderUserId: string;
  /** Batas byte yang boleh dibaca dari stream untuk purpose ini (N-10). */
  readonly maxBytes: number;
}

export interface UploadContent {
  data: Buffer;
  /** Nama berkas dari klien (hanya untuk cek ekstensi; tidak pernah disimpan). */
  filename?: string | null;
  /** Content-Type bagian multipart dari klien (hanya untuk cek penyamaran). */
  declaredMime?: string | null;
}

export interface UploadInput extends UploadContent {
  uploader: FileUploader;
  /** Nilai field `purpose` mentah dari klien; divalidasi di sini. */
  purpose: unknown;
}

export interface FileUrl {
  url: string;
  /** null untuk berkas publik (URL tetap). */
  expiresAt: Date | null;
}

/** Hasil GET /files/{fileId}/access: URL + jenis isi agar klien memilih pratinjau (gambar atau PDF). */
export interface FileAccessGrant extends FileUrl {
  mime: string;
}

/**
 * Kait yang dijalankan {@link FilesService.accessFor} SETELAH kebijakan akses berkas privat mengizinkan dan SEBELUM URL
 * bertanda tangan diterbitkan, mis. audit `audit.export.downloaded` untuk setiap akses ekspor audit (PRD 3.17, kontrak
 * C7). Galat kait menggagalkan akses (tanpa jejak audit tidak ada URL). Didaftarkan modul di onModuleInit.
 */
export type FileAccessHook = (input: { file: FileRow; viewer: FileViewer }) => Promise<void>;

export interface FileContent {
  file: FileRow;
  body: Readable;
}

export type FileRefDto = components["schemas"]["FileRef"];

/** Object key tanpa PII (PRD 5.4): `<purpose>/<yyyy>/<mm>/<uuidv7>` (tahun/bulan UTC). */
export function objectKeyFor(purpose: FilePurpose, at: Date, id: string): string {
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${purpose}/${at.getUTCFullYear()}/${month}/${id}`;
}

const LINK_EXPIRED = "Tautan berkas tidak berlaku. Buka ulang dari aplikasi.";

/**
 * Layanan berkas core (ARCHITECTURE §4.2; PRD 2.5, 5.4; N-10). Modul domain memakai:
 * - `beginUpload` + `completeUpload` (POST /files: purpose diperiksa sebelum isi dibaca) atau `upload` sekaligus,
 * - `attach(tx, fileId, ownerUserId, purpose)` saat berkas dipakai objek (bukti bayar, avatar, cover),
 * - `discard(tx, fileId)` saat berkas diganti/dihapus; `setVisibility` untuk avatar publik,
 * - `registerAccessPolicy(purpose, policy)` di onModuleInit untuk aturan baca berkas privat, dan
 *   `registerAccessHook(purpose, hook)` untuk efek wajib saat akses diberikan (mis. audit unduhan ekspor audit),
 * - `signedUrl(file, viewer)` / `publicUrl(fileId)` / `toFileRef(file)` untuk payload,
 * - `storeGenerated` untuk berkas buatan sistem (ekspor audit).
 * Berkas baru berstatus `pending` sampai objek tersimpan, lalu `ready`; yang tidak terlampir > 24 jam dihapus job
 * `files.cleanup-temp`.
 */
@Injectable()
export class FilesService implements OnModuleInit {
  /** Kebijakan bawaan core per purpose (pemilik, izin pengurus). */
  private readonly defaultPolicies = new Map<FilePurpose, FileAccessPolicy[]>();
  /** Kebijakan yang didaftarkan modul domain (digabung OR). */
  private readonly modulePolicies = new Map<FilePurpose, FileAccessPolicy[]>();
  /** Purpose yang kebijakan bawaannya digantikan modul pemiliknya (`replaceDefaults`). */
  private readonly replacedDefaults = new Set<FilePurpose>();
  /** Kait akses per purpose ({@link registerAccessHook}), dijalankan setelah kebijakan mengizinkan. */
  private readonly accessHooks = new Map<FilePurpose, FileAccessHook[]>();
  private readonly urlKey: Uint8Array;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: BaseEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORAGE) private readonly storageDriver: StorageDriver | null,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly rateLimits: RateLimitService,
    private readonly jobs: JobRegistry,
    private readonly membership: MembershipKernel,
  ) {
    this.urlKey = deriveFileUrlKey(env.FILE_URL_SECRET);
    // Kebijakan bawaan core (PRD 2.3): pemilik, ditambah izin pengurus yang relevan. Modul menambah aturan lain
    // (anggota room untuk chat_image, direktori untuk avatar, dsb.) atau menggantikan bawaan bila pemilik berkas tidak
    // boleh membuka tanpa syarat (chat_image: hanya anggota room, AC F11-4).
    const owner = FilePolicies.owner();
    this.registerDefaultPolicy("avatar", owner);
    this.registerDefaultPolicy("avatar", FilePolicies.adminPermission("members.read"));
    this.registerDefaultPolicy("chat_image", owner);
    this.registerDefaultPolicy("payment_proof", owner);
    this.registerDefaultPolicy("payment_proof", FilePolicies.adminPermission("payments.read"));
    this.registerDefaultPolicy("adjustment_evidence", FilePolicies.adminPermission("payments.read"));
    // Ekspor audit (kontrak C7): audit.read + audit.export DAN pemohon ekspor atau Super Admin; jalur unduh utama
    // adalah adminGetAuditExportAccess.
    this.registerDefaultPolicy(
      "audit_export",
      FilePolicies.allOf(
        FilePolicies.adminPermission("audit.read", "audit.export"),
        FilePolicies.anyOf(owner, FilePolicies.superAdmin()),
      ),
    );
  }

  private registerDefaultPolicy(purpose: FilePurpose, policy: FileAccessPolicy): void {
    const list = this.defaultPolicies.get(purpose) ?? [];
    list.push(policy);
    this.defaultPolicies.set(purpose, list);
  }

  onModuleInit(): void {
    this.jobs.registerScheduled({
      name: "files.cleanup-temp",
      everyMs: FILES_CLEANUP_EVERY_MS,
      run: async (now, job) => {
        const result = await this.cleanup(now);
        if (result.deleted > 0 || result.failed > 0) job.logger.info(result, "pembersihan berkas selesai");
        if (result.failed > 0)
          throw new Error(`${result.failed} berkas gagal dibersihkan; diulang pada jadwal berikut`);
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
   * Tahap 1 unggahan, SEBELUM isi berkas dibaca: purpose sah (400), hak pengunggah per purpose (403
   * FORBIDDEN/MEMBERSHIP_REQUIRED/ACCOUNT_SUSPENDED), batas percobaan per jam dan kuota N-10 (429). Mengembalikan
   * batas byte stream untuk purpose sehingga controller berhenti membaca begitu batas terlampaui (413).
   */
  async beginUpload(
    uploader: FileUploader,
    purpose: unknown,
    options: { allowed?: readonly FilePurpose[] } = {},
  ): Promise<UploadTicket> {
    if (
      !isFilePurpose(purpose) ||
      FILE_PURPOSE_SPECS[purpose].uploader === "system" ||
      (options.allowed && !options.allowed.includes(purpose))
    )
      throw fieldError("purpose", "Purpose berkas tidak valid.");
    const spec = FILE_PURPOSE_SPECS[purpose];
    await this.assertUploader(spec, uploader);
    await this.rateLimits.consumeOrThrow(
      `files-upload:${uploader.userId}`,
      UPLOAD_ATTEMPTS_PER_HOUR,
      3600_000,
      "Terlalu banyak percobaan unggah. Coba lagi nanti.",
    );
    // Cek awal tanpa kunci agar pengguna yang sudah mencapai kuota tidak memakai bandwidth/CPU dekode gambar.
    await this.assertQuota(this.db, uploader.userId, spec.purpose, this.clock.now());
    return { spec, uploaderUserId: uploader.userId, maxBytes: maxStreamBytesFor(spec) };
  }

  /**
   * Tahap 2: pemeriksaan isi (magic bytes, ekstensi/Content-Type penyamar, ukuran per jenis, dekode aman dengan batas
   * piksel, EXIF dibuang lewat re-encode, PDF berkonten aktif ditolak), kuota diperiksa ulang di bawah kunci advisory
   * per (pengguna, purpose) sehingga unggahan bersamaan tidak melewati 10, baris `pending` dicatat, objek disimpan,
   * lalu `ready`. Galat: 413/415/422 FILE_INVALID, 429 RATE_LIMITED, 500 bila storage gagal (baris `failed`).
   */
  async completeUpload(ticket: UploadTicket, content: UploadContent): Promise<FileRow> {
    const { spec, uploaderUserId: userId } = ticket;
    let processed;
    try {
      processed = await inspectUpload({
        data: content.data,
        spec,
        filename: content.filename,
        declaredMime: content.declaredMime,
      });
    } catch (error) {
      if (error instanceof FileRejectedError)
        throw new AppException(error.status, "FILE_INVALID", error.message);
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
      // Baris `failed` tidak dihitung kuota; objek setengah jadi (bila ada) dibuang.
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

  /** Unggahan sekaligus (modul yang sudah memegang isi berkas, mis. uji atau impor). */
  async upload(input: UploadInput): Promise<FileRow> {
    const ticket = await this.beginUpload(input.uploader, input.purpose);
    if (input.data.byteLength > ticket.maxBytes)
      throw new AppException(413, "FILE_INVALID", "Berkas terlalu besar untuk keperluan ini.");
    return this.completeUpload(ticket, input);
  }

  /**
   * Purpose anggota untuk sesi mobile dengan effective_status sesuai (dan sesi admin bila purpose mengizinkan pengurus
   * berizin tertentu); purpose pengurus butuh izin.
   */
  private async assertUploader(spec: FilePurposeSpec, uploader: FileUploader): Promise<void> {
    if (spec.uploader === "member") {
      if (uploader.audience === "admin" && spec.adminPermissions) {
        if (!spec.adminPermissions.every((permission) => uploader.permissions.has(permission)))
          throw forbidden("Anda tidak memiliki izin mengunggah berkas jenis ini.");
        return;
      }
      if (uploader.audience !== "mobile") throw forbidden("Jenis berkas ini hanya dapat diunggah anggota.");
      const status =
        uploader.effectiveStatus ??
        (await this.membership.effectiveStatusFor(uploader.userId))?.status ??
        "unverified";
      assertMemberAccess(spec.memberAccess ?? "nonsuspended", status);
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
   * 400 VALIDATION_ERROR pada field `field` (bawaan `file_id`). Baris dikunci UPDATE bersyarat, sehingga job cleanup
   * (yang mengunci baris yang sama) tidak dapat menghapus berkas yang sedang dilampirkan.
   *
   *   await withTx(db, async (tx) => {
   *     const proof = await files.attach(tx, body.file_id, auth.userId, "payment_proof", { field: "file_id" });
   *     await tx.update(payments).set({ proofFileId: proof.id, ... })...
   *   });
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
   * Mengubah visibilitas berkas (PRD 5.4: avatar publik hanya sesuai kebijakan visibilitas). Hanya purpose yang
   * `publicAllowed` dapat dijadikan publik; berkas wajib `ready`. Mengembalikan baris terbaru.
   */
  async setVisibility(tx: DbOrTx, fileId: string, visibility: FileVisibility): Promise<FileRow> {
    const [file] = await tx.select().from(files).where(eq(files.id, fileId)).limit(1);
    if (!file || file.status !== "ready") throw notFound("Berkas tidak ditemukan.");
    if (visibility === "public" && !FILE_PURPOSE_SPECS[file.purpose as FilePurpose].publicAllowed)
      throw new Error(`Berkas ${file.purpose} tidak boleh publik (PRD 5.4)`);
    if (file.visibility === visibility) return file;
    const [updated] = await tx
      .update(files)
      .set({ visibility, updatedAt: this.clock.now() })
      .where(and(eq(files.id, fileId), eq(files.status, "ready")))
      .returning();
    if (!updated) throw notFound("Berkas tidak ditemukan.");
    return updated;
  }

  /**
   * Menghapus berkas yang diganti/tidak dipakai lagi: baris langsung `deleted` (tidak lagi dilayani) dan objek dihapus
   * setelah commit. Kegagalan hapus objek dicatat; pembersihan yang wajib terjamin (penghapusan akun) memakai
   * {@link deleteNow}. Wajib tx commit-aware (this.db.transaction dari DB yang diinjeksi, TxRunner, atau withTx).
   *
   * Retensi bukti moderasi (PRD 3.12, D2; kontrak C6 createReport "berkas yang dirujuk bukti ditahan"): berkas yang
   * dirujuk bukti laporan ({@link isRetainedAsEvidence}) TIDAK dihapus saat pesan dihapus atau avatar diganti; berkas
   * hanya dijadikan privat dan tetap `ready` untuk pengurus moderation.read, lalu false dikembalikan.
   */
  async discard(tx: Tx, fileId: string): Promise<boolean> {
    assertCommitAware(tx, "FilesService.discard");
    const now = this.clock.now();
    if (await this.isRetainedAsEvidence(tx, fileId)) {
      await tx
        .update(files)
        .set({ visibility: "private", updatedAt: now })
        .where(and(eq(files.id, fileId), ne(files.status, "deleted"), eq(files.visibility, "public")));
      return false;
    }
    const [row] = await tx
      .update(files)
      .set({ status: "deleted", deletedAt: now, updatedAt: now })
      .where(and(eq(files.id, fileId), ne(files.status, "deleted")))
      .returning({ objectKey: files.objectKey });
    if (!row) return false;
    afterCommit(() =>
      this.storage.delete(row.objectKey).catch((error: unknown) => {
        this.logger.warn(
          { error: safeError(error), file_id: fileId },
          "objek berkas gagal dihapus setelah discard",
        );
      }),
    );
    return true;
  }

  /**
   * true bila berkas dirujuk bukti laporan moderasi (`reports.evidence.file_ids`, ditulis modul moderation saat laporan
   * dibuat) DAN pemiliknya masih ada serta tidak sedang/sudah dihapus. D2: unggahan pengguna yang akunnya dihapus
   * tetap dihapus (job penghapusan akun), sehingga retensi tidak pernah menahan data pribadi setelah penghapusan.
   * Dibaca di transaksi pemanggil: modul moderation mengunci baris pesan/profil/room (FOR SHARE) saat mengambil
   * snapshot, sehingga penghapusan pesan/penggantian avatar yang bersamaan melihat laporan yang sudah commit.
   */
  async isRetainedAsEvidence(db: DbOrTx, fileId: string): Promise<boolean> {
    const [row] = rows<{ retained: number }>(
      await db.execute(sql`
        select 1 as retained
        from app.files f
        join app.users u on u.id = f.owner_user_id
        where f.id = ${fileId}
          and u.status not in ('deletion_pending', 'deleted')
          and exists (
            select 1 from app.reports r
            where (r.evidence -> ${REPORT_EVIDENCE_FILE_IDS_KEY}::text) @> to_jsonb(${fileId}::text)
          )
        limit 1`),
    );
    return row !== undefined;
  }

  /**
   * Menghapus objek lalu menandai baris `deleted` dalam satu transaksi dengan baris terkunci; galat storage
   * dilempar (baris tetap, pemanggil/job mengulang). `onlyIf` membatasi ke berkas sementara kedaluwarsa (job cleanup)
   * atau berkas ber-expires_at yang sudah lewat.
   */
  async deleteNow(fileId: string, onlyIf?: "unattached-expired" | "expired"): Promise<boolean> {
    return withTx(this.db, async (tx) => {
      const [row] = await tx.select().from(files).where(eq(files.id, fileId)).for("update");
      if (!row || row.status === "deleted") return false;
      const now = this.clock.now();
      if (
        onlyIf === "unattached-expired" &&
        (row.attachedAt || row.createdAt.getTime() > now.getTime() - TEMP_FILE_MAX_AGE_MS)
      )
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
   * kedaluwarsa opsional. Dipanggil job worker; objek ditulis lebih dulu lalu baris dicatat (objek dibuang bila
   * pencatatan gagal). Dengan `tx`, baris dicatat di transaksi pemanggil (mis. bersama entri audit
   * `audit.export.completed`, kontrak C7); bila transaksi itu kemudian batal, pemanggil wajib membuang objeknya lewat
   * {@link deleteStoredObject}.
   */
  async storeGenerated(input: {
    ownerUserId: string | null;
    purpose: FilePurpose;
    mime: string;
    body: ObjectBody;
    expiresAt?: Date | null;
    tx?: DbOrTx;
  }): Promise<FileRow> {
    const spec = FILE_PURPOSE_SPECS[input.purpose];
    if (spec.uploader !== "system") throw new Error(`Purpose ${input.purpose} bukan berkas buatan sistem`);
    const now = this.clock.now();
    const id = uuidv7();
    const objectKey = objectKeyFor(input.purpose, now, id);
    const stored = await this.storage.put(objectKey, input.body, { contentType: input.mime });
    try {
      const [row] = await (input.tx ?? this.db)
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

  /**
   * Membuang objek storage berkas buatan sistem yang barisnya batal dicatat (transaksi pemanggil
   * {@link storeGenerated} dengan `tx` rollback). Galat hapus hanya dicatat; objek yatim tidak pernah dilayani karena
   * tidak memiliki baris `files`.
   */
  async deleteStoredObject(objectKey: string): Promise<void> {
    await this.storage.delete(objectKey).catch((error: unknown) => {
      this.logger.warn({ error: safeError(error) }, "objek berkas buatan sistem gagal dibuang");
    });
  }

  // ------------------------------------------------------------------------------------------------ akses baca

  /**
   * Menambah kebijakan baca berkas privat untuk purpose (digabung OR dengan kebijakan bawaan dan modul lain).
   * Dipanggil modul di onModuleInit, mis. chat: anggota room boleh membuka chat_image di room itu.
   *
   * `replaceDefaults: true` (modul pemilik purpose): kebijakan BAWAAN core untuk purpose itu (mis. pemilik berkas)
   * tidak lagi dievaluasi, sehingga aturan modul menjadi penentu, mis. pengunggah chat_image yang sudah keluar room
   * tidak dapat membuka gambarnya (AC F11-4). Kebijakan yang didaftarkan modul lain tetap berlaku (OR), tidak
   * bergantung urutan inisialisasi modul.
   */
  registerAccessPolicy(
    purpose: FilePurpose,
    policy: FileAccessPolicy,
    options: { replaceDefaults?: boolean } = {},
  ): void {
    if (!(FILE_PURPOSES as readonly string[]).includes(purpose))
      throw new Error(`Purpose tidak dikenal: ${purpose}`);
    const list = this.modulePolicies.get(purpose) ?? [];
    list.push(policy);
    this.modulePolicies.set(purpose, list);
    if (options.replaceDefaults) this.replacedDefaults.add(purpose);
  }

  /**
   * Menambah kait akses untuk purpose (lihat {@link FileAccessHook}); dijalankan berurutan pada setiap
   * {@link accessFor} berkas privat yang diizinkan, termasuk GET /files/{fileId}/access.
   */
  registerAccessHook(purpose: FilePurpose, hook: FileAccessHook): void {
    if (!(FILE_PURPOSES as readonly string[]).includes(purpose))
      throw new Error(`Purpose tidak dikenal: ${purpose}`);
    const list = this.accessHooks.get(purpose) ?? [];
    list.push(hook);
    this.accessHooks.set(purpose, list);
  }

  /** true bila penampil boleh membuka berkas (publik selalu boleh). */
  async canAccess(file: FileRow, viewer: FileViewer, db: DbOrTx = this.db): Promise<boolean> {
    if (file.visibility === "public") return true;
    const purpose = file.purpose as FilePurpose;
    const policies = [
      ...(this.replacedDefaults.has(purpose) ? [] : (this.defaultPolicies.get(purpose) ?? [])),
      ...(this.modulePolicies.get(purpose) ?? []),
    ];
    for (const policy of policies) if (await policy({ file, viewer, db })) return true;
    return false;
  }

  /** Baris berkas `ready`, atau null (dipakai modul yang memvalidasi file_id sebelum melampirkan). */
  async findReady(fileId: string, db: DbOrTx = this.db): Promise<FileRow | null> {
    const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
    return file && file.status === "ready" ? file : null;
  }

  /**
   * GET /files/{fileId}/access: kebijakan diperiksa lebih dulu (TTL tidak menggantikan otorisasi, PRD 5.4), lalu URL
   * bertanda tangan <= 10 menit terikat berkas + purpose + penampil (user, sesi, session_version). Berkas yang tidak
   * ada, belum siap, atau tidak boleh dibuka → 404 (N-09). Berkas publik → URL publik tetap. Kait akses purpose
   * ({@link registerAccessHook}) dijalankan setelah izin lolos dan sebelum URL diterbitkan.
   */
  async accessFor(
    fileId: string,
    viewer: FileViewer,
    options: { ttlSeconds?: number } = {},
  ): Promise<FileAccessGrant> {
    const file = await this.findReady(fileId);
    if (!file) throw notFound("Berkas tidak ditemukan.");
    if (file.visibility === "public")
      return { url: this.publicUrl(file.id), expiresAt: null, mime: file.mime };
    if (!(await this.canAccess(file, viewer))) throw notFound("Berkas tidak ditemukan.");
    for (const hook of this.accessHooks.get(file.purpose as FilePurpose) ?? []) await hook({ file, viewer });
    const signed = await this.signedUrl(
      file,
      { userId: viewer.userId, sessionId: viewer.sessionId, sessionVersion: viewer.sessionVersion },
      options,
    );
    return { ...signed, mime: file.mime };
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
        sessionVersion: viewer?.sessionVersion ?? null,
      },
      this.clock.now(),
      options.ttlSeconds ?? FILE_URL_DEFAULT_TTL_SECONDS,
    );
    return { url: `${this.env.API_PUBLIC_URL}/api/v1/files/content/${token}`, expiresAt };
  }

  /** URL tetap berkas publik (cover berita/event, banner, avatar publik). */
  publicUrl(fileId: string): string {
    return `${this.env.API_PUBLIC_URL}/api/v1/files/public/${fileId}`;
  }

  /** Bentuk kontrak `FileRef` (tanpa object key maupun nama berkas asli). */
  toFileRef(file: FileRow): FileRefDto {
    return {
      id: file.id,
      purpose: file.purpose as FilePurpose,
      mime: file.mime,
      bytes: file.bytes,
      width: file.width,
      height: file.height,
      visibility: file.visibility as FileVisibility,
      public_url: file.visibility === "public" ? this.publicUrl(file.id) : null,
      created_at: file.createdAt.toISOString(),
    };
  }

  /**
   * GET /files/content/{token}: token sah dan belum kedaluwarsa, berkas `ready` dengan purpose yang sama. Bila URL
   * terikat sesi, otorisasi DIULANG saat dibuka (PRD 5.4: TTL tidak menggantikan otorisasi): sesi belum dicabut/
   * kedaluwarsa, session_version sama, akun aktif (admin: status admin aktif), lalu kebijakan akses purpose dievaluasi
   * dengan izin/effective_status terbaru. Logout, suspend, pencabutan izin, atau keluar room langsung mematikan URL
   * yang beredar. Selain itu 404.
   */
  async openContent(token: string): Promise<FileContent> {
    const now = this.clock.now();
    const claims = await verifyFileToken(this.urlKey, token, now);
    if (!claims) throw notFound(LINK_EXPIRED);
    const file = await this.findReady(claims.fileId);
    if (!file || file.purpose !== claims.purpose) throw notFound(LINK_EXPIRED);
    if (file.visibility === "private" && claims.sessionId) {
      const viewer = await this.viewerFor(claims, now);
      if (!viewer || !(await this.canAccess(file, viewer))) throw notFound(LINK_EXPIRED);
    }
    return { file, body: await this.readObject(file) };
  }

  /** GET /files/public/{fileId}: hanya berkas `ready` bervisibilitas publik. */
  async openPublic(fileId: string): Promise<FileContent> {
    const file = await this.findReady(fileId);
    if (!file || file.visibility !== "public") throw notFound("Berkas tidak ditemukan.");
    return { file, body: await this.readObject(file) };
  }

  /** Metadata berkas publik tanpa membuka objek (ETag/304). */
  async publicMeta(fileId: string): Promise<FileRow> {
    const file = await this.findReady(fileId);
    if (!file || file.visibility !== "public") throw notFound("Berkas tidak ditemukan.");
    return file;
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

  /**
   * Penampil terkini untuk token terikat sesi, dibangun dari database seperti AuthGuard (ARCHITECTURE §4.3): keluarga
   * sesi masih aktif (rotasi refresh setiap ±15 menit bukan pencabutan, kontrak C1 "Keluarga sesi"; logout/pencabutan
   * keluarga mematikan URL) dan session_version sama, akun aktif berjenis sesuai audience, admin aktif + izin dari
   * database (super_admin semua izin), anggota dengan effective_status nonsuspended (tingkat yang sama dengan
   * GET /files/{id}/access). null bila salah satu tidak terpenuhi.
   */
  private async viewerFor(claims: FileTokenClaims, now: Date): Promise<FileViewer | null> {
    if (!claims.userId || !claims.sessionId || claims.sessionVersion === null) return null;
    const [row] = await this.db
      .select({
        familyId: sessions.familyId,
        audience: sessions.audience,
        userStatus: users.status,
        userKind: users.kind,
        sessionVersion: users.sessionVersion,
        adminId: admins.id,
        adminRole: admins.role,
        adminStatus: admins.status,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .leftJoin(admins, eq(admins.userId, users.id))
      .where(and(eq(sessions.id, claims.sessionId), eq(sessions.userId, claims.userId)))
      .limit(1);
    if (!row || row.userStatus !== "active" || row.sessionVersion !== claims.sessionVersion) return null;
    const [active] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
      )
      .limit(1);
    if (!active) return null;
    const base = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      sessionVersion: claims.sessionVersion,
    };
    if (row.audience === "admin") {
      if (row.userKind !== "admin" || !row.adminId || row.adminStatus !== "active") return null;
      const permissions: ReadonlySet<Permission> =
        row.adminRole === "super_admin"
          ? new Set(PERMISSION_VALUES)
          : new Set(
              (
                await this.db
                  .select({ permission: adminPermissions.permission })
                  .from(adminPermissions)
                  .where(eq(adminPermissions.adminId, row.adminId))
              ).map((p) => p.permission as Permission),
            );
      return {
        ...base,
        audience: "admin",
        adminId: row.adminId,
        adminRole: row.adminRole,
        permissions,
        effectiveStatus: null,
      };
    }
    if (row.audience !== "mobile" || row.userKind !== "alumni") return null;
    const status = (await this.membership.effectiveStatusFor(claims.userId, { now }))?.status ?? "unverified";
    if (!memberAccessAllows("nonsuspended", status)) return null;
    return {
      ...base,
      audience: "mobile",
      adminId: null,
      adminRole: null,
      permissions: new Set(),
      effectiveStatus: status,
    };
  }
}
