import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { deviceTokens, files, otpCodes, sessions } from "@kapdh/database";
import { and, asc, eq, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../../core/db/types.js";
import { FilesService } from "../../core/files/files.service.js";
import { IdempotencyService } from "../../core/idempotency/idempotency.service.js";
import type { JobContext } from "../../core/jobs/job-registry.js";
import { JobRegistry } from "../../core/jobs/job-registry.js";
import { safeError } from "../../core/logging/safe-error.js";
import { DB } from "../../core/tokens.js";

const DAY_MS = 24 * 3600_000;
/** Interval job harian (ARCHITECTURE §4.8). */
export const MAINTENANCE_CLEANUP_EVERY_MS = DAY_MS;
/** Challenge OTP disimpan 7 hari setelah kedaluwarsa (jejak batas kirim ulang dan investigasi, PRD 2.5). */
export const OTP_RETENTION_MS = 7 * DAY_MS;
/** Baris sesi dihapus 30 hari setelah kedaluwarsa (deteksi pemakaian ulang refresh token tidak lagi relevan). */
export const SESSION_RETENTION_MS = 30 * DAY_MS;
/** Ekspor audit kedaluwarsa per eksekusi (sisanya pada jadwal berikut). */
const EXPORT_BATCH = 500;

export interface MaintenanceCleanupResult {
  idempotencyKeys: number;
  otpCodes: number;
  sessions: number;
  auditExports: number;
  auditExportFailures: number;
}

/**
 * Job `maintenance.cleanup` harian (ARCHITECTURE §4.8, pemilik core/admin): kunci idempotensi kedaluwarsa (24 jam,
 * PRD 4.3), challenge OTP lama, baris sesi lama yang tidak lagi dirujuk token push aktif, dan berkas ekspor audit
 * privat yang kedaluwarsa (AC F17-4: objek storage + baris `files` menjadi deleted sehingga status ekspor `expired`).
 * Idempoten: setiap langkah hanya menghapus yang sudah lewat batas pada `now`.
 */
@Injectable()
export class MaintenanceCleanupJob implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobRegistry,
    private readonly idempotency: IdempotencyService,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerScheduled({
      name: "maintenance.cleanup",
      everyMs: MAINTENANCE_CLEANUP_EVERY_MS,
      run: (now, ctx) => this.run(now, ctx).then(() => undefined),
    });
  }

  async run(now: Date, ctx?: JobContext): Promise<MaintenanceCleanupResult> {
    const idempotencyKeys = await this.idempotency.purgeExpired(now);
    const otp = await this.db
      .delete(otpCodes)
      .where(lt(otpCodes.expiresAt, new Date(now.getTime() - OTP_RETENTION_MS)))
      .returning({ id: otpCodes.id });
    const oldSessions = await this.db
      .delete(sessions)
      .where(
        and(
          lt(sessions.expiresAt, new Date(now.getTime() - SESSION_RETENTION_MS)),
          sql`not exists (select 1 from ${deviceTokens} where ${deviceTokens.sessionId} = ${sessions.id} and ${deviceTokens.revokedAt} is null)`,
        ),
      )
      .returning({ id: sessions.id });
    const expiredExports = await this.db
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          eq(files.purpose, "audit_export"),
          ne(files.status, "deleted"),
          isNotNull(files.expiresAt),
          lte(files.expiresAt, now),
        ),
      )
      .orderBy(asc(files.expiresAt))
      .limit(EXPORT_BATCH);
    let auditExports = 0;
    let auditExportFailures = 0;
    for (const { id } of expiredExports) {
      try {
        if (await this.files.deleteNow(id, "expired")) auditExports++;
      } catch (error) {
        auditExportFailures++;
        ctx?.logger.warn({ file_id: id, error: safeError(error) }, "berkas ekspor audit gagal dihapus");
      }
    }
    const result = {
      idempotencyKeys,
      otpCodes: otp.length,
      sessions: oldSessions.length,
      auditExports,
      auditExportFailures,
    };
    ctx?.logger.info(result, "pembersihan harian selesai");
    if (auditExportFailures > 0)
      throw new Error(
        `${auditExportFailures} berkas ekspor audit gagal dihapus; diulang pada jadwal berikut`,
      );
    return result;
  }
}
