/**
 * Target penanganan laporan (PRD 3.12 "disahkan v3.2", kontrak admin-moderation: aturan domain): risiko
 * ancaman/keselamatan (`violence_threat`) prioritas urgent dengan target 24 jam; kategori lain (termasuk banding)
 * normal dengan target 2 hari kerja Senin-Jumat WIB sejak laporan dibuat. Fungsi murni tanpa Clock; waktu dari
 * pemanggil (ARCHITECTURE §2 butir 6).
 */

export type ReportPriority = "normal" | "urgent";

/** Asia/Jakarta (WIB) tetap UTC+7 tanpa DST. */
const JAKARTA_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** Target urgent: 24 jam kalender (risiko ancaman/keselamatan tidak menunggu hari kerja). */
export const URGENT_SLA_MS = DAY_MS;
/** Target normal: 2 hari kerja (v3.2, D8). */
export const NORMAL_SLA_BUSINESS_DAYS = 2;

/** Kategori yang otomatis urgent (kontrak ModerationReportCategory: violence_threat). */
export function priorityFor(category: string): ReportPriority {
  return category === "violence_threat" ? "urgent" : "normal";
}

/**
 * Menambah `days` hari kerja (Senin-Jumat WIB) dengan jam dinding yang sama. Laporan yang dibuat Sabtu/Minggu mulai
 * dihitung Senin 00:00 WIB, sehingga "2 hari kerja" dari akhir pekan berakhir Selasa 24:00 WIB (Rabu 00:00).
 */
export function addBusinessDaysJakarta(at: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 0) throw new Error("Jumlah hari kerja tidak valid");
  // Field UTC dari `local` = jam dinding WIB.
  let local = new Date(at.getTime() + JAKARTA_OFFSET_MS);
  const weekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
  if (weekend(local)) {
    const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    local = new Date(midnight);
    while (weekend(local)) local = new Date(local.getTime() + DAY_MS);
  }
  let remaining = days;
  while (remaining > 0) {
    local = new Date(local.getTime() + DAY_MS);
    if (!weekend(local)) remaining--;
  }
  return new Date(local.getTime() - JAKARTA_OFFSET_MS);
}

/** due_at laporan/banding yang selalu diisi server saat insert (reports.due_at NOT NULL, migrasi 0006). */
export function dueAtFor(priority: ReportPriority, createdAt: Date): Date {
  return priority === "urgent"
    ? new Date(createdAt.getTime() + URGENT_SLA_MS)
    : addBusinessDaysJakarta(createdAt, NORMAL_SLA_BUSINESS_DAYS);
}
