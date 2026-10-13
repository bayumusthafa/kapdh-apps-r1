import { describe, expect, it } from "vitest";
import { AUDIT_LIMITS, isSensitiveAuditKey, sanitizeAuditValue } from "./sanitize.js";

describe("penyaring audit (F-17, AC F17-3, ARCHITECTURE §2.3)", () => {
  it.each([
    "password",
    "new_password",
    "passwordHash",
    "password_hash",
    "refresh_token",
    "refreshTokenHash",
    "reauth_token",
    "mfa_token",
    "invite_token_hash",
    "otp",
    "code",
    "code_hmac",
    "totp_secret",
    "secretEncrypted",
    "backup_code",
    "backupCodes",
    "backup_code_hashes",
    "nik",
    "nomor_ktp",
    "refund_destination",
    "bank_account",
    "account_number",
    "push_token",
    "device_token",
    "authorization",
    "private_key",
  ])("kunci %s dibuang", (key) => {
    expect(isSensitiveAuditKey(key)).toBe(true);
  });

  it.each([
    "member_number",
    "status",
    "reason",
    "fee",
    "registration_fee",
    "email_masked",
    "version",
    "role",
    "codex",
  ])("kunci %s dipertahankan", (key) => {
    expect(isSensitiveAuditKey(key)).toBe(false);
  });

  it("membuang rahasia di kedalaman mana pun dan menormalkan tipe", () => {
    const at = new Date("2026-10-13T02:00:00Z");
    expect(
      sanitizeAuditValue({
        status: "paid",
        password: "Rahasia#1",
        nested: { refresh_token: "x", ok: 1, list: [{ otp: "123456", label: "a" }] },
        at,
        big: 10n,
        fn: () => 1,
        missing: undefined,
        nan: Number.NaN,
      }),
    ).toEqual({
      status: "paid",
      nested: { ok: 1, list: [{ label: "a" }] },
      at: "2026-10-13T02:00:00.000Z",
      big: "10",
      nan: null,
    });
    expect(sanitizeAuditValue(undefined)).toBeNull();
    expect(sanitizeAuditValue(null)).toBeNull();
  });

  it("membatasi panjang string, jumlah item, kedalaman, dan ukuran total", () => {
    const long = sanitizeAuditValue({ text: "x".repeat(AUDIT_LIMITS.maxStringLength + 10) }) as {
      text: string;
    };
    expect(long.text.length).toBe(AUDIT_LIMITS.maxStringLength + 1);
    const items = sanitizeAuditValue({ ids: Array.from({ length: 60 }, (_, i) => i) }) as { ids: unknown[] };
    expect(items.ids).toHaveLength(AUDIT_LIMITS.maxArrayItems + 1);
    expect(items.ids.at(-1)).toBe("[+10 item]");
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(sanitizeAuditValue(deep))).toContain("[terlalu dalam]");
    const huge = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "y".repeat(1500)]));
    expect(sanitizeAuditValue(huge)).toEqual({ _truncated: true, keys: Object.keys(huge) });
  });
});
