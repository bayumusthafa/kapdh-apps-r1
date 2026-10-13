import { Inject, Injectable } from "@nestjs/common";
import type { components, Permission } from "@kapdh/contracts";
import {
  admins,
  alumni,
  events,
  files,
  membershipEvents,
  paymentAdjustments,
  paymentEvents,
  paymentMethods,
  payments,
  tickets,
  users,
} from "@kapdh/database";
import { asc, eq, inArray, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Clock } from "../../core/adapters/clock.js";
import type { DbOrTx } from "../../core/db/types.js";
import { notFound } from "../../core/errors/app-exception.js";
import { type AccountStatus, effectiveStatus, type EffectiveStatus } from "../../core/membership/effective-status.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK } from "../../core/tokens.js";
import { money } from "./money.js";
import { reviewDueSql } from "./payment-sql.js";
import {
  type AdjustmentRow,
  type DevicePlatform,
  duesInstructionsHidden,
  type EventRow,
  fullRefundOnApprove,
  holdActive,
  memberActions,
  type PaymentRow,
  paymentStage,
  readLineSnapshot,
  readMethodSnapshot,
  reservationLapsed,
  reviewDueAt,
  type ReviewRules,
  reviewRulesOf,
  type TicketRow,
  ticketEventStatus,
} from "./payment-rules.js";

type Schemas = components["schemas"];
export type PaymentDto = Schemas["Payment"];
export type PaymentDetailDto = Schemas["PaymentDetail"];
export type AdminPaymentItemDto = Schemas["AdminPaymentItem"];
export type AdminPaymentDetailDto = Schemas["AdminPaymentDetail"];
export type AdminPaymentAdjustmentDto = Schemas["AdminPaymentAdjustment"];
type PaymentTicketRef = Schemas["PaymentTicketRef"];
type AdminPaymentMember = Schemas["AdminPaymentMember"];

/** Pemanggil anggota: pemilik payment, effective_status saat ini (dari guard) dan platform X-App-Platform (D13). */
export interface MemberViewer {
  userId: string;
  status: EffectiveStatus | null;
  platform: DevicePlatform | null;
}

/** Pemanggil pengurus: izin dari database request ini dan akun alumni tertaut (konflik kepentingan, PRD 2.3). */
export interface AdminViewer {
  adminId: string | null;
  permissions: ReadonlySet<Permission>;
  linkedAlumniUserId: string | null;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/** Konflik kepentingan (PRD 2.3): payment milik akun alumni yang tertaut ke identitas admin pemanggil. */
export function conflictOfInterest(viewer: Pick<AdminViewer, "linkedAlumniUserId">, ownerUserId: string | null) {
  return viewer.linkedAlumniUserId !== null && ownerUserId !== null && viewer.linkedAlumniUserId === ownerUserId;
}

/**
 * Status tiket untuk respons BACA (aturan tag Events): hold yang sudah lewat tetapi belum dilepas job tampil expired.
 */
export function projectedTicketStatus(ticket: Pick<TicketRow, "status" | "holdExpiresAt">, now: Date) {
  return ticket.status === "awaiting_payment" && !holdActive(ticket, now) ? "expired" : ticket.status;
}

export function ticketRefOf(ticket: TicketRow, event: EventRow, now: Date): PaymentTicketRef {
  const status = projectedTicketStatus(ticket, now);
  return {
    ticket_id: ticket.id,
    event_id: event.id,
    event_title: event.title,
    event_starts_at: event.startsAt.toISOString(),
    event_timezone: event.timezone,
    ticket_status: status,
    hold_expires_at: status === "awaiting_payment" ? iso(ticket.holdExpiresAt) : null,
    event_status: ticketEventStatus(event.status),
    ticket_cancelled_by: status === "cancelled" ? ticket.cancelledBy : null,
  };
}

/** Kolom anggota pada join payments → users/alumni (identitas minimum N-09). */
const memberColumns = {
  memberName: alumni.fullName,
  memberNumber: alumni.memberNumber,
  memberCohort: alumni.cohort,
  memberExpiresAt: alumni.expiresAt,
  memberSuspendedAt: alumni.suspendedAt,
  accountStatus: users.status,
  userKind: users.kind,
};

interface MemberColumns {
  memberName: string | null;
  memberNumber: string | null;
  memberCohort: number | null;
  memberExpiresAt: Date | null;
  memberSuspendedAt: Date | null;
  accountStatus: string | null;
  userKind: string | null;
}

/** AdminPaymentMember, atau null bila akun pemilik sudah dihapus/dianonimkan (D2, AC F14-4). */
function adminMemberOf(userId: string | null, row: MemberColumns, now: Date): AdminPaymentMember | null {
  if (!userId || row.memberName === null || row.userKind !== "alumni" || row.accountStatus === "deleted")
    return null;
  return {
    user_id: userId,
    full_name: row.memberName,
    member_number: row.memberNumber,
    cohort: row.memberCohort ?? 1,
    effective_status: effectiveStatus(
      {
        accountStatus: (row.accountStatus ?? "active") as AccountStatus,
        expiresAt: row.memberExpiresAt,
        suspendedAt: row.memberSuspendedAt,
      },
      now,
    ),
  };
}

const createdBy = alias(admins, "pa_created_by");
const completedBy = alias(admins, "pa_completed_by");
const cancelledBy = alias(admins, "pa_cancelled_by");

/**
 * Penyusun respons kontrak C3 dari data canonical (anggota: PaymentDetail/Payment; pengurus: AdminPaymentItem/
 * AdminPaymentDetail/AdminPaymentAdjustment). Semua fungsi menerima `db` (atau `tx`) agar `current` pada 409 dibaca
 * dari transaksi yang sama.
 */
@Injectable()
export class PaymentViews {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  now(): Date {
    return this.clock.now();
  }

