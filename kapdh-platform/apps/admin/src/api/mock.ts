import type { components } from "@kapdh/contracts";

/**
 * Server tiruan untuk pengembangan UI tanpa backend (`pnpm dev:mock`) dan untuk uji komponen.
 * Data contoh mengikuti prototipe; bukan bukti lulus acceptance criteria (PRD 7.3).
 */
type S = components["schemas"];

const ADMIN_EMAIL = "admin@kapdh.test";
const ADMIN_PASSWORD = "Kapdh#2026";
const TOTP = "123456";
const BACKUP_CODE = "A1B2C3D4E5";

let refreshCookie = false;

/** Untuk uji: kembalikan server tiruan ke keadaan awal (tanpa cookie sesi). */
export function resetMockSession(): void {
  refreshCookie = false;
  mfaPending = false;
}

const method: S["PaymentMethod"] = {
  id: "0199e000-0000-7000-8000-000000000001",
  kind: "bank",
  provider: "[Nama bank 1]",
  account_number: "[Nomor rekening]",
  account_holder: "[Nama pemilik rekening]",
};

function item(
  id: string,
  name: string,
  number: string,
  cohort: number,
  type: S["PaymentType"],
  amount: string,
  submitted: string,
  overdue = false,
): S["AdminPaymentDetail"] {
  return {
    id,
    type,
    status: "pending",
    amount,
    member: { full_name: name, member_number: number, cohort },
    event_title: null,
    submitted_at: submitted,
    proof_version: 1,
    overdue,
    lines:
      type === "registration"
        ? [
            { code: "registration_fee", label: "Register alumni baru", amount: "50000.00" },
            { code: "card_fee", label: "Pembuatan KTA", amount: "10000.00" },
          ]
        : [{ code: "renewal_fee", label: "Perpanjangan KTA", amount: "10000.00" }],
    method,
    proof_file_id: "0199e000-0000-7000-8000-0000000000f1",
    transfer_note: null,
    events: [{ at: submitted, kind: "proof_submitted", proof_version: 1, reason: null }],
    conflict_of_interest: false,
    version: "1",
  };
}

const payments = new Map<string, S["AdminPaymentDetail"]>(
  [
    item(
      "0199e000-0000-7000-8000-0000000000a1",
      "Siti Rahmawati",
      "27.02.02.5",
      27,
      "registration",
      "60000.00",
      "2026-10-11T02:02:00Z",
      true,
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
      "0199e000-0000-7000-8000-0000000000a4",
      "Rizky Pratama",
      "22.03.01.11",
      22,
      "registration",
      "60000.00",
      "2026-10-12T09:02:00Z",
    ),
  ].map((p) => [p.id, p]),
);

let mfaPending = false;

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(
  status: number,
  code: S["ErrorCode"],
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json(status, {
    code,
    message,
    request_id: "mock-" + Math.random().toString(16).slice(2, 10),
    ...extra,
  });
}

export async function mockFetch(request: Request): Promise<Response> {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname.replace(/^\/api\/v1/, "");
  const body = request.method === "GET" ? null : await request.json().catch(() => null);

  if (request.method === "POST" && path === "/admin/auth/login") {
    if (body?.email === ADMIN_EMAIL && body?.password === ADMIN_PASSWORD) {
      mfaPending = true;
      return json(200, {
        mfa_token: "mock-mfa",
        mfa_expires_at: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    return error(401, "UNAUTHENTICATED", "Email atau sandi salah.");
  }
  if (request.method === "POST" && path === "/auth/refresh") {
    // Meniru cookie HttpOnly kapdh_admin_rt: berlaku sampai logout.
    if (!refreshCookie) return error(401, "UNAUTHENTICATED", "Sesi berakhir. Silakan masuk kembali.");
    return json(200, {
      access_token: "mock-access",
      access_expires_at: new Date(Date.now() + 900_000).toISOString(),
    });
  }
  if (request.method === "POST" && path === "/auth/logout") {
    refreshCookie = false;
    return new Response(null, { status: 204 });
  }
  if (request.method === "POST" && path === "/admin/auth/mfa") {
    if (mfaPending && (body?.totp_code === TOTP || body?.backup_code === BACKUP_CODE)) {
      mfaPending = false;
      refreshCookie = true;
      return json(200, {
        access_token: "mock-access",
        access_expires_at: new Date(Date.now() + 900_000).toISOString(),
        idle_timeout_seconds: 1800,
      });
    }
    return error(401, "UNAUTHENTICATED", "Kode autentikator salah.");
  }
  if (request.method === "GET" && path === "/admin/me") {
    if (request.headers.get("Authorization") !== "Bearer mock-access")
      return error(401, "UNAUTHENTICATED", "Sesi berakhir.");
    return json(200, {
      admin_id: "0199e000-0000-7000-8000-0000000000ad",
      display_name: "Bayu Musthafa",
      role: "super_admin",
      permissions: ["payments.read", "payments.decide", "members.read", "settings.manage", "audit.read"],
      permissions_version: 1,
    });
  }
  if (request.method === "GET" && path === "/admin/payments") {
    const status = url.searchParams.get("status") ?? "pending";
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const items = [...payments.values()]
      .filter((p) => p.status === status)
      .filter(
        (p) =>
          !q || p.member.full_name.toLowerCase().includes(q) || (p.member.member_number ?? "").includes(q),
      );
    return json(200, { items, total: items.length, next_cursor: null });
  }
  const detail = path.match(/^\/admin\/payments\/([^/]+)$/);
  if (request.method === "GET" && detail) {
    const p = payments.get(detail[1]!);
    return p ? json(200, p) : error(404, "NOT_FOUND", "Data tidak ditemukan.");
  }
  const decision = path.match(/^\/admin\/payments\/([^/]+)\/decision$/);
  if (request.method === "POST" && decision) {
    const p = payments.get(decision[1]!);
    if (!p) return error(404, "NOT_FOUND", "Data tidak ditemukan.");
    if (p.status !== "pending")
      return error(409, "PAYMENT_STATE_CONFLICT", "Pembayaran sudah diputus admin lain.", { current: p });
    if (body?.expected_proof_version !== p.proof_version)
      return error(409, "PROOF_VERSION_CONFLICT", "Bukti sudah diganti.", { current: p });
    if (body?.decision === "approve" && body?.funds_verified !== true)
      return error(400, "VALIDATION_ERROR", "Konfirmasi dana masuk wajib.", {
        field_errors: { funds_verified: ["Wajib dicentang"] },
      });
    if (body?.decision === "reject" && !String(body?.reason ?? "").trim())
      return error(400, "VALIDATION_ERROR", "Alasan penolakan wajib diisi.", {
        field_errors: { reason: ["Wajib diisi"] },
      });
    const updated: S["AdminPaymentDetail"] = {
      ...p,
      status: body.decision === "approve" ? "paid" : "rejected",
      version: String(Number(p.version) + 1),
      events: [
        ...p.events,
        {
          at: new Date().toISOString(),
          kind: body.decision === "approve" ? "approved" : "rejected",
          reason: body.reason ?? null,
        },
      ],
    };
    payments.set(p.id, updated);
    return json(200, updated);
  }
  return error(404, "NOT_FOUND", "Data tidak ditemukan.");
}

export const MOCK_CREDENTIALS = {
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
  totp: TOTP,
  backupCode: BACKUP_CODE,
};
