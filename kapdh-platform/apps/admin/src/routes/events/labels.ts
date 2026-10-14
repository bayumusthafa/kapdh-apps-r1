import type { components } from "@kapdh/contracts";
import { formatInTimeZone } from "date-fns-tz";
import { id as localeId } from "date-fns/locale";
import { DEFAULT_TIME_ZONE, formatDateTime, zoneLabel } from "../../lib/format";

type RejectionReason = components["schemas"]["AdminCheckinRejectionReason"];
type TicketCancelledBy = components["schemas"]["TicketCancelledBy"];
type TicketPaymentStatus = components["schemas"]["TicketPaymentStatus"];
type TicketRefundStatus = components["schemas"]["TicketRefundStatus"];
type EventSort = components["schemas"]["AdminEventSort"];
type TicketSort = components["schemas"]["AdminEventTicketSort"];

/**
 * Label dan format area Manajemen Event & Tiket (F-09, F-15). Semua waktu event ditampilkan dalam zona event
 * (PRD 2.1, ARCHITECTURE §2.6); waktu operasional admin lainnya (dibuat, check-in) dalam WIB.
 */

/** Zona waktu Indonesia yang ditawarkan formulir event (bawaan Asia/Jakarta, kontrak AdminEventCreateRequest). */
export const TIMEZONE_OPTIONS = [
  { value: "Asia/Jakarta", label: "WIB (Asia/Jakarta)" },
  { value: "Asia/Makassar", label: "WITA (Asia/Makassar)" },
  { value: "Asia/Jayapura", label: "WIT (Asia/Jayapura)" },
] as const;

/** Opsi zona untuk formulir; zona lain milik event lama tetap ditampilkan agar tidak hilang diam-diam. */
export function timezoneOptions(current: string | null | undefined): { value: string; label: string }[] {
  const base: { value: string; label: string }[] = TIMEZONE_OPTIONS.map((o) => ({ ...o }));
  if (current && !base.some((o) => o.value === current)) base.push({ value: current, label: current });
  return base;
}

function fmt(iso: string, pattern: string, timeZone: string): string {
  return formatInTimeZone(new Date(iso), timeZone, pattern, { locale: localeId });
}

/**
 * Jadwal ringkas dalam zona event: "12 Okt 2026, 09.00–15.00 WIB" bila sehari, atau
 * "12 Okt 2026, 09.00 – 13 Okt 2026, 15.00 WIB" bila lintas hari.
 */
export function formatSchedule(startsAt: string, endsAt: string, timeZone = DEFAULT_TIME_ZONE): string {
  const sameDay = fmt(startsAt, "yyyy-MM-dd", timeZone) === fmt(endsAt, "yyyy-MM-dd", timeZone);
  const start = fmt(startsAt, "d MMM yyyy, HH.mm", timeZone);
  const end = sameDay ? fmt(endsAt, "HH.mm", timeZone) : fmt(endsAt, "d MMM yyyy, HH.mm", timeZone);
  return sameDay ? `${start}–${end} ${zoneLabel(timeZone)}` : `${start} – ${end} ${zoneLabel(timeZone)}`;
}

/** Rentang dua waktu lengkap dalam satu zona: "12 Okt 2026, 07.00 WIB – 12 Okt 2026, 15.00 WIB". */
export function formatRange(from: string, to: string, timeZone = DEFAULT_TIME_ZONE): string {
  return `${formatDateTime(from, timeZone)} – ${formatDateTime(to, timeZone)}`;
}

/** Tanggal sel tabel guideline p14 ("08 Sep 2026") dalam zona event. */
export function formatTableDate(iso: string, timeZone = DEFAULT_TIME_ZONE): string {
  return fmt(iso, "dd MMM yyyy", timeZone);
}