  async reviewRules(): Promise<ReviewRules> {
    return reviewRulesOf(await this.settings.get("events"));
  }

  // ===================================================================================================== anggota

  /** Payment milik pemanggil (404 untuk payment orang lain, N-09). */
  async ownedPayment(db: DbOrTx, paymentId: string, userId: string): Promise<PaymentRow> {
    const [row] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!row || row.userId !== userId) throw notFound("Pembayaran tidak ditemukan.");
    return row;
  }

  /** Daftar Payment kontrak untuk baris milik pemanggil (tiket, periode, tindakan dihitung per baris). */
  async memberPayments(db: DbOrTx, rows: PaymentRow[], viewer: MemberViewer): Promise<PaymentDto[]> {
    if (rows.length === 0) return [];
    const now = this.now();
    const hiddenSetting = await this.settings.get("payment_instructions");
    const ticketMap = await this.ticketsFor(db, rows);
    const periodMap = await this.periodsFor(db, rows);
    const adminProofs = await this.adminProofIds(db, rows);
    return rows.map((row) => {
      const linked = row.ticketId ? (ticketMap.get(row.ticketId) ?? null) : null;
      const hidden = duesInstructionsHidden(row.type, viewer.platform, hiddenSetting);
      const adminProof = row.proofFileId !== null && adminProofs.has(row.proofFileId);
      const period = periodMap.get(row.id) ?? null;
      return {
        id: row.id,
        type: row.type,
        status: row.status,
        stage: paymentStage(row),
        amount: money(row.amount),
        lines: readLineSnapshot(row),
        method: readMethodSnapshot(row),
        proof_version: row.proofVersion,
        proof_file_id: adminProof ? null : row.proofFileId,
        transfer_note: adminProof ? null : row.transferNote,
        submitted_at: iso(row.submittedAt),
        decided_at: iso(row.decidedAt),
        rejection_reason: row.rejectionReason,
        cancelled_at: iso(row.cancelledAt),
        cancel_reason: row.cancelReason,
        ticket: linked ? ticketRefOf(linked.ticket, linked.event, now) : null,
        period: period
          ? { starts_at: period.startsAt.toISOString(), expires_at: period.expiresAt.toISOString() }
          : null,
        created_at: row.createdAt.toISOString(),
        version: String(row.version),
        actions: memberActions(row, {
          ticket: linked ? linked.ticket : null,
          status: viewer.status,
          hidden,
          now,
        }),
      };
    });
  }

