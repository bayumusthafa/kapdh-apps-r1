import type { components } from "@kapdh/contracts";
import type { events, tickets } from "@kapdh/database";
import type { EffectiveStatus } from "../../core/membership/effective-status.js";
import type { SettingValue } from "../../core/settings/keys.js";
import { toCents } from "../payments/money.js";
import { REFUND_DUE_BUSINESS_DAYS, selfCancelFullRefundUntil } from "../payments/payment-rules.js";

/**
 * Aturan murni domain event dan tiket (F-09, PRD 3.9, 4.4, D5, D6; kontrak C5 events.yaml dan admin-events.yaml).
 * Tidak menyentuh database: proyeksi kursi/hold, label pendaftaran, alasan blokir reservasi, jendela check-in, kelayakan
 * pembatalan/refund, transisi status dan aksi pengurus, serta alasan penolakan check-in. Dipakai layanan HTTP, job,
 * dan handler pembayaran tiket sehingga semua jalur memakai rumus yang sama.
 */

type Schemas = components["schemas"];
export type EventRow = typeof events.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
export type EventStatus = EventRow["status"];
export type TicketStatus = TicketRow["status"];
export type EventsSetting = SettingValue<"events">;
export type RegistrationState = Schemas["EventRegistrationState"];
export type BlockReason = Schemas["EventReservationBlockReason"];
export type AdminEventAction = Schemas["AdminEventAction"];
export type CheckinRejectionReason = Schemas["AdminCheckinRejectionReason"];

const HOUR_MS = 3600_000;

/** Status tiket yang menahan atau mengonsumsi kursi (indeks unik parsial tickets_user_id_event_id_active_key). */
export const ACTIVE_TICKET_STATUSES = ["awaiting_payment", "awaiting_review", "paid"] as const;

/** Event yang terlihat anggota: draft tidak pernah tampil (404, aturan tag Events). */
export const PUBLISHED_EVENT_STATUSES = ["open", "closed", "done", "cancelled"] as const;

/** Alasan pembatalan payment tiket saat hold habis (kontrak C3 open issue 4; AC F09-2). */
export const HOLD_EXPIRED_REASON = "Batas reservasi habis";

// --------------------------------------------------------------------------------------- proyeksi hold dan kursi

/** Hold awaiting_payment yang sudah lewat `hold_expires_at` tetapi belum dilepas fisik (aturan tag Events). */
export function holdLapsed(ticket: Pick<TicketRow, "status" | "holdExpiresAt">, now: Date): boolean {
  return (
    ticket.status === "awaiting_payment" &&
    (ticket.holdExpiresAt === null || ticket.holdExpiresAt.getTime() <= now.getTime())
  );
}

/** Status tiket menurut proyeksi baca: hold kedaluwarsa tampil `expired` walau job belum berjalan (AC F09-2). */
export function projectedTicketStatus(
  ticket: Pick<TicketRow, "status" | "holdExpiresAt">,
  now: Date,
): TicketStatus {
  return holdLapsed(ticket, now) ? "expired" : ticket.status;
}

/** Tiket aktif (menahan/mengonsumsi kursi) menurut proyeksi baca. */
export function ticketActive(ticket: Pick<TicketRow, "status" | "holdExpiresAt">, now: Date): boolean {
  const status = projectedTicketStatus(ticket, now);
  return status === "awaiting_payment" || status === "awaiting_review" || status === "paid";
}

export interface SeatProjection {
  /** held_aktif = held_quantity - hold kedaluwarsa yang belum dilepas. */
  held: number;
  paid: number;
  available: number;
}

/**
 * Proyeksi kursi (PRD 4.4, aturan tag Events): `seats_available = seats_total - paid_quantity - held_aktif`.
 * `lapsedHolds` = jumlah tiket awaiting_payment event ini yang hold-nya sudah lewat.
 */
export function seatProjection(
  event: Pick<EventRow, "seatsTotal" | "heldQuantity" | "paidQuantity">,
  lapsedHolds: number,
): SeatProjection {
  const held = Math.max(0, event.heldQuantity - lapsedHolds);
  const paid = event.paidQuantity;
  return { held, paid, available: Math.max(0, event.seatsTotal - paid - held) };
}

/** Batas hold reservasi berbayar: min(now + hold_hours, registration_closes_at) (D5, PRD 3.9). */
export function holdExpiresAt(now: Date, holdHours: number, registrationClosesAt: Date): Date {
  const byHours = now.getTime() + holdHours * HOUR_MS;
  return new Date(Math.min(byHours, registrationClosesAt.getTime()));
}

// ------------------------------------------------------------------------------------------ label pendaftaran

