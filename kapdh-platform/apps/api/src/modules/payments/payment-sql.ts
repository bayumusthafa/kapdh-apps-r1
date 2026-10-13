import { events, paymentAdjustments, payments, tickets } from "@kapdh/database";
import { type AnyColumn, and, asc, count, desc, eq, gt, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../../core/db/types.js";
import { addBusinessDaysSql } from "./business-days.js";
import type { ReviewRules } from "./payment-rules.js";

/**
 * Ekspresi SQL bersama antrean pembayaran (kontrak C3 adminListPayments/adminGetPaymentSummary dan C7
 * DashboardPayments): rumusnya sama dengan fungsi JS di payment-rules.ts.
 */

/**
 * `review_due_at` payment pending berbukti: iuran `submitted_at` + 1 hari kerja; tiket yang lebih dahulu antara
 * `submitted_at` + `review_escalation_business_days` dan pembukaan check-in. Memerlukan LEFT JOIN tickets dan events
 * pada payment (lihat PaymentViews.adminRowsQuery).
 */
export function reviewDueSql(rules: ReviewRules): SQL<Date | null> {
  const ticketDue = sql`least(${addBusinessDaysSql(payments.submittedAt, rules.ticketBusinessDays)}, coalesce(${events.checkinOpensAt}, ${events.startsAt} - make_interval(hours => ${rules.checkinBeforeHours}::int)))`;
  const duesDue = addBusinessDaysSql(payments.submittedAt, rules.duesBusinessDays);
  return sql`(case when ${payments.status} = 'pending' and ${payments.proofVersion} >= 1 and ${payments.submittedAt} is not null then (case when ${payments.type} = 'ticket' and ${events.id} is not null then ${ticketDue} else ${duesDue} end) end)`.mapWith(
    payments.submittedAt,
  ) as SQL<Date | null>;
}

const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Kunci waktu di dalam cursor keyset: hanya bentuk kanonik `Date.toISOString()` (yang ditulis `cursorOf`) dengan
 * tanggal sah tahun 1..9999. Cursor yang dimanipulasi (bukan tanggal, 31 Februari, tahun 0) gagal di validasi skema
 * sehingga decodeCursor menjawab 400 VALIDATION_ERROR field `cursor` (kontrak root.yaml Cursor, PRD 7.3), bukan
 * 500 dari cast `::timestamptz` PostgreSQL.
 */
export const cursorTimestamp = z.string().refine((value) => {
  if (!CANONICAL_ISO.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 1 && date.toISOString() === value;
}, "Cursor tidak valid");

/** Literal timestamptz untuk perbandingan SQL (presisi milidetik dari Clock aplikasi). */
export function tsParam(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}

/** Escape pola LIKE (backslash adalah karakter escape bawaan PostgreSQL). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export type SortDirection = "asc" | "desc";

/**
 * Predikat keyset "sesudah cursor" untuk kunci urut yang BOLEH null dengan NULLS LAST di kedua arah, ditambah id
 * sebagai pemutus seri: (k > v) OR (k = v AND id > c) OR (k IS NULL) untuk asc; cursor di kelompok null → (k IS NULL
 * AND id > c). Arah id mengikuti arah kunci.
 */
export function nullableKeysetAfter(
  key: AnyColumn | SQL,
  idColumn: AnyColumn,
  direction: SortDirection,
  cursor: { k: string | null; id: string },
): SQL {
  const idStep = direction === "asc" ? gt(idColumn, cursor.id) : lt(idColumn, cursor.id);
  if (cursor.k === null) return and(sql`${key} is null`, idStep)!;
  const value = sql`${cursor.k}::timestamptz`;
  const step = direction === "asc" ? sql`${key} > ${value}` : sql`${key} < ${value}`;
  return or(step, and(sql`${key} = ${value}`, idStep), sql`${key} is null`)!;
}

/** ORDER BY pasangan {@link nullableKeysetAfter}. */
export function nullableOrderBy(key: AnyColumn | SQL, idColumn: AnyColumn, direction: SortDirection): SQL[] {
  return direction === "asc"
    ? [sql`${key} asc nulls last`, asc(idColumn)]
    : [sql`${key} desc nulls last`, desc(idColumn)];
}

/** Ringkasan antrean (kontrak AdminPaymentSummary; dipakai juga dasbor C7 lewat PaymentsKernel.summary). */
export interface PaymentQueueSummary {
  awaiting_review_count: number;
  overdue_count: number;
  awaiting_transfer_count: number;
  awaiting_review_by_type: { registration: number; renewal: number; ticket: number };
  adjustments_pending_count: number;
  adjustments_overdue_count: number;
  generated_at: string;
}

export async function paymentQueueSummary(
  db: DbOrTx,
  rules: ReviewRules,
  now: Date,
): Promise<PaymentQueueSummary> {
  const due = reviewDueSql(rules);
  const awaitingReview = sql`${payments.proofVersion} >= 1`;
  const counted = (condition: SQL) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
  const [queue] = await db
    .select({
      awaitingReview: counted(awaitingReview),
      overdue: counted(sql`${due} <= ${tsParam(now)}`),
      awaitingTransfer: counted(sql`${payments.proofVersion} = 0`),
      registration: counted(sql`${awaitingReview} and ${payments.type} = 'registration'`),
      renewal: counted(sql`${awaitingReview} and ${payments.type} = 'renewal'`),
      ticket: counted(sql`${awaitingReview} and ${payments.type} = 'ticket'`),
    })
    .from(payments)
    .leftJoin(tickets, eq(tickets.id, payments.ticketId))
    .leftJoin(events, eq(events.id, tickets.eventId))
    .where(eq(payments.status, "pending"));
  const [adjustments] = await db
    .select({
      pending: count(),
      overdue: counted(
        sql`${paymentAdjustments.dueAt} is not null and ${paymentAdjustments.dueAt} <= ${tsParam(now)}`,
      ),
    })
    .from(paymentAdjustments)
    .where(eq(paymentAdjustments.status, "pending"));
  return {
    awaiting_review_count: queue?.awaitingReview ?? 0,
    overdue_count: queue?.overdue ?? 0,
    awaiting_transfer_count: queue?.awaitingTransfer ?? 0,
    awaiting_review_by_type: {
      registration: queue?.registration ?? 0,
      renewal: queue?.renewal ?? 0,
      ticket: queue?.ticket ?? 0,
    },
    adjustments_pending_count: Number(adjustments?.pending ?? 0),
    adjustments_overdue_count: adjustments?.overdue ?? 0,
    generated_at: now.toISOString(),
  };
}