  /** PaymentDetail milik pemanggil: histori (alasan lama tetap, AC F03-3), penyesuaian, metode aktif, D13. */
  async memberDetail(db: DbOrTx, paymentId: string, viewer: MemberViewer): Promise<PaymentDetailDto> {
    const row = await this.ownedPayment(db, paymentId, viewer.userId);
    const [base] = await this.memberPayments(db, [row], viewer);
    const history = await db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, row.id))
      .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));
    const adjustments = await db
      .select()
      .from(paymentAdjustments)
      .where(eq(paymentAdjustments.paymentId, row.id))
      .orderBy(asc(paymentAdjustments.createdAt), asc(paymentAdjustments.id));
    const hiddenSetting = await this.settings.get("payment_instructions");
    return {
      ...base!,
      events: history.map((event) => ({
        at: event.createdAt.toISOString(),
        kind: event.kind,
        actor: event.actorAdminId ? "admin" : event.actorUserId ? "member" : "system",
        proof_version: event.proofVersion,
        // Alasan hanya untuk rejected dan cancelled; catatan verifikasi pengurus (D13) tidak dikirim ke anggota.
        reason: event.kind === "rejected" || event.kind === "cancelled" ? event.reason : null,
      })),
      adjustments: adjustments.map((adjustment) => ({
        id: adjustment.id,
        kind: adjustment.kind,
        amount: money(adjustment.amount),
        status: adjustment.status,
        has_refund_destination: adjustment.refundDestination !== null,
        destination_required:
          adjustment.kind === "refund" && adjustment.status === "pending" && adjustment.refundDestination === null,
        due_at: iso(adjustment.dueAt),
        completed_at: iso(adjustment.completedAt),
        cancelled_at: iso(adjustment.cancelledAt),
        created_at: adjustment.createdAt.toISOString(),
        version: String(adjustment.version),
      })),
      method_active: await this.methodActive(db, row.paymentMethodId),
      instructions_hidden: duesInstructionsHidden(row.type, viewer.platform, hiddenSetting),
    };
  }

  private async ticketsFor(
    db: DbOrTx,
    rows: Pick<PaymentRow, "ticketId">[],
  ): Promise<Map<string, { ticket: TicketRow; event: EventRow }>> {
    const ids = [...new Set(rows.map((row) => row.ticketId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const found = await db
      .select({ ticket: tickets, event: events })
      .from(tickets)
      .innerJoin(events, eq(events.id, tickets.eventId))
      .where(inArray(tickets.id, ids));
    return new Map(found.map((item) => [item.ticket.id, item]));
  }

  private async periodsFor(
    db: DbOrTx,
    rows: Pick<PaymentRow, "id" | "status" | "type">[],
  ): Promise<Map<string, { startsAt: Date; expiresAt: Date }>> {
    const ids = rows.filter((row) => row.status === "paid" && row.type !== "ticket").map((row) => row.id);
    if (ids.length === 0) return new Map();
    const found = await db
      .select({
        paymentId: membershipEvents.paymentId,
        startsAt: membershipEvents.afterStartsAt,
        expiresAt: membershipEvents.afterExpiresAt,
      })
      .from(membershipEvents)
      .where(inArray(membershipEvents.paymentId, ids));
    const map = new Map<string, { startsAt: Date; expiresAt: Date }>();
    for (const item of found)
      if (item.paymentId && item.startsAt && item.expiresAt)
        map.set(item.paymentId, { startsAt: item.startsAt, expiresAt: item.expiresAt });
    return map;
  }

  /** Bukti aktif yang diunggah pengurus (D13): pemiliknya bukan pemilik payment, tidak pernah dibuka ke anggota. */
  private async adminProofIds(db: DbOrTx, rows: Pick<PaymentRow, "proofFileId" | "userId">[]): Promise<Set<string>> {
    const ids = rows.map((row) => row.proofFileId).filter((id): id is string => id !== null);
    if (ids.length === 0) return new Set();
    const found = await db
      .select({ id: files.id, ownerUserId: files.ownerUserId })
      .from(files)
      .where(inArray(files.id, ids));
    const owners = new Map(found.map((file) => [file.id, file.ownerUserId]));
    return new Set(
      rows
        .filter((row) => row.proofFileId !== null && owners.get(row.proofFileId) !== row.userId)
        .map((row) => row.proofFileId!),
    );
  }

  private async methodActive(db: DbOrTx, methodId: string | null): Promise<boolean> {
    if (!methodId) return false;
    const [method] = await db
      .select({ active: paymentMethods.active })
      .from(paymentMethods)
      .where(eq(paymentMethods.id, methodId))
      .limit(1);
    return method?.active ?? false;
  }

  // ===================================================================================================== pengurus

  /** Query dasar antrean pengurus: payment + identitas minimum + tiket/event + review_due_at. */
  adminRowsQuery(db: DbOrTx, rules: ReviewRules) {
    return db
      .select({
        payment: payments,
        ...memberColumns,
        ticket: tickets,
        event: events,
        reviewDueAt: reviewDueSql(rules),
      })
      .from(payments)
      .leftJoin(users, eq(users.id, payments.userId))
      .leftJoin(alumni, eq(alumni.userId, payments.userId))
      .leftJoin(tickets, eq(tickets.id, payments.ticketId))
      .leftJoin(events, eq(events.id, tickets.eventId))
      .$dynamic();
  }

  /** Baris AdminPaymentItem dari hasil {@link adminRowsQuery}. */
  adminItem(row: AdminRow, now: Date): AdminPaymentItemDto {
    const payment = row.payment;
    const ticket = payment.type === "ticket" ? row.ticket : null;
    const event = payment.type === "ticket" ? row.event : null;
    return {
      id: payment.id,
      type: payment.type,
      status: payment.status,
      stage: paymentStage(payment),
      amount: money(payment.amount),
      member: adminMemberOf(payment.userId, row, now),
      event_title: event?.title ?? null,
      event_starts_at: iso(event?.startsAt),
      ticket_status: ticket ? projectedTicketStatus(ticket, now) : null,
      event_cancelled: event ? event.status === "cancelled" : null,
      submitted_at: iso(payment.submittedAt),
      decided_at: iso(payment.decidedAt),
      review_due_at: iso(row.reviewDueAt),
      proof_version: payment.proofVersion,
      overdue: row.reviewDueAt !== null && row.reviewDueAt.getTime() <= now.getTime(),
      created_at: payment.createdAt.toISOString(),
      version: String(payment.version),
    };
  }

  /** AdminPaymentDetail untuk keputusan (AC F04-4): bukti aktif, histori lengkap, penyesuaian, konflik kepentingan. */
  async adminDetail(db: DbOrTx, paymentId: string, viewer: AdminViewer): Promise<AdminPaymentDetailDto> {
    const rules = await this.reviewRules();
    const [row] = await this.adminRowsQuery(db, rules).where(eq(payments.id, paymentId)).limit(1);
    if (!row) throw notFound("Pembayaran tidak ditemukan.");
    const now = this.now();
    const payment = row.payment;
    const item = this.adminItem(row, now);

    const history = await db
      .select({ event: paymentEvents, adminName: admins.displayName, fileStatus: files.status })
      .from(paymentEvents)
      .leftJoin(admins, eq(admins.id, paymentEvents.actorAdminId))
      .leftJoin(files, eq(files.id, paymentEvents.proofFileId))
      .where(eq(paymentEvents.paymentId, payment.id))
      .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));
    const [proofFile] = payment.proofFileId
      ? await db.select().from(files).where(eq(files.id, payment.proofFileId)).limit(1)
      : [];
    const [decider] = payment.decidedByAdminId
      ? await db
          .select({ id: admins.id, name: admins.displayName })
          .from(admins)
          .where(eq(admins.id, payment.decidedByAdminId))
          .limit(1)
      : [];
    const [period] =
      payment.status === "paid" && payment.type !== "ticket"
        ? await db
            .select({ startsAt: membershipEvents.afterStartsAt, expiresAt: membershipEvents.afterExpiresAt })
            .from(membershipEvents)
            .where(eq(membershipEvents.paymentId, payment.id))
            .limit(1)
        : [];
    const adjustments = await this.adminAdjustments(db, eq(paymentAdjustments.paymentId, payment.id), viewer);
    const coi = conflictOfInterest(viewer, payment.userId);
    const decide = viewer.permissions.has("payments.decide") && !coi;
    const selfCancelDays = (await this.settings.get("events")).self_cancel_days;
    const ticket = payment.type === "ticket" ? row.ticket : null;
    const event = payment.type === "ticket" ? row.event : null;
    return {
      ...item,
      lines: readLineSnapshot(payment),
      method: readMethodSnapshot(payment),
      method_id: payment.paymentMethodId,
      method_active: await this.methodActive(db, payment.paymentMethodId),
      proof:
        proofFile && proofFile.status === "ready" && payment.proofVersion >= 1 && payment.submittedAt
          ? {
              file_id: proofFile.id,
              version: payment.proofVersion,
              mime: proofFile.mime,
              bytes: proofFile.bytes,
              submitted_at: payment.submittedAt.toISOString(),
            }
          : null,
      transfer_note: payment.transferNote,
      rejection_reason: payment.rejectionReason,
      rejection_count: history.filter((entry) => entry.event.kind === "rejected").length,
      decided_by: decider ? { admin_id: decider.id, display_name: decider.name } : null,
      cancelled_at: iso(payment.cancelledAt),
      cancel_reason: payment.cancelReason,
      ticket: ticket && event ? ticketRefOf(ticket, event, now) : null,
      period:
        period?.startsAt && period.expiresAt
          ? { starts_at: period.startsAt.toISOString(), expires_at: period.expiresAt.toISOString() }
          : null,
      settings_version: payment.settingsVersion === null ? null : String(payment.settingsVersion),
      events: history.map(({ event: entry, adminName, fileStatus }) => ({
        at: entry.createdAt.toISOString(),
        kind: entry.kind,
        actor: entry.actorAdminId ? "admin" : entry.actorUserId ? "member" : "system",
        proof_version: entry.proofVersion,
        reason: entry.reason,
        // Berkas versi lama tetap dapat dibuka pengurus (U-02); berkas yang sudah dihapus bersama akun → null (D2).
        proof_file_id: entry.proofFileId && fileStatus === "ready" ? entry.proofFileId : null,
        actor_admin: entry.actorAdminId
          ? { admin_id: entry.actorAdminId, display_name: adminName ?? "Pengurus (akun dihapus)" }
          : null,
      })),
      adjustments,
      conflict_of_interest: coi,
      refund_on_approve: fullRefundOnApprove({ payment, ticket, event, selfCancelDays }),
      actions: {
        can_decide: decide && payment.status === "pending" && payment.proofVersion >= 1,
        can_cancel: decide && payment.status === "pending" && payment.proofVersion === 0,
        can_adjust: decide && payment.status === "paid",
      },
    };
  }

  /** Batas review satu payment (dipakai uji dan ringkasan) dengan rumus JS yang sama dengan SQL. */
  reviewDueAtOf(payment: PaymentRow, event: EventRow | null, rules: ReviewRules): Date | null {
    return reviewDueAt(payment, event, rules);
  }

  // ============================================================================================== penyesuaian

  /** Query dasar penyesuaian beserta payment asal, identitas minimum dan nama pengurus pelaku. */
  adjustmentRowsQuery(db: DbOrTx) {
    return db
      .select({
        adjustment: paymentAdjustments,
        payment: payments,
        ...memberColumns,
        eventTitle: events.title,
        createdByName: createdBy.displayName,
        completedByName: completedBy.displayName,
        cancelledByName: cancelledBy.displayName,
      })
      .from(paymentAdjustments)
      .innerJoin(payments, eq(payments.id, paymentAdjustments.paymentId))
      .leftJoin(users, eq(users.id, payments.userId))
      .leftJoin(alumni, eq(alumni.userId, payments.userId))
      .leftJoin(tickets, eq(tickets.id, payments.ticketId))
      .leftJoin(events, eq(events.id, tickets.eventId))
      .leftJoin(createdBy, eq(createdBy.id, paymentAdjustments.createdByAdminId))
      .leftJoin(completedBy, eq(completedBy.id, paymentAdjustments.completedByAdminId))
      .leftJoin(cancelledBy, eq(cancelledBy.id, paymentAdjustments.cancelledByAdminId))
      .$dynamic();
  }

  /** AdminPaymentAdjustment dari hasil {@link adjustmentRowsQuery}. */
  adminAdjustment(row: AdjustmentQueryRow, viewer: AdminViewer, now: Date): AdminPaymentAdjustmentDto {
    const adjustment = row.adjustment;
    const payment = row.payment;
    const coi = conflictOfInterest(viewer, payment.userId);
    // Rekening tujuan refund hanya untuk pemutus tanpa konflik kepentingan selama refund pending (D2).
    const showDestination =
      viewer.permissions.has("payments.decide") &&
      !coi &&
      adjustment.kind === "refund" &&
      adjustment.status === "pending";
    const destination = adjustment.refundDestination as {
      provider: string;
      account_number: string;
      account_holder: string;
    } | null;
    const actor = (id: string | null, name: string | null) =>
      id ? { admin_id: id, display_name: name ?? "Pengurus (akun dihapus)" } : null;
    return {
      id: adjustment.id,
      payment_id: payment.id,
      payment: {
        id: payment.id,
        type: payment.type,
        status: payment.status,
        amount: money(payment.amount),
        member: adminMemberOf(payment.userId, row, now),
        event_title: payment.type === "ticket" ? row.eventTitle : null,
        decided_at: iso(payment.decidedAt),
      },
      kind: adjustment.kind,
      amount: money(adjustment.amount),
      reason: adjustment.reason,
      status: adjustment.status,
      has_refund_destination: destination !== null,
      refund_destination:
        showDestination && destination
          ? {
              provider: destination.provider,
              account_number: destination.account_number,
              account_holder: destination.account_holder,
            }
          : null,
      evidence_file_id: adjustment.evidenceFileId,
      due_at: iso(adjustment.dueAt),
      overdue: adjustmentOverdue(adjustment, now),
      created_by: actor(adjustment.createdByAdminId, row.createdByName),
      completed_by: actor(adjustment.completedByAdminId, row.completedByName),
      completed_at: iso(adjustment.completedAt),
      cancelled_by: actor(adjustment.cancelledByAdminId, row.cancelledByName),
      cancelled_at: iso(adjustment.cancelledAt),
      cancel_reason: adjustment.cancelReason,
      created_at: adjustment.createdAt.toISOString(),
      updated_at: adjustment.updatedAt.toISOString(),
      version: String(adjustment.version),
    };
  }

  async adminAdjustments(db: DbOrTx, where: SQL, viewer: AdminViewer): Promise<AdminPaymentAdjustmentDto[]> {
    const rows = await this.adjustmentRowsQuery(db)
      .where(where)
      .orderBy(asc(paymentAdjustments.createdAt), asc(paymentAdjustments.id));
    const now = this.now();
    return rows.map((row) => this.adminAdjustment(row, viewer, now));
  }

  async adminAdjustmentDetail(
    db: DbOrTx,
    adjustmentId: string,
    viewer: AdminViewer,
  ): Promise<AdminPaymentAdjustmentDto> {
    const [row] = await this.adjustmentRowsQuery(db).where(eq(paymentAdjustments.id, adjustmentId)).limit(1);
    if (!row) throw notFound("Penyesuaian tidak ditemukan.");
    return this.adminAdjustment(row, viewer, this.now());
  }
}

