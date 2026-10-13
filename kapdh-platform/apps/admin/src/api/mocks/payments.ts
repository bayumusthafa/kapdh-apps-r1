import { mockAdminRef, mockHasPermission, requirePermission, requireReauth } from "./auth";
import { error, json, type MockRequest, type MockRoute, paginate, type S } from "./http";

/**
 * Tiruan antrean dan keputusan pembayaran (F-04) serta biaya (F-03, AC F15-3) mengikuti kontrak admin-payments
 * dan admin-settings final (C3). Data contoh mengikuti prototipe screen_8; bukan bukti lulus acceptance criteria
 * (PRD 7.3). Endpoint nyata dibangun irisan API payments.
 *
 * Aturan server yang ditiru:
 * - `stage` dihitung server; "Menunggu" = `stage=awaiting_review` (bukan `status=pending`, yang ikut memuat
 *   instruksi tanpa bukti), total sama dengan `awaiting_review_count` di GET /admin/payments/summary.
 * - `actions` dihitung per pemanggil (izin payments.decide, tahap, konflik kepentingan PRD 2.3).
 * - Akun pemilik dihapus (D2, AC F14-4): `member` null, `proof` null walau `proof_version` >= 1, catatan transfer
 *   dihapus; payment tetap wajib diputus.
 * - Tiket yang sudah dibatalkan sebelum keputusan: approve = dana diterima tanpa menghidupkan tiket, dan refund
 *   sistem penuh dibuat bila `refund_on_approve` (D6).
 * - Urutan 409 keputusan: PAYMENT_STATE_CONFLICT, PROOF_VERSION_CONFLICT, VERSION_CONFLICT; Idempotency-Key yang
 *   sama dengan payload sama mengembalikan hasil pertama.
 */
type Detail = S["AdminPaymentDetail"];
type PaymentEvent = S["AdminPaymentEvent"];

/** Waktu server tiruan saat data contoh dibuat; dasar `overdue` agar data contoh deterministik. */
const MOCK_SERVER_NOW = Date.parse("2026-10-12T11:00:00Z");
/** Asia/Jakarta UTC+7 tanpa DST: hari kerja Senin-Jumat dihitung pada tanggal WIB (kontrak adminListPayments). */
const WIB_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
/** Jendela check-in dibuka 2 jam sebelum event (app_settings events.checkin_before_hours, D5). */
const CHECKIN_BEFORE_MS = 2 * 3_600_000;

const METHOD: S["PaymentMethod"] = {
  id: "0199e000-0000-7000-8000-000000000001",
  kind: "bank",
  provider: "[Nama bank 1]",
  account_number: "[Nomor rekening]",
  account_holder: "[Nama pemilik rekening]",
  instructions: null,
};

/** Berkas bukti contoh; GET /files/{id}/access di mocks/files.ts mengembalikan gambar tiruan. */
export const MOCK_PROOF_FILE_ID = "0199e000-0000-7000-8000-0000000000f1";
export const MOCK_PROOF_FILE_ID_V2 = "0199e000-0000-7000-8000-0000000000f2";
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

