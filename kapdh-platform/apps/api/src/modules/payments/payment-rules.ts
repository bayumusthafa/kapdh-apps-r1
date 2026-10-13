import type { components } from "@kapdh/contracts";
import type { events, paymentAdjustments, paymentMethods, payments, tickets } from "@kapdh/database";
import type { EffectiveStatus } from "../../core/membership/effective-status.js";
import type { SettingValue } from "../../core/settings/keys.js";
import { addBusinessDaysJakarta } from "./business-days.js";
import { fromCents, money, toCents } from "./money.js";

/**
 * Aturan murni domain pembayaran (PRD 3.3, 3.4, 4.3; ARCHITECTURE §3.3; kontrak C3): tahap tampilan, tindakan pemilik,
 * baris iuran dari pengaturan `fees`, batas review, dan pratinjau refund D6. Tidak menyentuh database.
 */

type Schemas = components["schemas"];
export type PaymentRow = typeof payments.$inferSelect;
export type PaymentMethodRow = typeof paymentMethods.$inferSelect;
export type AdjustmentRow = typeof paymentAdjustments.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type PaymentType = PaymentRow["type"];
export type DuesType = "registration" | "renewal";
export type PaymentStage = Schemas["PaymentStage"];
export type PaymentLineCode = Schemas["PaymentLineCode"];
export type DevicePlatform = "android" | "ios";

const DAY_MS = 24 * 3600_000;

/** Snapshot metode (rekening tujuan organisasi) yang disimpan di payments.method_snapshot (AC F15-3). */
export interface MethodSnapshot {
  id: string;
  kind: "bank" | "ewallet";
  provider: string;
  account_number: string;
  account_holder: string;
  instructions: string | null;
}

/** Baris rincian nominal yang disimpan di payments.lines_snapshot (AC F03-5). */
export interface LineSnapshot {
  code: PaymentLineCode;
  label: string;
  amount: string;
}

/** Label baris iuran berbahasa Indonesia (D4, PRD 3.3; positioning iuran organisasi D13). */
export const LINE_LABELS: Readonly<Record<PaymentLineCode, string>> = {
  registration_fee: "Register alumni baru",
  card_fee: "Pembuatan KTA",
  renewal_fee: "Perpanjangan KTA per tahun",
  ticket: "Tiket event",
};

export function isDuesType(type: PaymentType): type is DuesType {
  return type === "registration" || type === "renewal";
}

/** Snapshot metode dari baris payment_methods (dipangkas, tanpa kolom pengelolaan). */
export function methodSnapshotOf(row: PaymentMethodRow): MethodSnapshot {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    account_number: row.accountNumber,
    account_holder: row.accountHolder,
    instructions: row.instructions,
  };
}

/** Membaca snapshot metode tersimpan; data lama tanpa `id` memakai metode asal payment. */
export function readMethodSnapshot(payment: Pick<PaymentRow, "methodSnapshot" | "paymentMethodId">): MethodSnapshot {
  const raw = (payment.methodSnapshot ?? {}) as Partial<MethodSnapshot>;
  return {
    id: raw.id ?? payment.paymentMethodId ?? "00000000-0000-0000-0000-000000000000",
    kind: raw.kind === "ewallet" ? "ewallet" : "bank",
    provider: raw.provider ?? "",
    account_number: raw.account_number ?? "",
    account_holder: raw.account_holder ?? "",
    instructions: raw.instructions ?? null,
  };
}

/** Membaca snapshot baris tersimpan sebagai PaymentLine kontrak. */
export function readLineSnapshot(payment: Pick<PaymentRow, "linesSnapshot">): LineSnapshot[] {
  const raw = Array.isArray(payment.linesSnapshot) ? (payment.linesSnapshot as Partial<LineSnapshot>[]) : [];
  return raw.map((line) => {
    const code = (line.code && line.code in LINE_LABELS ? line.code : "ticket") as PaymentLineCode;
    return { code, label: line.label ?? LINE_LABELS[code], amount: money(String(line.amount ?? "0")) };
  });
}

/**
 * Baris dan total iuran dari pengaturan `fees` versi aktif (D4, AC F03-1): registration = register alumni baru +
 * pembuatan KTA; renewal = perpanjangan KTA per tahun. Nilai klien tidak pernah dipakai (PRD 3.3).
 */
export function duesLines(fees: SettingValue<"fees">, type: DuesType): { lines: LineSnapshot[]; total: string } {
  const lines: LineSnapshot[] =
    type === "registration"
      ? [
          { code: "registration_fee", label: LINE_LABELS.registration_fee, amount: money(fees.registration_fee) },
          { code: "card_fee", label: LINE_LABELS.card_fee, amount: money(fees.card_fee) },
        ]
      : [{ code: "renewal_fee", label: LINE_LABELS.renewal_fee, amount: money(fees.renewal_fee) }];
  const total = fromCents(lines.reduce((sum, line) => sum + toCents(line.amount), 0n));
  return { lines, total };
}

