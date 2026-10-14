import { describe, expect, it } from "vitest";
import type { ApiFailure } from "./api";
import {
  confirmDeletion,
  deletionFacts,
  deletionStatusLabel,
  describeFailure,
  disclosureWarnings,
  isAccountDeletion,
  isOtpChallenge,
  isWebDeletionVerification,
  refundPolicyText,
  resendChallenge,
  retentionSummary,
  startChallenge,
  toVerifyOutcome,
  validateCode,
  validateEmail,
  verifyChallenge,
} from "./delete-account";
import {
  CHALLENGE,
  DELETION,
  DISCLOSURE,
  DISCLOSURE_WITH_WARNINGS,
  VERIFIED_DELETABLE,
  VERIFIED_DISABLED,
  VERIFIED_IN_PROGRESS,
} from "./fixtures";
import { API, fakeFetch, json } from "./testing";

const http = (
  status: number,
  error: Partial<ApiFailure["error"]> | null = null,
  retryAfterSeconds: number | null = null,
): ApiFailure => ({
  ok: false,
  kind: "http",
  status,
  error: error
    ? ({ request_id: "r", message: "pesan server", code: "VALIDATION_ERROR", ...error } as never)
    : null,
  retryAfterSeconds,
});
const network: ApiFailure = { ok: false, kind: "network", status: 0, error: null, retryAfterSeconds: null };
const invalid: ApiFailure = { ok: false, kind: "invalid", status: 200, error: null, retryAfterSeconds: null };

describe("panggilan API alur web (account.yaml)", () => {
  it("challenge -> verify -> confirm memakai path, body dan Idempotency-Key kontrak", async () => {
    const f = fakeFetch({
      "POST /public/deletion/challenge": () => json(202, CHALLENGE),
      "POST /auth/otp/resend": () => json(200, CHALLENGE),
      "POST /public/deletion/verify": () => json(200, VERIFIED_DELETABLE),
      "POST /public/deletion/confirm": () => json(202, DELETION),
    });
    expect((await startChallenge(API, "ahmad@email.com", f.fetcher)).ok).toBe(true);
    expect((await resendChallenge(API, CHALLENGE.challenge_id, f.fetcher)).ok).toBe(true);
    expect((await verifyChallenge(API, CHALLENGE.challenge_id, "123456", f.fetcher)).ok).toBe(true);
    const confirmed = await confirmDeletion(
      API,
      {
        deletionToken: "tok",
        disclosureVersion: "v1-abc",
        idempotencyKey: "0192f6a0-0000-4000-8000-000000000000",
      },
      f.fetcher,
    );
    expect(confirmed).toMatchObject({ ok: true, data: { request_number: "DEL-2026-7K3Q9X" } });
    expect(f.calls.map((c) => c.body)).toEqual([
      { email: "ahmad@email.com" },
      { challenge_id: CHALLENGE.challenge_id },
      { challenge_id: CHALLENGE.challenge_id, code: "123456" },
      { deletion_token: "tok", confirm: true, acknowledged_disclosure_version: "v1-abc" },
    ]);
    expect(f.calls[3]!.headers["idempotency-key"]).toBe("0192f6a0-0000-4000-8000-000000000000");
    // Kode dan token tidak pernah masuk URL (log akses).
    expect(f.calls.every((c) => !c.url.includes("123456") && !c.url.includes("tok"))).toBe(true);
  });
});

describe("guard respons", () => {
  it("OtpChallenge, AccountDeletion, WebDeletionVerification", () => {
    expect(isOtpChallenge(CHALLENGE)).toBe(true);
    expect(isOtpChallenge({ ...CHALLENGE, expires_at: "x" })).toBe(false);
    expect(isAccountDeletion(DELETION)).toBe(true);
    expect(isAccountDeletion({ ...DELETION, status: "deleted" })).toBe(false);
    expect(isWebDeletionVerification(VERIFIED_DELETABLE)).toBe(true);
    expect(isWebDeletionVerification(VERIFIED_IN_PROGRESS)).toBe(true);
    expect(isWebDeletionVerification(VERIFIED_DISABLED)).toBe(true);
    // deletable tanpa token/pengungkapan melanggar kontrak -> tidak dipercaya.
    expect(isWebDeletionVerification({ ...VERIFIED_DELETABLE, deletion_token: null })).toBe(false);
    expect(isWebDeletionVerification({ ...VERIFIED_DELETABLE, disclosure: { version: "x" } })).toBe(false);
    expect(isWebDeletionVerification({ ...VERIFIED_DISABLED, blocked_reason: null })).toBe(false);
  });
});

