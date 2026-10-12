import { requirePermission, requireReauth } from "./auth";
import { error, json, type MockRoute, paginate, type S } from "./http";

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
  return {
    id,
    type,
    status: "pending",
    amount,
    member: { full_name: name, member_number: number, cohort },
    event_title: opts.eventTitle ?? null,
    submitted_at: submitted,
    proof_version: 1,
    overdue: opts.overdue ?? false,
    lines: lines(type, amount),
    method: METHOD,
    proof_file_id: MOCK_PROOF_FILE_ID,
    transfer_note: null,
    events: [
      { at: submitted, kind: "created", reason: null },
      { at: submitted, kind: "proof_submitted", proof_version: 1, reason: null },
    ],
    conflict_of_interest: false,
    version: "1",
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
  base[base.length - 1]!.conflict_of_interest = true;
  return base;
}

let payments = new Map<string, Detail>();
let fees: S["FeeSettings"];

export function reset(): void {
  payments = new Map(fixtures().map((p) => [p.id, p]));
  fees = {
    registration_fee: "50000.00",
    card_fee: "10000.00",
    renewal_fee: "10000.00",
    version: "1",
    effective_from: "2026-10-01T00:00:00Z",
  };
}
reset();

function summary(p: Detail): S["AdminPaymentItem"] {
  return {
    id: p.id,
    type: p.type,
    status: p.status,
    amount: p.amount,
    member: p.member,
    event_title: p.event_title ?? null,
    submitted_at: p.submitted_at ?? null,
    proof_version: p.proof_version,
    overdue: p.overdue,
  };
}

/** Kendali server tiruan untuk uji: meniru alumni mengganti bukti (AC F03-2, F04-4). */
export const mockPayments = {
  replaceProof(paymentId: string): void {
    const p = payments.get(paymentId);
    if (!p) return;
    const at = new Date().toISOString();
    payments.set(paymentId, {
      ...p,
      proof_version: p.proof_version + 1,
      proof_file_id: MOCK_PROOF_FILE_ID_V2,
      version: String(Number(p.version) + 1),
      events: [...p.events, { at, kind: "proof_replaced", proof_version: p.proof_version + 1, reason: null }],
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
      const denied = requirePermission(req, "payments.read");
      if (denied) return denied;
      const status = req.url.searchParams.get("status");
      const type = req.url.searchParams.get("type");
      const q = (req.url.searchParams.get("q") ?? "").trim().toLowerCase();
      const items = [...payments.values()]
        .filter((p) => !status || p.status === status)
        .filter((p) => !type || p.type === type)
        .filter(
          (p) =>
            !q || p.member.full_name.toLowerCase().includes(q) || (p.member.member_number ?? "").includes(q),
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
      const updated: Detail = {
        ...p,
        status: body.decision === "approve" ? "paid" : "rejected",
        version: String(Number(p.version) + 1),
        events: [
          ...p.events,
          { at, kind: body.decision === "approve" ? "approved" : "rejected", reason: reason || null },
        ],
      };
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
        version: String(Number(fees.version) + 1),
        effective_from: new Date().toISOString(),
      };
      return json(200, fees);
    },
  },
];
