import { requirePermission, requireReauth } from "./auth";
import { error, json, type MockRequest, type MockRoute, paginate, type S } from "./http";

/**
 * Tiruan antrean dan keputusan pembayaran (F-04) serta biaya (F-03, AC F15-3). Data contoh mengikuti prototipe
 * screen_8; bukan bukti lulus acceptance criteria (PRD 7.3). Endpoint nyata dibangun irisan API payments.
 */
type Detail = S["AdminPaymentDetail"];

const METHOD: S["PaymentMethod"] = {
  id: "0199e000-0000-7000-8000-000000000001",
  kind: "bank",
  provider: "[Nama bank 1]",
  account_number: "[Nomor rekening]",
  account_holder: "[Nama pemilik rekening]",
};

/** Berkas bukti contoh; GET /files/{id}/access di mocks/files.ts mengembalikan gambar tiruan. */
export const MOCK_PROOF_FILE_ID = "0199e000-0000-7000-8000-0000000000f1";
export const MOCK_PROOF_FILE_ID_V2 = "0199e000-0000-7000-8000-0000000000f2";

function lines(type: S["PaymentType"], amount: string): S["PaymentLine"][] {
  if (type === "registration")
    return [
      { code: "registration_fee", label: "Register alumni baru", amount: "50000.00" },
      { code: "card_fee", label: "Pembuatan KTA", amount: "10000.00" },
    ];
  if (type === "renewal") return [{ code: "renewal_fee", label: "Perpanjangan KTA", amount: "10000.00" }];
  return [{ code: "ticket", label: "Tiket event", amount }];
}

const DAY_MS = 24 * 3600_000;

/** Pengurus contoh yang memutus di mode mock (identitas tiruan, bukan data nyata). */
const MOCK_DECIDER: S["AdminPaymentActorRef"] = {
  admin_id: "0199e000-0000-7000-8000-0000000000d1",
  display_name: "Admin Contoh",
};

function proofOf(fileId: string, version: number, at: string): S["AdminPaymentProof"] {
  return { file_id: fileId, version, mime: "image/svg+xml", bytes: 2048, submitted_at: at };
}

function event(
  at: string,
  kind: S["PaymentEventKind"],
  actor: S["PaymentEventActor"],
  extra: { proofVersion?: number; proofFileId?: string; reason?: string | null } = {},
): S["AdminPaymentEvent"] {
  return {
    at,
    kind,
    actor,
    proof_version: extra.proofVersion ?? null,
    reason: extra.reason ?? null,
    proof_file_id: extra.proofFileId ?? null,
    actor_admin: actor === "admin" ? MOCK_DECIDER : null,
  };
}

/** Tindakan yang diizinkan server (kontrak AdminPaymentActions) untuk admin mock dengan payments.decide. */
function actionsOf(
  p: Pick<Detail, "status" | "proof_version" | "conflict_of_interest">,
): S["AdminPaymentActions"] {
  const free = !p.conflict_of_interest;
  return {
    can_decide: free && p.status === "pending" && p.proof_version > 0,
    can_cancel: free && p.status === "pending" && p.proof_version === 0,
    can_adjust: free && p.status === "paid",
  };
}

function item(
  id: string,
  name: string,
  number: string,
  cohort: number,
  type: S["PaymentType"],
  amount: string,
  submitted: string,
  opts: { overdue?: boolean; eventTitle?: string } = {},
): Detail {
  const isTicket = type === "ticket";
  const eventStartsAt = isTicket ? new Date(Date.parse(submitted) + 14 * DAY_MS).toISOString() : null;
  return {
    id,
    type,
    status: "pending",
    stage: "awaiting_review",
    amount,
    member: {
      user_id: id.replace("-8000-", "-9000-"),
      full_name: name,
      member_number: number,
      cohort,
      effective_status: type === "renewal" ? "expiring" : type === "ticket" ? "verified" : "unverified",
    },
    event_title: opts.eventTitle ?? null,
    event_starts_at: eventStartsAt,
    ticket_status: isTicket ? "awaiting_review" : null,
    event_cancelled: isTicket ? false : null,
    submitted_at: submitted,
    decided_at: null,
    // Iuran: 1 hari kerja; tiket: 2 hari kerja atau pembukaan check-in (pendekatan sederhana untuk mock).
    review_due_at: new Date(Date.parse(submitted) + (isTicket ? 2 : 1) * DAY_MS).toISOString(),
    proof_version: 1,
    overdue: opts.overdue ?? false,
    created_at: submitted,
    version: "1",
    lines: lines(type, amount),
    method: METHOD,
    method_id: METHOD.id,
    method_active: true,
    proof: proofOf(MOCK_PROOF_FILE_ID, 1, submitted),
    transfer_note: null,
    rejection_reason: null,
    rejection_count: 0,
    decided_by: null,
    cancelled_at: null,
    cancel_reason: null,
    ticket: isTicket
      ? {
          ticket_id: id.replace("-8000-", "-a000-"),
          event_id: "0199e000-0000-7000-8000-0000000000e1",
          event_title: opts.eventTitle ?? "Event",
          event_starts_at: eventStartsAt!,
          event_timezone: "Asia/Jakarta",
          ticket_status: "awaiting_review",
          hold_expires_at: null,
        }
      : null,
    period: null,
    settings_version: isTicket ? null : "1",
    events: [
      event(submitted, "created", "member"),
      event(submitted, "proof_submitted", "member", { proofVersion: 1, proofFileId: MOCK_PROOF_FILE_ID }),
    ],
    adjustments: [],
    conflict_of_interest: false,
    refund_on_approve: false,
    actions: { can_decide: true, can_cancel: false, can_adjust: false },
  };
}

