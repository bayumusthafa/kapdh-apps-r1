import type { Permission } from "@kapdh/contracts";
import { mockAdminRef, mockHasPermission, requirePermission, requireReauth } from "./auth";
import { error, json, type MockRequest, type MockRoute, noContent, paginate, type S } from "./http";
import {
  applyPaidDuesForMocks,
  MOCK_MEMBER,
  peekMemberForMocks,
  registerMemberPaymentsSourceForMocks,
} from "./members";

/**
 * Tiruan area pembayaran web admin mengikuti kontrak admin-payments dan admin-settings final (C3): antrean,
 * detail dan keputusan (F-04), pembatalan instruksi tanpa bukti (PRD 4.3), penyesuaian refund/koreksi (D6, D2),
 * metode bayar (F-15) dan biaya iuran (F-03, AC F15-3). Data contoh mengikuti prototipe screen_8; bukan bukti
 * lulus acceptance criteria (PRD 7.3). Endpoint nyata dibangun irisan API payments.
 *
 * Aturan server yang ditiru:
 * - Penjaga berurutan seperti API: izin (semua izin `x-kapdh-access.permissions`), reautentikasi, pemutaran ulang
 *   Idempotency-Key, validasi body, If-Match, lalu pemeriksaan keadaan.
 * - `stage` dihitung server; "Menunggu" = `stage=awaiting_review`, total sama dengan `awaiting_review_count`.
 * - `actions` dihitung per pemanggil (izin payments.decide, tahap, konflik kepentingan PRD 2.3).
 * - Akun pemilik dihapus (D2, AC F14-4): `member` null, `proof` null walau `proof_version` >= 1.
 * - Tiket yang sudah dibatalkan sebelum keputusan: approve = dana diterima tanpa menghidupkan tiket, refund sistem
 *   penuh dibuat bila `refund_on_approve` (D6).
 * - Urutan 409 keputusan: PAYMENT_STATE_CONFLICT, PROOF_VERSION_CONFLICT, VERSION_CONFLICT.
 * - Rekening tujuan refund hanya dikirim di detail penyesuaian kepada pemegang payments.decide yang tidak
 *   berkonflik kepentingan, selama pending; tidak pernah di daftar; dihapus saat selesai/dibatal (D2).
 * - Metode yang sudah dipakai payment (`in_use`) hanya dapat dinonaktifkan; identitas rekeningnya terkunci.
 * - Pencatatan iuran D13 (adminRecordPayment): kelayakan seperti GET /me/fees, payment terbuka awaiting_transfer/
 *   needs_fix diselesaikan di tempat (200), awaiting_review → 409 dengan `current`, selain itu payment baru dari biaya
 *   aktif (201); bukti wajib payment_proof unggahan admin pemanggil yang belum terpakai (422).
 * - Anggota Siti, Hasan, Fikri dan Nur adalah anggota tiruan members.ts yang sama (user_id sama): payment mereka
 *   tampil di "Pembayaran terbaru" detail anggota, dan iuran yang paid memperbarui masa aktif anggota itu.
 */
type Detail = S["AdminPaymentDetail"];
type PaymentEvent = S["AdminPaymentEvent"];
type Adjustment = S["AdminPaymentAdjustment"];
type ActorRef = S["AdminPaymentActorRef"];
type MethodRow = Omit<S["AdminPaymentMethod"], "in_use">;

/** Waktu server tiruan saat data contoh dibuat; dasar `overdue` agar data contoh deterministik. */
const MOCK_SERVER_NOW = Date.parse("2026-10-12T11:00:00Z");
/** Asia/Jakarta UTC+7 tanpa DST: hari kerja Senin-Jumat dihitung pada tanggal WIB (kontrak adminListPayments). */
const WIB_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
/** Jendela check-in dibuka 2 jam sebelum event (app_settings events.checkin_before_hours, D5). */
const CHECKIN_BEFORE_MS = 2 * 3_600_000;
/** Tenggat refund bendahara: 7 hari kerja sejak pembatalan (D6). */
const REFUND_DUE_BUSINESS_DAYS = 7;

/** Pengurus lain (bukan admin yang sedang masuk) sebagai pelaku keputusan dan penyesuaian contoh. */
const OTHER_ADMIN: ActorRef = {
  admin_id: "0199e000-0000-7000-8000-0000000000ae",
  display_name: "Admin Keuangan",
};

const METHOD_ID = "0199e000-0000-7000-8000-000000000001";

/** Snapshot rekening tujuan pada payment contoh (sama dengan metode M1 saat instruksi dibuat). */
const METHOD: S["PaymentMethod"] = {
  id: METHOD_ID,
  kind: "bank",
  provider: "[Nama bank 1]",
  account_number: "[Nomor rekening]",
  account_holder: "[Nama pemilik rekening]",
  instructions: null,
};

/** Berkas bukti contoh; GET /files/{id}/access di mocks/files.ts mengembalikan gambar tiruan. */
export const MOCK_PROOF_FILE_ID = "0199e000-0000-7000-8000-0000000000f1";
export const MOCK_PROOF_FILE_ID_V2 = "0199e000-0000-7000-8000-0000000000f2";
/** Bukti transfer berupa PDF (N-10: PDF <= 10 MB khusus bukti bayar). */
export const MOCK_PROOF_FILE_ID_PDF = "0199e000-0000-7000-8000-0000000000f3";
/** Bukti penyelesaian refund (purpose adjustment_evidence, D6). */
export const MOCK_EVIDENCE_FILE_ID = "0199e000-0000-7000-8000-0000000000f4";
/** Jenis dan ukuran berkas bukti tiruan (sama dengan mocks/files.ts). */
const PROOF_MIME = "image/svg+xml";
const PROOF_BYTES = 2048;