describe("validasi input", () => {
  it("email dan kode 6 digit", () => {
    expect(validateEmail("  ahmad@email.com ")).toEqual({ email: "ahmad@email.com" });
    expect(validateEmail("")).toEqual({ error: "Masukkan email akun Anda." });
    expect(validateEmail("ahmad@")).toHaveProperty("error");
    expect(validateEmail(`${"a".repeat(250)}@x.id`)).toHaveProperty("error");
    expect(validateCode("123456")).toEqual({ code: "123456" });
    expect(validateCode("12345")).toHaveProperty("error");
    expect(validateCode("12a456")).toHaveProperty("error");
  });
});

describe("pemetaan galat setiap langkah", () => {
  it("jaringan putus dan respons non-JSON: coba lagi, tidak pernah dianggap jawaban", () => {
    expect(describeFailure("challenge", network).action).toBe("retry");
    expect(describeFailure("verify", invalid).action).toBe("retry");
    expect(describeFailure("confirm", network).message).toContain("tidak akan dibuat dua kali");
  });

  it("429: tunggu retry_after_seconds (default 60 detik)", () => {
    expect(describeFailure("challenge", http(429, { code: "RATE_LIMITED" }, 120))).toMatchObject({
      action: "wait",
      retryAfterSeconds: 120,
    });
    expect(describeFailure("resend", http(429, null, null))).toMatchObject({
      action: "wait",
      retryAfterSeconds: 60,
    });
  });

  it("400 kode salah memakai pesan server berisi sisa percobaan", () => {
    const failure = http(400, { field_errors: { code: ["Kode salah. Sisa percobaan 3."] } });
    expect(describeFailure("verify", failure)).toMatchObject({
      action: "fix",
      message: "Kode salah. Sisa percobaan 3.",
    });
    expect(
      describeFailure("challenge", http(400, { field_errors: { email: ["Email tidak valid."] } })),
    ).toMatchObject({
      action: "fix",
      message: "Email tidak valid.",
    });
  });

  it("410: verify -> minta kode baru; resend -> mulai ulang; confirm -> verifikasi ulang", () => {
    expect(describeFailure("verify", http(410, { code: "OTP_EXPIRED" })).action).toBe("resend");
    expect(describeFailure("resend", http(410, { code: "OTP_EXPIRED" })).action).toBe("restart");
    expect(describeFailure("confirm", http(410, { code: "OTP_EXPIRED" })).action).toBe("restart");
  });

  it("409 VERSION_CONFLICT pada konfirmasi membawa pengungkapan terkini dari current", () => {
    const view = describeFailure(
      "confirm",
      http(409, { code: "VERSION_CONFLICT", current: DISCLOSURE_WITH_WARNINGS }),
    );
    expect(view.action).toBe("review");
    expect(view.disclosure?.version).toBe("v2-warn");
    // Body berubah (versi baru) sehingga Idempotency-Key baru wajib.
    expect(view.rotateKey).toBe(true);
    // Pengungkapan terkini tidak terbaca: verifikasi ulang (bukan mengulang versi lama yang pasti bentrok lagi).
    expect(
      describeFailure("confirm", http(409, { code: "VERSION_CONFLICT", current: { x: 1 } })).action,
    ).toBe("restart");
  });

  it("PRD 4.3: 409 IDEMPOTENCY_CONFLICT 'masih diproses' (retry_after_seconds) mempertahankan key; tanpa jeda berarti key bentrok", () => {
    const stillRunning = describeFailure(
      "confirm",
      http(409, { code: "IDEMPOTENCY_CONFLICT", message: "Permintaan yang sama masih diproses." }, 2),
    );
    expect(stillRunning).toMatchObject({ action: "pending", retryAfterSeconds: 2 });
    expect(stillRunning.rotateKey).toBeUndefined();
    expect(stillRunning.message).toContain("tidak akan dibuat dua kali");
    const otherPayload = describeFailure("confirm", http(409, { code: "IDEMPOTENCY_CONFLICT" }));
    expect(otherPayload).toMatchObject({ action: "retry", rotateKey: true });
    // 409 tanpa body Error kontrak (proxy) tidak pernah mengganti key.
    const proxy = describeFailure("confirm", http(409, null));
    expect(proxy.action).toBe("retry");
    expect(proxy.rotateKey).toBeUndefined();
  });

  it("PRD 5.2: perilaku mengikuti kode galat kontrak, bukan status saja", () => {
    // 410 tanpa body OTP_EXPIRED (HTML dari proxy) bukan "kode tidak berlaku".
    expect(describeFailure("verify", http(410, null)).action).toBe("retry");
    // 400 tanpa body VALIDATION_ERROR bukan "kode salah": kode tetap terisi dan sisa percobaan tidak berkurang.
    expect(describeFailure("verify", http(400, null)).action).toBe("retry");
    expect(describeFailure("challenge", http(400, null)).action).toBe("retry");
    // 429 tanpa body (limit_req nginx) tetap jeda.
    expect(describeFailure("verify", http(429, null, 15))).toMatchObject({
      action: "wait",
      retryAfterSeconds: 15,
    });
  });

  it("F-14: pesan konfirmasi menyebut tombol yang benar-benar tampil (pembatalan pendaftaran pending_otp)", () => {
    const label = "Batalkan pendaftaran dan hapus data";
    const cases: ApiFailure[] = [
      network,
      http(409, { code: "IDEMPOTENCY_CONFLICT" }),
      http(409, { code: "IDEMPOTENCY_CONFLICT" }, 2),
      http(429, { code: "RATE_LIMITED" }, 30),
    ];
    for (const failure of cases) {
      const message = describeFailure("confirm", failure, { confirmLabel: label }).message;
      expect(message).toContain(label);
      expect(message).not.toContain("Hapus akun saya");
    }
    expect(describeFailure("confirm", network).message).toContain("Hapus akun saya");
  });

  it("N-11/PRD 4.5: pesan 429 statis menyebut tindakan yang dibatasi dan lama jeda (tanpa hitung mundur)", () => {
    const resend = describeFailure("resend", http(429, { code: "RATE_LIMITED" }, 3000));
    expect(resend.message).toBe(
      "Batas pengiriman kode tercapai. Tombol Kirim ulang kode dapat dipakai lagi dalam 50 menit. Kode yang sudah dikirim tetap dapat dipakai selama masih berlaku.",
    );
    const verify = describeFailure("verify", http(429, { code: "RATE_LIMITED" }, 45));
    expect(verify.message).toBe(
      "Terlalu banyak percobaan verifikasi kode. Tombol Verifikasi dapat dipakai lagi dalam 45 detik.",
    );
    expect(describeFailure("challenge", http(429, null, null)).message).toContain(
      "Tombol Kirim kode verifikasi dapat dipakai lagi dalam 1 menit.",
    );
    for (const m of [resend.message, verify.message]) expect(m).not.toMatch(/\d+:\d\d/);
  });

  it("503 MAINTENANCE dan 5xx tanpa body", () => {
    expect(
      describeFailure("challenge", http(503, { code: "MAINTENANCE", message: "Sedang pemeliharaan." }))
        .message,
    ).toContain("Sedang pemeliharaan.");
    expect(describeFailure("challenge", http(502, null)).message).toContain("Server KAPDH sedang bermasalah");
  });
});