/** Label pendaftaran kartu event (kontrak EventRegistrationState, guideline p8). */
export function registrationState(
  event: Pick<EventRow, "status" | "registrationOpensAt" | "registrationClosesAt">,
  seatsAvailable: number,
  now: Date,
): RegistrationState {
  if (event.status === "cancelled") return "cancelled";
  if (
    event.status === "closed" ||
    event.status === "done" ||
    now.getTime() >= event.registrationClosesAt.getTime()
  )
    return "closed";
  if (now.getTime() < event.registrationOpensAt.getTime()) return "not_yet_open";
  if (seatsAvailable <= 0) return "sold_out";
  return "open";
}

/** Anggota yang boleh mendaftar event (PRD 2.2): verified/expiring. */
export function canReserveStatus(status: EffectiveStatus | null): boolean {
  return status === "verified" || status === "expiring";
}

/**
 * Alasan pemanggil belum dapat mendaftar (kontrak EventReservationBlockReason), urutan prioritas: membership_required,
 * has_active_ticket, cancelled, closed, not_yet_open, sold_out. null = dapat mendaftar.
 */
export function reservationBlockReason(input: {
  status: EffectiveStatus | null;
  hasActiveTicket: boolean;
  registration: RegistrationState;
}): BlockReason | null {
  if (!canReserveStatus(input.status)) return "membership_required";
  if (input.hasActiveTicket) return "has_active_ticket";
  switch (input.registration) {
    case "cancelled":
      return "cancelled";
    case "closed":
      return "closed";
    case "not_yet_open":
      return "not_yet_open";
    case "sold_out":
      return "sold_out";
    case "open":
      return null;
  }
}

// ----------------------------------------------------------------------------------------------- check-in D5

export interface CheckinWindow {
  opensAt: Date;
  closesAt: Date;
}

/** Jendela check-in efektif: override event, atau 2 jam sebelum mulai sampai selesai (D5, PRD 3.9). */
export function checkinWindow(
  event: Pick<EventRow, "checkinOpensAt" | "checkinClosesAt" | "startsAt" | "endsAt">,
  checkinBeforeHours: number,
): CheckinWindow {
  return {
    opensAt: event.checkinOpensAt ?? new Date(event.startsAt.getTime() - checkinBeforeHours * HOUR_MS),
    closesAt: event.checkinClosesAt ?? event.endsAt,
  };
}

/** Data pemegang yang menentukan kelayakan check-in (PRD 2.2). */
export interface HolderState {
  /** null bila akun dihapus (tickets.user_id SET NULL). */
  accountStatus: string | null;
  suspended: boolean;
}

/**
 * Pemegang tiket boleh memakai tiket paid (PRD 2.2): akun aktif dan tidak suspended. Anggota expired tetap boleh;
 * suspended, disabled, deletion_pending, atau akun dihapus tidak.
 */
export function holderEligible(holder: HolderState): boolean {
  return holder.accountStatus === "active" && !holder.suspended;
}

/**
 * Pemeriksaan check-in berurutan (kontrak adminCheckInTicket, AC F09-5, F09-6): penolakan PERTAMA yang cocok, atau
 * null bila tiket boleh dicatat hadir.
 */
export function checkinRejection(input: {
  requestedEventId: string;
  ticket: Pick<TicketRow, "eventId" | "status" | "holdExpiresAt" | "checkedInAt">;
  event: Pick<EventRow, "status">;
  holder: HolderState;
  window: CheckinWindow;
  now: Date;
}): CheckinRejectionReason | null {
  const { ticket, event, now } = input;
  if (ticket.eventId !== input.requestedEventId) return "other_event";
  if (event.status === "cancelled") return "event_cancelled";
  const status = projectedTicketStatus(ticket, now);
  if (status === "cancelled") return "ticket_cancelled";
  if (status === "expired") return "ticket_expired";
  if (status === "awaiting_payment") return "ticket_awaiting_payment";
  if (status === "awaiting_review") return "ticket_awaiting_review";
  if (ticket.checkedInAt !== null) return "already_checked_in";
  if (!holderEligible(input.holder)) return "holder_ineligible";
  if (now.getTime() < input.window.opensAt.getTime()) return "too_early";
  if (event.status === "done" || now.getTime() > input.window.closesAt.getTime()) return "too_late";
  return null;
}

/** Kode galat baku per alasan penolakan check-in (kontrak AdminCheckinRejection). */
export function checkinRejectionCode(
  reason: CheckinRejectionReason,
): "TICKET_ALREADY_CHECKED_IN" | "RESERVATION_EXPIRED" | "PAYMENT_STATE_CONFLICT" | "VALIDATION_ERROR" {
  switch (reason) {
    case "already_checked_in":
      return "TICKET_ALREADY_CHECKED_IN";
    case "ticket_expired":
      return "RESERVATION_EXPIRED";
    case "ticket_awaiting_payment":
    case "ticket_awaiting_review":
      return "PAYMENT_STATE_CONFLICT";
    default:
      return "VALIDATION_ERROR";
  }
}