/** Tambah `days` hari kerja (Senin-Jumat, tanggal WIB) dengan jam yang sama. */
function addBusinessDays(iso: string, days: number): string {
  let local = Date.parse(iso) + WIB_OFFSET_MS;
  let added = 0;
  while (added < days) {
    local += DAY_MS;
    const dow = new Date(local).getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return new Date(local - WIB_OFFSET_MS).toISOString();
}

/** Batas review: iuran +1 hari kerja; tiket min(+2 hari kerja, pembukaan check-in) (C3, PRD 4.4, D5). */
function reviewDueAt(type: S["PaymentType"], submittedAt: string, eventStartsAt: string | null): string {
  if (type !== "ticket" || !eventStartsAt) return addBusinessDays(submittedAt, 1);
  const byDays = Date.parse(addBusinessDays(submittedAt, 2));
  const checkinOpens = Date.parse(eventStartsAt) - CHECKIN_BEFORE_MS;
  return new Date(Math.min(byDays, checkinOpens)).toISOString();
}

/** Lewat tenggat terhadap waktu server data contoh. */
function pastMockNow(iso: string | null): boolean {
  return iso !== null && Date.parse(iso) < MOCK_SERVER_NOW;
}

/** Money "60000.00" sebagai sen BigInt; aritmetika uang tanpa floating point (ARCHITECTURE §2 butir 5). */
function cents(m: string): bigint {
  return BigInt(m.replace(".", ""));
}

function fromCents(value: bigint): string {
  const text = value.toString().padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

function addMoney(a: string, b: string): string {
  return fromCents(cents(a) + cents(b));
}

function lines(type: S["PaymentType"], amount: string): S["PaymentLine"][] {
  if (type === "registration")
    return [
      { code: "registration_fee", label: "Register alumni baru", amount: "50000.00" },
      { code: "card_fee", label: "Pembuatan KTA", amount: "10000.00" },
    ];
  if (type === "renewal") return [{ code: "renewal_fee", label: "Perpanjangan KTA", amount: "10000.00" }];
  return [{ code: "ticket", label: "Tiket event", amount }];
}

interface TicketSpec {
  eventId: string;
  ticketId: string;
  eventTitle: string;
  eventStartsAt: string;
  /** Tiket/event sudah dibatalkan sebelum keputusan (PRD 4.4). */
  cancelled?: { by: S["PaymentTicketCancelledBy"]; eventCancelled: boolean; at: string };
}

interface Spec {
  id: string;
  /** null = akun pemilik sudah dihapus (D2, AC F14-4). */
  member: S["AdminPaymentMember"] | null;
  type: S["PaymentType"];
  amount: string;
  createdAt: string;
  /** null = belum ada bukti (stage awaiting_transfer). */
  submittedAt: string | null;
  ticket?: TicketSpec;
  transferNote?: string;
  proofFileId?: string;
  proofMime?: string;
}

function member(
  userId: string,
  fullName: string,
  memberNumber: string,
  cohort: number,
  status: S["EffectiveStatus"],
): S["AdminPaymentMember"] {
  return {
    user_id: userId,
    full_name: fullName,
    member_number: memberNumber,
    cohort,
    effective_status: status,
  };
}

/** Pemilik payment yang juga anggota tiruan members.ts (identitas, nomor dan status dari sana). */
function directoryMember(userId: string): S["AdminPaymentMember"] {
  const m = peekMemberForMocks(userId);
  if (!m) throw new Error(`Anggota tiruan ${userId} tidak ada di members.ts`);
  return {
    user_id: m.user_id,
    full_name: m.full_name,
    member_number: m.member_number,
    cohort: m.cohort,
    effective_status: m.effective_status,
  };
}

const NO_ACTIONS: S["AdminPaymentActions"] = { can_decide: false, can_cancel: false, can_adjust: false };

function event(
  at: string,
  kind: PaymentEvent["kind"],
  actor: PaymentEvent["actor"],
  extra: Partial<Pick<PaymentEvent, "proof_version" | "reason" | "proof_file_id" | "actor_admin">> = {},
): PaymentEvent {
  return {
    at,
    kind,
    actor,
    proof_version: extra.proof_version ?? null,
    reason: extra.reason ?? null,
    proof_file_id: extra.proof_file_id ?? null,
    actor_admin: extra.actor_admin ?? null,
  };
}

/** Payment pending (berbukti versi 1, atau tanpa bukti) dengan semua field wajib AdminPaymentDetail. */
function build(spec: Spec): Detail {
  const t = spec.ticket;
  const hasProof = spec.submittedAt !== null;
  const deleted = spec.member === null;
  const dueAt = hasProof ? reviewDueAt(spec.type, spec.submittedAt!, t?.eventStartsAt ?? null) : null;
  const proofFileId = spec.proofFileId ?? MOCK_PROOF_FILE_ID;
  const ticketStatus: S["PaymentTicketStatus"] | null = t
    ? t.cancelled
      ? "cancelled"
      : hasProof
        ? "awaiting_review"
        : "awaiting_payment"
    : null;
  const events: PaymentEvent[] = [event(spec.createdAt, "created", "member")];
  if (hasProof)
    events.push(
      event(spec.submittedAt!, "proof_submitted", "member", {
        proof_version: 1,
        // Berkas bukti ikut dihapus bersama akun pemilik; histori mengembalikan null (D2).
        proof_file_id: deleted ? null : proofFileId,
      }),
    );
  if (t?.cancelled)
    events.push(
      event(
        t.cancelled.at,
        "cancelled",
        t.cancelled.by === "system" ? "system" : t.cancelled.by === "admin" ? "admin" : "member",
        { reason: t.cancelled.eventCancelled ? "Event dibatalkan pengurus." : "Tiket dibatalkan." },
      ),
    );
  return {
    id: spec.id,
    type: spec.type,
    status: "pending",
    stage: hasProof ? "awaiting_review" : "awaiting_transfer",
    amount: spec.amount,
    member: spec.member,
    event_title: t?.eventTitle ?? null,
    event_starts_at: t?.eventStartsAt ?? null,
    ticket_status: ticketStatus,
    event_cancelled: t ? (t.cancelled?.eventCancelled ?? false) : null,
    submitted_at: spec.submittedAt,
    decided_at: null,
    review_due_at: dueAt,
    proof_version: hasProof ? 1 : 0,
    overdue: pastMockNow(dueAt),
    created_at: spec.createdAt,
    version: "1",
    lines: lines(spec.type, spec.amount),
    method: METHOD,
    method_id: METHOD.id,
    method_active: true,
    proof:
      hasProof && !deleted
        ? {
            file_id: proofFileId,
            version: 1,
            mime: spec.proofMime ?? PROOF_MIME,
            bytes: PROOF_BYTES,
            submitted_at: spec.submittedAt!,
          }
        : null,
    transfer_note: hasProof && !deleted ? (spec.transferNote ?? null) : null,
    rejection_reason: null,
    rejection_count: 0,
    decided_by: null,
    cancelled_at: null,
    cancel_reason: null,
    ticket: t
      ? {
          ticket_id: t.ticketId,
          event_id: t.eventId,
          event_title: t.eventTitle,
          event_starts_at: t.eventStartsAt,
          event_timezone: "Asia/Jakarta",
          ticket_status: ticketStatus!,
          hold_expires_at: null,
          event_status: t.cancelled?.eventCancelled ? "cancelled" : "open",
          ticket_cancelled_by: t.cancelled?.by ?? null,
        }
      : null,
    period: null,
    settings_version: spec.type === "ticket" ? null : "1",
    events,
    adjustments: [],
    conflict_of_interest: false,
    // Refund penuh otomatis saat approve hanya untuk event dibatalkan atau batal mandiri sampai H-3 (D6).
    refund_on_approve: Boolean(t?.cancelled && (t.cancelled.eventCancelled || t.cancelled.by === "self")),
    actions: NO_ACTIONS,
  };
}

function nextVersion(p: { version: string }): string {
  return String(Number(p.version) + 1);
}

/** Anggota mengganti rekening tujuan sebelum mentransfer (payment_events `method_changed`). */
function withMethodChange(p: Detail, at: string): Detail {
  return {
    ...p,
    version: nextVersion(p),
    events: [...p.events, event(at, "method_changed", "member")],
  };
}

/**
 * Bukti berikutnya dari anggota: instruksi tanpa bukti menjadi berbukti (proof_submitted), pending tetap pending dan
 * iuran rejected kembali pending pada payment yang sama (proof_replaced, AC F03-3).
 */
function withReplacedProof(p: Detail, at: string, fileId: string, overdue: (due: string) => boolean): Detail {
  const proofVersion = p.proof_version + 1;
  const dueAt = reviewDueAt(p.type, at, p.event_starts_at);
  return {
    ...p,
    status: "pending",
    stage: "awaiting_review",
    proof_version: proofVersion,
    proof: { file_id: fileId, version: proofVersion, mime: PROOF_MIME, bytes: PROOF_BYTES, submitted_at: at },
    submitted_at: at,
    decided_at: null,
    review_due_at: dueAt,
    overdue: overdue(dueAt),
    version: nextVersion(p),
    events: [
      ...p.events,
      event(at, p.proof_version === 0 ? "proof_submitted" : "proof_replaced", "member", {
        proof_version: proofVersion,
        proof_file_id: fileId,
      }),
    ],
  };
}

/** Keputusan yang sudah lolos semua pemeriksaan (satu transaksi di server, AC F04-1). */
function applyDecision(
  p: Detail,
  decision: "approve" | "reject",
  reason: string,
  at: string,
  admin: ActorRef,
): { payment: Detail; refund: Adjustment | null } {
  const common = {
    ...p,
    decided_at: at,
    decided_by: admin,
    review_due_at: null,
    overdue: false,
    version: nextVersion(p),
    events: [
      ...p.events,
      event(at, decision === "approve" ? "approved" : "rejected", "admin", {
        proof_version: p.proof_version,
        reason: decision === "reject" ? reason : null,
        actor_admin: admin,
      }),
    ],
  };
  if (decision === "approve") {
    // Tiket yang sudah dibatalkan tidak dihidupkan kembali; selain itu tiket menjadi paid (PRD 4.4).
    const ticketStatus = p.ticket_status === "cancelled" ? "cancelled" : p.type === "ticket" ? "paid" : null;
    const expires = new Date(at);
    expires.setUTCMonth(expires.getUTCMonth() + 12);
    const payment: Detail = {
      ...common,
      status: "paid",
      stage: "paid",
      ticket_status: ticketStatus,
      ticket: p.ticket && ticketStatus ? { ...p.ticket, ticket_status: ticketStatus } : p.ticket,
      // Periode keanggotaan hanya bila pemilik masih ada (akun dihapus: tanpa efek keanggotaan, PRD 4.4).
      period:
        p.type !== "ticket" && p.member ? { starts_at: at, expires_at: expires.toISOString() } : p.period,
      refund_on_approve: false,
    };
    return { payment, refund: p.refund_on_approve ? systemRefund(payment, at) : null };
  }
  // Iuran ditolak dapat diperbaiki pemilik (needs_fix); tiket ditolak final dan tiketnya cancelled (AC F09-4).
  const ticket = p.type === "ticket";
  return {
    payment: {
      ...common,
      status: "rejected",
      stage: ticket ? "rejected_final" : "needs_fix",
      ticket_status: ticket ? "cancelled" : null,
      ticket: p.ticket ? { ...p.ticket, ticket_status: "cancelled" } : null,
      rejection_reason: reason,
      rejection_count: p.rejection_count + 1,
      refund_on_approve: false,
    },
    refund: null,
  };
}

/** Tiket paid yang kemudian dibatalkan (event dibatalkan pengurus atau peserta batal mandiri, D6). */
function withTicketCancelledAfterPaid(
  p: Detail,
  by: S["PaymentTicketCancelledBy"],
  eventCancelled: boolean,
): Detail {
  return {
    ...p,
    ticket_status: "cancelled",
    event_cancelled: eventCancelled,
    ticket: p.ticket
      ? {
          ...p.ticket,
          ticket_status: "cancelled",
          ticket_cancelled_by: by,
          event_status: eventCancelled ? "cancelled" : p.ticket.event_status,
        }
      : null,
  };
}

function paymentRef(p: Detail): S["AdminAdjustmentPaymentRef"] {
  return {
    id: p.id,
    type: p.type,
    status: p.status,
    amount: p.amount,
    member: p.member,
    event_title: p.event_title,
    decided_at: p.decided_at,
  };
}

interface AdjustmentSpec {
  id: string;
  payment: Detail;
  kind: Adjustment["kind"];
  amount: string;
  reason: string;
  createdAt: string;
  createdBy: ActorRef | null;
  dueAt: string | null;
  destination?: S["AdminRefundDestination"] | null;
  evidenceFileId?: string | null;
}

function newAdjustment(spec: AdjustmentSpec): Adjustment {
  return {
    id: spec.id,
    payment_id: spec.payment.id,
    payment: paymentRef(spec.payment),
    kind: spec.kind,
    amount: spec.amount,
    reason: spec.reason,
    status: "pending",
    has_refund_destination: Boolean(spec.destination),
    // Disimpan mentah di server tiruan; respons disaring per pemanggil (lihat presentAdjustment).
    refund_destination: spec.destination ?? null,
    evidence_file_id: spec.evidenceFileId ?? null,
    due_at: spec.dueAt,
    overdue: pastMockNow(spec.dueAt),
    created_by: spec.createdBy,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: spec.createdAt,
    updated_at: spec.createdAt,
    version: "1",
  };
}

let adjustmentSeq = 0;

function nextAdjustmentId(): string {
  adjustmentSeq += 1;
  return `0199e000-0000-7000-8000-0000000003${String(adjustmentSeq).padStart(2, "0")}`;
}

/** Waktu pembatalan tiket/event terkait payment (dasar tenggat refund 7 hari kerja, D6). */
function cancellationAt(p: Detail): string | null {
  return p.events.findLast((e) => e.kind === "cancelled")?.at ?? null;
}

/** Refund sistem penuh saat approve tiket yang event-nya dibatalkan (D6): created_by null, tenggat 7 hari kerja. */
function systemRefund(p: Detail, decidedAt: string): Adjustment {
  return {
    ...newAdjustment({
      id: nextAdjustmentId(),
      payment: p,
      kind: "refund",
      amount: p.amount,
      reason: p.event_cancelled
        ? "Refund penuh otomatis: event dibatalkan pengurus (D6)."
        : "Refund penuh otomatis: peserta membatalkan tiket paling lambat H-3 (D6).",
      createdAt: decidedAt,
      createdBy: null,
      dueAt: addBusinessDays(cancellationAt(p) ?? decidedAt, REFUND_DUE_BUSINESS_DAYS),
    }),
    overdue: false,
  };
}

/** Waktu pembatalan event contoh (dasar tenggat refund 7 hari kerja, D6). */
const SEMINAR_CANCELLED_AT = "2026-10-12T09:00:00Z";
const SEMINAR = {
  eventId: "0199e000-0000-7000-8000-0000000000e2",
  eventTitle: "Seminar Karier Alumni",
  eventStartsAt: "2026-10-25T02:00:00Z",
};
const HALAL = {
  eventId: "0199e000-0000-7000-8000-0000000000e1",
  eventTitle: "Halal bi Halal",
  eventStartsAt: "2026-10-24T01:00:00Z",
};

interface Fixtures {
  payments: Detail[];
  adjustments: Adjustment[];
}

function fixtures(): Fixtures {
  const overdueAtMockNow = (due: string) => pastMockNow(due);
  // Siti: bukti versi 1 ditolak, lalu bukti pengganti versi 2 dikirim; alasan lama tetap di histori (AC F03-3).
  const sitiV1 = build({
    id: "0199e000-0000-7000-8000-0000000000a1",
    member: directoryMember(MOCK_MEMBER.siti),
    type: "registration",
    amount: "60000.00",
    createdAt: "2026-10-09T01:40:00Z",
    submittedAt: "2026-10-09T02:00:00Z",
  });
  const sitiRejected = applyDecision(
    sitiV1,
    "reject",
    "Foto bukti buram sehingga nominal tidak terbaca.",
    "2026-10-10T03:00:00Z",
    OTHER_ADMIN,
  ).payment;
  const siti = withReplacedProof(
    sitiRejected,
    "2026-10-11T02:02:00Z",
    MOCK_PROOF_FILE_ID_V2,
    overdueAtMockNow,
  );

  const base: Detail[] = [
    siti,
    build({
      id: "0199e000-0000-7000-8000-0000000000a2",
      member: member("0199e000-0000-7000-8000-0000000000b2", "Ahmad Islam", "29.01.01.7", 29, "unverified"),
      type: "registration",
      amount: "60000.00",
      createdAt: "2026-10-12T07:00:00Z",
      submittedAt: "2026-10-12T07:20:00Z",
      transferNote: "Transfer m-banking a.n. Ahmad Islam pukul 14.15 WIB.",
    }),
    build({
      id: "0199e000-0000-7000-8000-0000000000a3",
      member: directoryMember(MOCK_MEMBER.fikri),
      type: "renewal",
      amount: "10000.00",
      createdAt: "2026-10-12T07:50:00Z",
      submittedAt: "2026-10-12T08:05:00Z",
    }),
    build({
      id: "0199e000-0000-7000-8000-0000000000a5",
      member: directoryMember(MOCK_MEMBER.nur),
      type: "ticket",
      amount: "75000.00",
      createdAt: "2026-10-12T08:30:00Z",
      submittedAt: "2026-10-12T08:40:00Z",
      ticket: { ...HALAL, ticketId: "0199e000-0000-7000-8000-0000000000c5" },
    }),
    // Bukti berupa PDF (N-10): pratinjau tampil sebagai dokumen PDF.
    build({
      id: "0199e000-0000-7000-8000-0000000000a4",
      member: member(
        "0199e000-0000-7000-8000-0000000000b4",
        "Rizky Pratama",
        "22.03.01.11",
        22,
        "unverified",
      ),
      type: "registration",
      amount: "60000.00",
      createdAt: "2026-10-12T08:50:00Z",
      submittedAt: "2026-10-12T09:02:00Z",
      proofFileId: MOCK_PROOF_FILE_ID_PDF,
      proofMime: "application/pdf",
    }),
    // Akun pemilik dihapus setelah mengirim bukti: tetap di antrean dalam bentuk anonim (AC F14-4, PRD 4.4).
    build({
      id: "0199e000-0000-7000-8000-0000000000a6",
      member: null,
      type: "registration",
      amount: "60000.00",
      createdAt: "2026-10-12T04:40:00Z",
      submittedAt: "2026-10-12T05:00:00Z",
    }),
    // Event dibatalkan pengurus setelah bukti dikirim: approve = dana diterima + refund penuh otomatis (D6).
    build({
      id: "0199e000-0000-7000-8000-0000000000a8",
      member: member("0199e000-0000-7000-8000-0000000000b8", "Dewi Lestari", "25.01.02.14", 25, "verified"),
      type: "ticket",
      amount: "50000.00",
      createdAt: "2026-10-12T06:00:00Z",
      submittedAt: "2026-10-12T06:15:00Z",
      ticket: {
        ...SEMINAR,
        ticketId: "0199e000-0000-7000-8000-0000000000c8",
        cancelled: { by: "system", eventCancelled: true, at: SEMINAR_CANCELLED_AT },
      },
    }),
    // Instruksi tanpa bukti (awaiting_transfer): tidak termasuk "Menunggu", hanya terlihat di "Semua". Anggota
    // sempat mengganti rekening tujuan sebelum mentransfer (histori method_changed).
    withMethodChange(
      build({
        id: "0199e000-0000-7000-8000-0000000000a7",
        member: directoryMember(MOCK_MEMBER.hasan),
        type: "renewal",
        amount: "10000.00",
        createdAt: "2026-10-12T03:00:00Z",
        submittedAt: null,
      }),
      "2026-10-12T03:10:00Z",
    ),
  ];

  // Payment yang sudah diputus (tab Disetujui/Ditolak) beserta penyesuaiannya (D6).
  const fajar = withTicketCancelledAfterPaid(
    applyDecision(
      build({
        id: "0199e000-0000-7000-8000-0000000001a1",
        member: member(
          "0199e000-0000-7000-8000-0000000002a1",
          "Fajar Nugroho",
          "24.01.01.21",
          24,
          "verified",
        ),
        type: "ticket",
        amount: "50000.00",
        createdAt: "2026-10-02T02:00:00Z",
        submittedAt: "2026-10-02T02:30:00Z",
        ticket: { ...SEMINAR, ticketId: "0199e000-0000-7000-8000-0000000002c1" },
      }),
      "approve",
      "",
      "2026-10-03T03:00:00Z",
      OTHER_ADMIN,
    ).payment,
    "system",
    true,
  );
  const laila = withTicketCancelledAfterPaid(
    applyDecision(
      build({
        id: "0199e000-0000-7000-8000-0000000001a2",
        member: member(
          "0199e000-0000-7000-8000-0000000002a2",
          "Laila Fitriani",
          "28.02.02.6",
          28,
          "verified",
        ),
        type: "ticket",
        amount: "75000.00",
        createdAt: "2026-09-25T02:00:00Z",
        submittedAt: "2026-09-25T02:20:00Z",
        ticket: { ...HALAL, ticketId: "0199e000-0000-7000-8000-0000000002c2" },
      }),
      "approve",
      "",
      "2026-09-26T03:00:00Z",
      OTHER_ADMIN,
    ).payment,
    "self",
    false,
  );
  const yusuf = applyDecision(
    build({
      id: "0199e000-0000-7000-8000-0000000001a3",
      member: member("0199e000-0000-7000-8000-0000000002a3", "Yusuf Hidayat", "15.01.01.9", 15, "verified"),
      type: "renewal",
      amount: "10000.00",
      createdAt: "2026-10-04T01:00:00Z",
      submittedAt: "2026-10-04T01:10:00Z",
    }),
    "approve",
    "",
    "2026-10-05T02:00:00Z",
    OTHER_ADMIN,
  ).payment;
  const gitaPaid = withTicketCancelledAfterPaid(
    applyDecision(
      build({
        id: "0199e000-0000-7000-8000-0000000001a4",
        member: member("0199e000-0000-7000-8000-0000000002a4", "Gita Permata", "26.02.01.12", 26, "verified"),
        type: "ticket",
        amount: "75000.00",
        createdAt: "2026-09-28T02:00:00Z",
        submittedAt: "2026-09-28T02:15:00Z",
        ticket: { ...HALAL, ticketId: "0199e000-0000-7000-8000-0000000002c4" },
      }),
      "approve",
      "",
      "2026-09-29T02:00:00Z",
      OTHER_ADMIN,
    ).payment,
    "self",
    false,
  );
  const gita: Detail = {
    ...gitaPaid,
    version: nextVersion(gitaPaid),
    events: [
      ...gitaPaid.events,
      event("2026-10-08T04:00:00Z", "adjusted", "admin", {
        reason: "Refund selesai",
        actor_admin: OTHER_ADMIN,
      }),
    ],
  };
  const andi = applyDecision(
    build({
      id: "0199e000-0000-7000-8000-0000000001a5",
      member: member("0199e000-0000-7000-8000-0000000002a5", "Andi Saputra", "31.01.01.2", 31, "unverified"),
      type: "registration",
      amount: "60000.00",
      createdAt: "2026-10-08T01:00:00Z",
      submittedAt: "2026-10-08T01:30:00Z",
    }),
    "reject",
    "Nominal transfer Rp50.000, kurang Rp10.000 dari tagihan.",
    "2026-10-09T02:00:00Z",
    OTHER_ADMIN,
  ).payment;

  // Data sintetis agar paging kursor dapat dicoba di dev:mock (lebih baru dari data prototipe).
  const synthetic: Detail[] = [];
  for (let i = 1; i <= 21; i += 1) {
    if (i >= 16 && i <= 20) continue;
    const n = String(i).padStart(2, "0");
    const renewal = i % 3 === 0;
    const submitted = new Date(Date.UTC(2026, 9, 12, 10, i)).toISOString();
    synthetic.push(
      build({
        id: `0199e000-0000-7000-8000-0000000001${n}`,
        member: member(
          `0199e000-0000-7000-8000-0000000002${n}`,
          `Alumni Contoh ${n}`,
          `2${i % 10}.01.0${(i % 2) + 1}.${100 + i}`,
          20 + (i % 10),
          renewal ? "expiring" : "unverified",
        ),
        type: renewal ? "renewal" : "registration",
        amount: renewal ? "10000.00" : "60000.00",
        createdAt: new Date(Date.parse(submitted) - 60_000).toISOString(),
        submittedAt: submitted,
      }),
    );
  }
  // Payment milik akun alumni yang tertaut ke admin tiruan (konflik kepentingan, PRD 2.3).
  synthetic[synthetic.length - 1]!.conflict_of_interest = true;

  const adjustments: Adjustment[] = [
    // Laila batal mandiri H-18 (refund penuh, D6); rekening tujuan sudah dikirim lewat aplikasi; lewat tenggat.
    newAdjustment({
      id: "0199e000-0000-7000-8000-000000000501",
      payment: laila,
      kind: "refund",
      amount: "75000.00",
      reason: "Refund penuh otomatis: peserta membatalkan tiket paling lambat H-3 (D6).",
      createdAt: "2026-10-01T05:00:00Z",
      createdBy: null,
      dueAt: addBusinessDays("2026-10-01T05:00:00Z", REFUND_DUE_BUSINESS_DAYS),
      destination: {
        provider: "[Bank tujuan refund]",
        account_number: "[Nomor rekening refund]",
        account_holder: "Laila Fitriani",
      },
    }),
    // Event Seminar dibatalkan pengurus: refund sistem untuk peserta berbayar, rekening belum dikirim.
    newAdjustment({
      id: "0199e000-0000-7000-8000-000000000502",
      payment: fajar,
      kind: "refund",
      amount: "50000.00",
      reason: "Refund penuh otomatis: event dibatalkan pengurus (D6).",
      createdAt: SEMINAR_CANCELLED_AT,
      createdBy: null,
      dueAt: addBusinessDays(SEMINAR_CANCELLED_AT, REFUND_DUE_BUSINESS_DAYS),
    }),
    // Koreksi administratif tanpa mengubah payment paid (PRD 3.4).
    newAdjustment({
      id: "0199e000-0000-7000-8000-000000000503",
      payment: yusuf,
      kind: "correction",
      amount: "0.00",
      reason:
        "Koreksi catatan: dana masuk ke rekening [Nama bank 1] pada 5 Okt, bukan 4 Okt seperti di bukti.",
      createdAt: "2026-10-06T03:00:00Z",
      createdBy: OTHER_ADMIN,
      dueAt: null,
    }),
    {
      ...newAdjustment({
        id: "0199e000-0000-7000-8000-000000000504",
        payment: gita,
        kind: "refund",
        amount: "75000.00",
        reason: "Refund penuh otomatis: peserta membatalkan tiket paling lambat H-3 (D6).",
        createdAt: "2026-10-06T02:00:00Z",
        createdBy: null,
        dueAt: addBusinessDays("2026-10-06T02:00:00Z", REFUND_DUE_BUSINESS_DAYS),
        evidenceFileId: MOCK_EVIDENCE_FILE_ID,
      }),
      status: "completed",
      overdue: false,
      completed_by: OTHER_ADMIN,
      completed_at: "2026-10-08T04:00:00Z",
      updated_at: "2026-10-08T04:00:00Z",
      version: "3",
    },
    {
      ...newAdjustment({
        id: "0199e000-0000-7000-8000-000000000505",
        payment: gita,
        kind: "refund",
        amount: "75000.00",
        reason: "Refund manual atas pembatalan tiket.",
        createdAt: "2026-10-06T06:00:00Z",
        createdBy: OTHER_ADMIN,
        dueAt: addBusinessDays("2026-10-06T02:00:00Z", REFUND_DUE_BUSINESS_DAYS),
      }),
      status: "cancelled",
      overdue: false,
      cancelled_by: OTHER_ADMIN,
      cancelled_at: "2026-10-06T07:00:00Z",
      cancel_reason: "Tercatat ganda dengan refund otomatis.",
      updated_at: "2026-10-06T07:00:00Z",
      version: "2",
    },
  ];

  return { payments: [...base, fajar, laila, yusuf, gita, andi, ...synthetic], adjustments };
}

let payments = new Map<string, Detail>();
let adjustments = new Map<string, Adjustment>();
let methods = new Map<string, MethodRow>();
let fees: S["FeeSettings"];
let methodSeq = 0;
/** Nomor urut payment iuran yang dicatat pengurus (D13). */
let recordSeq = 0;

/** Berkas unggahan yang dikenal tiruan files.ts, untuk memeriksa bukti verifikasi D13 (422 FILE_INVALID). */
export interface MockUploadedFile {
  purpose: S["FilePurpose"];
  mime: string;
  bytes: number;
  /** Admin pengunggah; null untuk berkas contoh unggahan anggota. */
  owner_admin_id: string | null;
}
type FileLookup = (fileId: string) => MockUploadedFile | undefined;
let fileLookup: FileLookup = () => undefined;

/** Dipanggil files.ts (yang mengimpor berkas ini) agar tidak ada impor melingkar. */
export function registerFileLookupForMocks(lookup: FileLookup): void {
  fileLookup = lookup;
}
/** Idempotency-Key: payload pertama dan respons pertama yang berhasil (ARCHITECTURE §4.2, PRD 4.3). */
const replays = new Map<string, { payload: string; status: number; body: unknown }>();

export interface PaymentRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  background: boolean;
  idempotencyKey: string | null;
  ifMatch: string | null;
  reauthToken: string | null;
  body: Record<string, unknown> | null;
}

/** Log permintaan ke endpoint pembayaran tiruan, untuk uji (debounce, header latar, Idempotency-Key, If-Match). */
export const paymentRequests: PaymentRequestLog[] = [];

/** Pencocok permintaan untuk kendali uji: metode HTTP dan path persis (string) atau pola (RegExp). */
interface RequestMatcher {
  method: MockRoute["method"];
  path: string | RegExp;
}

/** Galat yang disuntikkan uji ke permintaan berikutnya yang cocok (keadaan error/izin ditolak, BUILD_PLAN). */
interface InjectedFailure extends RequestMatcher {
  status: number;
  code: S["ErrorCode"];
  message: string;
  remaining: number;
}

/** Permintaan yang ditahan sampai uji melepasnya (keadaan memuat terlihat, BUILD_PLAN). */
interface HeldRequest extends RequestMatcher {
  gate: Promise<void>;
  release: () => void;
  used: boolean;
}

const failures: InjectedFailure[] = [];
const holds: HeldRequest[] = [];

function matchesRequest(m: RequestMatcher, req: MockRequest): boolean {
  return (
    m.method === req.method && (typeof m.path === "string" ? m.path === req.path : m.path.test(req.path))
  );
}

/** Galat suntikan pertama yang cocok (jatahnya dikurangi), atau null. */
function takeFailure(req: MockRequest): InjectedFailure | null {
  const index = failures.findIndex((f) => f.remaining > 0 && matchesRequest(f, req));
  if (index < 0) return null;
  const failure = failures[index]!;
  failure.remaining -= 1;
  if (failure.remaining === 0) failures.splice(index, 1);
  return failure;
}

/** Penahan pertama yang belum dipakai dan cocok; satu penahan menahan satu permintaan. */
function takeHold(req: MockRequest): HeldRequest | null {
  const hold = holds.find((h) => !h.used && matchesRequest(h, req));
  if (!hold) return null;
  hold.used = true;
  return hold;
}

function log(req: MockRequest): void {
  paymentRequests.push({
    method: req.method,
    path: req.path,
    query: Object.fromEntries(req.url.searchParams.entries()),
    background: req.headers.get("X-Background-Request") === "1",
    idempotencyKey: req.headers.get("Idempotency-Key"),
    ifMatch: req.headers.get("If-Match"),
    reauthToken: req.headers.get("X-Reauth-Token"),
    body: req.body,
  });
}

function feeSettings(
  registrationFee: string,
  cardFee: string,
  renewalFee: string,
  version: string,
  effectiveFrom: string,
  updatedBy: S["FeeSettings"]["updated_by"],
): S["FeeSettings"] {
  return {
    registration_fee: registrationFee,
    card_fee: cardFee,
    renewal_fee: renewalFee,
    // Dihitung server dengan aritmetika desimal (kontrak FeeSettings.registration_total).
    registration_total: addMoney(registrationFee, cardFee),
    version,
    effective_from: effectiveFrom,
    updated_by: updatedBy,
  };
}

function methodFixtures(): MethodRow[] {
  const at = "2026-09-01T00:00:00Z";
  return [
    { ...METHOD, active: true, sort_order: 0, version: "1", created_at: at, updated_at: at },
    {
      id: "0199e000-0000-7000-8000-000000000002",
      kind: "ewallet",
      provider: "[Nama e-wallet]",
      account_number: "[Nomor akun e-wallet]",
      account_holder: "[Nama pemilik akun]",
      instructions: "Pilih menu transfer ke sesama pengguna, lalu masukkan nomor akun di atas.",
      active: true,
      sort_order: 1,
      version: "1",
      created_at: at,
      updated_at: at,
    },
    {
      id: "0199e000-0000-7000-8000-000000000003",
      kind: "bank",
      provider: "[Nama bank 2]",
      account_number: "[Nomor rekening lama]",
      account_holder: "[Nama pemilik rekening]",
      instructions: null,
      active: false,
      sort_order: 2,
      version: "2",
      created_at: at,
      updated_at: "2026-09-15T00:00:00Z",
    },
  ];
}

export function reset(): void {
  paymentRequests.length = 0;
  replays.clear();
  failures.length = 0;
  // Permintaan yang masih tertahan dilepas agar tidak menggantung ke uji berikutnya.
  for (const hold of holds.splice(0)) hold.release();
  adjustmentSeq = 0;
  methodSeq = 0;
  recordSeq = 0;
  const data = fixtures();
  payments = new Map(data.payments.map((p) => [p.id, p]));
  adjustments = new Map(data.adjustments.map((a) => [a.id, a]));
  methods = new Map(methodFixtures().map((m) => [m.id, m]));
  fees = feeSettings("50000.00", "10000.00", "10000.00", "1", "2026-10-01T00:00:00Z", null);
}
reset();

// "Pembayaran terbaru" pada detail anggota tiruan memuat payment tiruan ini milik anggota tersebut (D6-02).
registerMemberPaymentsSourceForMocks((userId) =>
  [...payments.values()]
    .filter((p) => p.member?.user_id === userId)
    .map((p) => ({
      id: p.id,
      type: p.type,
      status: p.status,
      amount: p.amount,
      proof_version: p.proof_version,
      created_at: p.created_at,
      submitted_at: p.submitted_at,
      decided_at: p.decided_at,
    })),
);

function canDecide(p: Detail): boolean {
  return mockHasPermission("payments.decide") && !p.conflict_of_interest;
}

/**
 * Bentuk respons penyesuaian untuk pemanggil: rekening tujuan hanya untuk pemegang payments.decide tanpa konflik
 * kepentingan, kind refund dan status pending (kontrak AdminPaymentAdjustment, D2); di daftar selalu null.
 */
function presentAdjustment(a: Adjustment, opts: { list?: boolean } = {}): Adjustment {
  const p = payments.get(a.payment_id);
  const visible =
    !opts.list && p !== undefined && canDecide(p) && a.kind === "refund" && a.status === "pending";
  return {
    ...a,
    payment: p ? paymentRef(p) : a.payment,
    refund_destination: visible ? a.refund_destination : null,
  };
}

function adjustmentsOf(paymentId: string): Adjustment[] {
  return [...adjustments.values()]
    .filter((a) => a.payment_id === paymentId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Identitas pemilik dihitung saat request seperti server: pemilik yang juga anggota tiruan members.ts memakai status
 * efektif terkininya (mis. menjadi verified setelah iurannya disetujui).
 */
function liveMember(m: S["AdminPaymentMember"] | null): S["AdminPaymentMember"] | null {
  if (!m) return null;
  return peekMemberForMocks(m.user_id) ? directoryMember(m.user_id) : m;
}

/** Tindakan yang diizinkan server untuk pemanggil saat ini (izin, tahap, konflik kepentingan). */
function present(p: Detail): Detail {
  const decide = canDecide(p);
  return {
    ...p,
    member: liveMember(p.member),
    adjustments: adjustmentsOf(p.id).map((a) => presentAdjustment(a)),
    actions: {
      can_decide: decide && p.stage === "awaiting_review",
      can_cancel: decide && p.status === "pending" && p.proof_version === 0,
      can_adjust: decide && p.status === "paid",
    },
  };
}

function summary(p: Detail): S["AdminPaymentItem"] {
  return {
    id: p.id,
    type: p.type,
    status: p.status,
    stage: p.stage,
    amount: p.amount,
    member: liveMember(p.member),
    event_title: p.event_title,
    event_starts_at: p.event_starts_at,
    ticket_status: p.ticket_status,
    event_cancelled: p.event_cancelled,
    submitted_at: p.submitted_at,
    decided_at: p.decided_at,
    review_due_at: p.review_due_at,
    proof_version: p.proof_version,
    overdue: p.overdue,
    created_at: p.created_at,
    version: p.version,
  };
}

function inUse(methodId: string): boolean {
  for (const p of payments.values()) if (p.method_id === methodId || p.method.id === methodId) return true;
  return false;
}

function presentMethod(m: MethodRow): S["AdminPaymentMethod"] {
  return { ...m, in_use: inUse(m.id) };
}

/** Kendali server tiruan untuk uji: meniru tindakan alumni dan admin lain (AC F03-2, F04-3, F04-4, F15-4). */
export const mockPayments = {
  /** Alumni mengganti bukti (AC F03-2, F04-4). */
  replaceProof(paymentId: string): void {
    const p = payments.get(paymentId);
    if (!p) return;
    payments.set(
      paymentId,
      withReplacedProof(p, new Date().toISOString(), MOCK_PROOF_FILE_ID_V2, () => false),
    );
  },
  /** Admin lain memutus lebih dulu (AC F04-3). */
  decideAsOtherAdmin(
    paymentId: string,
    decision: "approve" | "reject",
    reason = "Dana tidak ditemukan.",
  ): void {
    const p = payments.get(paymentId);
    if (!p) return;
    const at = new Date().toISOString();
    const result = applyDecision(p, decision, reason, at, OTHER_ADMIN);
    payments.set(paymentId, result.payment);
    if (result.refund) adjustments.set(result.refund.id, result.refund);
    if (decision === "approve") duesPaid(result.payment, at);
  },
  /** Admin lain membatalkan instruksi tanpa bukti (PRD 4.3), sehingga anggota tidak lagi punya payment terbuka. */
  cancelAsOtherAdmin(paymentId: string, reason = "Instruksi ditinggalkan."): void {
    const p = payments.get(paymentId);
    if (!p || p.status !== "pending" || p.proof_version !== 0) return;
    const at = new Date().toISOString();
    payments.set(paymentId, {
      ...p,
      status: "cancelled",
      stage: "cancelled",
      cancelled_at: at,
      cancel_reason: reason,
      version: nextVersion(p),
      events: [...p.events, event(at, "cancelled", "admin", { reason, actor_admin: OTHER_ADMIN })],
    });
  },
  /** Data payment berubah tanpa bukti baru (mis. status tiket terkait), sehingga `version` naik. */
  touch(paymentId: string): void {
    const p = payments.get(paymentId);
    if (p) payments.set(paymentId, { ...p, version: nextVersion(p) });
  },
  /** Data mentah payment beserta penyesuaiannya (rekening tujuan tidak disaring). */
  get(paymentId: string): Detail | undefined {
    const p = payments.get(paymentId);
    return p ? { ...p, adjustments: adjustmentsOf(paymentId) } : undefined;
  },
  adjustment(adjustmentId: string): Adjustment | undefined {
    return adjustments.get(adjustmentId);
  },
  /** Pemilik mengirim rekening tujuan refund lewat aplikasi (setMyRefundDestination): versi naik. */
  setRefundDestination(adjustmentId: string, destination: S["AdminRefundDestination"]): void {
    const a = adjustments.get(adjustmentId);
    if (!a) return;
    adjustments.set(adjustmentId, {
      ...a,
      refund_destination: destination,
      has_refund_destination: true,
      version: nextVersion(a),
      updated_at: new Date().toISOString(),
    });
  },
  method(methodId: string): S["AdminPaymentMethod"] | undefined {
    const m = methods.get(methodId);
    return m ? presentMethod(m) : undefined;
  },
  /** Admin lain mengubah metode (AC F15-4). */
  updateMethodAsOtherAdmin(methodId: string, patch: Partial<Omit<MethodRow, "id" | "version">>): void {
    const m = methods.get(methodId);
    if (!m) return;
    methods.set(methodId, { ...m, ...patch, version: nextVersion(m), updated_at: new Date().toISOString() });
  },
  fees(): S["FeeSettings"] {
    return fees;
  },
  /**
   * Pengaturan `fees` belum pernah tersimpan: GET /admin/settings/fees mengembalikan nilai bawaan kode dengan versi
   * "0", dan iuran baru ditolak 403 sampai pengurus menyimpan nominal (gagal tertutup, PRD 8.2 butir 4).
   */
  unsetFees(): void {
    fees = feeSettings("50000.00", "10000.00", "10000.00", "0", "2026-10-01T00:00:00Z", null);
  },
  /** Admin lain menyimpan biaya baru (AC F15-4). */
  updateFeesAsOtherAdmin(registrationFee: string, cardFee: string, renewalFee: string): void {
    fees = feeSettings(
      registrationFee,
      cardFee,
      renewalFee,
      nextVersion(fees),
      new Date().toISOString(),
      OTHER_ADMIN,
    );
  },
  /** Belum ada metode bayar sama sekali (mis. sebelum go-live), untuk keadaan kosong tab metode. */
  clearMethods(): void {
    methods.clear();
  },
  /** Pemilik payment tertaut ke akun admin yang sedang masuk (admins.linked_alumni_user_id, PRD 2.3). */
  linkOwnerToAdmin(paymentId: string): void {
    const p = payments.get(paymentId);
    if (p) payments.set(paymentId, { ...p, conflict_of_interest: true });
  },
  /**
   * Permintaan berikutnya yang cocok dijawab galat (bawaan 500 INTERNAL_ERROR) sebanyak `times` kali, untuk uji
   * keadaan error dan izin ditolak (403 FORBIDDEN) di tengah sesi (BUILD_PLAN "Acceptance evidence").
   */
  fail(
    method: MockRoute["method"],
    path: string | RegExp,
    opts: { status?: number; code?: S["ErrorCode"]; message?: string; times?: number } = {},
  ): void {
    failures.push({
      method,
      path,
      status: opts.status ?? 500,
      code: opts.code ?? "INTERNAL_ERROR",
      message: opts.message ?? "Terjadi kesalahan pada server. Coba lagi.",
      remaining: opts.times ?? 1,
    });
  },
  /** Tahan permintaan berikutnya yang cocok sampai fungsi hasil dipanggil (keadaan memuat terlihat). */
  hold(method: MockRoute["method"], path: string | RegExp): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    holds.push({ method, path, gate, release, used: false });
    return release;
  },
};

const MONEY = /^[0-9]{1,12}\.[0-9]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FieldErrors = Record<string, string[]>;

function validationError(fieldErrors: FieldErrors): Response {
  return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
    field_errors: fieldErrors,
  });
}

