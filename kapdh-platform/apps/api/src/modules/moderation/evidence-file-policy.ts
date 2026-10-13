import { Injectable, type OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { FileAccessPolicy } from "../../core/files/access-policy.js";
import { FilesService, REPORT_EVIDENCE_FILE_IDS_KEY } from "../../core/files/files.service.js";
import { rows } from "../../core/db/rows.js";

/**
 * Akses berkas bukti moderasi (PRD 3.12 "akses bukti dibatasi dan diaudit", 5.4): gambar pesan dan avatar
 * profil/grup yang dirujuk `reports.evidence` boleh dibuka sesi admin ber-izin moderation.read. URL bertanda tangan
 * (<= 10 menit, terikat sesi admin) hanya diterbitkan lewat detail laporan yang pembacaannya diaudit; saat URL dibuka,
 * FilesService mengevaluasi ulang kebijakan ini dengan izin terbaru dari database (pencabutan izin langsung berlaku).
 */
export const evidenceFilePolicy: FileAccessPolicy = async ({ file, viewer, db }) => {
  if (viewer.audience !== "admin" || !viewer.permissions.has("moderation.read")) return false;
  const [row] = rows<{ found: number }>(
    await db.execute(sql`
      select 1 as found from app.reports r
      where (r.evidence -> ${REPORT_EVIDENCE_FILE_IDS_KEY}::text) @> to_jsonb(${file.id}::text)
      limit 1`),
  );
  return row !== undefined;
};

/** Mendaftarkan kebijakan akses berkas bukti untuk purpose yang dapat dirujuk bukti (gambar chat dan avatar). */
@Injectable()
export class EvidenceFilePolicyRegistrar implements OnModuleInit {
  constructor(private readonly files: FilesService) {}

  onModuleInit(): void {
    this.files.registerAccessPolicy("chat_image", evidenceFilePolicy);
    this.files.registerAccessPolicy("avatar", evidenceFilePolicy);
  }
}
