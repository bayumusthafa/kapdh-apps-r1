import { describe, expect, it } from "vitest";
import { checkPassword, utf8ByteLength } from "./password.js";

describe("checkPassword", () => {
  it("menerima sandi yang memenuhi semua aturan", () => {
    expect(checkPassword("Kapdh#2026").valid).toBe(true);
  });
  it("menghitung byte UTF-8, bukan karakter", () => {
    expect(utf8ByteLength("é")).toBe(2);
    const seventyOneAsciiPlusMultibyte = "Aa1!" + "a".repeat(67) + "é"; // 72 karakter, 73 byte
    expect(checkPassword(seventyOneAsciiPlusMultibyte).lengthOk).toBe(false);
  });
  it("menolak sandi tanpa simbol", () => {
    expect(checkPassword("Kapdh2026").valid).toBe(false);
  });
});