describe("hasil verifikasi (PRD 2.2: challenge terbatas)", () => {
  it("deletable, sedang diproses, dinonaktifkan", () => {
    expect(toVerifyOutcome(VERIFIED_DELETABLE)).toMatchObject({
      kind: "deletable",
      token: VERIFIED_DELETABLE.deletion_token,
    });
    expect(toVerifyOutcome({ ...VERIFIED_DELETABLE, registration_pending: true })).toMatchObject({
      registrationPending: true,
    });
    expect(toVerifyOutcome(VERIFIED_IN_PROGRESS)).toMatchObject({
      kind: "in_progress",
      deletion: { status: "processing" },
    });
    expect(toVerifyOutcome(VERIFIED_DISABLED)).toEqual({ kind: "disabled", emailMasked: "ah***@email.com" });
  });

  it("AC F14-1: status permintaan dengan nomor dan perkiraan selesai", () => {
    expect(deletionStatusLabel("failed")).toBe("Sedang diproses ulang");
    expect(deletionFacts(DELETION)).toEqual([
      { label: "Nomor permintaan", value: "DEL-2026-7K3Q9X" },
      { label: "Status", value: "Menunggu diproses" },
      { label: "Diajukan lewat", value: "Situs kapdh.or.id" },
      { label: "Diajukan", value: "13 Okt 2026, 07.01 WIB" },
      { label: "Selesai paling lambat", value: "20 Oktober 2026" },
    ]);
    expect(
      deletionFacts({ ...DELETION, status: "completed", completed_at: "2026-10-15T00:00:00Z" }).at(-1),
    ).toEqual({
      label: "Selesai",
      value: "15 Okt 2026, 07.00 WIB",
    });
  });
});