export const EVENT_SORT_OPTIONS: readonly { value: EventSort; label: string }[] = [
  { value: "starts_at_desc", label: "Acara terbaru" },
  { value: "starts_at_asc", label: "Acara terdekat" },
  { value: "registration_closes_at_asc", label: "Tutup daftar terdekat" },
  { value: "created_at_desc", label: "Baru dibuat" },
  { value: "title_asc", label: "Nama A-Z" },
];

export const TICKET_SORT_OPTIONS: readonly { value: TicketSort; label: string }[] = [
  { value: "created_at_desc", label: "Pesanan terbaru" },
  { value: "created_at_asc", label: "Pesanan terlama" },
  { value: "holder_name_asc", label: "Nama A-Z" },
  { value: "checked_in_at_desc", label: "Check-in terbaru" },
];

export const CANCELLED_BY_LABEL: Record<TicketCancelledBy, string> = {
  self: "Dibatalkan peserta",
  admin: "Dibatalkan pengurus",
  system: "Dibatalkan sistem",
};

export const TICKET_PAYMENT_STATUS_LABEL: Record<TicketPaymentStatus, string> = {
  pending: "Menunggu",
  paid: "Lunas",
  rejected: "Ditolak",
  cancelled: "Dibatalkan",
};

export const REFUND_STATUS_LABEL: Record<TicketRefundStatus, string> = {
  pending: "Refund menunggu",
  completed: "Refund selesai",
  cancelled: "Refund dibatalkan",
};

export type ResultTone = "success" | "warning" | "danger";

export interface RejectionCopy {
  /** Judul besar kartu hasil pemindaian. */
  title: string;
  /** Tindakan yang dapat dilakukan petugas (AC F09-6). */
  action: string;
  tone: ResultTone;
}

/**
 * Teks kartu penolakan check-in per alasan server (AC F09-6, PRD 4.5). Pesan server tetap ditampilkan sebagai
 * rincian; teks di sini memberi tindakan lanjut yang konsisten untuk petugas.
 */
export const CHECKIN_REJECTION: Record<RejectionReason, RejectionCopy> = {
  other_event: {
    title: "Tiket event lain",
    action: "Pastikan peserta datang ke event yang benar, atau pilih event tiket ini di pemindai.",
    tone: "danger",
  },
  event_cancelled: {
    title: "Event dibatalkan",
    action: "Seluruh QR tiket event ini tidak berlaku. Arahkan peserta ke pengurus untuk informasi refund.",
    tone: "danger",
  },
  ticket_cancelled: {
    title: "Tiket dibatalkan",
    action: "Tiket ini tidak berlaku. Arahkan peserta ke meja informasi.",
    tone: "danger",
  },
  ticket_expired: {
    title: "Tiket kedaluwarsa",
    action: "Reservasi tidak dibayar sampai batas waktu. Peserta perlu mendaftar ulang bila kuota masih ada.",
    tone: "danger",
  },
  ticket_awaiting_payment: {
    title: "Belum dibayar",
    action: "Peserta belum mengirim bukti transfer. Check-in hanya untuk tiket lunas.",
    tone: "danger",
  },
  ticket_awaiting_review: {
    title: "Pembayaran belum diverifikasi",
    action:
      "Minta pengurus pembayaran memutus bukti transfer di antrean Verifikasi Pembayaran, lalu pindai ulang.",
    tone: "warning",
  },
  already_checked_in: {
    title: "Sudah check-in",
    action: "Tiket ini sudah dipakai. Periksa identitas bila peserta berbeda dengan pemegang tiket.",
    tone: "warning",
  },
  holder_ineligible: {
    title: "Pemegang tidak memenuhi syarat",
    action: "Akun pemegang sedang dibatasi atau tidak aktif. Arahkan peserta ke pengurus.",
    tone: "danger",
  },
  too_early: {
    title: "Check-in belum dibuka",
    action: "Minta peserta kembali saat jendela check-in dibuka.",
    tone: "warning",
  },
  too_late: {
    title: "Check-in sudah ditutup",
    action: "Jendela check-in event ini sudah berakhir.",
    tone: "danger",
  },
};
