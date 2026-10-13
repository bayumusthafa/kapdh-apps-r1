import {
  deviceTokens,
  events,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  paymentAdjustments,
  payments,
  reports,
  roomMembers,
  tickets,
  users,
} from "@kapdh/database";
import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../../core/db/types.js";
import type { SettingValue } from "../../core/settings/keys.js";
import { addBusinessDaysSql } from "./business-days.js";

/**
 * Definisi hitungan antrean yang DIBAGI dasbor dan lencana (kontrak C7 admin-dashboard) dengan daftar domain
 * pemiliknya, sehingga angka yang sama selalu dihasilkan satu rumus:
 * - pembayaran = AdminPaymentSummary / adminListPayments (C3),
 * - laporan = aturan visibilitas konflik kepentingan adminListReports (C6 admin-moderation butir a dan c),
 * - kegagalan pengiriman = AdminNotificationDelivery.retryable (C7 admin-notifications).
 * Modul payments, moderation dan notifications dapat memakai fungsi ini langsung (catatan integrasi).
 */

/** Literal timestamptz dari Clock aplikasi (ARCHITECTURE §2.6), tidak memakai now() database. */
export function tsLiteral(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}

// ------------------------------------------------------------------------------------------------ pembayaran

export type EventsPolicy = Pick<
  SettingValue<"events">,
  "review_escalation_business_days" | "checkin_before_hours"
>;

/** Pending berbukti, siap diputus (PaymentStage awaiting_review; total filter stage=awaiting_review). */
export const awaitingReviewSql = sql`(${payments.status} = 'pending' and ${payments.proofVersion} > 0)`;
/** Pending tanpa bukti (PaymentStage awaiting_transfer). */
export const awaitingTransferSql = sql`(${payments.status} = 'pending' and ${payments.proofVersion} = 0)`;

/**
 * `review_due_at` payment pending berbukti (kontrak C3 adminListPayments): iuran = submitted_at + 1 hari kerja; tiket =
 * yang lebih dahulu antara submitted_at + `review_escalation_business_days` hari kerja (D5) dan pembukaan check-in
 * event (`checkin_opens_at`, atau starts_at dikurangi `checkin_before_hours`). Memerlukan join tickets dan events.
 */
export function reviewDueAtSql(policy: EventsPolicy): SQL {
  const submitted = sql`${payments.submittedAt}`;
  return sql`(case when ${payments.type} = 'ticket' then least(${addBusinessDaysSql(
    submitted,
    policy.review_escalation_business_days,
  )}, coalesce(${events.checkinOpensAt}, ${events.startsAt} - (${policy.checkin_before_hours}::int * interval '1 hour'))) else ${addBusinessDaysSql(
    submitted,
    1,
  )} end)`;
}

export interface PaymentTypeCounts {
  registration: number;
  renewal: number;
  ticket: number;
}

export interface PaymentQueueSummary {
  awaitingReviewCount: number;
  awaitingReviewByType: PaymentTypeCounts;
  oldestSubmittedAt: Date | null;
  overdueCount: number;
  overdueByType: PaymentTypeCounts;
  awaitingTransferCount: number;
  adjustmentsPendingCount: number;
  adjustmentsOverdueCount: number;
}

const countWhere = (condition: SQL) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

/**
 * Ringkasan antrean pembayaran (C3 AdminPaymentSummary = C7 DashboardPayments): dua kueri agregat (payment pending dan
 * penyesuaian pending) tanpa memuat baris ke aplikasi. Lewat batas = waktu server melewati review_due_at.
 */
export async function paymentQueueSummary(
  db: DbOrTx,
  now: Date,
  policy: EventsPolicy,
): Promise<PaymentQueueSummary> {
  const overdue = sql`(${awaitingReviewSql} and ${tsLiteral(now)} > ${reviewDueAtSql(policy)})`;
  const typed = (condition: SQL, type: "registration" | "renewal" | "ticket") =>
    countWhere(sql`${condition} and ${payments.type} = ${type}`);
  const [queue] = await db
    .select({
      awaitingReview: countWhere(awaitingReviewSql),
      reviewRegistration: typed(awaitingReviewSql, "registration"),
      reviewRenewal: typed(awaitingReviewSql, "renewal"),
      reviewTicket: typed(awaitingReviewSql, "ticket"),
      oldestSubmittedAt: sql<Date | null>`min(${payments.submittedAt}) filter (where ${awaitingReviewSql})`.mapWith(
        payments.submittedAt,
      ),
      overdue: countWhere(overdue),
      overdueRegistration: typed(overdue, "registration"),
      overdueRenewal: typed(overdue, "renewal"),
      overdueTicket: typed(overdue, "ticket"),
      awaitingTransfer: countWhere(awaitingTransferSql),
    })
    .from(payments)
    .leftJoin(tickets, eq(tickets.id, payments.ticketId))
    .leftJoin(events, eq(events.id, tickets.eventId))
    .where(eq(payments.status, "pending"));
  const [adjustments] = await db
    .select({
      pending: sql<number>`count(*)`.mapWith(Number),
      overdue: countWhere(
        sql`${paymentAdjustments.dueAt} is not null and ${tsLiteral(now)} > ${paymentAdjustments.dueAt}`,
      ),
    })
    .from(paymentAdjustments)
    .where(eq(paymentAdjustments.status, "pending"));
  return {
    awaitingReviewCount: queue?.awaitingReview ?? 0,
    awaitingReviewByType: {
      registration: queue?.reviewRegistration ?? 0,
      renewal: queue?.reviewRenewal ?? 0,
      ticket: queue?.reviewTicket ?? 0,
    },
    oldestSubmittedAt: queue?.oldestSubmittedAt ?? null,
    overdueCount: queue?.overdue ?? 0,
    overdueByType: {
      registration: queue?.overdueRegistration ?? 0,
      renewal: queue?.overdueRenewal ?? 0,
      ticket: queue?.overdueTicket ?? 0,
    },
    awaitingTransferCount: queue?.awaitingTransfer ?? 0,
    adjustmentsPendingCount: adjustments?.pending ?? 0,
    adjustmentsOverdueCount: adjustments?.overdue ?? 0,
  };
}

