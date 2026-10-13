import { describe, expect, it } from "vitest";
import {
  AUDIT_DOCUMENT_LIMITS,
  AUDIT_LIMITS,
  type AuditLimits,
  isSensitiveAuditKey,
  sanitizeAuditValue,
} from "./sanitize.js";

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

  it("batas khusus: parameter limits menggantikan AUDIT_LIMITS tanpa melonggarkan penyaringan rahasia", () => {
    const custom: AuditLimits = {
      maxDepth: 2,
      maxArrayItems: 2,
      maxStringLength: 5,
      maxObjectKeys: 3,
      maxBytes: 200,
    };
    expect(
      sanitizeAuditValue(
        { text: "abcdefgh", ids: [1, 2, 3], token: "rahasia", nested: { deeper: { v: 1 } } },
        custom,
      ),
    ).toEqual({ text: "abcde…", ids: [1, 2, "[+1 item]"], nested: { deeper: "[terlalu dalam]" } });
    expect(sanitizeAuditValue({ a: "x".repeat(5), b: "y".repeat(5) }, { ...custom, maxBytes: 10 })).toEqual({
      _truncated: true,
      keys: ["a", "b"],
    });
    // Tanpa parameter tetap memakai batas bawaan.
    expect((sanitizeAuditValue({ text: "x".repeat(3000) }) as { text: string }).text).toHaveLength(
      AUDIT_LIMITS.maxStringLength + 1,
    );
  });

  it("F-01: AUDIT_DOCUMENT_LIMITS menyimpan utuh body tayang terburuk (200.000 karakter kontrol, escape 6 byte)", () => {
    // Batas isi hasil sanitasi halaman/berita (CONTENT_BODY_HTML_MAX) dan kasus JSON terburuk.
    const worstBody = "\u0001".repeat(200_000);
    const after = {
      slug: "kebijakan-privasi",
      title: "\u0001".repeat(200),
      body_html: worstBody,
      change_note: "\u0001".repeat(500),
      body_sha256: "a".repeat(64),
    };
    const audited = sanitizeAuditValue(after, AUDIT_DOCUMENT_LIMITS) as typeof after;
    expect(audited.body_html).toBe(worstBody);
    expect(audited).toEqual(after);
    expect(AUDIT_DOCUMENT_LIMITS.maxStringLength).toBeGreaterThanOrEqual(200_000);
    // Penyaringan rahasia tetap berlaku pada batas dokumen.
    expect(sanitizeAuditValue({ body_html: "<p>x</p>", password: "x" }, AUDIT_DOCUMENT_LIMITS)).toEqual({
      body_html: "<p>x</p>",
    });
  });
});