function fixtures(): Detail[] {
  const base: Detail[] = [
    item(
      "0199e000-0000-7000-8000-0000000000a1",
      "Siti Rahmawati",
      "27.02.02.5",
      27,
      "registration",
      "60000.00",
      "2026-10-11T02:02:00Z",
      { overdue: true },
    ),
    item(
      "0199e000-0000-7000-8000-0000000000a2",
      "Ahmad Islam",
      "29.01.01.7",
      29,
      "registration",
      "60000.00",
      "2026-10-12T07:20:00Z",
    ),
    item(
      "0199e000-0000-7000-8000-0000000000a3",
      "Muhammad Fikri",
      "18.01.01.3",
      18,
      "renewal",
      "10000.00",
      "2026-10-12T08:05:00Z",
    ),
    item(
      "0199e000-0000-7000-8000-0000000000a5",
      "Nur Aisyah",
      "30.02.02.9",
      30,
      "ticket",
      "75000.00",
      "2026-10-12T08:40:00Z",
      { eventTitle: "Halal bi Halal" },
    ),
    item(
      "0199e000-0000-7000-8000-0000000000a4",
      "Rizky Pratama",
      "22.03.01.11",
      22,
      "registration",
      "60000.00",
      "2026-10-12T09:02:00Z",
    ),
  ];
  // Data sintetis agar paging kursor dapat dicoba di dev:mock (lebih baru dari data prototipe).
  for (let i = 1; i <= 21; i += 1) {
    const n = String(i).padStart(2, "0");
    base.push(
      item(
        `0199e000-0000-7000-8000-0000000001${n}`,
        `Alumni Contoh ${n}`,
        `2${i % 10}.01.0${(i % 2) + 1}.${100 + i}`,
        20 + (i % 10),
        i % 3 === 0 ? "renewal" : "registration",
        i % 3 === 0 ? "10000.00" : "60000.00",
        new Date(Date.UTC(2026, 9, 12, 10, i)).toISOString(),
      ),
    );
  }
  const linked = base[base.length - 1]!;
  linked.conflict_of_interest = true;
  linked.actions = actionsOf(linked);
  return base;
}

let payments = new Map<string, Detail>();
let fees: S["FeeSettings"];

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

export function reset(): void {
  paymentRequests.length = 0;
  payments = new Map(fixtures().map((p) => [p.id, p]));
  fees = {
    registration_fee: "50000.00",
    card_fee: "10000.00",
    renewal_fee: "10000.00",
    registration_total: "60000.00",
    version: "1",
    effective_from: "2026-10-01T00:00:00Z",
    updated_by: null,
  };
}
reset();

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

/** Penjumlahan Money desimal tanpa floating point (ARCHITECTURE §2 butir 5): "50000.00" + "10000.00". */
function addMoney(a: string, b: string): string {
  const cents = (m: string) => BigInt(m.replace(".", ""));
  const total = (cents(a) + cents(b)).toString().padStart(3, "0");
  return `${total.slice(0, -2)}.${total.slice(-2)}`;
}

/** Kendali server tiruan untuk uji: meniru alumni mengganti bukti (AC F03-2, F04-4). */
export const mockPayments = {
  replaceProof(paymentId: string): void {
    const p = payments.get(paymentId);
    if (!p) return;
    const at = new Date().toISOString();
    const version = p.proof_version + 1;
    payments.set(paymentId, {
      ...p,
      proof_version: version,
      proof: proofOf(MOCK_PROOF_FILE_ID_V2, version, at),
      version: String(Number(p.version) + 1),
      events: [
        ...p.events,
        event(at, "proof_replaced", "member", { proofVersion: version, proofFileId: MOCK_PROOF_FILE_ID_V2 }),
      ],
    });
  },
  get(paymentId: string): Detail | undefined {
    return payments.get(paymentId);
  },
};

