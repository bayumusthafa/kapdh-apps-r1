import { describe, expect, it } from "vitest";
import { containsSecretKeys } from "./idempotent.js";

/**
 * Pemeriksaan rahasia respons @Idempotent (ARCHITECTURE §2.3): kunci sensitif tidak pernah disimpan untuk replay,
 * kecuali path yang dinyatakan bukan rahasia (`publicResponsePaths`). Kunci sensitif bernilai null hanya dianggap
 * kosong untuk body hasil penyaring `storedBody` (`ignoreNullValues`); tanpa opsi perilakunya sama dengan semula.
 */
describe("containsSecretKeys", () => {
  it("ARCHITECTURE §2.3: token, kode dan rekening refund di kedalaman mana pun terdeteksi", () => {
    expect(containsSecretKeys({ session: { access_token: "x" } })).toBe(true);
    expect(containsSecretKeys({ items: [{ refund_destination: { provider: "BCA" } }] })).toBe(true);
    expect(containsSecretKeys({ lines: [{ code: "registration_fee" }] })).toBe(true);
  });

  it("ARCHITECTURE §2.3: tanpa opsi, kunci sensitif bernilai null tetap dihitung (perilaku core semula)", () => {
    expect(containsSecretKeys({ refund_destination: null, has_refund_destination: true })).toBe(true);
    expect(containsSecretKeys({ session: { access_token: null } })).toBe(true);
  });

  it("D2: ignoreNullValues (body hasil storedBody) mengabaikan kunci sensitif bernilai null saja", () => {
    const options = { ignoreNullValues: true };
    expect(containsSecretKeys({ refund_destination: null, has_refund_destination: true }, options)).toBe(
      false,
    );
    expect(containsSecretKeys({ adjustments: [{ refund_destination: null }] }, options)).toBe(false);
    expect(containsSecretKeys({ adjustments: [{ refund_destination: { provider: "BRI" } }] }, options)).toBe(
      true,
    );
  });

  it("D13: path publik (rekening organisasi, kode baris) dikecualikan; kunci sensitif di luar path tetap terdeteksi", () => {
    const publicPaths = ["method.account_number", "lines.*.code"];
    const body = {
      method: { account_number: "7000123456" },
      lines: [{ code: "registration_fee" }, { code: "card_fee" }],
    };
    expect(containsSecretKeys(body, { publicPaths })).toBe(false);
    expect(containsSecretKeys({ ...body, account_number: "1" }, { publicPaths })).toBe(true);
    expect(containsSecretKeys({ method: { account_number: "1", token: "t" } }, { publicPaths })).toBe(true);
  });
});