// --------------------------------------------------------------------------------------------------- laporan

/** Laporan aktif (antrean bawaan adminListReports `status=active`). */
export const activeReportSql = sql`${reports.status} in ('open', 'in_review')`;

/**
 * Aturan konflik kepentingan butir a (C6 admin-moderation, AC F12-2, PRD 2.3): laporan yang pihak terlapornya akun
 * alumni tertaut pemanggil (target_user_id: pihak terlapor, pengirim pesan terlapor, subjek, atau pemohon banding),
 * atau laporan grup tanpa subjek yang pemanggilnya anggota joined grup itu, TIDAK terlihat. Berlaku juga untuk
 * super_admin. Tanpa tautan alumni semua laporan terlihat (undefined = tanpa predikat).
 */
export function reportsVisibleTo(linkedAlumniUserId: string | null): SQL | undefined {
  if (!linkedAlumniUserId) return undefined;
  return sql`not (coalesce(${reports.targetUserId} = ${linkedAlumniUserId}, false) or (${reports.targetType} = 'room' and ${reports.targetUserId} is null and exists (select 1 from ${roomMembers} where ${roomMembers.roomId} = ${reports.roomId} and ${roomMembers.userId} = ${linkedAlumniUserId} and ${roomMembers.status} = 'joined')))`;
}

export interface ReportQueueSummary {
  openCount: number;
  urgentCount: number;
  overdueCount: number;
  oldestOpenCreatedAt: Date | null;
}

/** Hitungan laporan aktif yang terlihat pemanggil (= AdminModerationQueueCounts pemanggil yang sama, butir c). */
export async function reportQueueSummary(
  db: DbOrTx,
  now: Date,
  linkedAlumniUserId: string | null,
): Promise<ReportQueueSummary> {
  const [row] = await db
    .select({
      open: sql<number>`count(*)`.mapWith(Number),
      urgent: countWhere(sql`${reports.priority} = 'urgent'`),
      overdue: countWhere(sql`${tsLiteral(now)} >= ${reports.dueAt}`),
      oldest: sql<Date | null>`min(${reports.createdAt})`.mapWith(reports.createdAt),
    })
    .from(reports)
    .where(and(activeReportSql, reportsVisibleTo(linkedAlumniUserId)));
  return {
    openCount: row?.open ?? 0,
    urgentCount: row?.urgent ?? 0,
    overdueCount: row?.overdue ?? 0,
    oldestOpenCreatedAt: row?.oldest ?? null,
  };
}

// ------------------------------------------------------------------------------------ pengiriman notifikasi

/** Jendela hitungan kegagalan pengiriman yang dapat ditindak (usulan kontrak C7: 7 hari). */
export const FAILED_DELIVERY_WINDOW_MS = 7 * 24 * 3600_000;

/**
 * AdminNotificationDelivery.retryable (C7): status failed DAN target masih sah, yaitu akun penerima `active`,
 * preferensi kategori/kanal tidak dimatikan (tanpa baris = aktif; security/account wajib), dan untuk push token belum
 * dicabut serta masih milik penerima notifikasi (AC F13-5). Memerlukan join notifications, users (penerima) dan
 * device_tokens (left join).
 */
export const retryableDeliverySql = sql`(${notificationDeliveries.status} = 'failed' and ${users.status} = 'active' and not exists (select 1 from ${notificationPreferences} where ${notificationPreferences.userId} = ${notifications.userId} and ${notificationPreferences.category} = ${notifications.category} and ${notificationPreferences.channel} = ${notificationDeliveries.channel} and ${notificationPreferences.enabled} = false) and (${notificationDeliveries.channel} = 'email' or (${deviceTokens.id} is not null and ${deviceTokens.revokedAt} is null and ${deviceTokens.userId} = ${notifications.userId})))`;

/** Jumlah kegagalan pengiriman yang dapat ditindak sejak `since` (= total daftar status=failed&retryable=true&from). */
export async function retryableFailedDeliveryCount(db: DbOrTx, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .innerJoin(users, eq(users.id, notifications.userId))
    .leftJoin(deviceTokens, eq(deviceTokens.id, notificationDeliveries.deviceTokenId))
    .where(
      and(
        eq(notificationDeliveries.status, "failed"),
        gte(notificationDeliveries.createdAt, since),
        retryableDeliverySql,
      ),
    );
  return row?.count ?? 0;
}