/** Tahap tampilan yang dihitung server (kontrak PaymentStage). */
export function paymentStage(payment: Pick<PaymentRow, "status" | "type" | "proofVersion">): PaymentStage {
  switch (payment.status) {
    case "pending":
      return payment.proofVersion === 0 ? "awaiting_transfer" : "awaiting_review";
    case "rejected":
      return payment.type === "ticket" ? "rejected_final" : "needs_fix";
    case "paid":
      return "paid";
    case "cancelled":
      return "cancelled";
  }
}

/**
 * Rencana cadangan D13: instruksi iuran disembunyikan untuk platform pemanggil (header X-App-Platform) yang terdaftar
 * di `payment_instructions.dues_hidden_platforms`. Tiket tidak pernah disembunyikan; tanpa header = tidak disembunyikan.
 */
export function duesInstructionsHidden(
  type: PaymentType,
  platform: DevicePlatform | null,
  setting: SettingValue<"payment_instructions">,
): boolean {
  return isDuesType(type) && platform !== null && setting.dues_hidden_platforms.includes(platform);
}

/** Hold tiket masih berlaku saat `now` (awaiting_payment sebelum hold_expires_at, D5). */
export function holdActive(ticket: Pick<TicketRow, "status" | "holdExpiresAt">, now: Date): boolean {
  return (
    ticket.status === "awaiting_payment" &&
    ticket.holdExpiresAt !== null &&
    ticket.holdExpiresAt.getTime() > now.getTime()
  );
}

/**
 * Reservasi tiket sudah habis dari sudut pandang kirim bukti/ganti metode (AC F09-2): tiket expired, atau masih
 * awaiting_payment tetapi hold sudah lewat (belum dilepas job).
 */
export function reservationLapsed(ticket: Pick<TicketRow, "status" | "holdExpiresAt">, now: Date): boolean {
  if (ticket.status === "expired") return true;
  return (
    ticket.status === "awaiting_payment" &&
    (ticket.holdExpiresAt === null || ticket.holdExpiresAt.getTime() <= now.getTime())
  );
}

export interface MemberActionContext {
  /** Tiket terkait untuk payment tiket. */
  ticket: Pick<TicketRow, "status" | "holdExpiresAt"> | null;
  /** effective_status pemilik saat ini (PRD 2.2: hanya nonsuspended yang boleh bertindak atas pembayaran). */
  status: EffectiveStatus | null;
  hidden: boolean;
  now: Date;
}

const ACTING_STATUSES: ReadonlySet<EffectiveStatus> = new Set([
  "unverified",
  "verified",
  "expiring",
  "expired",
]);

/** Tindakan pemilik yang diizinkan saat respons dibuat (kontrak PaymentActions). Server tetap memeriksa ulang. */
export function memberActions(
  payment: Pick<PaymentRow, "status" | "type" | "proofVersion">,
  context: MemberActionContext,
): Schemas["PaymentActions"] {
  const canAct = context.status !== null && ACTING_STATUSES.has(context.status);
  if (!canAct) return { can_submit_proof: false, can_change_method: false, can_cancel: false };
  if (isDuesType(payment.type)) {
    const open = payment.status === "pending" || payment.status === "rejected";
    const awaitingTransfer = payment.status === "pending" && payment.proofVersion === 0;
    return {
      can_submit_proof: open && !context.hidden,
      can_change_method: awaitingTransfer && !context.hidden,
      can_cancel: awaitingTransfer,
    };
  }
  const ticket = context.ticket;
  if (!ticket || payment.status !== "pending")
    return { can_submit_proof: false, can_change_method: false, can_cancel: false };
  const beforeHold = holdActive(ticket, context.now);
  return {
    can_submit_proof: beforeHold || ticket.status === "awaiting_review",
    can_change_method: payment.proofVersion === 0 && beforeHold,
    can_cancel: false,
  };
}

/** Aturan batas review (kontrak adminListPayments): iuran 1 hari kerja, tiket min(2 hari kerja, buka check-in). */
export interface ReviewRules {
  duesBusinessDays: number;
  ticketBusinessDays: number;
  checkinBeforeHours: number;
}

/** Batas review iuran: `submitted_at` + 1 hari kerja (prototipe screen_8, usulan PRD 1.6). */
export const DUES_REVIEW_BUSINESS_DAYS = 1;

export function reviewRulesOf(eventsSetting: SettingValue<"events">): ReviewRules {
  return {
    duesBusinessDays: DUES_REVIEW_BUSINESS_DAYS,
    ticketBusinessDays: eventsSetting.review_escalation_business_days,
    checkinBeforeHours: eventsSetting.checkin_before_hours,
  };
}