/** Penyesuaian pending yang melewati tenggat (D6). */
export function adjustmentOverdue(adjustment: Pick<AdjustmentRow, "status" | "dueAt">, now: Date): boolean {
  return adjustment.status === "pending" && adjustment.dueAt !== null && adjustment.dueAt.getTime() <= now.getTime();
}

/** Payment tiket yang reservasinya habis (dipakai layanan anggota, AC F09-2). */
export function ticketLapsed(ticket: TicketRow | null, now: Date): boolean {
  return ticket !== null && reservationLapsed(ticket, now);
}

export type AdminRow = Awaited<ReturnType<ReturnType<PaymentViews["adminRowsQuery"]>["execute"]>>[number];
export type AdjustmentQueryRow = Awaited<
  ReturnType<ReturnType<PaymentViews["adjustmentRowsQuery"]>["execute"]>
>[number];

/** Penyaring body sebelum disimpan idempotency_keys: rekening tujuan refund tidak pernah disalin (D2, §2.3). */
export function redactRefundDestinations(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(redactRefundDestinations);
  if (body === null || typeof body !== "object") return body;
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([key, value]) => [
      key,
      key === "refund_destination" ? null : redactRefundDestinations(value),
    ]),
  );
}

/**
 * Path respons pembayaran yang namanya cocok daftar kunci sensitif audit tetapi BUKAN rahasia, untuk @Idempotent:
 * rekening ORGANISASI tujuan transfer (D13) dan kode baris iuran (PaymentLineCode, mis. registration_fee).
 */
export const PUBLIC_PAYMENT_PATHS = ["method.account_number", "lines.*.code"] as const;