describe("pengungkapan D2 dan peringatan refund (N-15, PRD 3.9/4.4)", () => {
  it("tanpa peringatan pribadi bila tidak ada tiket, refund, pembayaran, grup", () => {
    expect(disclosureWarnings(DISCLOSURE)).toEqual([]);
  });

  it("refund belum ditransfer, tiket hangus, pembayaran terbuka, grup, identitas pengurus", () => {
    const warnings = disclosureWarnings(DISCLOSURE_WITH_WARNINGS);
    expect(warnings.map((w) => w.title)).toEqual([
      "Refund belum ditransfer",
      "Tiket aktif akan hangus",
      "Pembayaran terbuka akan dibatalkan",
      "Grup chat yang Anda kelola sendiri",
      "Akun tertaut ke identitas pengurus",
    ]);
    expect(warnings[0]!.lines[0]).toBe(
      "Refund Rp75.000 untuk tiket Camping KAPDH, tenggat bendahara 22 Oktober 2026; rekening tujuan sudah diberikan.",
    );
    expect(warnings[0]!.lines[1]).toContain("tidak menganggap dana sudah dikembalikan");
    expect(warnings[1]!.lines[0]).toContain("Reuni Akbar 2026 (1 Nov 2026, 09.00 WIB, Rp150.000)");
    expect(warnings[1]!.lines[0]).toContain("sebelum 29 Okt 2026, 09.00 WIB");
    expect(warnings[2]!.lines[0]).toBe("Iuran perpanjangan Rp10.000: bukti transfer sudah diunggah.");
    expect(warnings[3]!.lines[0]).toContain("2 grup");
  });

  it("teks kebijakan refund D6 untuk setiap nilai refund_policy", () => {
    const t = DISCLOSURE_WITH_WARNINGS.active_tickets[0]!;
    expect(refundPolicyText({ ...t, event_cancelled: true })).toContain("Event dibatalkan pengurus");
    expect(refundPolicyText({ ...t, refund_policy: "no_refund" })).toContain("tidak mendapat refund");
    expect(refundPolicyText({ ...t, refund_policy: "case_by_case" })).toContain("per kasus");
    expect(refundPolicyText({ ...t, refund_policy: "payment_pending" })).toContain("dibatalkan");
  });

  it("ringkasan retensi memakai nilai dari server", () => {
    const lines = retentionSummary({
      ...DISCLOSURE,
      estimated_completion_days: 5,
      backup_retention_days: 30,
    });
    expect(lines[0]).toContain("5 hari kalender");
    expect(lines[1]).toContain("Tidak ada periode retensi data pribadi");
    expect(lines[2]).toContain("30 hari");
  });
});
