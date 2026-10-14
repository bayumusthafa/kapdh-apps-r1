import { Inject, Injectable } from "@nestjs/common";
import type { components, Permission } from "@kapdh/contracts";
import {
  accountDeletions,
  admins,
  alumni,
  events,
  outboxEvents,
  payments,
  tickets,
  users,
} from "@kapdh/database";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, type SQL, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import type { Db } from "../../core/db/types.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { effectiveStatus } from "../../core/membership/effective-status.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { ModerationVisibility } from "../moderation/moderation-visibility.js";
import { countActionableFailedDeliveries } from "../notifications/delivery-predicates.js";
import { PaymentsKernel } from "../payments/payments.kernel.js";
import { FAILED_DELIVERY_WINDOW_MS, tsLiteral } from "./queue-rules.js";

type AdminDashboard = components["schemas"]["AdminDashboard"];
type DashboardPayments = components["schemas"]["DashboardPayments"];
type DashboardMembers = components["schemas"]["DashboardMembers"];
type DashboardEvents = components["schemas"]["DashboardEvents"];
type DashboardUpcomingEvent = components["schemas"]["DashboardUpcomingEvent"];
type DashboardModeration = components["schemas"]["DashboardModeration"];
type DashboardJobs = components["schemas"]["DashboardJobs"];
type AdminNavBadges = components["schemas"]["AdminNavBadges"];
type EffectiveStatus = components["schemas"]["EffectiveStatus"];

const DAY_MS = 24 * 3600_000;
/** Cuplikan tabel dasbor maksimal 10 baris (kontrak C7). */
const SNIPPET = 10;
/** Jendela status expiring (PRD 2.2, D4): 30 hari. */
const EXPIRING_MS = 30 * DAY_MS;
/** Event mendatang 30 hari ke depan (kontrak DashboardUpcomingEvent). */
const UPCOMING_MS = 30 * DAY_MS;

const count = () => sql<number>`count(*)`.mapWith(Number);
const countWhere = (condition: ReturnType<typeof sql>) =>
  sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

