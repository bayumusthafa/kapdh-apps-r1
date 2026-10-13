import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import {
  admins,
  alumni,
  events,
  paymentAdjustments,
  payments,
  roomMembers,
  rooms,
  tickets,
} from "@kapdh/database";
import { and, asc, count, eq, gt, inArray, isNull, lte, ne, not, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Clock } from "../../core/adapters/clock.js";
import type { DbOrTx } from "../../core/db/types.js";
import type { AccountStatus } from "../../core/membership/effective-status.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK } from "../../core/tokens.js";
import {
  BACKUP_RETENTION_DAYS,
  DELETED_DATA,
  DELETION_COMPLETION_DAYS,
  DISCLOSURE_TEXT_VERSION,
  PRIVACY_POLICY_SLUG,
  RETAINED_DATA,
} from "./deletion-policy.js";

type Disclosure = components["schemas"]["AccountDeletionDisclosure"];
type TicketWarning = components["schemas"]["AccountDeletionTicketWarning"];
type RefundPolicy = components["schemas"]["AccountDeletionRefundPolicy"];

const DAY_MS = 24 * 3600_000;
/** Batas item tiap daftar peringatan (kontrak maxItems 100). */
const WARNING_LIMIT = 100;
const ACTIVE_TICKET_STATUSES = ["awaiting_payment", "awaiting_review", "paid"] as const;

/**
 * Tiket yang hangus bila akun dihapus (PRD 3.9 "Akun dihapus: tiket hangus", D6): tiket aktif pada event yang belum
 * selesai (status bukan `done` dan `ends_at` belum lewat). Hold kedaluwarsa (`awaiting_payment` dengan
 * `hold_expires_at <= now`) diperlakukan sudah lepas seperti semua respons baca (aturan tag Events).
 * Predikat ini dipakai bersama pengungkapan (peringatan) dan job penghapusan (pelepasan kursi) agar keduanya selalu
 * sama.
 */
export function forfeitableTicketWhere(userId: string, now: Date) {
  return and(
    eq(tickets.userId, userId),
    inArray(tickets.status, [...ACTIVE_TICKET_STATUSES]),
    ne(events.status, "done"),
    gt(events.endsAt, now),
  );
}

/**
 * Pengungkapan wajib sebelum konfirmasi penghapusan (N-15, D2, F-14; kontrak AccountDeletionDisclosure) beserta
 * peringatan pribadi: tiket aktif dan kebijakan refund D6 yang berlaku bila pengguna bertindak SEBELUM menghapus,
 * refund yang belum ditransfer (PRD 4.4), pembayaran pending, grup yang admin tunggalnya pengguna (AC F14-5) dan
 * identitas pengurus tertaut (PRD 3.14). `version` adalah hash isi tersebut; konfirmasi wajib mengirim versi yang
 * sama (409 VERSION_CONFLICT bila berubah).
 */
@Injectable()
export class DeletionDisclosureService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  async compute(db: DbOrTx, user: { id: string; status: AccountStatus }): Promise<Disclosure> {
    const now = this.clock.now();
    const legal = await this.settings.get("legal");
    const base = {
      estimated_completion_days: DELETION_COMPLETION_DAYS,
      backup_retention_days: BACKUP_RETENTION_DAYS,
      deleted_data: DELETED_DATA.map((item) => ({ ...item })),
      retained_data: RETAINED_DATA.map((item) => ({ ...item })),
      privacy_policy_slug: PRIVACY_POLICY_SLUG,
      privacy_policy_version: legal.privacy_version,
    };
    // Pendaftaran pending_otp tidak dapat membayar, memesan tiket, bergabung grup atau ditautkan pengurus (F-14).
    if (user.status === "pending_otp")
      return this.withVersion(
        {
          ...base,
          active_tickets: [],
          pending_refunds: [],
          open_payments: [],
          sole_admin_group_count: 0,
          linked_admin_identity: false,
        },
        false,
      );

