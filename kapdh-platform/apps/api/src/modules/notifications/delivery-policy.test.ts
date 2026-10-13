import { describe, expect, it } from "vitest";
import {
  classifyMailError,
  classifyPushResult,
  decideDelivery,
  DELIVERY_BACKOFF_MAX_MS,
  DELIVERY_MAX_ATTEMPTS,
  deliveryBackoffMs,
  lockScreenText,
} from "./delivery-policy.js";
import { channelEnabled, hasEmailChannel } from "./channel-policy.js";

const NOW = new Date("2026-10-13T02:00:00.000Z");
const MINUTE = 60_000;

describe("Jadwal backoff pengiriman (AC F13-4, R5)", () => {
  it("AC F13-4: eksponensial 1, 2, 4, 8, 16 menit … maksimal 1 jam", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => deliveryBackoffMs(attempt) / MINUTE)).toEqual([
      1, 2, 4, 8, 16, 32, 60, 60,
    ]);
    expect(deliveryBackoffMs(50)).toBe(DELIVERY_BACKOFF_MAX_MS);
  });

  it("AC F13-4: Retry-After provider dihormati bila lebih lama, tetap dibatasi 1 jam", () => {
    expect(deliveryBackoffMs(1, 600)).toBe(600_000);
    expect(deliveryBackoffMs(4, 30)).toBe(8 * MINUTE);
    expect(deliveryBackoffMs(1, 86_400)).toBe(DELIVERY_BACKOFF_MAX_MS);
    expect(deliveryBackoffMs(1, Number.NaN)).toBe(MINUTE);
  });

  it("AC F13-4: gangguan sementara dijadwalkan ulang sampai batas percobaan, lalu failed tanpa mencabut token", () => {
    for (let attempt = 1; attempt < DELIVERY_MAX_ATTEMPTS; attempt++)
      expect(decideDelivery({ kind: "retry", errorClass: "UNAVAILABLE" }, attempt, NOW)).toEqual({
        status: "pending",
        errorClass: "UNAVAILABLE",
        nextRetryAt: new Date(NOW.getTime() + deliveryBackoffMs(attempt)),
      });
    expect(decideDelivery({ kind: "retry", errorClass: "UNAVAILABLE" }, DELIVERY_MAX_ATTEMPTS, NOW)).toEqual({
      status: "failed",
      errorClass: "UNAVAILABLE",
      revokeToken: false,
    });
    expect(
      decideDelivery({ kind: "failed", errorClass: "UNREGISTERED", revokeToken: true }, 1, NOW),
    ).toEqual({ status: "failed", errorClass: "UNREGISTERED", revokeToken: true });
    expect(decideDelivery({ kind: "sent", providerMessageId: "m-1" }, 3, NOW)).toEqual({
      status: "sent",
      providerMessageId: "m-1",
    });
  });
});

describe("Klasifikasi galat FCM (AC F13-4, R5)", () => {
  it.each([
    ["unregistered", false, true, "UNREGISTERED", "failed", true],
    ["invalid_argument", false, true, "INVALID_ARGUMENT", "failed", true],
    ["invalid_argument", false, false, "INVALID_ARGUMENT", "failed", false],
    ["sender_mismatch", false, true, "SENDER_ID_MISMATCH", "failed", true],
    ["quota_exceeded", true, false, "QUOTA_EXCEEDED", "retry", false],
    ["unavailable", true, false, "UNAVAILABLE", "retry", false],
    ["internal", true, false, "INTERNAL", "retry", false],
    ["network", true, false, "NETWORK", "retry", false],
    ["auth_error", false, false, "AUTH_ERROR", "failed", false],
  ] as const)(
    "AC F13-4: %s (retryable=%s, nonaktifkan=%s) → %s / %s",
    (errorClass, retryable, deactivateToken, expectedClass, kind, revoke) => {
      const outcome = classifyPushResult({ ok: false, errorClass, retryable, deactivateToken });
      expect(outcome.kind).toBe(kind);
      expect("errorClass" in outcome ? outcome.errorClass : null).toBe(expectedClass);
      if (outcome.kind === "failed") expect(outcome.revokeToken).toBe(revoke);
    },
  );

  it("AC F13-4: Retry-After 429 diteruskan; sukses membawa id pesan provider (accepted ≠ dibaca)", () => {
    expect(
      classifyPushResult({
        ok: false,
        errorClass: "quota_exceeded",
        retryable: true,
        deactivateToken: false,
        retryAfterSeconds: 120,
      }),
    ).toEqual({ kind: "retry", errorClass: "QUOTA_EXCEEDED", retryAfterSeconds: 120 });
    expect(classifyPushResult({ ok: true, messageId: "projects/x/messages/1" })).toEqual({
      kind: "sent",
      providerMessageId: "projects/x/messages/1",
    });
  });
});