/** Semua izin pada `x-kapdh-access.permissions` wajib dimiliki (AC F15-1, F16-3). */
function requireAll(req: MockRequest, permissions: readonly Permission[]): Response | null {
  for (const p of permissions) {
    const denied = requirePermission(req, p);
    if (denied) return denied;
  }
  return null;
}

/** If-Match wajib berisi versi yang dibaca (core parseIfMatch): kosong/tidak valid → 400. */
function ifMatch(req: MockRequest): { version: string } | { denied: Response } {
  const raw = (req.headers.get("If-Match") ?? "").trim();
  if (raw === "")
    return {
      denied: validationError({ "If-Match": ["Header If-Match wajib berisi versi data yang dibaca."] }),
    };
  const m = /^(?:(?:W\/)?"(\d{1,9})"|(\d{1,9}))$/.exec(raw);
  if (!m) return { denied: validationError({ "If-Match": ["Format If-Match tidak valid."] }) };
  return { version: String(Number(m[1] ?? m[2])) };
}

interface Ok {
  status: number;
  body: unknown;
}

/**
 * Idempotency-Key (PRD 4.3): key sama + payload sama → hasil pertama; payload berbeda → 409 IDEMPOTENCY_CONFLICT.
 * Hanya hasil berhasil yang disimpan untuk diputar ulang.
 */
