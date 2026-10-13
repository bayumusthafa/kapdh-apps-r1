import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/**
 * Hari kerja Senin sampai Jumat waktu Asia/Jakarta (kontrak C3/C7; belum ada kalender libur nasional): batas review
 * iuran (1 hari kerja, prototipe screen_8), eskalasi review tiket (2 hari kerja, D5) dan tenggat refund (7 hari kerja,
 * D6). Fungsi JS dan ekspresi SQL di bawah memakai rumus yang sama sehingga antrean, filter `overdue`, urutan
 * `review_due_at_asc` dan ringkasan dasbor selalu sepakat.
 *
 * Aturan: setiap langkah maju satu hari kalender dengan jam yang sama dan melewati Sabtu/Minggu. Kiriman pada akhir
 * pekan dihitung seperti Jumat pada jam yang sama (Sabtu 10.00 + 1 hari kerja = Senin 10.00). Asia/Jakarta tanpa DST,
 * jadi menambah hari pada instant UTC sama dengan menambah hari kalender lokal.
 */

const JAKARTA_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** Jumlah hari kalender yang ditambahkan untuk `days` hari kerja dari hari ISO `isoDow` (1 = Senin ... 7 = Minggu). */
export function businessDayOffset(isoDow: number, days: number): number {
  if (!Number.isInteger(days) || days < 0) throw new Error("Jumlah hari kerja tidak valid");
  const weekday = Math.min(isoDow, 5);
  const back = Math.max(isoDow - 5, 0);
  return days + 2 * Math.floor((weekday - 1 + days) / 5) - back;
}

/** Hari ISO (1 = Senin ... 7 = Minggu) instant menurut Asia/Jakarta. */
export function jakartaIsoDow(instant: Date): number {
  const day = new Date(instant.getTime() + JAKARTA_OFFSET_MS).getUTCDay();
  return day === 0 ? 7 : day;
}

/** `instant` + `days` hari kerja (Senin-Jumat, Asia/Jakarta), jam yang sama. */
export function addBusinessDaysJakarta(instant: Date, days: number): Date {
  return new Date(instant.getTime() + businessDayOffset(jakartaIsoDow(instant), days) * DAY_MS);
}

/** Ekspresi SQL timestamptz: `column` + `days` hari kerja, rumus sama dengan {@link addBusinessDaysJakarta}. */
export function addBusinessDaysSql(column: AnyColumn | SQL, days: number): SQL {
  if (!Number.isInteger(days) || days < 0) throw new Error("Jumlah hari kerja tidak valid");
  const dow = sql`extract(isodow from (${column} at time zone 'Asia/Jakarta'))::int`;
  return sql`(${column} + make_interval(days => (${days}::int + 2 * ((least(${dow}, 5) - 1 + ${days}::int) / 5) - greatest(${dow} - 5, 0))))`;
}