/** Money "60000.00" ditambah tanpa floating point (ARCHITECTURE §2 butir 5). */
function addMoney(a: string, b: string): string {
  const cents = (m: string) => BigInt(m.replace(".", ""));
  const total = (cents(a) + cents(b)).toString().padStart(3, "0");
  return `${total.slice(0, -2)}.${total.slice(-2)}`;
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

const NO_ACTIONS: S["AdminPaymentActions"] = { can_decide: false, can_cancel: false, can_adjust: false };

/** Payment pending (berbukti versi 1, atau tanpa bukti) dengan semua field wajib AdminPaymentDetail. */
function build(spec: Spec): Detail {
  const t = spec.ticket;
  const hasProof = spec.submittedAt !== null;
  const deleted = spec.member === null;
  const dueAt = hasProof ? reviewDueAt(spec.type, spec.submittedAt!, t?.eventStartsAt ?? null) : null;
  const ticketStatus: S["PaymentTicketStatus"] | null = t
    ? t.cancelled
      ? "cancelled"
      : hasProof
        ? "awaiting_review"
        : "awaiting_payment"
    : null;
  const events: PaymentEvent[] = [
    {
      at: spec.createdAt,
      kind: "created",
      actor: "member",
      proof_version: null,
      reason: null,
      proof_file_id: null,
      actor_admin: null,
    },
  ];
  if (hasProof)
    events.push({
      at: spec.submittedAt!,
      kind: "proof_submitted",
      actor: "member",
      proof_version: 1,
      reason: null,
      // Berkas bukti ikut dihapus bersama akun pemilik; histori mengembalikan null (D2).
      proof_file_id: deleted ? null : MOCK_PROOF_FILE_ID,
      actor_admin: null,
    });
  if (t?.cancelled)
    events.push({
      at: t.cancelled.at,
      kind: "cancelled",
      actor: t.cancelled.by === "system" ? "system" : t.cancelled.by === "admin" ? "admin" : "member",
      proof_version: null,
      reason: t.cancelled.eventCancelled ? "Event dibatalkan pengurus." : "Tiket dibatalkan.",
      proof_file_id: null,
      actor_admin: null,
    });
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
    overdue: dueAt !== null && Date.parse(dueAt) < MOCK_SERVER_NOW,
    created_at: spec.createdAt,
    version: "1",
    lines: lines(spec.type, spec.amount),
    method: METHOD,
    method_id: METHOD.id,
    method_active: true,
    proof:
      hasProof && !deleted
        ? {
            file_id: MOCK_PROOF_FILE_ID,
            version: 1,
            mime: PROOF_MIME,
            bytes: PROOF_BYTES,
            submitted_at: spec.submittedAt!,
          }
        : null,
    transfer_note: null,
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

/** Anggota mengganti rekening tujuan sebelum mentransfer (payment_events `method_changed`). */
function withMethodChange(p: Detail, at: string): Detail {
  return {
    ...p,
    version: nextVersion(p),
    events: [
      ...p.events,
      {
        at,
        kind: "method_changed",
        actor: "member",
        proof_version: null,
        reason: null,
        proof_file_id: null,
        actor_admin: null,
      },
    ],
  };
}

/** Waktu pembatalan event contoh (dasar tenggat refund 7 hari kerja, D6). */
const SEMINAR_CANCELLED_AT = "2026-10-12T09:00:00Z";

function fixtures(): Detail[] {
  const base: Detail[] = [
    build({
      id: "0199e000-0000-7000-8000-0000000000a1",
      member: member(
        "0199e000-0000-7000-8000-0000000000b1",
        "Siti Rahmawati",
        "27.02.02.5",
        27,
        "unverified",
      ),
      type: "registration",
      amount: "60000.00",
      createdAt: "2026-10-11T01:40:00Z",
      submittedAt: "2026-10-11T02:02:00Z",
    }),
    build({
      id: "0199e000-0000-7000-8000-0000000000a2",
      member: member("0199e000-0000-7000-8000-0000000000b2", "Ahmad Islam", "29.01.01.7", 29, "unverified"),
      type: "registration",
      amount: "60000.00",
      createdAt: "2026-10-12T07:00:00Z",
      submittedAt: "2026-10-12T07:20:00Z",
    }),
    build({
      id: "0199e000-0000-7000-8000-0000000000a3",
      member: member("0199e000-0000-7000-8000-0000000000b3", "Muhammad Fikri", "18.01.01.3", 18, "expiring"),
      type: "renewal",
      amount: "10000.00",
      createdAt: "2026-10-12T07:50:00Z",
      submittedAt: "2026-10-12T08:05:00Z",
    }),
    build({
      id: "0199e000-0000-7000-8000-0000000000a5",
      member: member("0199e000-0000-7000-8000-0000000000b5", "Nur Aisyah", "30.02.02.9", 30, "verified"),
      type: "ticket",
      amount: "75000.00",
      createdAt: "2026-10-12T08:30:00Z",
      submittedAt: "2026-10-12T08:40:00Z",
      ticket: {
        eventId: "0199e000-0000-7000-8000-0000000000e1",
        ticketId: "0199e000-0000-7000-8000-0000000000c5",
        eventTitle: "Halal bi Halal",
        eventStartsAt: "2026-10-24T01:00:00Z",
      },
    }),
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
        eventId: "0199e000-0000-7000-8000-0000000000e2",
        ticketId: "0199e000-0000-7000-8000-0000000000c8",
        eventTitle: "Seminar Karier Alumni",
        eventStartsAt: "2026-10-25T02:00:00Z",
        cancelled: { by: "system", eventCancelled: true, at: SEMINAR_CANCELLED_AT },
      },
    }),
    // Instruksi tanpa bukti (awaiting_transfer): tidak termasuk "Menunggu", hanya terlihat di "Semua". Anggota
    // sempat mengganti rekening tujuan sebelum mentransfer (histori method_changed).
    withMethodChange(
      build({
        id: "0199e000-0000-7000-8000-0000000000a7",
        member: member("0199e000-0000-7000-8000-0000000000b7", "Hasan Basri", "16.02.01.4", 16, "expired"),
        type: "renewal",
        amount: "10000.00",
        createdAt: "2026-10-12T03:00:00Z",
        submittedAt: null,
      }),
      "2026-10-12T03:10:00Z",
    ),
  ];
  // Data sintetis agar paging kursor dapat dicoba di dev:mock (lebih baru dari data prototipe).
  for (let i = 1; i <= 21; i += 1) {
    const n = String(i).padStart(2, "0");
    const renewal = i % 3 === 0;
    const submitted = new Date(Date.UTC(2026, 9, 12, 10, i)).toISOString();
    base.push(
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
  base[base.length - 1]!.conflict_of_interest = true;
  return base;
}

let payments = new Map<string, Detail>();
let fees: S["FeeSettings"];
let adjustmentSeq = 0;
/** Idempotency-Key keputusan: payload pertama dan respons pertama (ARCHITECTURE §4.2). */
const decisionReplays = new Map<string, { payload: string; status: number; body: unknown }>();

export interface PaymentRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  background: boolean;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
}