function withReplay(req: MockRequest, run: () => Ok | Response): Response {
  const key = req.headers.get("Idempotency-Key");
  const payload = JSON.stringify([req.method, req.path, req.body, req.headers.get("If-Match")]);
  const replay = key ? replays.get(key) : undefined;
  if (replay) {
    if (replay.payload !== payload)
      return error(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah dipakai untuk permintaan lain.");
    return json(replay.status, replay.body);
  }
  const out = run();
  if (out instanceof Response) return out;
  if (key) replays.set(key, { payload, status: out.status, body: out.body });
  return json(out.status, out.body);
}

function bool(value: string | null): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

/** Alasan wajib: string 3..500 karakter dan tidak hanya spasi (AC F04-2). */
function reasonInvalid(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length < 3 || value.length > 500;
}

function conflictOfInterest(): Response {
  return error(403, "FORBIDDEN", "Pembayaran milik akun alumni yang tertaut ke Anda tidak dapat diproses.");
}

function textInvalid(value: unknown, max: number): boolean {
  return typeof value !== "string" || value.trim().length === 0 || value.trim().length > max;
}

/** Validasi PaymentMethodInput (POST dan PUT penggantian penuh). */
function methodInputErrors(body: Record<string, unknown>): FieldErrors {
  const fe: FieldErrors = {};
  if (body.kind !== "bank" && body.kind !== "ewallet") fe.kind = ["Pilih jenis rekening"];
  if (textInvalid(body.provider, 80))
    fe.provider = ["Nama bank atau e-wallet wajib diisi (maksimal 80 karakter)"];
  if (textInvalid(body.account_number, 64))
    fe.account_number = ["Nomor rekening wajib diisi (maksimal 64 karakter)"];
  if (textInvalid(body.account_holder, 120))
    fe.account_holder = ["Nama pemilik rekening wajib diisi (maksimal 120 karakter)"];
  if (body.instructions !== null) {
    if (typeof body.instructions !== "string" || body.instructions.length > 1000)
      fe.instructions = ["Petunjuk maksimal 1000 karakter"];
    else if (/<[^>]*>/.test(body.instructions)) fe.instructions = ["Petunjuk berupa teks polos tanpa HTML"];
  }
  if (typeof body.active !== "boolean") fe.active = ["Pilih status aktif"];
  if (
    !Number.isInteger(body.sort_order) ||
    (body.sort_order as number) < 0 ||
    (body.sort_order as number) > 32767
  )
    fe.sort_order = ["Urutan tampil 0 sampai 32767"];
  return fe;
}

function methodFromInput(
  body: Record<string, unknown>,
): Omit<MethodRow, "id" | "version" | "created_at" | "updated_at"> {
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  return {
    kind: body.kind as MethodRow["kind"],
    provider: String(body.provider).trim(),
    account_number: String(body.account_number).trim(),
    account_holder: String(body.account_holder).trim(),
    instructions: instructions.length > 0 ? instructions : null,
    active: body.active as boolean,
    sort_order: body.sort_order as number,
  };
}

function destinationErrors(value: unknown, field: string): FieldErrors {
  const d = value as Record<string, unknown> | null;
  if (typeof d !== "object" || d === null) return { [field]: ["Rekening tujuan tidak valid."] };
  const fe: FieldErrors = {};
  if (textInvalid(d.provider, 80)) fe[`${field}.provider`] = ["Nama bank atau e-wallet wajib diisi"];
  if (textInvalid(d.account_number, 64)) fe[`${field}.account_number`] = ["Nomor rekening wajib diisi"];
  if (textInvalid(d.account_holder, 120))
    fe[`${field}.account_holder`] = ["Nama pemilik rekening wajib diisi"];
  return fe;
}

function trimDestination(value: unknown): S["AdminRefundDestination"] {
  const d = value as Record<string, string>;
  return {
    provider: d.provider!.trim(),
    account_number: d.account_number!.trim(),
    account_holder: d.account_holder!.trim(),
  };
}

/** Refund > 0 dan total refund pending + completed tidak melebihi nominal payment; koreksi >= 0 (D6). */
function amountError(p: Detail, kind: Adjustment["kind"], amount: string, excludeId?: string): string | null {
  if (kind === "correction") return null;
  if (cents(amount) <= 0n) return "Nominal refund harus lebih dari 0.";
  const others = adjustmentsOf(p.id)
    .filter((a) => a.kind === "refund" && a.status !== "cancelled" && a.id !== excludeId)
    .reduce((sum, a) => sum + cents(a.amount), 0n);
  if (others + cents(amount) > cents(p.amount))
    return `Total refund melebihi nominal pembayaran (sisa yang dapat direfund ${fromCents(cents(p.amount) - others)}).`;
  return null;
}

const sorters: Record<S["AdminPaymentSort"], (a: Detail, b: Detail) => number> = {
  submitted_at_asc: (a, b) => nullsLast(a.submitted_at, b.submitted_at, 1) || a.id.localeCompare(b.id),
  submitted_at_desc: (a, b) => nullsLast(a.submitted_at, b.submitted_at, -1) || b.id.localeCompare(a.id),
  review_due_at_asc: (a, b) => nullsLast(a.review_due_at, b.review_due_at, 1) || a.id.localeCompare(b.id),
  decided_at_desc: (a, b) => nullsLast(a.decided_at, b.decided_at, -1) || b.id.localeCompare(a.id),
  created_at_desc: (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
};

/** Pembanding nilai waktu ISO dengan nilai kosong di akhir (kontrak AdminPaymentSort). */
function nullsLast(a: string | null, b: string | null, direction: 1 | -1): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b) * direction;
}