    const [member] = await db
      .select({ suspendedAt: alumni.suspendedAt })
      .from(alumni)
      .where(eq(alumni.userId, user.id));
    const suspended = member?.suspendedAt != null;
    const [activeTickets, pendingRefunds, openPayments, soleAdminGroups, linked] = await Promise.all([
      this.activeTickets(db, user.id, suspended, now),
      this.pendingRefunds(db, user.id),
      this.openPayments(db, user.id),
      this.soleAdminGroupCount(db, user.id),
      db.select({ id: admins.id }).from(admins).where(eq(admins.linkedAlumniUserId, user.id)).limit(1),
    ]);
    return this.withVersion(
      {
        ...base,
        active_tickets: activeTickets,
        pending_refunds: pendingRefunds,
        open_payments: openPayments,
        sole_admin_group_count: soleAdminGroups,
        linked_admin_identity: linked.length > 0,
      },
      suspended,
    );
  }

  private async activeTickets(
    db: DbOrTx,
    userId: string,
    suspended: boolean,
    now: Date,
  ): Promise<TicketWarning[]> {
    const { self_cancel_days: selfCancelDays } = await this.settings.get("events");
    const rows = await db
      .select({
        ticketId: tickets.id,
        status: tickets.status,
        total: tickets.totalSnapshot,
        holdExpiresAt: tickets.holdExpiresAt,
        eventId: events.id,
        title: events.title,
        startsAt: events.startsAt,
        timezone: events.timezone,
        eventStatus: events.status,
      })
      .from(tickets)
      .innerJoin(events, eq(events.id, tickets.eventId))
      .where(
        and(
          forfeitableTicketWhere(userId, now),
          // Hold kedaluwarsa sudah lepas menurut proyeksi baca (aturan tag Events).
          not(and(eq(tickets.status, "awaiting_payment"), lte(tickets.holdExpiresAt, now))!),
        ),
      )
      .orderBy(asc(events.startsAt), asc(tickets.id))
      .limit(WARNING_LIMIT);
    return rows.map((row) => {
      const free = Number(row.total) === 0;
      const deadline = free ? null : new Date(row.startsAt.getTime() - selfCancelDays * DAY_MS);
      const cancelled = row.eventStatus === "cancelled";
      const status = row.status as TicketWarning["status"];
      return {
        ticket_id: row.ticketId,
        event_id: row.eventId,
        event_title: row.title,
        event_starts_at: row.startsAt.toISOString(),
        event_timezone: row.timezone,
        event_cancelled: cancelled,
        status,
        total: row.total,
        refund_policy: refundPolicy({ status, suspended, cancelled, free, deadline, now }),
        self_cancel_deadline_at: deadline?.toISOString() ?? null,
      };
    });
  }

  private async pendingRefunds(db: DbOrTx, userId: string) {
    const ticket = alias(tickets, "refund_ticket");
    const event = alias(events, "refund_event");
    const rows = await db
      .select({
        adjustmentId: paymentAdjustments.id,
        paymentId: payments.id,
        type: payments.type,
        ticketId: payments.ticketId,
        title: event.title,
        amount: paymentAdjustments.amount,
        dueAt: paymentAdjustments.dueAt,
        destinationProvided: sql<boolean>`${paymentAdjustments.refundDestination} is not null`,
        createdAt: paymentAdjustments.createdAt,
      })
      .from(paymentAdjustments)
      .innerJoin(payments, eq(payments.id, paymentAdjustments.paymentId))
      .leftJoin(ticket, eq(ticket.id, payments.ticketId))
      .leftJoin(event, eq(event.id, ticket.eventId))
      .where(
        and(
          eq(payments.userId, userId),
          eq(paymentAdjustments.kind, "refund"),
          eq(paymentAdjustments.status, "pending"),
        ),
      )
      .orderBy(asc(paymentAdjustments.createdAt), asc(paymentAdjustments.id))
      .limit(WARNING_LIMIT);
    return rows.map((row) => ({
      adjustment_id: row.adjustmentId,
      payment_id: row.paymentId,
      payment_type: row.type,
      ticket_id: row.ticketId,
      event_title: row.title ?? null,
      amount: row.amount,
      due_at: row.dueAt?.toISOString() ?? null,
      destination_provided: Boolean(row.destinationProvided),
      created_at: row.createdAt.toISOString(),
    }));
  }

  private async openPayments(db: DbOrTx, userId: string) {
    const rows = await db
      .select({
        id: payments.id,
        type: payments.type,
        amount: payments.amount,
        proofVersion: payments.proofVersion,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(and(eq(payments.userId, userId), eq(payments.status, "pending")))
      .orderBy(asc(payments.createdAt), asc(payments.id))
      .limit(WARNING_LIMIT);
    return rows.map((row) => ({
      payment_id: row.id,
      type: row.type,
      amount: row.amount,
      proof_submitted: row.proofVersion >= 1,
      created_at: row.createdAt.toISOString(),
    }));
  }

  /** Grup aktif yang admin joined satu-satunya adalah pengguna (AC F14-5). */
  private async soleAdminGroupCount(db: DbOrTx, userId: string): Promise<number> {
    const other = alias(roomMembers, "other_admin");
    const [row] = await db
      .select({ value: count() })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(
        and(
          eq(roomMembers.userId, userId),
          eq(roomMembers.status, "joined"),
          eq(roomMembers.role, "admin"),
          eq(rooms.kind, "group"),
          isNull(rooms.closedAt),
          notExists(
            db
              .select({ one: sql`1` })
              .from(other)
              .where(
                and(
                  eq(other.roomId, roomMembers.roomId),
                  ne(other.userId, userId),
                  eq(other.status, "joined"),
                  eq(other.role, "admin"),
                ),
              ),
          ),
        ),
      );
    return Number(row?.value ?? 0);
  }

  /**
   * `version` opaque: hash isi pengungkapan dan peringatan pribadi (termasuk status suspend dan kebijakan refund yang
   * bergantung waktu), sehingga tiket/refund/pembayaran/kebijakan yang berubah memaksa pengguna membaca ulang.
   */
  private withVersion(content: Omit<Disclosure, "version">, suspended: boolean): Disclosure {
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          t: DISCLOSURE_TEXT_VERSION,
          p: content.privacy_policy_version,
          s: suspended,
          a: content.active_tickets.map((x) => [
            x.ticket_id,
            x.status,
            x.total,
            x.refund_policy,
            x.event_cancelled,
            x.self_cancel_deadline_at,
          ]),
          r: content.pending_refunds.map((x) => [x.adjustment_id, x.amount, x.due_at, x.destination_provided]),
          o: content.open_payments.map((x) => [x.payment_id, x.type, x.amount, x.proof_submitted]),
          g: content.sole_admin_group_count,
          l: content.linked_admin_identity,
        }),
      )
      .digest("hex");
    return { version: `d${DISCLOSURE_TEXT_VERSION}.${digest.slice(0, 40)}`, ...content };
  }
}

/** Kebijakan refund D6 yang berlaku bila pengguna bertindak sebelum menghapus (kontrak AccountDeletionRefundPolicy). */
export function refundPolicy(input: {
  status: TicketWarning["status"];
  suspended: boolean;
  cancelled: boolean;
  free: boolean;
  deadline: Date | null;
  now: Date;
}): RefundPolicy {
  if (input.status !== "paid") return "payment_pending";
  if (input.suspended) return "case_by_case";
  if (input.free) return "no_refund";
  if (input.cancelled) return "full_refund";
  return input.deadline && input.now < input.deadline ? "full_refund" : "no_refund";
}