describe("Klasifikasi galat SMTP (F-13)", () => {
  it.each([
    [{ responseCode: 550 }, "failed", "bounce_hard"],
    [{ responseCode: 553 }, "failed", "bounce_hard"],
    [{ responseCode: 554 }, "failed", "rejected"],
    [{ responseCode: 552 }, "retry", "bounce_soft"],
    [{ responseCode: 421 }, "retry", "bounce_soft"],
    [{ code: "ETIMEDOUT" }, "retry", "timeout"],
    [{ code: "ECONNECTION" }, "retry", "network"],
    [{ code: "ESOCKET" }, "retry", "network"],
    [{ code: "EAUTH" }, "retry", "auth_error"],
    [{ code: "EENVELOPE" }, "failed", "rejected"],
    [new Error("tak dikenal"), "failed", "unknown"],
    [null, "failed", "unknown"],
  ] as const)("%j → %s %s", (error, kind, errorClass) => {
    const outcome = classifyMailError(error);
    expect(outcome.kind).toBe(kind);
    expect("errorClass" in outcome ? outcome.errorClass : null).toBe(errorClass);
  });
});

describe("Teks layar kunci (F-13: tanpa kontak; isi ringkas)", () => {
  it("menyamarkan email dan nomor telepon, merapikan spasi, membatasi panjang", () => {
    expect(lockScreenText("Hubungi budi@contoh.test atau 0812-3456-7890 sekarang", 200)).toBe(
      "Hubungi [disembunyikan] atau [disembunyikan] sekarang",
    );
    expect(lockScreenText("+62 812 3456 7890 dan 6281234567890", 200)).toBe(
      "[disembunyikan] dan [disembunyikan]",
    );
    expect(lockScreenText("  Pembayaran   Rp60.000 disetujui  ", 200)).toBe("Pembayaran Rp60.000 disetujui");
    expect(lockScreenText("Nomor anggota 29.01.1.123 aktif", 200)).toBe("Nomor anggota 29.01.1.123 aktif");
    const long = lockScreenText("a".repeat(300), 240);
    expect(long).toHaveLength(240);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("Kebijakan kanal per kategori (ARCHITECTURE §4.7, AC F13-2)", () => {
  it("security/account wajib; email hanya payment/membership/event + wajib; baris tidak ada = aktif", () => {
    expect(channelEnabled("security", "push", false)).toBe(true);
    expect(channelEnabled("account", "email", false)).toBe(true);
    expect(channelEnabled("payment", "push", undefined)).toBe(true);
    expect(channelEnabled("payment", "push", false)).toBe(false);
    expect(channelEnabled("news", "email", true)).toBe(false);
    expect(channelEnabled("chat", "email", undefined)).toBe(false);
    expect(channelEnabled("event", "email", null)).toBe(true);
    expect(["payment", "membership", "event", "security", "account"].every((c) => hasEmailChannel(c as never))).toBe(
      true,
    );
    expect(hasEmailChannel("news") || hasEmailChannel("chat")).toBe(false);
  });
});