function adjustmentConflict(code: "PAYMENT_STATE_CONFLICT" | "VERSION_CONFLICT", a: Adjustment): Response {
  return error(
    409,
    code,
    code === "PAYMENT_STATE_CONFLICT"
      ? "Penyesuaian ini sudah selesai atau dibatalkan."
      : "Penyesuaian sudah diubah. Muat ulang data terbaru.",
    { current: presentAdjustment(a) },
  );
}

/** Pemeriksaan bersama PATCH/complete/cancel penyesuaian: 404, konflik kepentingan, status, versi. */
function lockAdjustment(
  req: MockRequest,
  expectedVersion: string,
): { adjustment: Adjustment; payment: Detail } | { denied: Response } {
  const a = adjustments.get(req.params.adjustmentId ?? "");
  const p = a ? payments.get(a.payment_id) : undefined;
  if (!a || !p) return { denied: error(404, "NOT_FOUND", "Penyesuaian tidak ditemukan.") };
  if (p.conflict_of_interest) return { denied: conflictOfInterest() };
  if (a.status !== "pending") return { denied: adjustmentConflict("PAYMENT_STATE_CONFLICT", a) };
  if (a.version !== expectedVersion) return { denied: adjustmentConflict("VERSION_CONFLICT", a) };
  return { adjustment: a, payment: p };
}

/** Catat histori `adjusted` pada payment asal saat penyesuaian selesai (kontrak adminCompletePaymentAdjustment). */
function recordAdjusted(p: Detail, a: Adjustment, at: string): void {
  payments.set(p.id, {
    ...p,
    version: nextVersion(p),
    events: [
      ...p.events,
      event(at, "adjusted", "admin", {
        reason: a.kind === "refund" ? "Refund selesai" : "Koreksi dicatat",
        actor_admin: mockAdminRef(),
      }),
    ],
  });
}