/** Pembukaan jendela check-in event: override event, atau `starts_at` dikurangi `checkin_before_hours` (D5). */
export function checkinOpensAt(
  event: Pick<EventRow, "checkinOpensAt" | "startsAt">,
  checkinBeforeHours: number,
): Date {
  return event.checkinOpensAt ?? new Date(event.startsAt.getTime() - checkinBeforeHours * 3600_000);
}

/** Batas review payment pending berbukti; null selain itu (kontrak AdminPaymentItem.review_due_at). */
export function reviewDueAt(
  payment: Pick<PaymentRow, "status" | "type" | "proofVersion" | "submittedAt">,
  event: Pick<EventRow, "checkinOpensAt" | "startsAt"> | null,
  rules: ReviewRules,
): Date | null {
  if (payment.status !== "pending" || payment.proofVersion < 1 || !payment.submittedAt) return null;
  if (payment.type !== "ticket" || !event)
    return addBusinessDaysJakarta(payment.submittedAt, rules.duesBusinessDays);
  const escalation = addBusinessDaysJakarta(payment.submittedAt, rules.ticketBusinessDays);
  const checkin = checkinOpensAt(event, rules.checkinBeforeHours);
  return escalation.getTime() <= checkin.getTime() ? escalation : checkin;
}

/** Tenggat refund D6: 7 hari kerja sejak pembatalan (PRD 3.9). */
export const REFUND_DUE_BUSINESS_DAYS = 7;

export function refundDueAt(cancelledAt: Date): Date {
  return addBusinessDaysJakarta(cancelledAt, REFUND_DUE_BUSINESS_DAYS);
}

/** Batas pembatalan mandiri dengan refund penuh: sampai H-`selfCancelDays` sebelum `starts_at` (D6, PRD 3.9). */
export function selfCancelFullRefundUntil(startsAt: Date, selfCancelDays: number): Date {
  return new Date(startsAt.getTime() - selfCancelDays * DAY_MS);
}

/**
 * Aturan D6 (PRD 3.9) untuk tiket yang sudah cancelled: refund penuh bila event dibatalkan pengurus (tiket dibatalkan
 * oleh pembatalan event, bukan sebelumnya oleh pengurus) atau peserta membatalkan sendiri sampai H-`selfCancelDays`
 * (pengaturan `events.self_cancel_days`, bawaan 3). Pembatalan oleh pengurus, suspend atau penghapusan akun diputuskan
 * per kasus (false). Dipakai pratinjau `refund_on_approve` dan sebaiknya juga oleh handler tiket modul events agar
 * keduanya selalu sama.
 */
export function fullRefundForCancelledTicket(input: {
  ownerPresent: boolean;
  ticket: Pick<TicketRow, "status" | "cancelledBy" | "cancelledAt"> | null;
  event: Pick<EventRow, "status" | "startsAt" | "cancelledAt"> | null;
  selfCancelDays: number;
}): boolean {
  const { ticket, event } = input;
  if (!input.ownerPresent || !ticket || !event || ticket.status !== "cancelled" || !ticket.cancelledAt) return false;
  if (ticket.cancelledBy === "self")
    return (
      ticket.cancelledAt.getTime() <= selfCancelFullRefundUntil(event.startsAt, input.selfCancelDays).getTime()
    );
  if (event.status !== "cancelled" || ticket.cancelledBy === "admin") return false;
  return !event.cancelledAt || ticket.cancelledAt.getTime() >= event.cancelledAt.getTime();
}

/**
 * Pratinjau `refund_on_approve` (kontrak AdminPaymentDetail): payment tiket pending berbukti yang tiketnya sudah
 * cancelled dengan sebab yang mewajibkan refund penuh D6 ({@link fullRefundForCancelledTicket}).
 */
export function fullRefundOnApprove(input: {
  payment: Pick<PaymentRow, "type" | "status" | "proofVersion" | "userId">;
  ticket: Pick<TicketRow, "status" | "cancelledBy" | "cancelledAt"> | null;
  event: Pick<EventRow, "status" | "startsAt" | "cancelledAt"> | null;
  selfCancelDays: number;
}): boolean {
  const { payment } = input;
  if (payment.type !== "ticket" || payment.status !== "pending" || payment.proofVersion < 1) return false;
  return fullRefundForCancelledTicket({ ...input, ownerPresent: payment.userId !== null });
}

/** Status event payment tiket untuk kontrak (draft tidak pernah memiliki tiket). */
export function ticketEventStatus(status: EventRow["status"]): Schemas["PaymentTicketEventStatus"] | null {
  return status === "draft" ? null : status;
}