/**
 * Dasbor pengurus sesuai izin (F-15, AC F15-1, PRD 3.15, guideline hlm. 11-12). Setiap bagian hanya dihitung dan
 * dikirim bila pemanggil memiliki izinnya (super_admin semua izin); izin dibaca AuthGuard dari database pada request
 * yang sama (AC F16-3). Semua hitungan berupa kueri agregat (tanpa memuat baris ke aplikasi) dan cuplikan dibatasi 10
 * baris; bagian dihitung paralel. Hitungan antrean pembayaran, laporan dan kegagalan pengiriman memakai fungsi bersama
 * modul pemilik domain (lihat queue-rules.ts), bukan rumus kedua.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly paymentsKernel: PaymentsKernel,
    private readonly moderationVisibility: ModerationVisibility,
  ) {}

  async dashboard(auth: AuthContext): Promise<AdminDashboard> {
    const now = this.clock.now();
    const can = (permission: Permission) => auth.permissions.has(permission);
    const [paymentsSection, membersSection, eventsSection, upcoming, moderation, jobs] = await Promise.all([
      can("payments.read") ? this.payments(now) : undefined,
      can("members.read") ? this.members(now) : undefined,
      can("events.manage") ? this.events() : undefined,
      can("events.manage") || can("events.checkin") ? this.upcomingEvents(now) : undefined,
      can("moderation.read") ? this.moderation(now, auth.linkedAlumniUserId) : undefined,
      can("notifications.manage") ? this.jobs(now) : undefined,
    ]);
    // Bagian tanpa izin DIHILANGKAN dari payload, bukan null atau nol (AC F15-1).
    const result: AdminDashboard = { generated_at: now.toISOString() };
    if (paymentsSection) result.payments = paymentsSection;
    if (membersSection) result.members = membersSection;
    if (eventsSection) result.events = eventsSection;
    if (upcoming) result.upcoming_events = upcoming;
    if (moderation) result.moderation = moderation;
    if (jobs) result.jobs = jobs;
    return result;
  }

  /** Lencana menu ringan (polling): field hanya ada bila izinnya dimiliki (AC F15-1). */
  async badges(auth: AuthContext): Promise<AdminNavBadges> {
    const now = this.clock.now();
    const result: AdminNavBadges = {};
    const [reportsOpen, failedJobs] = await Promise.all([
      auth.permissions.has("moderation.read")
        ? this.moderationVisibility.dashboardSummary(auth.linkedAlumniUserId, now).then((s) => s.open_count)
        : undefined,
      auth.permissions.has("notifications.manage")
        ? this.jobs(now).then((j) => j.failed_delivery_count + j.dead_outbox_count)
        : undefined,
    ]);
    if (reportsOpen !== undefined) result.reports_open = reportsOpen;
    if (failedJobs !== undefined) result.failed_jobs = failedJobs;
    return result;
  }

  // ------------------------------------------------------------------------------------------- pembayaran

  private async payments(now: Date): Promise<DashboardPayments> {
    const [queue, [totals], recent] = await Promise.all([
      this.paymentsKernel.dashboardSummary(now),
      this.db
        .select({
          // Total bruto payment paid sebelum penyesuaian (kartu "Total Transaksi"), aritmetika desimal di database.
          amount: sql<string>`coalesce(sum(${payments.amount}), 0)::numeric(20, 2)::text`,
          count: count(),
        })
        .from(payments)
        .where(eq(payments.status, "paid")),
      this.db
        .select({
          id: payments.id,
          type: payments.type,
          amount: payments.amount,
          decidedAt: payments.decidedAt,
          userId: payments.userId,
          accountStatus: users.status,
          fullName: alumni.fullName,
          memberNumber: alumni.memberNumber,
          eventTitle: events.title,
        })
        .from(payments)
        .leftJoin(users, eq(users.id, payments.userId))
        .leftJoin(alumni, eq(alumni.userId, payments.userId))
        .leftJoin(tickets, eq(tickets.id, payments.ticketId))
        .leftJoin(events, eq(events.id, tickets.eventId))
        .where(eq(payments.status, "paid"))
        .orderBy(desc(payments.decidedAt), desc(payments.id))
        .limit(SNIPPET),
    ]);
    const { summary } = queue;
    return {
      awaiting_review_count: summary.awaiting_review_count,
      awaiting_review_by_type: summary.awaiting_review_by_type,
      oldest_submitted_at: queue.oldestSubmittedAt?.toISOString() ?? null,
      overdue_count: summary.overdue_count,
      overdue_by_type: queue.overdueByType,
      awaiting_transfer_count: summary.awaiting_transfer_count,
      adjustments_pending_count: summary.adjustments_pending_count,
      adjustments_overdue_count: summary.adjustments_overdue_count,
      paid_total_amount: totals?.amount ?? "0.00",
      paid_count: totals?.count ?? 0,
      recent_transactions: recent.map((row) => {
        // Akun terhapus/anonim: identitas pemilik tidak pernah ditampilkan (D2, AC F14-4).
        const known = row.userId !== null && row.accountStatus !== null && row.accountStatus !== "deleted";
        return {
          payment_id: row.id,
          type: row.type,
          event_title: row.type === "ticket" ? (row.eventTitle ?? null) : null,
          member: {
            user_id: known ? row.userId : null,
            full_name: known ? (row.fullName ?? null) : null,
            member_number: known ? (row.memberNumber ?? null) : null,
          },
          amount: row.amount,
          paid_at: (row.decidedAt ?? now).toISOString(),
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------------------------- anggota

  private async members(now: Date): Promise<DashboardMembers> {
    const at = tsLiteral(now);
    const expiringUntil = tsLiteral(new Date(now.getTime() + EXPIRING_MS));
    const notSuspended = sql`${alumni.suspendedAt} is null`;
    const [[counts], latest] = await Promise.all([
      // Partisi effective_status (PRD 2.2, ARCHITECTURE §3.1) dari data canonical, satu agregat.
      this.db
        .select({
          total: count(),
          suspended: countWhere(sql`${alumni.suspendedAt} is not null`),
          unverified: countWhere(sql`${notSuspended} and ${alumni.expiresAt} is null`),
          expired: countWhere(sql`${notSuspended} and ${alumni.expiresAt} <= ${at}`),
          expiring: countWhere(
            sql`${notSuspended} and ${alumni.expiresAt} > ${at} and ${alumni.expiresAt} <= ${expiringUntil}`,
          ),
          verified: countWhere(sql`${notSuspended} and ${alumni.expiresAt} > ${expiringUntil}`),
        })
        .from(alumni)
        .innerJoin(users, eq(users.id, alumni.userId))
        .where(eq(users.status, "active")),
      this.db
        .select({
          userId: alumni.userId,
          fullName: alumni.fullName,
          memberNumber: alumni.memberNumber,
          expiresAt: alumni.expiresAt,
          suspendedAt: alumni.suspendedAt,
          registeredAt: users.createdAt,
          linkedAdmin:
            sql<boolean>`exists (select 1 from ${admins} where ${admins.linkedAlumniUserId} = ${alumni.userId} and ${admins.status} = 'active')`.mapWith(
              Boolean,
            ),
        })
        .from(alumni)
        .innerJoin(users, eq(users.id, alumni.userId))
        .where(eq(users.status, "active"))
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(SNIPPET),
    ]);
    const statusCounts = {
      unverified: counts?.unverified ?? 0,
      verified: counts?.verified ?? 0,
      expiring: counts?.expiring ?? 0,
      expired: counts?.expired ?? 0,
      suspended: counts?.suspended ?? 0,
    };
    return {
      total_alumni: counts?.total ?? 0,
      active_count: statusCounts.verified + statusCounts.expiring,
      status_counts: statusCounts,
      latest_members: latest.map((row) => ({
        user_id: row.userId,
        full_name: row.fullName,
        member_number: row.memberNumber,
        effective_status: effectiveStatus(
          { accountStatus: "active", expiresAt: row.expiresAt, suspendedAt: row.suspendedAt },
          now,
        ) as EffectiveStatus,
        linked_admin: row.linkedAdmin,
        registered_at: row.registeredAt.toISOString(),
      })),
    };
  }

  // ------------------------------------------------------------------------------------------------ event

  /**
   * Jumlah tiket per event yang memenuhi `condition`, sebagai subquery berkelompok untuk LEFT JOIN. Subquery berkorelasi
   * di daftar kolom tidak dipakai: pada kueri satu tabel Drizzle menulis kolom tanpa nama tabel sehingga
   * `event_id = id` akan terikat ke tabel tickets di dalam subquery.
   */
  private ticketCounts(name: string, condition: SQL) {
    return this.db
      .select({ eventId: tickets.eventId, n: sql<number>`count(*)`.mapWith(Number).as(`${name}_n`) })
      .from(tickets)
      .where(condition)
      .groupBy(tickets.eventId)
      .as(name);
  }

  private async events(): Promise<DashboardEvents> {
    const review = this.ticketCounts("review_counts", eq(tickets.status, "awaiting_review"));
    const [[sold], sales] = await Promise.all([
      this.db.select({ count: count() }).from(tickets).where(eq(tickets.status, "paid")),
      this.db
        .select({
          id: events.id,
          title: events.title,
          status: events.status,
          startsAt: events.startsAt,
          timezone: events.timezone,
          seatsTotal: events.seatsTotal,
          paid: events.paidQuantity,
          held: events.heldQuantity,
          awaitingReview: sql<number>`coalesce(${review.n}, 0)`.mapWith(Number),
        })
        .from(events)
        .leftJoin(review, eq(review.eventId, events.id))
        .where(ne(events.status, "draft"))
        .orderBy(desc(events.startsAt), desc(events.id))
        .limit(SNIPPET),
    ]);
    return {
      tickets_sold_count: sold?.count ?? 0,
      ticket_sales: sales.map((row) => ({
        event_id: row.id,
        title: row.title,
        status: row.status,
        starts_at: row.startsAt.toISOString(),
        timezone: row.timezone,
        seats_total: row.seatsTotal,
        sold_count: row.paid,
        held_count: row.held,
        seats_available: Math.max(0, row.seatsTotal - row.held - row.paid),
        awaiting_review_count: row.awaitingReview,
      })),
    };
  }

  private async upcomingEvents(now: Date): Promise<DashboardUpcomingEvent[]> {
    const window = and(
      inArray(events.status, ["open", "closed"]),
      gte(events.startsAt, now),
      lt(events.startsAt, new Date(now.getTime() + UPCOMING_MS)),
    );
    // Hanya tiket event dalam jendela 30 hari yang dihitung, sehingga biaya kueri tidak tumbuh dengan riwayat check-in.
    const checkedIn = this.ticketCounts(
      "checkin_counts",
      and(
        isNotNull(tickets.checkedInAt),
        inArray(tickets.eventId, this.db.select({ id: events.id }).from(events).where(window)),
      )!,
    );
    const rows = await this.db
      .select({
        id: events.id,
        title: events.title,
        status: events.status,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        timezone: events.timezone,
        locationName: events.locationName,
        seatsTotal: events.seatsTotal,
        paid: events.paidQuantity,
        held: events.heldQuantity,
        checkedIn: sql<number>`coalesce(${checkedIn.n}, 0)`.mapWith(Number),
      })
      .from(events)
      .leftJoin(checkedIn, eq(checkedIn.eventId, events.id))
      .where(window)
      .orderBy(asc(events.startsAt), asc(events.id))
      .limit(SNIPPET);
    return rows.map((row) => ({
      event_id: row.id,
      title: row.title,
      status: row.status,
      starts_at: row.startsAt.toISOString(),
      ends_at: row.endsAt.toISOString(),
      timezone: row.timezone,
      location_name: row.locationName,
      seats_total: row.seatsTotal,
      sold_count: row.paid,
      held_count: row.held,
      checked_in_count: row.checkedIn,
    }));
  }

  // -------------------------------------------------------------------------------------------- moderasi

  private moderation(now: Date, linkedAlumniUserId: string | null): Promise<DashboardModeration> {
    return this.moderationVisibility.dashboardSummary(linkedAlumniUserId, now);
  }

  // -------------------------------------------------------------------------------------------- job gagal

  private async jobs(now: Date): Promise<DashboardJobs> {
    const since = new Date(now.getTime() - FAILED_DELIVERY_WINDOW_MS);
    const [failedDeliveries, [outbox], [deletions]] = await Promise.all([
      countActionableFailedDeliveries(this.db, since),
      this.db
        .select({
          failed: countWhere(sql`${outboxEvents.status} = 'failed'`),
          dead: countWhere(sql`${outboxEvents.status} = 'dead'`),
          oldestPending:
            sql<Date | null>`min(${outboxEvents.createdAt}) filter (where ${outboxEvents.status} = 'pending')`.mapWith(
              outboxEvents.createdAt,
            ),
        })
        .from(outboxEvents)
        .where(inArray(outboxEvents.status, ["pending", "failed", "dead"])),
      this.db.select({ count: count() }).from(accountDeletions).where(eq(accountDeletions.status, "failed")),
    ]);
    return {
      failed_delivery_count: failedDeliveries,
      failed_delivery_since: since.toISOString(),
      failed_outbox_count: outbox?.failed ?? 0,
      dead_outbox_count: outbox?.dead ?? 0,
      oldest_pending_outbox_at: outbox?.oldestPending?.toISOString() ?? null,
      failed_account_deletion_count: deletions?.count ?? 0,
    };
  }
}