/** Iuran yang menjadi paid memperbarui masa aktif anggota tiruan members.ts yang sama (handler keanggotaan server). */
function duesPaid(p: Detail, at: string): void {
  if (p.status !== "paid" || p.type === "ticket" || !p.member) return;
  applyPaidDuesForMocks(p.member.user_id, { paymentId: p.id, type: p.type, approvedAt: at });
}

const RECORD_FILE_INVALID =
  "Berkas bukti tidak dapat dipakai. Unggah ulang bukti verifikasi (JPG/PNG maksimal 5 MB atau PDF maksimal 10 MB).";

interface RecordOwner {
  member: S["AdminPaymentMember"];
  accountStatus: S["AccountStatus"];
  expiresAt: string | null;
  linkedToCaller: boolean;
}

/**
 * Pemilik iuran adminRecordPayment: anggota tiruan members.ts (pilihan alumni di UI), atau pemilik payment contoh
 * tiruan ini yang tidak ada di members.ts (status dari payment-nya; tertaut bila payment-nya berkonflik kepentingan).
 */
function recordOwner(userId: string): RecordOwner | null {
  const d = peekMemberForMocks(userId);
  if (d)
    return {
      member: directoryMember(userId),
      accountStatus: d.account_status,
      expiresAt: d.expires_at,
      linkedToCaller: d.linked_admin_id === mockAdminRef().admin_id,
    };
  const owned = [...payments.values()].filter((p) => p.member?.user_id === userId);
  const first = owned[0];
  if (!first?.member) return null;
  return {
    member: first.member,
    accountStatus: "active",
    expiresAt: null,
    linkedToCaller: owned.some((p) => p.conflict_of_interest),
  };
}

/** Kelayakan seperti GET /me/fees (AC F07-5): registration bila belum pernah paid, renewal bila expiring/expired. */
function recordEligibility(type: "registration" | "renewal", status: S["EffectiveStatus"]): Response | null {
  if (type === "registration")
    return status === "unverified"
      ? null
      : error(409, "PAYMENT_STATE_CONFLICT", "Iuran pendaftaran anggota ini sudah disetujui.");
  if (status === "unverified")
    return validationError({
      type: ["Perpanjangan hanya dapat dicatat setelah iuran pendaftaran disetujui."],
    });
  if (status === "verified")
    return validationError({
      type: ["Jendela perpanjangan anggota ini belum dibuka (30 hari sebelum masa aktif habis)."],
    });
  return null;
}

/** Baris dan total iuran dari pengaturan `fees` versi aktif (AC F03-5); nominal tidak pernah dari klien. */
function duesFromFees(type: "registration" | "renewal"): { lines: S["PaymentLine"][]; total: string } {
  if (type === "registration")
    return {
      lines: [
        { code: "registration_fee", label: "Register alumni baru", amount: fees.registration_fee },
        { code: "card_fee", label: "Pembuatan KTA", amount: fees.card_fee },
      ],
      total: fees.registration_total,
    };
  return {
    lines: [{ code: "renewal_fee", label: "Perpanjangan KTA", amount: fees.renewal_fee }],
    total: fees.renewal_fee,
  };
}

/** Pesan 403 server untuk pengurus (apps/api payment-ledger DUES_UNCONFIGURED_MESSAGE.admin). */
const DUES_UNCONFIGURED_ADMIN =
  "Nominal iuran belum ditetapkan atau bernilai nol. Simpan nominal iuran yang disahkan bendahara di Pengaturan Biaya terlebih dahulu.";

/** Nominal iuran belum tersimpan (versi "0", nilai bawaan kode) atau total jenis ini 0.00 (gagal tertutup). */
function duesUnconfigured(type: "registration" | "renewal"): boolean {
  return fees.version === "0" || /^0+\.00$/.test(duesFromFees(type).total);
}

function methodSnapshot(m: MethodRow): S["PaymentMethod"] {
  return {
    id: m.id,
    kind: m.kind,
    provider: m.provider,
    account_number: m.account_number,
    account_holder: m.account_holder,
    instructions: m.instructions,
  };
}

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

/**
 * adminRecordPayment (D13): urutan pemeriksaan seperti server (validasi body, konflik kepentingan, akun, kelayakan,
 * payment terbuka berbukti, metode, berkas bukti), lalu satu "transaksi": payment baru (201) atau payment terbuka
 * diselesaikan di tempat (200), bukti pengurus versi berikutnya, lalu paid beraktor admin.
 */
function recordDues(req: MockRequest): Ok | Response {
  const body = req.body ?? {};
  const fe: FieldErrors = {};
  if (typeof body.user_id !== "string" || !UUID.test(body.user_id)) fe.user_id = ["Pilih akun alumni"];
  if (body.type !== "registration" && body.type !== "renewal") fe.type = ["Pilih jenis iuran"];
  if (typeof body.payment_method_id !== "string" || !UUID.test(body.payment_method_id))
    fe.payment_method_id = ["Pilih rekening tujuan"];
  if (typeof body.proof_file_id !== "string" || !UUID.test(body.proof_file_id))
    fe.proof_file_id = ["Unggah bukti verifikasi"];
  if (
    body.transfer_note !== undefined &&
    (typeof body.transfer_note !== "string" || body.transfer_note.length > 200)
  )
    fe.transfer_note = ["Catatan maksimal 200 karakter"];
  if (body.funds_verified !== true)
    fe.funds_verified = ["Konfirmasi bahwa dana sudah dicocokkan dengan mutasi rekening."];
  if (reasonInvalid(body.reason))
    fe.reason = ["Catatan verifikasi minimal 3 karakter dan tidak boleh hanya spasi."];
  if (Object.keys(fe).length > 0) return validationError(fe);
  const userId = body.user_id as string;
  const type = body.type as "registration" | "renewal";
  const reason = String(body.reason).trim();

  const owner = recordOwner(userId);
  if (owner?.linkedToCaller) return conflictOfInterest();
  const status = owner?.member.effective_status;
  if (
    !owner ||
    owner.accountStatus !== "active" ||
    status === "pending_otp" ||
    status === "disabled" ||
    status === "deletion_pending"
  )
    return validationError({
      user_id: ["Akun alumni tidak ditemukan, belum aktif, atau sedang dalam proses penghapusan."],
    });
  if (status === "suspended")
    return validationError({ user_id: ["Akun anggota sedang dibatasi; iuran tidak dapat dicatat."] });
  const refused = recordEligibility(type, owner.member.effective_status);
  if (refused) return refused;

  const open = [...payments.values()].find(
    (p) =>
      p.member?.user_id === userId && p.type === type && (p.status === "pending" || p.status === "rejected"),
  );
  if (open && open.status === "pending" && open.proof_version >= 1)
    return error(
      409,
      "PAYMENT_STATE_CONFLICT",
      "Anggota sudah mengirim bukti untuk iuran ini. Putuskan bukti tersebut dari antrean verifikasi.",
      { current: present(open) },
    );
  // Payment baru gagal tertutup bila nominal iuran belum ditetapkan (versi 0 atau total 0.00), seperti
  // PaymentLedger.duesSnapshot di server: diperiksa sebelum metode dan berkas, tanpa payment yang dibuat.
  if (!open && duesUnconfigured(type)) return error(403, "FORBIDDEN", DUES_UNCONFIGURED_ADMIN);
  const method = methods.get(body.payment_method_id as string);
  if (!method) return validationError({ payment_method_id: ["Metode pembayaran tidak ditemukan."] });
  const fileId = body.proof_file_id as string;
  const file = fileLookup(fileId);
  const used = [...payments.values()].some(
    (p) => p.proof?.file_id === fileId || p.events.some((e) => e.proof_file_id === fileId),
  );
  if (!file || file.purpose !== "payment_proof" || file.owner_admin_id !== mockAdminRef().admin_id || used)
    return error(422, "FILE_INVALID", RECORD_FILE_INVALID);

  const at = new Date().toISOString();
  const admin = mockAdminRef();
  let base: Detail;
  if (open) {
    base =
      open.method_id === method.id
        ? open
        : {
            ...open,
            method: methodSnapshot(method),
            method_id: method.id,
            method_active: method.active,
            version: nextVersion(open),
            events: [...open.events, event(at, "method_changed", "admin", { actor_admin: admin })],
          };
  } else {
    recordSeq += 1;
    const dues = duesFromFees(type);
    base = {
      id: `0199e000-0000-7000-8000-0000000006${String(recordSeq).padStart(2, "0")}`,
      type,
      status: "pending",
      stage: "awaiting_transfer",
      amount: dues.total,
      member: owner.member,
      event_title: null,
      event_starts_at: null,
      ticket_status: null,
      event_cancelled: null,
      submitted_at: null,
      decided_at: null,
      review_due_at: null,
      proof_version: 0,
      overdue: false,
      created_at: at,
      version: "1",
      lines: dues.lines,
      method: methodSnapshot(method),
      method_id: method.id,
      method_active: method.active,
      proof: null,
      transfer_note: null,
      rejection_reason: null,
      rejection_count: 0,
      decided_by: null,
      cancelled_at: null,
      cancel_reason: null,
      ticket: null,
      period: null,
      settings_version: fees.version,
      // Catatan verifikasi tersimpan pada histori created (hanya pengurus) untuk payment baru.
      events: [event(at, "created", "admin", { reason, actor_admin: admin })],
      adjustments: [],
      conflict_of_interest: false,
      refund_on_approve: false,
      actions: NO_ACTIONS,
    };
  }
  const proofVersion = base.proof_version + 1;
  const note = typeof body.transfer_note === "string" ? body.transfer_note.trim() : "";
  const proofed: Detail = {
    ...base,
    status: "pending",
    stage: "awaiting_review",
    proof_version: proofVersion,
    proof: { file_id: fileId, version: proofVersion, mime: file.mime, bytes: file.bytes, submitted_at: at },
    submitted_at: at,
    transfer_note: note || null,
    version: nextVersion(base),
    events: [
      ...base.events,
      event(at, base.proof_version === 0 ? "proof_submitted" : "proof_replaced", "admin", {
        proof_version: proofVersion,
        proof_file_id: fileId,
        actor_admin: admin,
      }),
    ],
  };
  const approved = applyDecision(proofed, "approve", "", at, admin).payment;
  // Payment terbuka yang diselesaikan di tempat menyimpan catatan verifikasi pada histori approved.
  const events = approved.events.map((e, i) =>
    i === approved.events.length - 1 && open ? { ...e, reason } : e,
  );
  const previousExpiry = owner.expiresAt;
  const starts =
    type === "renewal" && previousExpiry && Date.parse(previousExpiry) > Date.parse(at) ? previousExpiry : at;
  const paid: Detail = {
    ...approved,
    events,
    period: { starts_at: starts, expires_at: addMonthsIso(starts, 12) },
  };
  payments.set(paid.id, paid);
  duesPaid(paid, at);
  return { status: open ? 200 : 201, body: present(paid) };
}

const DECIDE: readonly Permission[] = ["payments.read", "payments.decide"];

/** Pesan bawaan server untuk VERSION_CONFLICT (apps/api core/errors versionConflict). */
const VERSION_CONFLICT_MESSAGE = "Data sudah diubah orang lain. Muat ulang untuk melihat versi terbaru.";

