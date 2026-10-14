import { type SQL, sql } from "drizzle-orm";

/**
 * Hitungan antrean dasbor dan lencana (kontrak C7 admin-dashboard) TIDAK memiliki rumus sendiri di modul admin: setiap
 * angka berasal dari fungsi bersama milik modul domainnya, sehingga dasbor selalu sama dengan daftar domain untuk
 * pemanggil yang sama (AC F15-1; uji `test/admin/queue-consistency.e2e.test.ts`):
 * - pembayaran = `PaymentsKernel.dashboardSummary` (kueri yang sama dengan GET /admin/payments/summary, `review_due_at`
 *   dan filter `overdue` adminListPayments; hari kerja `modules/payments/business-days.ts`),
 * - laporan = `ModerationVisibility.dashboardSummary` (aturan konflik kepentingan adminListReports butir a dan c,
 *   sama dengan `counts` antrean dan AdminNavBadges.reports_open),
 * - kegagalan pengiriman = `countActionableFailedDeliveries` modul notifications (definisi
 *   AdminNotificationDelivery.retryable, sama dengan total daftar `status=failed&retryable=true&from=`).
 */

/** Literal timestamptz dari Clock aplikasi (ARCHITECTURE §2.6), tidak memakai now() database. */
export function tsLiteral(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}

/** Jendela hitungan kegagalan pengiriman yang dapat ditindak (usulan kontrak C7: 7 hari). */
export const FAILED_DELIVERY_WINDOW_MS = 7 * 24 * 3600_000;