/** Pesan yang dapat ditindaklanjuti petugas per alasan penolakan (AC F09-6, PRD 4.5). */
export function checkinRejectionMessage(
  reason: CheckinRejectionReason,
  context: { ticketEventTitle: string },
): string {
  switch (reason) {
    case "other_event":
      return `QR ini tiket event lain (${context.ticketEventTitle}). Pastikan event yang dipindai sudah benar.`;
    case "event_cancelled":
      return "Event tiket ini sudah dibatalkan sehingga seluruh QR tidak berlaku.";
    case "ticket_cancelled":
      return "Tiket ini sudah dibatalkan dan tidak berlaku untuk check-in.";
    case "ticket_expired":
      return "Reservasi tiket ini sudah kedaluwarsa sebelum dibayar. Peserta perlu mendaftar ulang.";
    case "ticket_awaiting_payment":
      return "Pembayaran tiket belum dikirim. Selesaikan pembayaran sebelum check-in.";
    case "ticket_awaiting_review":
      return "Bukti pembayaran tiket belum diverifikasi. Minta bendahara memutus antrean pembayaran sebelum check-in.";
    case "already_checked_in":
      return "Sudah check-in. Tiket ini sudah tercatat hadir sebelumnya.";
    case "holder_ineligible":
      return "Tiket tidak dapat dipakai karena akun pemegang sedang tidak aktif. Arahkan peserta ke pengurus.";
    case "too_early":
      return "Check-in belum dibuka untuk event ini.";
    case "too_late":
      return "Jendela check-in event ini sudah berakhir.";
  }
}

// ------------------------------------------------------------------------------------ pembatalan dan refund D6

/** Batas refund penuh pembatalan mandiri (H-`self_cancel_days`); null untuk event/tiket gratis (D6). */
export function fullRefundUntil(
  startsAt: Date,
  amount: string,
  selfCancelDays: number,
): Date | null {
  if (toCents(amount) <= 0n) return null;
  return selfCancelFullRefundUntil(startsAt, selfCancelDays);
}

/**
 * Tiket dapat dibatalkan pemiliknya (kontrak cancelMyTicket): awaiting_payment (hold belum lewat) atau paid yang belum
 * check-in, sebelum acara dimulai, event tidak cancelled. awaiting_review tidak (dana mungkin sudah ditransfer).
 */
export function memberCanCancel(
  ticket: Pick<TicketRow, "status" | "holdExpiresAt" | "checkedInAt">,
  event: Pick<EventRow, "status" | "startsAt">,
  now: Date,
): boolean {
  if (event.status === "cancelled" || now.getTime() >= event.startsAt.getTime()) return false;
  if (ticket.checkedInAt !== null) return false;
  const status = projectedTicketStatus(ticket, now);
  return status === "awaiting_payment" || status === "paid";
}

/** Pembatalan mandiri SEKARANG menghasilkan refund penuh (paid, total > 0, sebelum H-3; D6). */
export function memberRefundEligible(
  ticket: Pick<TicketRow, "status" | "holdExpiresAt" | "checkedInAt" | "totalSnapshot">,
  event: Pick<EventRow, "status" | "startsAt">,
  now: Date,
  selfCancelDays: number,
): boolean {
  if (!memberCanCancel(ticket, event, now) || ticket.status !== "paid") return false;
  const until = fullRefundUntil(event.startsAt, ticket.totalSnapshot, selfCancelDays);
  return until !== null && now.getTime() < until.getTime();
}

/**
 * Tiket dapat dibatalkan pengurus (kontrak adminCancelTicket): awaiting_payment atau paid yang belum check-in pada
 * event yang tidak cancelled. awaiting_review ditolak terpisah (PAYMENT_STATE_CONFLICT).
 */
export function adminCanCancel(
  ticket: Pick<TicketRow, "status" | "holdExpiresAt" | "checkedInAt">,
  event: Pick<EventRow, "status">,
  now: Date,
): boolean {
  if (event.status === "cancelled" || ticket.checkedInAt !== null) return false;
  const status = projectedTicketStatus(ticket, now);
  return status === "awaiting_payment" || status === "paid";
}

// ------------------------------------------------------------------------------------------- format tampilan

const ZONE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  "Asia/Jakarta": "WIB",
  "Asia/Pontianak": "WIB",
  "Asia/Makassar": "WITA",
  "Asia/Jayapura": "WIT",
};

