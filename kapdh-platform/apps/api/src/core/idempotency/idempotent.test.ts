import { describe, expect, it } from "vitest";
import { containsSecretKeys } from "./idempotent.js";

/**
 * Pemeriksaan rahasia respons @Idempotent (ARCHITECTURE §2.3): kunci sensitif bernilai tidak pernah disimpan untuk
 * replay, kecuali path yang dinyatakan bukan rahasia (`publicResponsePaths`), dan kunci sensitif bernilai null tidak
 * memuat data.
 */
describe("containsSecretKeys", () => {
  it("ARCHITECTURE §2.3: token, kode dan rekening refund bernilai di kedalaman mana pun terdeteksi", () => {
    expect(containsSecretKeys({ session: { access_token: "x" } })).toBe(true);
    expect(containsSecretKeys({ items: [{ refund_destination: { provider: "BCA" } }] })).toBe(true);
    expect(containsSecretKeys({ lines: [{ code: "registration_fee" }] })).toBe(true);
  });

  it("ARCHITECTURE §2.3: kunci sensitif bernilai null/undefined tidak dihitung", () => {
    expect(containsSecretKeys({ refund_destination: null, has_refund_destination: true })).toBe(false);
    expect(containsSecretKeys({ adjustments: [{ refund_destination: null }] })).toBe(false);
  });

  it("D13: path publik (rekening organisasi, kode baris) dikecualikan; kunci sensitif di luar path tetap terdeteksi", () => {
    const publicPaths = ["method.account_number", "lines.*.code"];
    const body = {
      method: { account_number: "7000123456" },
      lines: [{ code: "registration_fee" }, { code: "card_fee" }],
    };
    expect(containsSecretKeys(body, 0, publicPaths)).toBe(false);
    expect(containsSecretKeys({ ...body, account_number: "1" }, 0, publicPaths)).toBe(true);
    expect(containsSecretKeys({ method: { account_number: "1", token: "t" } }, 0, publicPaths)).toBe(true);
  });
});