/** Log permintaan ke endpoint pembayaran tiruan, untuk uji (debounce, header latar, Idempotency-Key). */
export const paymentRequests: PaymentRequestLog[] = [];

function log(req: MockRequest): void {
  paymentRequests.push({
    method: req.method,
    path: req.path,
    query: Object.fromEntries(req.url.searchParams.entries()),
    background: req.headers.get("X-Background-Request") === "1",
    idempotencyKey: req.headers.get("Idempotency-Key"),
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

export function reset(): void {
  paymentRequests.length = 0;
  decisionReplays.clear();
  adjustmentSeq = 0;
  payments = new Map(fixtures().map((p) => [p.id, p]));
  fees = feeSettings("50000.00", "10000.00", "10000.00", "1", "2026-10-01T00:00:00Z", null);
}
reset();

/** Tindakan yang diizinkan server untuk pemanggil saat ini (izin, tahap, konflik kepentingan). */
function present(p: Detail): Detail {
  const decide = mockHasPermission("payments.decide") && !p.conflict_of_interest;
  return {
    ...p,
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
    member: p.member,
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

function nextVersion(p: Detail): string {
  return String(Number(p.version) + 1);
}

/** Kendali server tiruan untuk uji: meniru alumni mengganti bukti (AC F03-2, F04-4). */
export const mockPayments = {
  replaceProof(paymentId: string): void {
    const p = payments.get(paymentId);
    if (!p) return;
    const at = new Date().toISOString();
    const proofVersion = p.proof_version + 1;
    // Bukti pengganti: pending tetap pending, iuran rejected kembali pending pada payment yang sama (AC F03-3).
    payments.set(paymentId, {
      ...p,
      status: "pending",
      stage: "awaiting_review",
      proof_version: proofVersion,
      proof: {
        file_id: MOCK_PROOF_FILE_ID_V2,
        version: proofVersion,
        mime: PROOF_MIME,
        bytes: PROOF_BYTES,
        submitted_at: at,
      },
      submitted_at: at,
      review_due_at: reviewDueAt(p.type, at, p.event_starts_at),
      overdue: false,
      version: nextVersion(p),
      events: [
        ...p.events,
        {
          at,
          kind: "proof_replaced",
          actor: "member",
          proof_version: proofVersion,
          reason: null,
          proof_file_id: MOCK_PROOF_FILE_ID_V2,
          actor_admin: null,
        },
      ],
    });
  },
  get(paymentId: string): Detail | undefined {
    return payments.get(paymentId);
  },
};

const MONEY = /^[0-9]{1,12}\.[0-9]{2}$/;

/** Refund sistem penuh saat approve tiket yang event-nya dibatalkan (D6): created_by null, tenggat 7 hari kerja. */
function systemRefund(p: Detail, decidedAt: string): S["AdminPaymentAdjustment"] {
  adjustmentSeq += 1;
  const cancelledAt = p.events.find((e) => e.kind === "cancelled")?.at ?? decidedAt;
  return {
    id: `0199e000-0000-7000-8000-0000000003${String(adjustmentSeq).padStart(2, "0")}`,
    payment_id: p.id,
    payment: {
      id: p.id,
      type: p.type,
      status: "paid",
      amount: p.amount,
      member: p.member,
      event_title: p.event_title,
      decided_at: decidedAt,
    },
    kind: "refund",
    amount: p.amount,
    reason: p.event_cancelled
      ? "Refund penuh otomatis: event dibatalkan pengurus (D6)."
      : "Refund penuh otomatis: peserta membatalkan tiket paling lambat H-3 (D6).",
    status: "pending",
    has_refund_destination: false,
    refund_destination: null,
    evidence_file_id: null,
    due_at: addBusinessDays(cancelledAt, 7),
    overdue: false,
    created_by: null,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: decidedAt,
    updated_at: decidedAt,
    version: "1",
  };
}

/** Terapkan keputusan yang sudah lolos semua pemeriksaan (satu transaksi di server, AC F04-1). */
function applyDecision(p: Detail, decision: "approve" | "reject", reason: string): Detail {
  const at = new Date().toISOString();
  const admin = mockAdminRef();
  const event: PaymentEvent = {
    at,
    kind: decision === "approve" ? "approved" : "rejected",
    actor: "admin",
    proof_version: p.proof_version,
    reason: decision === "reject" ? reason : null,
    proof_file_id: null,
    actor_admin: admin,
  };
  const common = {
    ...p,
    decided_at: at,
    decided_by: admin,
    review_due_at: null,
    overdue: false,
    version: nextVersion(p),
    events: [...p.events, event],
  };
  if (decision === "approve") {
    // Tiket yang sudah dibatalkan tidak dihidupkan kembali; selain itu tiket menjadi paid (PRD 4.4).
    const ticketStatus = p.ticket_status === "cancelled" ? "cancelled" : p.type === "ticket" ? "paid" : null;
    const approvedAt = new Date(at);
    const expires = new Date(approvedAt);
    expires.setUTCMonth(expires.getUTCMonth() + 12);
    return {
      ...common,
      status: "paid",
      stage: "paid",
      ticket_status: ticketStatus,
      ticket: p.ticket && ticketStatus ? { ...p.ticket, ticket_status: ticketStatus } : p.ticket,
      // Periode keanggotaan hanya bila pemilik masih ada (akun dihapus: tanpa efek keanggotaan, PRD 4.4).
      period:
        p.type !== "ticket" && p.member ? { starts_at: at, expires_at: expires.toISOString() } : p.period,
      adjustments: p.refund_on_approve ? [...p.adjustments, systemRefund(p, at)] : p.adjustments,
      refund_on_approve: false,
    };
  }
  // Iuran ditolak dapat diperbaiki pemilik (needs_fix); tiket ditolak final dan tiketnya cancelled (AC F09-4).
  const ticket = p.type === "ticket";
  return {
    ...common,
    status: "rejected",
    stage: ticket ? "rejected_final" : "needs_fix",
    ticket_status: ticket ? "cancelled" : null,
    ticket: p.ticket ? { ...p.ticket, ticket_status: "cancelled" } : null,
    rejection_reason: reason,
    rejection_count: p.rejection_count + 1,
    refund_on_approve: false,
  };
}

function bool(value: string | null): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

export const routes: MockRoute[] = [
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
      const q = (params.get("q") ?? "").trim().toLowerCase();
      const items = [...payments.values()]
        .filter((p) => !status || p.status === status)
        .filter((p) => !stage || p.stage === stage)
        .filter((p) => !type || p.type === type)
        .filter((p) => overdue === undefined || p.overdue === overdue)
        // Nama sebagian tanpa beda huruf besar atau awalan nomor anggota; akun terhapus tidak dapat dicari.
        .filter(
          (p) =>
            !q ||
            (p.member !== null &&
              (p.member.full_name.toLowerCase().includes(q) || (p.member.member_number ?? "").startsWith(q))),
        )
        // Bawaan submitted_at_asc: paling lama menunggu di atas, payment tanpa bukti di akhir (PRD 3.4).
        .sort((a, b) => {
          if (a.submitted_at === b.submitted_at) return a.id.localeCompare(b.id);
          if (a.submitted_at === null) return 1;
          if (b.submitted_at === null) return -1;
          return a.submitted_at.localeCompare(b.submitted_at);
        })
        .map(summary);
      return json(200, paginate(items, req.url) satisfies S["AdminPaymentPage"]);
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
      const adjustments = all.flatMap((p) => p.adjustments).filter((a) => a.status === "pending");
      const body: S["AdminPaymentSummary"] = {
        awaiting_review_count: review.length,
        overdue_count: review.filter((p) => p.overdue).length,
        awaiting_transfer_count: all.filter((p) => p.stage === "awaiting_transfer").length,
        awaiting_review_by_type: {
          registration: review.filter((p) => p.type === "registration").length,
          renewal: review.filter((p) => p.type === "renewal").length,
          ticket: review.filter((p) => p.type === "ticket").length,
        },
        adjustments_pending_count: adjustments.length,
        adjustments_overdue_count: adjustments.filter((a) => a.overdue).length,
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
      const denied = requirePermission(req, "payments.read") ?? requirePermission(req, "payments.decide");
      if (denied) return denied;
      const body = req.body ?? {};
      const p = payments.get(req.params.paymentId ?? "");
      if (!p) return error(404, "NOT_FOUND", "Data tidak ditemukan.");

      const key = req.headers.get("Idempotency-Key");
      const payload = JSON.stringify([req.params.paymentId, body]);
      const replay = key ? decisionReplays.get(key) : undefined;
      if (replay) {
        if (replay.payload !== payload)
          return error(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah dipakai untuk permintaan lain.");
        return json(replay.status, replay.body);
      }

      // Validasi body (400) sebelum pemeriksaan keadaan.
      const decision = body.decision;
      const fieldErrors: Record<string, string[]> = {};
      if (decision !== "approve" && decision !== "reject")
        fieldErrors.decision = ["Keputusan tidak dikenal."];
      if (!Number.isInteger(body.expected_proof_version) || (body.expected_proof_version as number) < 1)
        fieldErrors.expected_proof_version = ["Versi bukti tidak valid."];
      if (typeof body.expected_version !== "string" || body.expected_version.length > 64)
        fieldErrors.expected_version = ["Versi pembayaran tidak valid."];
      if (decision === "approve" && body.funds_verified !== true)
        fieldErrors.funds_verified = ["Centang setelah dana terlihat di rekening tujuan."];
      const reason = typeof body.reason === "string" ? body.reason : "";
      if (decision === "reject" && (reason.trim().length < 3 || reason.length > 500))
        fieldErrors.reason = ["Alasan minimal 3 karakter dan tidak boleh hanya spasi."];
      if (Object.keys(fieldErrors).length > 0)
        return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          field_errors: fieldErrors,
        });

      if (p.conflict_of_interest)
        return error(
          403,
          "FORBIDDEN",
          "Pembayaran milik akun alumni yang tertaut ke Anda tidak dapat diputus.",
        );
      const current = present(p);
      if (p.status !== "pending" || p.proof_version === 0)
        return error(409, "PAYMENT_STATE_CONFLICT", "Pembayaran sudah diputus admin lain.", { current });
      if (body.expected_proof_version !== p.proof_version)
        return error(409, "PROOF_VERSION_CONFLICT", "Bukti sudah diganti. Periksa bukti terbaru.", {
          current,
        });
      if (body.expected_version !== p.version)
        return error(409, "VERSION_CONFLICT", "Data pembayaran sudah berubah. Muat ulang.", { current });

      const updated = applyDecision(p, decision as "approve" | "reject", reason.trim());
      payments.set(p.id, updated);
      const result = present(updated);
      // Hanya hasil berhasil yang disimpan untuk diputar ulang (pengulangan setelah respons hilang, PRD 4.5).
      if (key) decisionReplays.set(key, { payload, status: 200, body: result });
      return json(200, result);
    },
  },
  {
    method: "GET",
    path: "/admin/settings/fees",
    handler: (req) => requirePermission(req, "settings.manage") ?? json(200, fees),
  },
  {
    method: "PUT",
    path: "/admin/settings/fees",
    handler: (req) => {
      const denied = requirePermission(req, "settings.manage") ?? requireReauth(req);
      if (denied) return denied;
      if (req.headers.get("If-Match") !== fees.version)
        return error(409, "VERSION_CONFLICT", "Biaya sudah diubah admin lain. Muat ulang.", {
          current: fees,
        });
      const body = req.body ?? {};
      const fieldErrors: Record<string, string[]> = {};
      for (const key of ["registration_fee", "card_fee", "renewal_fee"] as const) {
        if (typeof body[key] !== "string" || !MONEY.test(body[key] as string))
          fieldErrors[key] = ["Nominal tidak valid."];
      }
      if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500))
        fieldErrors.reason = ["Catatan maksimal 500 karakter."];
      if (Object.keys(fieldErrors).length > 0)
        return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          field_errors: fieldErrors,
        });
      fees = feeSettings(
        body.registration_fee as string,
        body.card_fee as string,
        body.renewal_fee as string,
        String(Number(fees.version) + 1),
        new Date().toISOString(),
        mockAdminRef(),
      );
      return json(200, fees);
    },
  },
];