const paymentRoutes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/payments",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "payments.read");
      if (denied) return denied;
      const params = req.url.searchParams;
      const status = params.get("status");
      const stage = params.get("stage");
      const type = params.get("type");
      const overdue = bool(params.get("overdue"));
      const eventId = params.get("event_id");
      const userId = params.get("user_id");
      const from = params.get("submitted_from");
      const to = params.get("submitted_to");
      const sort = (params.get("sort") ?? "submitted_at_asc") as S["AdminPaymentSort"];
      if (!(sort in sorters)) return validationError({ sort: ["Urutan tidak dikenal."] });
      const q = (params.get("q") ?? "").trim().toLowerCase();
      const items = [...payments.values()]
        .filter((p) => !status || p.status === status)
        .filter((p) => !stage || p.stage === stage)
        .filter((p) => !type || p.type === type)
        .filter((p) => overdue === undefined || p.overdue === overdue)
        .filter((p) => !eventId || p.ticket?.event_id === eventId)
        .filter((p) => !userId || p.member?.user_id === userId)
        .filter((p) => !from || (p.submitted_at !== null && p.submitted_at >= from))
        .filter((p) => !to || (p.submitted_at !== null && p.submitted_at < to))
        // Nama sebagian tanpa beda huruf besar atau awalan nomor anggota; akun terhapus tidak dapat dicari.
        .filter(
          (p) =>
            !q ||
            (p.member !== null &&
              (p.member.full_name.toLowerCase().includes(q) || (p.member.member_number ?? "").startsWith(q))),
        )
        // Bawaan submitted_at_asc: paling lama menunggu di atas, payment tanpa bukti di akhir (PRD 3.4).
        .sort(sorters[sort])
        .map(summary);
      return json(200, paginate(items, req.url) satisfies S["AdminPaymentPage"]);
    },
  },
  {
    // adminRecordPayment: rencana cadangan D13 (PRD 10.1), payments.read + payments.decide, idempoten.
    method: "POST",
    path: "/admin/payments",
    handler: (req) => {
      log(req);
      const denied = requireAll(req, DECIDE);
      if (denied) return denied;
      return withReplay(req, () => recordDues(req));
    },
  },
  {
    method: "GET",
    path: "/admin/payments/summary",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "payments.read");
      if (denied) return denied;
      const all = [...payments.values()];
      const review = all.filter((p) => p.stage === "awaiting_review");
      const pendingAdjustments = [...adjustments.values()].filter((a) => a.status === "pending");
      const body: S["AdminPaymentSummary"] = {
        awaiting_review_count: review.length,
        overdue_count: review.filter((p) => p.overdue).length,
        awaiting_transfer_count: all.filter((p) => p.stage === "awaiting_transfer").length,
        awaiting_review_by_type: {
          registration: review.filter((p) => p.type === "registration").length,
          renewal: review.filter((p) => p.type === "renewal").length,
          ticket: review.filter((p) => p.type === "ticket").length,
        },
        adjustments_pending_count: pendingAdjustments.length,
        adjustments_overdue_count: pendingAdjustments.filter((a) => a.overdue).length,
        generated_at: new Date().toISOString(),
      };
      return json(200, body);
    },
  },
  {
    method: "GET",
    path: "/admin/payments/{paymentId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "payments.read");
      if (denied) return denied;
      const p = payments.get(req.params.paymentId ?? "");
      return p ? json(200, present(p)) : error(404, "NOT_FOUND", "Data tidak ditemukan.");
    },
  },
  {
    method: "POST",
    path: "/admin/payments/{paymentId}/decision",
    handler: (req) => {
      log(req);
      const denied = requireAll(req, DECIDE);
      if (denied) return denied;
      return withReplay(req, () => {
        const body = req.body ?? {};
        // Validasi body (400) sebelum pemeriksaan keadaan.
        const decision = body.decision;
        const fieldErrors: FieldErrors = {};
        if (decision !== "approve" && decision !== "reject")
          fieldErrors.decision = ["Keputusan tidak dikenal."];
        if (!Number.isInteger(body.expected_proof_version) || (body.expected_proof_version as number) < 1)
          fieldErrors.expected_proof_version = ["Versi bukti tidak valid."];
        if (typeof body.expected_version !== "string" || body.expected_version.length > 64)
          fieldErrors.expected_version = ["Versi pembayaran tidak valid."];
        if (decision === "approve" && body.funds_verified !== true)
          fieldErrors.funds_verified = ["Centang setelah dana terlihat di rekening tujuan."];
        const reason = typeof body.reason === "string" ? body.reason : "";
        if (decision === "reject" && reasonInvalid(reason))
          fieldErrors.reason = ["Alasan minimal 3 karakter dan tidak boleh hanya spasi."];
        if (Object.keys(fieldErrors).length > 0)
          return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
            field_errors: fieldErrors,
          });

        const p = payments.get(req.params.paymentId ?? "");
        if (!p) return error(404, "NOT_FOUND", "Data tidak ditemukan.");
        if (p.conflict_of_interest)
          return error(
            403,
            "FORBIDDEN",
            "Pembayaran milik akun alumni yang tertaut ke Anda tidak dapat diputus.",
          );
        const current = present(p);
        // Pesan galat sama dengan server (admin-payments.service decide), diperiksa jalur test:live.
        if (p.status !== "pending" || p.proof_version === 0)
          return error(
            409,
            "PAYMENT_STATE_CONFLICT",
            p.status === "pending"
              ? "Pembayaran belum memiliki bukti transfer sehingga belum dapat diputus."
              : "Pembayaran ini sudah diputus atau dibatalkan. Muat ulang untuk melihat status terbaru.",
            { current },
          );
        if (body.expected_proof_version !== p.proof_version)
          return error(
            409,
            "PROOF_VERSION_CONFLICT",
            "Bukti transfer sudah diganti anggota setelah layar dibuka. Periksa bukti versi terbaru.",
            { current },
          );
        if (body.expected_version !== p.version)
          return error(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE, { current });

        const at = new Date().toISOString();
        const result = applyDecision(p, decision as "approve" | "reject", reason.trim(), at, mockAdminRef());
        payments.set(p.id, result.payment);
        if (result.refund) adjustments.set(result.refund.id, result.refund);
        duesPaid(result.payment, at);
        return { status: 200, body: present(result.payment) };
      });
    },
  },
  {
    method: "POST",
    path: "/admin/payments/{paymentId}/cancel",
    handler: (req) => {
      log(req);
      const denied = requireAll(req, DECIDE);
      if (denied) return denied;
      return withReplay(req, () => {
        const body = req.body ?? {};
        if (reasonInvalid(body.reason))
          return validationError({ reason: ["Alasan minimal 3 karakter dan tidak boleh hanya spasi."] });
        const expected = ifMatch(req);
        if ("denied" in expected) return expected.denied;
        const p = payments.get(req.params.paymentId ?? "");
        if (!p) return error(404, "NOT_FOUND", "Data tidak ditemukan.");
        if (p.conflict_of_interest) return conflictOfInterest();
        // Hanya pending tanpa bukti (PRD 4.3): payment berbukti wajib diputus, rejected tidak dapat dibatalkan.
        if (p.status !== "pending" || p.proof_version !== 0)
          return error(
            409,
            "PAYMENT_STATE_CONFLICT",
            p.status === "pending"
              ? "Pembayaran yang sudah berbukti wajib diputus (setujui atau tolak), bukan dibatalkan."
              : "Hanya pembayaran pending tanpa bukti yang dapat dibatalkan.",
            { current: present(p) },
          );
        if (p.version !== expected.version)
          return error(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE, { current: present(p) });
        const at = new Date().toISOString();
        const reason = String(body.reason).trim();
        const cancelled: Detail = {
          ...p,
          status: "cancelled",
          stage: "cancelled",
          cancelled_at: at,
          cancel_reason: reason,
          ticket_status: p.ticket ? "cancelled" : p.ticket_status,
          ticket: p.ticket ? { ...p.ticket, ticket_status: "cancelled", ticket_cancelled_by: "admin" } : null,
          version: nextVersion(p),
          events: [...p.events, event(at, "cancelled", "admin", { reason, actor_admin: mockAdminRef() })],
        };
        payments.set(p.id, cancelled);
        return { status: 200, body: present(cancelled) };
      });
    },
  },
  {
    method: "POST",
    path: "/admin/payments/{paymentId}/adjustments",
    handler: (req) => {
      log(req);
      const denied = requireAll(req, DECIDE);
      if (denied) return denied;
      return withReplay(req, () => {
        const body = req.body ?? {};
        const fe: FieldErrors = {};
        const kind = body.kind;
        if (kind !== "refund" && kind !== "correction") fe.kind = ["Pilih jenis penyesuaian"];
        if (typeof body.amount !== "string" || !MONEY.test(body.amount))
          fe.amount = ["Nominal tidak valid, contoh 50000.00"];
        if (reasonInvalid(body.reason)) fe.reason = ["Alasan minimal 3 karakter dan tidak boleh hanya spasi"];
        if (body.refund_destination !== undefined) {
          if (kind === "correction") fe.refund_destination = ["Rekening tujuan hanya untuk refund."];
          else Object.assign(fe, destinationErrors(body.refund_destination, "refund_destination"));
        }
        if (
          body.evidence_file_id !== undefined &&
          (typeof body.evidence_file_id !== "string" || !UUID.test(body.evidence_file_id))
        )
          fe.evidence_file_id = ["Berkas bukti tidak valid."];
        if (Object.keys(fe).length > 0) return validationError(fe);
        const p = payments.get(req.params.paymentId ?? "");
        if (!p) return error(404, "NOT_FOUND", "Pembayaran tidak ditemukan.");
        if (p.conflict_of_interest) return conflictOfInterest();
        if (p.status !== "paid")
          return error(
            409,
            "PAYMENT_STATE_CONFLICT",
            "Penyesuaian hanya untuk pembayaran yang sudah disetujui (paid).",
            { current: present(p) },
          );
        const tooMuch = amountError(p, kind as Adjustment["kind"], body.amount as string);
        if (tooMuch) return validationError({ amount: [tooMuch] });
        const at = new Date().toISOString();
        const created = {
          ...newAdjustment({
            id: nextAdjustmentId(),
            payment: p,
            kind: kind as Adjustment["kind"],
            amount: body.amount as string,
            reason: String(body.reason).trim(),
            createdAt: at,
            createdBy: mockAdminRef(),
            // Refund: 7 hari kerja sejak pembatalan tiket/event terkait, atau sejak dicatat (PRD 3.9).
            dueAt:
              kind === "refund" ? addBusinessDays(cancellationAt(p) ?? at, REFUND_DUE_BUSINESS_DAYS) : null,
            destination: body.refund_destination ? trimDestination(body.refund_destination) : null,
            evidenceFileId: (body.evidence_file_id as string | undefined) ?? null,
          }),
          overdue: false,
        };
        adjustments.set(created.id, created);
        return { status: 201, body: presentAdjustment(created) };
      });
    },
  },
  {
    method: "GET",
    path: "/admin/payment-adjustments",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "payments.read");
      if (denied) return denied;
      const params = req.url.searchParams;
      const status = params.get("status");
      const kind = params.get("kind");
      const overdue = bool(params.get("overdue"));
      const hasDestination = bool(params.get("has_refund_destination"));
      const paymentId = params.get("payment_id");
      const sort = params.get("sort") ?? "due_at_asc";
      if (sort !== "due_at_asc" && sort !== "created_at_desc")
        return validationError({ sort: ["Urutan tidak dikenal."] });
      const q = (params.get("q") ?? "").trim().toLowerCase();
      const items = [...adjustments.values()]
        .filter((a) => !status || a.status === status)
        .filter((a) => !kind || a.kind === kind)
        .filter((a) => overdue === undefined || a.overdue === overdue)
        .filter((a) => hasDestination === undefined || a.has_refund_destination === hasDestination)
        .filter((a) => !paymentId || a.payment_id === paymentId)
        .filter((a) => {
          if (!q) return true;
          const m = payments.get(a.payment_id)?.member;
          return Boolean(
            m && (m.full_name.toLowerCase().includes(q) || (m.member_number ?? "").startsWith(q)),
          );
        })
        // due_at_asc: tenggat terdekat dahulu, tanpa tenggat (koreksi) di akhir.
        .sort((a, b) =>
          sort === "due_at_asc"
            ? nullsLast(a.due_at, b.due_at, 1) || a.id.localeCompare(b.id)
            : b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
        )
        .map((a) => presentAdjustment(a, { list: true }));
      return json(200, paginate(items, req.url) satisfies S["AdminPaymentAdjustmentPage"]);
    },
  },
  {
    method: "GET",
    path: "/admin/payment-adjustments/{adjustmentId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "payments.read");
      if (denied) return denied;
      const a = adjustments.get(req.params.adjustmentId ?? "");
      return a ? json(200, presentAdjustment(a)) : error(404, "NOT_FOUND", "Penyesuaian tidak ditemukan.");
    },
  },
  {
    method: "PATCH",
    path: "/admin/payment-adjustments/{adjustmentId}",
    handler: (req) => {
      log(req);
      const denied = requireAll(req, DECIDE);
      if (denied) return denied;
      const body = req.body ?? {};
      const fe: FieldErrors = {};
      if (body.amount !== undefined && (typeof body.amount !== "string" || !MONEY.test(body.amount)))
        fe.amount = ["Nominal tidak valid, contoh 50000.00"];
      if (body.reason !== undefined && reasonInvalid(body.reason))
        fe.reason = ["Alasan minimal 3 karakter dan tidak boleh hanya spasi"];
      if (body.refund_destination !== undefined && body.refund_destination !== null)
        Object.assign(fe, destinationErrors(body.refund_destination, "refund_destination"));
      if (
        body.evidence_file_id !== undefined &&
        body.evidence_file_id !== null &&
        (typeof body.evidence_file_id !== "string" || !UUID.test(body.evidence_file_id))
      )
        fe.evidence_file_id = ["Berkas bukti tidak valid."];
      if (Object.keys(fe).length > 0) return validationError(fe);
      const expected = ifMatch(req);
      if ("denied" in expected) return expected.denied;
      const locked = lockAdjustment(req, expected.version);
      if ("denied" in locked) return locked.denied;
      const { adjustment: a, payment: p } = locked;
      if (body.refund_destination !== undefined && a.kind !== "refund")
        return validationError({ refund_destination: ["Rekening tujuan hanya untuk refund."] });
      if (typeof body.amount === "string") {
        const tooMuch = amountError(p, a.kind, body.amount, a.id);
        if (tooMuch) return validationError({ amount: [tooMuch] });
      }
      const destination =
        body.refund_destination === undefined
          ? a.refund_destination
          : body.refund_destination === null
            ? null
            : trimDestination(body.refund_destination);
      const updated: Adjustment = {
        ...a,
        amount: typeof body.amount === "string" ? body.amount : a.amount,
        reason: typeof body.reason === "string" ? body.reason.trim() : a.reason,
        refund_destination: destination,
        has_refund_destination: destination !== null,
        evidence_file_id:
          body.evidence_file_id === undefined ? a.evidence_file_id : (body.evidence_file_id as string | null),
        version: nextVersion(a),
        updated_at: new Date().toISOString(),
      };
      adjustments.set(a.id, updated);
      return json(200, presentAdjustment(updated));
    },
  },
  {
    method: "POST",
    path: "/admin/payment-adjustments/{adjustmentId}/complete",
    handler: (req) => {
      log(req);
      const denied = requireAll(req, DECIDE);
      if (denied) return denied;
      return withReplay(req, () => {
        const body = req.body ?? {};
        if (
          body.evidence_file_id !== undefined &&
          (typeof body.evidence_file_id !== "string" || !UUID.test(body.evidence_file_id))
        )
          return validationError({ evidence_file_id: ["Berkas bukti tidak valid."] });
        const expected = ifMatch(req);
        if ("denied" in expected) return expected.denied;
        const locked = lockAdjustment(req, expected.version);
        if ("denied" in locked) return locked.denied;
        const { adjustment: a, payment: p } = locked;
        const evidence = (body.evidence_file_id as string | undefined) ?? a.evidence_file_id;
        if (a.kind === "refund" && !evidence)
          return validationError({
            evidence_file_id: ["Lampirkan bukti transfer refund sebelum menandai selesai."],
          });
        const at = new Date().toISOString();
        // Satu UPDATE bersyarat: completed, pelaku, dan rekening tujuan dikosongkan (D2).
        const completed: Adjustment = {
          ...a,
          status: "completed",
          completed_at: at,
          completed_by: mockAdminRef(),
          refund_destination: null,
          has_refund_destination: false,
          evidence_file_id: evidence,
          overdue: false,
          version: nextVersion(a),
          updated_at: at,
        };
        adjustments.set(a.id, completed);
        recordAdjusted(p, a, at);
        return { status: 200, body: presentAdjustment(completed) };
      });
    },
  },
  {
    method: "POST",
    path: "/admin/payment-adjustments/{adjustmentId}/cancel",
    handler: (req) => {
      log(req);
      const denied = requireAll(req, DECIDE);
      if (denied) return denied;
      return withReplay(req, () => {
        const body = req.body ?? {};
        if (reasonInvalid(body.reason))
          return validationError({ reason: ["Alasan minimal 3 karakter dan tidak boleh hanya spasi"] });
        const expected = ifMatch(req);
        if ("denied" in expected) return expected.denied;
        const locked = lockAdjustment(req, expected.version);
        if ("denied" in locked) return locked.denied;
        const { adjustment: a } = locked;
        const at = new Date().toISOString();
        const cancelled: Adjustment = {
          ...a,
          status: "cancelled",
          cancelled_at: at,
          cancelled_by: mockAdminRef(),
          cancel_reason: String(body.reason).trim(),
          refund_destination: null,
          has_refund_destination: false,
          overdue: false,
          version: nextVersion(a),
          updated_at: at,
        };
        adjustments.set(a.id, cancelled);
        return { status: 200, body: presentAdjustment(cancelled) };
      });
    },
  },
  {
    method: "GET",
    path: "/admin/payment-methods",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "settings.manage");
      if (denied) return denied;
      const active = bool(req.url.searchParams.get("active"));
      const items = [...methods.values()]
        .filter((m) => active === undefined || m.active === active)
        // Urutan tampil yang diatur pengurus, lalu nama penyedia, lalu id (keyset kontrak).
        .sort(
          (a, b) =>
            a.sort_order - b.sort_order || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
        )
        .map(presentMethod);
      return json(200, paginate(items, req.url) satisfies S["AdminPaymentMethodPage"]);
    },
  },
  {
    method: "POST",
    path: "/admin/payment-methods",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "settings.manage") ?? requireReauth(req);
      if (denied) return denied;
      return withReplay(req, () => {
        const body = req.body ?? {};
        const fe = methodInputErrors(body);
        if (Object.keys(fe).length > 0) return validationError(fe);
        methodSeq += 1;
        const at = new Date().toISOString();
        const row: MethodRow = {
          id: `0199e000-0000-7000-8000-0000000004${String(methodSeq).padStart(2, "0")}`,
          ...methodFromInput(body),
          version: "1",
          created_at: at,
          updated_at: at,
        };
        methods.set(row.id, row);
        return { status: 201, body: presentMethod(row) };
      });
    },
  },
  {
    method: "GET",
    path: "/admin/payment-methods/{methodId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "settings.manage");
      if (denied) return denied;
      const m = methods.get(req.params.methodId ?? "");
      return m ? json(200, presentMethod(m)) : error(404, "NOT_FOUND", "Metode pembayaran tidak ditemukan.");
    },
  },
  {
    method: "PUT",
    path: "/admin/payment-methods/{methodId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "settings.manage") ?? requireReauth(req);
      if (denied) return denied;
      const body = req.body ?? {};
      const fe = methodInputErrors(body);
      if (Object.keys(fe).length > 0) return validationError(fe);
      const expected = ifMatch(req);
      if ("denied" in expected) return expected.denied;
      const m = methods.get(req.params.methodId ?? "");
      if (!m) return error(404, "NOT_FOUND", "Metode pembayaran tidak ditemukan.");
      if (m.version !== expected.version)
        return error(409, "VERSION_CONFLICT", "Metode sudah diubah admin lain. Muat ulang.", {
          current: presentMethod(m),
        });
      const input = methodFromInput(body);
      if (inUse(m.id)) {
        // Identitas rekening metode yang sudah dipakai payment terkunci (kontrak adminUpdatePaymentMethod).
        const changed = (["kind", "provider", "account_number", "account_holder"] as const).filter(
          (f) => m[f] !== input[f],
        );
        if (changed.length > 0)
          return validationError(
            Object.fromEntries(
              changed.map((f) => [
                f,
                [
                  "Metode ini sudah dipakai pembayaran sehingga rekeningnya tidak dapat diubah. Nonaktifkan lalu buat metode baru.",
                ],
              ]),
            ),
          );
      }
      const updated: MethodRow = {
        ...m,
        ...input,
        version: nextVersion(m),
        updated_at: new Date().toISOString(),
      };
      methods.set(m.id, updated);
      return json(200, presentMethod(updated));
    },
  },
  {
    method: "DELETE",
    path: "/admin/payment-methods/{methodId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "settings.manage") ?? requireReauth(req);
      if (denied) return denied;
      const expected = ifMatch(req);
      if ("denied" in expected) return expected.denied;
      const m = methods.get(req.params.methodId ?? "");
      if (!m) return error(404, "NOT_FOUND", "Metode pembayaran tidak ditemukan.");
      if (m.version !== expected.version)
        return error(409, "VERSION_CONFLICT", "Metode sudah diubah admin lain. Muat ulang.", {
          current: presentMethod(m),
        });
      if (inUse(m.id))
        return validationError({
          _: ["Metode sudah dipakai pembayaran, nonaktifkan saja agar histori tetap utuh."],
        });
      methods.delete(m.id);
      return noContent();
    },
  },
  {
    method: "GET",
    path: "/admin/settings/fees",
    handler: (req) => {
      log(req);
      return requirePermission(req, "settings.manage") ?? json(200, fees);
    },
  },
  {
    method: "PUT",
    path: "/admin/settings/fees",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "settings.manage") ?? requireReauth(req);
      if (denied) return denied;
      const body = req.body ?? {};
      const fieldErrors: FieldErrors = {};
      for (const key of ["registration_fee", "card_fee", "renewal_fee"] as const) {
        if (typeof body[key] !== "string" || !MONEY.test(body[key] as string))
          fieldErrors[key] = ["Nominal tidak valid."];
      }
      if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500))
        fieldErrors.reason = ["Catatan maksimal 500 karakter."];
      if (Object.keys(fieldErrors).length > 0) return validationError(fieldErrors);
      const expected = ifMatch(req);
      if ("denied" in expected) return expected.denied;
      if (expected.version !== fees.version)
        return error(409, "VERSION_CONFLICT", "Biaya sudah diubah admin lain. Muat ulang.", {
          current: fees,
        });
      // Versi baru hanya dipakai instruksi yang dibuat sesudahnya; payment lama tetap memakai snapshot (AC F03-5).
      fees = feeSettings(
        body.registration_fee as string,
        body.card_fee as string,
        body.renewal_fee as string,
        nextVersion(fees),
        new Date().toISOString(),
        mockAdminRef(),
      );
      return json(200, fees);
    },
  },
];

/**
 * Rute yang diekspor: setiap handler melewati kendali uji lebih dahulu (permintaan ditahan atau galat
 * suntikan), lalu penjaga dan logika server tiruan di atas.
 */
export const routes: MockRoute[] = paymentRoutes.map((route) => ({
  ...route,
  handler: async (req) => {
    const hold = takeHold(req);
    if (hold) await hold.gate;
    const failure = takeFailure(req);
    if (failure) {
      log(req);
      return error(failure.status, failure.code, failure.message);
    }
    return route.handler(req);
  },
}));
