import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMoney,
  secondsUntil,
  zoneLabel,
} from "./format";

describe("format waktu (ARCHITECTURE §2 butir 6: Asia/Jakarta, WIB)", () => {
  it("tanggal panjang di Asia/Jakarta", () => {
    // 2026-10-12T20:00Z = 13 Oktober 03.00 WIB
    expect(formatDate("2026-10-12T20:00:00Z")).toBe("13 Oktober 2026");
  });

  it("tanggal-jam dengan label zona", () => {
    expect(formatDateTime("2026-10-12T07:05:00Z")).toBe("12 Okt 2026, 14.05 WIB");
    expect(formatDateTime("2026-10-12T07:05:00Z", "Asia/Makassar")).toBe("12 Okt 2026, 15.05 WITA");
    expect(formatDateTime("2026-10-12T07:05:00Z", "Asia/Jayapura")).toBe("12 Okt 2026, 16.05 WIT");
  });

  it("zona tidak dikenal jatuh ke WIB dan tanggal rusak menjadi -", () => {
    expect(formatDateTime("2026-10-12T07:05:00Z", "Bukan/Zona")).toBe("12 Okt 2026, 14.05 WIB");
    expect(formatDate("bukan tanggal")).toBe("-");
    expect(formatDateTime("bukan tanggal")).toBe("-");
    expect(zoneLabel("Europe/Paris")).toBe("Europe/Paris");
  });
});

describe("formatMoney (PRD 6.1, tanpa float)", () => {
  it("Money string menjadi Rp dengan titik ribuan", () => {
    expect(formatMoney("60000.00")).toBe("Rp60.000");
    expect(formatMoney("10000.00")).toBe("Rp10.000");
    expect(formatMoney("0.00")).toBe("Rp0");
    expect(formatMoney("1234567.50")).toBe("Rp1.234.567,50");
    expect(formatMoney("99999999999999.99")).toBe("Rp99.999.999.999.999,99");
  });

  it("nilai yang bukan Money tidak ditampilkan sebagai angka", () => {
    expect(formatMoney("60000")).toBe("-");
    expect(formatMoney("1e5")).toBe("-");
    expect(formatMoney("-5.00")).toBe("-");
  });
});

describe("hitung mundur", () => {
  it("m:ss dan batas atas", () => {
    expect(formatCountdown(42)).toBe("0:42");
    expect(formatCountdown(600)).toBe("10:00");
    expect(formatCountdown(-3)).toBe("0:00");
    expect(formatCountdown(59.2)).toBe("1:00");
    const now = Date.parse("2026-10-13T00:00:00Z");
    expect(secondsUntil("2026-10-13T00:00:30Z", now, 60)).toBe(30);
    expect(secondsUntil("2026-10-13T05:00:00Z", now, 60)).toBe(60);
    expect(secondsUntil("2026-10-12T00:00:00Z", now, 60)).toBe(0);
    expect(secondsUntil("rusak", now, 60)).toBe(0);
  });
});

describe("formatDuration (pesan jeda yang diumumkan sekali, N-11)", () => {
  it("detik, menit, jam dibulatkan ke atas", () => {
    expect(formatDuration(30)).toBe("30 detik");
    expect(formatDuration(0)).toBe("1 detik");
    expect(formatDuration(59.2)).toBe("1 menit");
    expect(formatDuration(60)).toBe("1 menit");
    expect(formatDuration(61)).toBe("2 menit");
    expect(formatDuration(3000)).toBe("50 menit");
    expect(formatDuration(3600)).toBe("1 jam");
  });
});
