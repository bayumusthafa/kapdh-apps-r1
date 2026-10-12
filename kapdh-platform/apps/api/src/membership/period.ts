/**
 * Periode keanggotaan (PRD 2.1, F-07).
 * - 12 bulan kalender dari waktu aktivasi, dihitung dalam waktu Asia/Jakarta (UTC+7, tanpa DST).
 * - Tanggal yang tidak ada di bulan tujuan memakai hari terakhir bulan tersebut dengan jam yang sama.
 * - Renewal dimulai dari max(expires_at lama, approved_at).
 * - Keanggotaan berakhir saat now >= expires_at; expiring bila sisa <= 30 hari dan > 0.
 */

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MEMBERSHIP_MONTHS = 12;
export const EXPIRING_WINDOW_DAYS = 30;

export function addCalendarMonthsJakarta(instant: Date, months: number): Date {
  const local = new Date(instant.getTime() + JAKARTA_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(local.getUTCDate(), lastDay);
  const resultLocal = Date.UTC(
    targetYear,
    targetMonth,
    day,
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return new Date(resultLocal - JAKARTA_OFFSET_MS);
}

export function registrationPeriod(approvedAt: Date) {
  return { startsAt: approvedAt, expiresAt: addCalendarMonthsJakarta(approvedAt, MEMBERSHIP_MONTHS) };
}

export function renewalPeriod(currentExpiresAt: Date | null, approvedAt: Date) {
  const startsAt = currentExpiresAt && currentExpiresAt > approvedAt ? currentExpiresAt : approvedAt;
  return { startsAt, expiresAt: addCalendarMonthsJakarta(startsAt, MEMBERSHIP_MONTHS) };
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

export function isExpiring(expiresAt: Date, now: Date): boolean {
  const remaining = expiresAt.getTime() - now.getTime();
  return remaining > 0 && remaining <= EXPIRING_WINDOW_DAYS * DAY_MS;
}

/** Jendela renewal dibuka 30 hari sebelum habis dan tetap terbuka setelah expired (disahkan v3.2). */
export function renewalOpensAt(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() - EXPIRING_WINDOW_DAYS * DAY_MS);
}
