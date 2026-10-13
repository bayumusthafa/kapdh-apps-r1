import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import {
  admins,
  alumni,
  categories,
  events,
  files,
  paymentAdjustments,
  payments,
  tickets,
  users,
} from "@kapdh/database";
import { and, asc, count, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import type { DbOrTx } from "../../core/db/types.js";
import type { FileAccessPolicy } from "../../core/files/access-policy.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import type { EffectiveStatus } from "../../core/membership/effective-status.js";
import { cohortCode } from "../../core/membership/member-number.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK } from "../../core/tokens.js";
import { money, toCents } from "../payments/money.js";
import {
  type AdjustmentRow,
  type PaymentRow,
  readMethodSnapshot,
  reviewDueAt,
  reviewRulesOf,
} from "../payments/payment-rules.js";
import {
  adminCanCancel,
  allowedActions,
  cancellationPolicy,
  checkinWindow,
  type EventRow,
  type EventsSetting,
  fullRefundUntil,
  holderEligible,
  memberCanCancel,
  memberRefundEligible,
  projectedTicketStatus,
  registrationState,
  reservationBlockReason,
  seatProjection,
  ticketActive,
  type TicketRow,
} from "./event-rules.js";

type Schemas = components["schemas"];
export type EventSummaryDto = Schemas["EventSummary"];
export type EventDetailDto = Schemas["EventDetail"];
export type TicketSummaryDto = Schemas["TicketSummary"];
export type TicketDetailDto = Schemas["TicketDetail"];
export type AdminEventSummaryDto = Schemas["AdminEventSummary"];
export type AdminEventDetailDto = Schemas["AdminEventDetail"];
export type AdminEventTicketDto = Schemas["AdminEventTicket"];
export type AdminEventActorDto = Schemas["AdminEventActor"];

/** Penampil anggota (sesi mobile): id dan effective_status terkini dari AuthGuard. */
export interface MemberViewer {
  userId: string;
  status: EffectiveStatus | null;
}

/** Penampil pengurus untuk URL avatar bertanda tangan dan `can_refund` (PRD 2.3). */
export type AdminViewer = Pick<
  AuthContext,
  "userId" | "sessionId" | "sessionVersion" | "permissions" | "linkedAlumniUserId"
>;

/** Data tambahan per event yang dimuat berkelompok untuk daftar dan detail. */
export interface EventExtras {
  category: Schemas["EventCategoryRef"] | null;
  coverUrl: string | null;
  /** Hold awaiting_payment yang sudah lewat tetapi belum dilepas (proyeksi kursi). */
  lapsed: number;
}

/** Data pemegang tiket untuk pengurus (minimum, tanpa kontak; AC F14-4 anonim sesudah akun dihapus). */
interface HolderRow {
  userId: string;
  accountStatus: string;
  fullName: string;
  memberNumber: string | null;
  cohort: number;
  avatarFileId: string | null;
  suspended: boolean;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/** Rekaman pengurus yang sudah dihapus (FK SET NULL) tetap tampil tanpa id (kontrak AdminEventActor). */
const DELETED_ADMIN_NAME = "Pengurus (akun dihapus)";

/**
 * Pembentuk DTO kontrak C5 (events.yaml, admin-events.yaml) dan pemuat data berkelompok. Semua angka kursi dan status
 * tiket memakai PROYEKSI BACA aturan tag Events: hold kedaluwarsa yang belum dilepas job tampil expired dan tidak
 * dihitung, tanpa pernah menulis (AC F09-1, F09-2).
 */
@Injectable()
export class EventViews implements OnModuleInit {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly files: FilesService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Avatar pemegang tiket boleh dibuka pengurus events.manage/events.checkin (pencocokan visual saat check-in dan
   * tabel peserta), hanya untuk berkas avatar milik anggota yang memegang tiket. Digabung OR dengan kebijakan core.
   */
  onModuleInit(): void {
    this.files.registerAccessPolicy("avatar", this.ticketHolderAvatarPolicy);
  }

  private readonly ticketHolderAvatarPolicy: FileAccessPolicy = async ({ file, viewer, db }) => {
    const staff =
      viewer.audience === "admin" &&
      (viewer.permissions.has("events.manage") || viewer.permissions.has("events.checkin"));
    if (!staff) return false;
    const [holder] = await db
      .select({ userId: alumni.userId })
      .from(alumni)
      .innerJoin(tickets, eq(tickets.userId, alumni.userId))
      .where(eq(alumni.avatarFileId, file.id))
      .limit(1);
    return holder !== undefined;
  };

  now(): Date {
    return this.clock.now();
  }

  eventsSetting(): Promise<EventsSetting> {
    return this.settings.get("events");
  }

  // -------------------------------------------------------------------------------------------- pemuat kelompok

  async extrasFor(db: DbOrTx, rows: readonly EventRow[], now: Date): Promise<Map<string, EventExtras>> {
    const ids = rows.map((row) => row.id);
    const categoryIds = [...new Set(rows.map((row) => row.categoryId).filter((id): id is string => !!id))];
    const coverIds = [...new Set(rows.map((row) => row.coverFileId).filter((id): id is string => !!id))];
    const [categoryRows, coverRows, lapsedRows] = await Promise.all([
      categoryIds.length
        ? db
            .select({ id: categories.id, slug: categories.slug, label: categories.label })
            .from(categories)
            .where(inArray(categories.id, categoryIds))
        : Promise.resolve([]),
      coverIds.length
        ? db
            .select({ id: files.id })
            .from(files)
            .where(
              and(
                inArray(files.id, coverIds),
                eq(files.status, "ready"),
                eq(files.visibility, "public"),
              ),
            )
        : Promise.resolve([]),
      ids.length
        ? db
            .select({ eventId: tickets.eventId, n: count() })
            .from(tickets)
            .where(
              and(
                inArray(tickets.eventId, ids),
                eq(tickets.status, "awaiting_payment"),
                lte(tickets.holdExpiresAt, now),
              ),
            )
            .groupBy(tickets.eventId)
        : Promise.resolve([]),
    ]);
    const categoryById = new Map(categoryRows.map((row) => [row.id, row]));
    const covers = new Set(coverRows.map((row) => row.id));
    const lapsed = new Map(lapsedRows.map((row) => [row.eventId, Number(row.n)]));
    return new Map(
      rows.map((row) => [
        row.id,
        {
          category: row.categoryId ? (categoryById.get(row.categoryId) ?? null) : null,
          coverUrl:
            row.coverFileId && covers.has(row.coverFileId) ? this.files.publicUrl(row.coverFileId) : null,
          lapsed: lapsed.get(row.id) ?? 0,
        },
      ]),
    );
  }

  /** Tiket terbaru pemanggil per event (status apa pun). */
  async latestTickets(db: DbOrTx, userId: string, eventIds: readonly string[]): Promise<Map<string, TicketRow>> {
    if (eventIds.length === 0) return new Map();
    const rows = await db
      .selectDistinctOn([tickets.eventId])
      .from(tickets)
      .where(and(eq(tickets.userId, userId), inArray(tickets.eventId, [...eventIds])))
      .orderBy(tickets.eventId, desc(tickets.createdAt), desc(tickets.id));
    return new Map(rows.map((row) => [row.eventId, row]));
  }

  async eventsWithTickets(db: DbOrTx, eventIds: readonly string[]): Promise<Set<string>> {
    if (eventIds.length === 0) return new Set();
    const rows = await db
      .selectDistinct({ eventId: tickets.eventId })
      .from(tickets)
      .where(inArray(tickets.eventId, [...eventIds]));
    return new Set(rows.map((row) => row.eventId));
  }

  async checkedInCounts(db: DbOrTx, eventIds: readonly string[]): Promise<Map<string, number>> {
    if (eventIds.length === 0) return new Map();
    const rows = await db
      .select({ eventId: tickets.eventId, n: count() })
      .from(tickets)
      .where(and(inArray(tickets.eventId, [...eventIds]), isNotNull(tickets.checkedInAt)))
      .groupBy(tickets.eventId);
    return new Map(rows.map((row) => [row.eventId, Number(row.n)]));
  }

  async adminNames(db: DbOrTx, adminIds: readonly (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(adminIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({ id: admins.id, name: admins.displayName })
      .from(admins)
      .where(inArray(admins.id, ids));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async paymentsForTickets(db: DbOrTx, ticketIds: readonly string[]): Promise<Map<string, PaymentRow>> {
    if (ticketIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(payments)
      .where(inArray(payments.ticketId, [...ticketIds]));
    return new Map(rows.map((row) => [row.ticketId!, row]));
  }

  async refundsForPayments(
    db: DbOrTx,
    paymentIds: readonly string[],
  ): Promise<Map<string, AdjustmentRow[]>> {
    const map = new Map<string, AdjustmentRow[]>();
    if (paymentIds.length === 0) return map;
    const rows = await db
      .select()
      .from(paymentAdjustments)
      .where(and(inArray(paymentAdjustments.paymentId, [...paymentIds]), eq(paymentAdjustments.kind, "refund")))
      .orderBy(desc(paymentAdjustments.createdAt), desc(paymentAdjustments.id));
    for (const row of rows) {
      const list = map.get(row.paymentId) ?? [];
      list.push(row);
      map.set(row.paymentId, list);
    }
    return map;
  }

  async holdersFor(db: DbOrTx, userIds: readonly (string | null)[]): Promise<Map<string, HolderRow>> {
    const ids = [...new Set(userIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({
        userId: users.id,
        accountStatus: users.status,
        fullName: alumni.fullName,
        memberNumber: alumni.memberNumber,
        cohort: alumni.cohort,
        avatarFileId: alumni.avatarFileId,
        suspendedAt: alumni.suspendedAt,
      })
      .from(users)
      .innerJoin(alumni, eq(alumni.userId, users.id))
      .where(inArray(users.id, ids));
    return new Map(
      rows.map((row) => [
        row.userId,
        {
          userId: row.userId,
          accountStatus: row.accountStatus,
          fullName: row.fullName,
          memberNumber: row.memberNumber,
          cohort: row.cohort,
          avatarFileId: row.avatarFileId,
          suspended: row.suspendedAt !== null,
        },
      ]),
    );
  }

  /** URL avatar bertanda tangan untuk penampil (≤ 10 menit, dinilai ulang kebijakan saat dibuka; PRD 5.4). */
  async avatarUrls(
    db: DbOrTx,
    fileIds: readonly (string | null)[],
    viewer: Pick<AuthContext, "userId" | "sessionId" | "sessionVersion">,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(fileIds.filter((id): id is string => !!id))];
    const urls = new Map<string, string>();
    if (ids.length === 0) return urls;
    const ready = await db
      .select({ id: files.id, purpose: files.purpose, visibility: files.visibility })
      .from(files)
      .where(and(inArray(files.id, ids), eq(files.status, "ready"), eq(files.purpose, "avatar")));
    for (const file of ready) {
      const { url } = await this.files.signedUrl(file, {
        userId: viewer.userId,
        sessionId: viewer.sessionId,
        sessionVersion: viewer.sessionVersion,
      });
      urls.set(file.id, url);
    }
    return urls;
  }

  // ------------------------------------------------------------------------------------------- DTO anggota

  eventSummary(
    event: EventRow,
    extras: EventExtras,
    myTicket: TicketRow | null,
    now: Date,
  ): EventSummaryDto {
    const seats = seatProjection(event, extras.lapsed);
    return {
      id: event.id,
      title: event.title,
      category: extras.category,
      cover_url: extras.coverUrl,
      starts_at: event.startsAt.toISOString(),
      ends_at: event.endsAt.toISOString(),
      timezone: event.timezone,
      location_name: event.locationName,
      status: event.status,
      registration_state: registrationState(event, seats.available, now),
      price: money(event.price),
      is_free: toCents(event.price) === 0n,
      seats_total: event.seatsTotal,
      seats_available: seats.available,
      my_ticket_status: myTicket ? projectedTicketStatus(myTicket, now) : null,
    };
  }

  eventDetail(
    event: EventRow,
    extras: EventExtras,
    viewer: MemberViewer,
    myTicket: TicketRow | null,
    myPayment: PaymentRow | null,
    setting: EventsSetting,
    now: Date,
  ): EventDetailDto {
    const summary = this.eventSummary(event, extras, myTicket, now);
    const window = checkinWindow(event, setting.checkin_before_hours);
    const block = reservationBlockReason({
      status: viewer.status,
      hasActiveTicket: myTicket !== null && ticketActive(myTicket, now),
      registration: summary.registration_state,
    });
    return {
      ...summary,
      description: event.description,
      location_address: event.locationAddress,
      location_url: event.locationUrl,
      registration_opens_at: event.registrationOpensAt.toISOString(),
      registration_closes_at: event.registrationClosesAt.toISOString(),
      checkin_opens_at: window.opensAt.toISOString(),
      checkin_closes_at: window.closesAt.toISOString(),
      hold_hours: setting.hold_hours,
      participant_count: event.paidQuantity,
      cancellation_policy: cancellationPolicy(event, setting),
      cancelled_at: iso(event.cancelledAt),
      cancel_reason: event.cancelReason,
      can_reserve: block === null,
      reservation_blocked_reason: block,
      my_ticket: myTicket ? this.ticketSummary(myTicket, event, myPayment, now, extras.coverUrl) : null,
      updated_at: event.updatedAt.toISOString(),
    };
  }

  ticketSummary(
    ticket: TicketRow,
    event: EventRow,
    payment: PaymentRow | null,
    now: Date,
    coverUrl: string | null = null,
  ): TicketSummaryDto {
    const status = projectedTicketStatus(ticket, now);
    return {
      id: ticket.id,
      status,
      event: {
        id: event.id,
        title: event.title,
        cover_url: coverUrl,
        starts_at: event.startsAt.toISOString(),
        ends_at: event.endsAt.toISOString(),
        timezone: event.timezone,
        location_name: event.locationName,
        status: event.status,
      },
      total: money(ticket.totalSnapshot),
      hold_expires_at: ticket.status === "awaiting_payment" ? iso(ticket.holdExpiresAt) : null,
      checked_in_at: iso(ticket.checkedInAt),
      cancelled_at: iso(ticket.cancelledAt),
      cancelled_by: ticket.cancelledBy,
      payment_status: payment?.status ?? null,
      created_at: ticket.createdAt.toISOString(),
    };
  }

  ticketDetail(
    ticket: TicketRow,
    event: EventRow,
    extras: Pick<EventExtras, "coverUrl">,
    payment: PaymentRow | null,
    refunds: readonly AdjustmentRow[],
    setting: EventsSetting,
    now: Date,
  ): TicketDetailDto {
    const summary = this.ticketSummary(ticket, event, payment, now, extras.coverUrl);
    const window = checkinWindow(event, setting.checkin_before_hours);
    const valid = summary.status === "paid" && event.status !== "cancelled";
    return {
      ...summary,
      qr_code: valid ? ticket.qrCode : null,
      checkin_opens_at: window.opensAt.toISOString(),
      checkin_closes_at: window.closesAt.toISOString(),
      cancel_reason: ticket.cancelReason,
      payment: payment ? this.ticketPayment(payment) : null,
      refunds: refunds.map((row) => this.refundInfo(row)),
      can_cancel: memberCanCancel(ticket, event, now),
      refund_eligible: memberRefundEligible(ticket, event, now, setting.self_cancel_days),
      full_refund_until: iso(fullRefundUntil(event.startsAt, ticket.totalSnapshot, setting.self_cancel_days)),
      version: String(ticket.version),
    };
  }

  ticketPayment(payment: PaymentRow): Schemas["TicketPaymentInfo"] {
    const method = readMethodSnapshot(payment);
    return {
      id: payment.id,
      status: payment.status,
      amount: money(payment.amount),
      method: {
        kind: method.kind,
        provider: method.provider,
        account_number: method.account_number,
        account_holder: method.account_holder,
        instructions: method.instructions,
      },
      proof_version: payment.proofVersion,
      submitted_at: iso(payment.submittedAt),
      decided_at: iso(payment.decidedAt),
      rejection_reason: payment.rejectionReason,
    };
  }

  refundInfo(row: AdjustmentRow): Schemas["TicketRefundInfo"] {
    return {
      id: row.id,
      status: row.status,
      amount: money(row.amount),
      due_at: iso(row.dueAt),
      completed_at: iso(row.completedAt),
      cancelled_at: iso(row.cancelledAt),
      created_at: row.createdAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------------------- muat + DTO anggota

  /** EventDetail untuk pemanggil (tanpa pemeriksaan akses; pemanggil sudah memastikan event terbit). */
  async memberEventDetail(db: DbOrTx, eventId: string, viewer: MemberViewer): Promise<EventDetailDto | null> {
    const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event || event.status === "draft") return null;
    const now = this.now();
    const [extras, latest, setting] = await Promise.all([
      this.extrasFor(db, [event], now),
      this.latestTickets(db, viewer.userId, [event.id]),
      this.eventsSetting(),
    ]);
    const myTicket = latest.get(event.id) ?? null;
    const myPayment = myTicket ? ((await this.paymentsForTickets(db, [myTicket.id])).get(myTicket.id) ?? null) : null;
    return this.eventDetail(event, extras.get(event.id)!, viewer, myTicket, myPayment, setting, now);
  }

  /** TicketDetail milik `userId`; null bila tiket tidak ada atau milik pengguna lain (N-09). */
  async memberTicketDetail(db: DbOrTx, ticketId: string, userId: string): Promise<TicketDetailDto | null> {
    const [row] = await db
      .select({ ticket: tickets, event: events })
      .from(tickets)
      .innerJoin(events, eq(events.id, tickets.eventId))
      .where(and(eq(tickets.id, ticketId), eq(tickets.userId, userId)))
      .limit(1);
    if (!row) return null;
    const now = this.now();
    const [extras, paymentMap, setting] = await Promise.all([
      this.extrasFor(db, [row.event], now),
      this.paymentsForTickets(db, [row.ticket.id]),
      this.eventsSetting(),
    ]);
    const payment = paymentMap.get(row.ticket.id) ?? null;
    const refunds = payment ? ((await this.refundsForPayments(db, [payment.id])).get(payment.id) ?? []) : [];
    return this.ticketDetail(row.ticket, row.event, extras.get(row.event.id)!, payment, refunds, setting, now);
  }

  // ------------------------------------------------------------------------------------------ DTO pengurus

  adminEventSummary(event: EventRow, extras: EventExtras, hasTickets: boolean): AdminEventSummaryDto {
    const seats = seatProjection(event, extras.lapsed);
    return {
      id: event.id,
      title: event.title,
      cover_url: extras.coverUrl,
      category: extras.category,
      location_name: event.locationName,
      timezone: event.timezone,
      starts_at: event.startsAt.toISOString(),
      ends_at: event.endsAt.toISOString(),
      registration_opens_at: event.registrationOpensAt.toISOString(),
      registration_closes_at: event.registrationClosesAt.toISOString(),
      status: event.status,
      price: money(event.price),
      seats_total: event.seatsTotal,
      seats_available: seats.available,
      held_quantity: seats.held,
      paid_quantity: seats.paid,
      has_tickets: hasTickets,
      version: String(event.version),
      updated_at: event.updatedAt.toISOString(),
    };
  }

  adminEventDetail(
    event: EventRow,
    extras: EventExtras,
    context: { hasTickets: boolean; checkedIn: number; createdByName: string | null },
    setting: EventsSetting,
    now: Date,
  ): AdminEventDetailDto {
    const summary = this.adminEventSummary(event, extras, context.hasTickets);
    const window = checkinWindow(event, setting.checkin_before_hours);
    return {
      ...summary,
      description: event.description,
      location_address: event.locationAddress,
      location_url: event.locationUrl,
      cover_file_id: event.coverFileId,
      checkin_opens_at: iso(event.checkinOpensAt),
      checkin_closes_at: iso(event.checkinClosesAt),
      effective_checkin_opens_at: window.opensAt.toISOString(),
      effective_checkin_closes_at: window.closesAt.toISOString(),
      checked_in_count: context.checkedIn,
      min_seats_total: Math.max(1, summary.held_quantity + summary.paid_quantity),
      cancelled_at: iso(event.cancelledAt),
      cancel_reason: event.cancelReason,
      created_by: event.createdByAdminId
        ? { admin_id: event.createdByAdminId, display_name: context.createdByName ?? DELETED_ADMIN_NAME }
        : null,
      created_at: event.createdAt.toISOString(),
      allowed_actions: allowedActions(event, context.hasTickets, now),
    };
  }

  /** AdminEventDetail lengkap untuk satu event; null bila tidak ada. */
  async adminEventDetailById(db: DbOrTx, eventId: string): Promise<AdminEventDetailDto | null> {
    const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) return null;
    const now = this.now();
    const [extras, withTickets, checkedIn, names, setting] = await Promise.all([
      this.extrasFor(db, [event], now),
      this.eventsWithTickets(db, [event.id]),
      this.checkedInCounts(db, [event.id]),
      this.adminNames(db, [event.createdByAdminId]),
      this.eventsSetting(),
    ]);
    return this.adminEventDetail(
      event,
      extras.get(event.id)!,
      {
        hasTickets: withTickets.has(event.id),
        checkedIn: checkedIn.get(event.id) ?? 0,
        createdByName: event.createdByAdminId ? (names.get(event.createdByAdminId) ?? null) : null,
      },
      setting,
      now,
    );
  }

  /** Daftar AdminEventTicket untuk baris tiket satu event (data dimuat berkelompok). */
  async adminTickets(
    db: DbOrTx,
    event: EventRow,
    rows: readonly TicketRow[],
    viewer: AdminViewer,
  ): Promise<AdminEventTicketDto[]> {
    if (rows.length === 0) return [];
    const now = this.now();
    const ticketIds = rows.map((row) => row.id);
    const [paymentMap, holders, names, setting] = await Promise.all([
      this.paymentsForTickets(db, ticketIds),
      this.holdersFor(
        db,
        rows.map((row) => row.userId),
      ),
      this.adminNames(
        db,
        rows.map((row) => row.checkedInByAdminId),
      ),
      this.eventsSetting(),
    ]);
    const paymentIds = [...paymentMap.values()].map((payment) => payment.id);
    const refunds = await this.refundsForPayments(db, paymentIds);
    const visibleHolders = [...holders.values()].filter((holder) => holder.accountStatus !== "deleted");
    const avatars = await this.avatarUrls(
      db,
      visibleHolders.map((holder) => holder.avatarFileId),
      viewer,
    );
    const rules = reviewRulesOf(setting);
    const canDecide = viewer.permissions.has("payments.decide");
    return rows.map((ticket) => {
      const payment = paymentMap.get(ticket.id) ?? null;
      const holderRow = ticket.userId ? (holders.get(ticket.userId) ?? null) : null;
      const holder = holderRow && holderRow.accountStatus !== "deleted" ? holderRow : null;
      const status = projectedTicketStatus(ticket, now);
      const dueAt = payment ? reviewDueAt(payment, event, rules) : null;
      const eligible = holder
        ? holderEligible({ accountStatus: holder.accountStatus, suspended: holder.suspended })
        : false;
      return {
        id: ticket.id,
        event_id: ticket.eventId,
        status,
        total: money(ticket.totalSnapshot),
        holder: {
          user_id: holder?.userId ?? null,
          full_name: holder?.fullName ?? null,
          member_number: holder?.memberNumber ?? null,
          cohort: holder?.cohort ?? null,
          cohort_code: holder ? cohortCode(holder.cohort) : null,
          avatar_url: holder?.avatarFileId ? (avatars.get(holder.avatarFileId) ?? null) : null,
        },
        holder_eligible: eligible,
        hold_expires_at: ticket.status === "awaiting_payment" ? iso(ticket.holdExpiresAt) : null,
        checked_in_at: iso(ticket.checkedInAt),
        checked_in_by: ticket.checkedInAt ? this.actor(ticket.checkedInByAdminId, names) : null,
        cancelled_at: iso(ticket.cancelledAt),
        cancelled_by: ticket.cancelledBy,
        cancel_reason: ticket.cancelReason,
        payment: payment
          ? {
              id: payment.id,
              status: payment.status,
              amount: money(payment.amount),
              proof_version: payment.proofVersion,
              submitted_at: iso(payment.submittedAt),
              decided_at: iso(payment.decidedAt),
              review_due_at: iso(dueAt),
            }
          : null,
        refunds: payment ? (refunds.get(payment.id) ?? []).map((row) => this.refundInfo(row)) : [],
        review_overdue: dueAt !== null && now.getTime() > dueAt.getTime(),
        can_refund:
          status === "paid" &&
          toCents(ticket.totalSnapshot) > 0n &&
          adminCanCancel(ticket, event, now) &&
          canDecide &&
          (ticket.userId === null || ticket.userId !== viewer.linkedAlumniUserId),
        created_at: ticket.createdAt.toISOString(),
        version: String(ticket.version),
      };
    });
  }

  /** Satu AdminEventTicket (dibaca ulang dari database). */
  async adminTicketById(
    db: DbOrTx,
    ticketId: string,
    viewer: AdminViewer,
  ): Promise<AdminEventTicketDto | null> {
    const [row] = await db
      .select({ ticket: tickets, event: events })
      .from(tickets)
      .innerJoin(events, eq(events.id, tickets.eventId))
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (!row) return null;
    const [dto] = await this.adminTickets(db, row.event, [row.ticket], viewer);
    return dto ?? null;
  }

  actor(adminId: string | null, names: Map<string, string>): AdminEventActorDto {
    if (!adminId) return { admin_id: null, display_name: DELETED_ADMIN_NAME };
    return { admin_id: adminId, display_name: names.get(adminId) ?? DELETED_ADMIN_NAME };
  }

  /** Kategori event kind=event untuk daftar anggota/pengurus. */
  async eventCategories(db: DbOrTx, options: { activeOnly: boolean }) {
    return db
      .select({
        id: categories.id,
        slug: categories.slug,
        label: categories.label,
        active: categories.active,
        sortOrder: categories.sortOrder,
      })
      .from(categories)
      .where(
        and(eq(categories.kind, "event"), options.activeOnly ? eq(categories.active, true) : undefined),
      )
      .orderBy(asc(categories.sortOrder), asc(categories.label), asc(categories.id));
  }

  /** Ekspresi SQL jumlah hold kedaluwarsa event (proyeksi kursi) untuk filter/urutan di SQL. */
  lapsedCountSql(now: Date) {
    return sql<number>`(select count(*)::int from ${tickets} where ${tickets.eventId} = ${events.id} and ${tickets.status} = 'awaiting_payment' and ${tickets.holdExpiresAt} <= ${now.toISOString()}::timestamptz)`;
  }
}