const MONEY = /^[0-9]+\.[0-9]{2}$/;

export const routes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/payments",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "payments.read");
      if (denied) return denied;
      const status = req.url.searchParams.get("status");
      const stage = req.url.searchParams.get("stage");
      const type = req.url.searchParams.get("type");
      const q = (req.url.searchParams.get("q") ?? "").trim().toLowerCase();
      const items = [...payments.values()]
        .filter((p) => !status || p.status === status)
        .filter((p) => !stage || p.stage === stage)
        .filter((p) => !type || p.type === type)
        .filter(
          (p) =>
            !q ||
            (p.member?.full_name.toLowerCase().includes(q) ?? false) ||
            (p.member?.member_number ?? "").includes(q),
        )
        // Antrean berdasarkan waktu kirim bukti, terlama dulu (PRD 3.4).
        .sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""))
        .map(summary);
      return json(200, paginate(items, req.url) satisfies S["AdminPaymentPage"]);
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
      return p ? json(200, p) : error(404, "NOT_FOUND", "Data tidak ditemukan.");
    },
  },
  {
    method: "POST",
    path: "/admin/payments/{paymentId}/decision",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "payments.decide");
      if (denied) return denied;
      const body = req.body ?? {};
      const p = payments.get(req.params.paymentId ?? "");
      if (!p) return error(404, "NOT_FOUND", "Data tidak ditemukan.");
      if (p.conflict_of_interest)
        return error(
          403,
          "FORBIDDEN",
          "Pembayaran milik akun alumni yang tertaut ke Anda tidak dapat diputus.",
        );
      if (p.status !== "pending")
        return error(409, "PAYMENT_STATE_CONFLICT", "Pembayaran sudah diputus admin lain.", { current: p });
      if (body.expected_proof_version !== p.proof_version)
        return error(409, "PROOF_VERSION_CONFLICT", "Bukti sudah diganti. Periksa bukti terbaru.", {
          current: p,
        });
      if (body.expected_version !== p.version)
        return error(409, "PAYMENT_STATE_CONFLICT", "Status pembayaran sudah berubah.", { current: p });
      if (body.decision === "approve" && body.funds_verified !== true)
        return error(400, "VALIDATION_ERROR", "Konfirmasi dana masuk wajib.", {
          field_errors: { funds_verified: ["Centang setelah dana terlihat di rekening tujuan."] },
        });
      const reason = String(body.reason ?? "").trim();
      if (body.decision === "reject" && reason.length < 3)
        return error(400, "VALIDATION_ERROR", "Alasan penolakan wajib diisi.", {
          field_errors: { reason: ["Alasan minimal 3 karakter dan tidak boleh hanya spasi."] },
        });
      const at = new Date().toISOString();
      const approved = body.decision === "approve";
      const status: S["PaymentStatus"] = approved ? "paid" : "rejected";
      const decided: Detail = {
        ...p,
        status,
        stage: approved ? "paid" : p.type === "ticket" ? "rejected_final" : "needs_fix",
        decided_at: at,
        decided_by: MOCK_DECIDER,
        review_due_at: null,
        overdue: false,
        rejection_reason: approved ? p.rejection_reason : reason,
        rejection_count: approved ? p.rejection_count : p.rejection_count + 1,
        version: String(Number(p.version) + 1),
        events: [
          ...p.events,
          event(at, approved ? "approved" : "rejected", "admin", {
            proofVersion: p.proof_version,
            reason: reason || null,
          }),
        ],
      };
      const updated: Detail = { ...decided, actions: actionsOf(decided) };
      payments.set(p.id, updated);
      return json(200, updated);
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
      if (Object.keys(fieldErrors).length > 0)
        return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          field_errors: fieldErrors,
        });
      fees = {
        registration_fee: body.registration_fee as string,
        card_fee: body.card_fee as string,
        renewal_fee: body.renewal_fee as string,
        registration_total: addMoney(body.registration_fee as string, body.card_fee as string),
        version: String(Number(fees.version) + 1),
        effective_from: new Date().toISOString(),
        updated_by: { admin_id: MOCK_DECIDER.admin_id, display_name: MOCK_DECIDER.display_name },
      };
      return json(200, fees);
    },
  },
];