/** Zona waktu IANA yang dikenal runtime (kontrak AdminEventCreateRequest.timezone, PRD 2.1). */
export function isValidTimezone(timezone: string): boolean {
  if (timezone.length === 0 || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("id-ID", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** "12 Okt 2026 09.00 WIB" dalam zona waktu event (PRD 2.1). */
export function formatEventDateTime(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const zone = ZONE_ABBREVIATIONS[timezone] ?? timezone;
  return `${part("day")} ${part("month")} ${part("year")} ${part("hour")}.${part("minute")} ${zone}`;
}

/** Aturan pembatalan dan refund D6 untuk event (kontrak EventCancellationPolicy). */
export function cancellationPolicy(
  event: Pick<EventRow, "startsAt" | "timezone" | "price">,
  setting: Pick<EventsSetting, "self_cancel_days">,
): Schemas["EventCancellationPolicy"] {
  const until = fullRefundUntil(event.startsAt, event.price, setting.self_cancel_days);
  const start = formatEventDateTime(event.startsAt, event.timezone);
  const summary =
    until === null
      ? `Event gratis: batalkan sebelum acara dimulai (${start}) untuk melepas kursi; tidak ada refund.`
      : `Batalkan sampai ${formatEventDateTime(until, event.timezone)} (H-${setting.self_cancel_days}) untuk refund penuh; ` +
        `setelah itu tanpa refund. Refund ditransfer bendahara paling lambat ${REFUND_DUE_BUSINESS_DAYS} hari kerja.`;
  return {
    self_cancel_until: event.startsAt.toISOString(),
    full_refund_until: until?.toISOString() ?? null,
    refund_processing_business_days: REFUND_DUE_BUSINESS_DAYS,
    summary,
  };
}

// --------------------------------------------------------------------------------- siklus event oleh pengurus

/** Event dapat diubah pengurus (kontrak adminUpdateEvent): draft/open/closed. */
export function eventEditable(status: EventStatus): boolean {
  return status === "draft" || status === "open" || status === "closed";
}

/**
 * Transisi adminSetEventStatus (PRD 4.4): draft → open (ends_at dan registration_closes_at masih di depan),
 * open → closed, closed → open (masih dalam jendela pendaftaran). Mengembalikan pesan penolakan atau null.
 */
export function statusTransitionError(
  event: Pick<EventRow, "status" | "endsAt" | "registrationClosesAt">,
  target: "open" | "closed",
  now: Date,
): string | null {
  const future = (at: Date) => at.getTime() > now.getTime();
  if (target === "open") {
    if (event.status === "draft")
      return future(event.endsAt) && future(event.registrationClosesAt)
        ? null
        : "Event tidak dapat diterbitkan karena jadwal pendaftaran atau acara sudah lewat. Ubah jadwal lebih dahulu.";
    if (event.status === "closed")
      return future(event.endsAt) && future(event.registrationClosesAt)
        ? null
        : "Pendaftaran tidak dapat dibuka kembali karena batas tutup daftar sudah lewat.";
    return "Event ini tidak dapat dibuka dari status saat ini.";
  }
  if (event.status === "open") return null;
  return "Hanya event berstatus open yang dapat ditutup.";
}

/** Aksi pengurus yang diizinkan saat ini (kontrak AdminEventAction). */
export function allowedActions(
  event: Pick<EventRow, "status" | "endsAt" | "registrationClosesAt">,
  hasTickets: boolean,
  now: Date,
): AdminEventAction[] {
  const actions: AdminEventAction[] = [];
  if (eventEditable(event.status)) actions.push("edit");
  if (event.status === "draft" && statusTransitionError(event, "open", now) === null) actions.push("publish");
  if (event.status === "open") actions.push("close");
  if (event.status === "closed" && statusTransitionError(event, "open", now) === null) actions.push("reopen");
  if (event.status === "open" || event.status === "closed") actions.push("cancel");
  if (!hasTickets) actions.push("delete");
  return actions;
}

// ---------------------------------------------------------------------------------------------- pengingat F13-6

export type ReminderKind = "h3" | "h1";

const DAY_MS = 24 * HOUR_MS;

/**
 * Jendela pengingat event (AC F13-6): H-1 bila acara dimulai dalam <= 1 hari, H-3 bila <= 3 hari (dan belum masuk
 * H-1); null bila belum waktunya atau acara sudah mulai.
 */
export function reminderDue(startsAt: Date, now: Date): ReminderKind | null {
  const remaining = startsAt.getTime() - now.getTime();
  if (remaining <= 0) return null;
  if (remaining <= DAY_MS) return "h1";
  if (remaining <= 3 * DAY_MS) return "h3";
  return null;
}

/**
 * Kunci dedup pengingat (AC F13-6): event + jenis + jadwal mulai. Perubahan jadwal menghasilkan kunci baru sehingga
 * pengingat jadwal usang tidak lagi berlaku dan jadwal baru tetap mendapat pengingatnya; job yang berjalan berulang
 * tidak pernah menggandakan inbox (kunci dedup notifikasi per pengguna).
 */
export function reminderDedupKey(eventId: string, kind: ReminderKind, startsAt: Date): string {
  return `event.reminder.${kind}:${eventId}:${startsAt.getTime()}`;
}
