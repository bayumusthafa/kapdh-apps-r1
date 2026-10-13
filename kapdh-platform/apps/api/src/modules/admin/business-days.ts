import { type SQL, sql } from "drizzle-orm";

/**
 * Hari kerja Senin sampai Jumat waktu Asia/Jakarta (kontrak C3 adminListPayments `review_due_at`, D5; tanpa kalender
 * libur nasional di R1.0). Menambah N hari kerja mempertahankan jam lokal: setiap langkah maju satu hari dan melewati
 * Sabtu/Minggu, sehingga Jumat 15.00 + 1 = Senin 15.00 dan Sabtu 10.00 + 1 = Senin 10.00 (titik awal akhir pekan
 * diperlakukan seperti Jumat jam yang sama). Jakarta tidak memakai DST sehingga selisih UTC selalu 7 jam.
 */
const DAY_MS = 24 * 3600_000;
const JAKARTA_OFFSET_MS = 7 * 3600_000;

/** Versi TypeScript (uji unit dan pembanding SQL). */
export function addBusinessDaysJakarta(at: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 0) throw new Error("Jumlah hari kerja wajib bilangan bulat >= 0");
  const local = new Date(at.getTime() + JAKARTA_OFFSET_MS);
  const isoDow = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
  const shift = isoDow === 6 ? 1 : isoDow === 7 ? 2 : 0;
  const baseDow = Math.min(isoDow, 5);
  const rest = days % 5;
  const offset = Math.floor(days / 5) * 7 + rest + (baseDow + rest > 5 ? 2 : 0);
  return new Date(at.getTime() + (offset - shift) * DAY_MS);
}

/**
 * Ekspresi SQL yang sama dengan {@link addBusinessDaysJakarta} untuk kolom/ekspresi timestamptz `at` dan `days`
 * (integer). Dipakai hitungan antrean dasbor agar tidak ada rumus kedua di klien (kontrak C7 DashboardPayments).
 */
export function addBusinessDaysSql(at: SQL, days: SQL | number): SQL {
  const n = typeof days === "number" ? sql`${days}::int` : sql`(${days})::int`;
  const local = sql`((${at}) at time zone 'Asia/Jakarta')`;
  const isoDow = sql`extract(isodow from ${local})::int`;
  const shift = sql`(case ${isoDow} when 6 then 1 when 7 then 2 else 0 end)`;
  const baseDow = sql`least(${isoDow}, 5)`;
  const offset = sql`((${n} / 5) * 7 + (${n} % 5) + case when ${baseDow} + (${n} % 5) > 5 then 2 else 0 end)`;
  // Aritmetika hari pada timestamp lokal (tanpa zona) agar tidak bergantung TimeZone sesi database.
  return sql`((${local} + ((${offset}) - ${shift}) * interval '1 day') at time zone 'Asia/Jakarta')`;
}
