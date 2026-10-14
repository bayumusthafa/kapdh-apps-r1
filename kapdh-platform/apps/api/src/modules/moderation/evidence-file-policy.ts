import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { admins, reports } from "@kapdh/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db, DbOrTx } from "../../core/db/types.js";
import type { FileAccessPolicy, FileViewer } from "../../core/files/access-policy.js";
import {
  type FileAccessHook,
  FilesService,
  REPORT_EVIDENCE_FILE_IDS_KEY,
} from "../../core/files/files.service.js";
import { DB } from "../../core/tokens.js";
import { reportVisibleTo } from "./moderation-visibility.js";

/** Jumlah maksimum id laporan yang dicatat pada satu audit `moderation.evidence_viewed`. */
const AUDITED_REPORT_IDS_MAX = 20;

/** Audit setiap pembukaan berkas bukti lewat GET /files/{fileId}/access (PRD 3.12, AC F17-1). */
export const EVIDENCE_VIEWED_ACTION = "moderation.evidence_viewed";

/** Pengurus yang dapat membaca bukti moderasi: sesi admin ber-izin moderation.read. */
function isModerator(viewer: FileViewer): viewer is FileViewer & { adminId: string } {
  return viewer.audience === "admin" && viewer.adminId !== null && viewer.permissions.has("moderation.read");
}

/**
 * Id laporan yang merujuk berkas di `evidence.file_ids` DAN terlihat bagi pengurus menurut aturan konflik kepentingan
 * (kontrak admin-moderation aturan domain butir a dan c; {@link reportVisibleTo}): laporan yang pihak terlapornya akun
 * alumni tertaut pengurus tidak pernah dihitung, sehingga ada/tidaknya laporan tersembunyi tidak dapat disimpulkan dari
 * perubahan 404 → 200 akses berkas. Akun tertaut dibaca dari database per evaluasi (FileViewer tidak membawanya, dan
 * URL bertanda tangan dievaluasi ulang saat dibuka sehingga penautan baru langsung berlaku).
 */
export async function visibleEvidenceReportIds(
  db: DbOrTx,
  fileId: string,
  adminId: string,
  limit: number,
): Promise<string[]> {
  const [admin] = await db
    .select({ linkedAlumniUserId: admins.linkedAlumniUserId })
    .from(admins)
    .where(eq(admins.id, adminId))
    .limit(1);
  if (!admin) return [];
  const found = await db
    .select({ id: reports.id })
    .from(reports)
    .where(
      and(
        sql`(${reports.evidence} -> ${REPORT_EVIDENCE_FILE_IDS_KEY}::text) @> to_jsonb(${fileId}::text)`,
        reportVisibleTo(admin.linkedAlumniUserId),
      ),
    )
    .orderBy(asc(reports.id))
    .limit(limit);
  return found.map((row) => row.id);
}

/**
 * Akses berkas bukti moderasi (PRD 3.12 "akses bukti dibatasi dan diaudit", 5.4): gambar pesan dan avatar
 * profil/grup yang dirujuk `reports.evidence` boleh dibuka sesi admin ber-izin moderation.read, HANYA bila minimal satu
 * laporan yang merujuknya terlihat bagi admin itu (aturan konflik kepentingan PRD 2.3, AC F12-2; detail laporan yang
 * sama juga 404 baginya). URL bertanda tangan (<= 10 menit, terikat sesi admin) diterbitkan lewat detail laporan yang
 * pembacaannya diaudit; saat URL dibuka, FilesService mengevaluasi ulang kebijakan ini dengan izin dan tautan terbaru
 * dari database (pencabutan izin atau penautan langsung berlaku).
 */
export const evidenceFilePolicy: FileAccessPolicy = async ({ file, viewer, db }) => {
  if (!isModerator(viewer)) return false;
  return (await visibleEvidenceReportIds(db, file.id, viewer.adminId, 1)).length > 0;
};

/**
 * Mendaftarkan kebijakan akses berkas bukti untuk purpose yang dapat dirujuk bukti (gambar chat dan avatar), serta kait
 * audit untuk GET /files/{fileId}/access: setiap URL bukti yang diterbitkan di luar detail laporan (yang sudah menulis
 * `moderation.report_viewed`) dicatat `moderation.evidence_viewed` SEBELUM URL diterbitkan; gagal mencatat = tanpa URL.
 */
@Injectable()
export class EvidenceFilePolicyRegistrar implements OnModuleInit {
  constructor(
    private readonly files: FilesService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  onModuleInit(): void {
    for (const purpose of ["chat_image", "avatar"] as const) {
      this.files.registerAccessPolicy(purpose, evidenceFilePolicy);
      this.files.registerAccessHook(purpose, this.auditEvidenceAccess);
    }
  }

  /**
   * Kait akses (dijalankan setelah kebijakan mana pun mengizinkan): bila penampil adalah pengurus moderation.read dan
   * berkas merupakan bukti laporan yang terlihat baginya, akses dicatat sebagai pembukaan bukti. Penampil lain (anggota
   * room, pengurus tanpa moderation.read) dan berkas yang bukan bukti laporan terlihat tidak dicatat. Isi bukti tidak
   * disalin ke audit (ARCHITECTURE §2 butir 3), hanya id berkas, purpose, dan id laporan.
   */
  private readonly auditEvidenceAccess: FileAccessHook = async ({ file, viewer }) => {
    if (!isModerator(viewer)) return;
    const reportIds = await visibleEvidenceReportIds(
      this.db,
      file.id,
      viewer.adminId,
      AUDITED_REPORT_IDS_MAX,
    );
    if (reportIds.length === 0) return;
    await this.db.transaction((tx) =>
      this.audit.write(tx, {
        action: EVIDENCE_VIEWED_ACTION,
        entityType: "file",
        entityId: file.id,
        after: { via: "file_access", purpose: file.purpose, report_ids: reportIds },
      }),
    );
  };
}
