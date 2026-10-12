import { describe, expect, it } from "vitest";
import { parseKtaLocation, toViewState, verify } from "./kta-verify";

describe("parseKtaLocation", () => {
  it("membaca nomor dari path dan token dari fragmen", () => {
    expect(parseKtaLocation("/kta/29.01.01.7", "#t=eyJhbGciOiJIUzI1NiJ9.x.y")).toEqual({
      memberNumber: "29.01.01.7",
      token: "eyJhbGciOiJIUzI1NiJ9.x.y",
    });
  });
  it("menolak nomor dengan format salah", () => {
    expect(parseKtaLocation("/kta/29.01.01.007", "").memberNumber).toBeNull();
  });
});

describe("toViewState", () => {
  it("API tidak terjangkau tidak menjadi Tidak ditemukan (AC F06-4)", () => {
    expect(toViewState(null).kind).toBe("unreachable");
  });
  it("token rusak tidak pernah menampilkan Aktif (AC F06-3)", () => {
    expect(toViewState({ result: "invalid_token", checked_at: "2026-10-12T00:00:00Z" }).kind).toBe("invalid");
  });
});

describe("verify", () => {
  it("mengembalikan null saat jaringan gagal", async () => {
    const failing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await verify("https://api.test/api/v1", "29.01.01.7", "token-panjang-sekali", failing)).toBeNull();
  });
});
