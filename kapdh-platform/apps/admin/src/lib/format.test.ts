import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatRelativeAge,
  formatRupiah,
  formatRupiahInput,
  formatShortDateTime,
  fromZonedInputValue,
  parseRupiahInput,
  toZonedInputValue,
  zoneLabel,
} from "./format";
import { moneySchema } from "./validation";

describe("format Rupiah dari string desimal (ARCHITECTURE §2.5)", () => {
  it.each([
    ["60000.00", "Rp60.000"],
    ["10000.00", "Rp10.000"],
    ["0.00", "Rp0"],
    ["1234567.50", "Rp1.234.567,50"],
    ["999999999999.99", "Rp999.999.999.999,99"],
    ["75000", "Rp75.000"],
  ])("%s → %s", (input, expected) => {
    expect(formatRupiah(input)).toBe(expected);
  });

  it("nilai tidak valid atau kosong ditampilkan sebagai '-'", () => {
    expect(formatRupiah(null)).toBe("-");
    expect(formatRupiah("abc")).toBe("-");
    expect(formatRupiah("1e5")).toBe("-");
  });

  it("isian pengguna diurai tanpa floating point", () => {
    expect(parseRupiahInput("60.000")).toBe("60000.00");
    expect(parseRupiahInput("Rp 60.000,5")).toBe("60000.50");
    expect(parseRupiahInput("60000")).toBe("60000.00");
    expect(parseRupiahInput("0,1")).toBe("0.10");
    expect(parseRupiahInput("")).toBeNull();
    expect(parseRupiahInput("60.00")).toBeNull();
    expect(parseRupiahInput("-5")).toBeNull();
    expect(parseRupiahInput("1234567890123")).toBeNull();
    expect(formatRupiahInput("60000.50")).toBe("60.000,50");
  });

  it("moneySchema menerima Money valid dan menolak teks mentah", () => {
    expect(moneySchema.safeParse("60000.00").success).toBe(true);
    expect(moneySchema.safeParse("60.000").success).toBe(false);
    expect(moneySchema.safeParse("").success).toBe(false);
  });
});

describe("format waktu WIB (ARCHITECTURE §2.6)", () => {
  it("UTC ditampilkan dalam Asia/Jakarta dengan akhiran WIB", () => {
    expect(formatDateTime("2026-10-12T07:20:00Z")).toBe("12 Okt 2026, 14.20 WIB");
    expect(formatDate("2026-10-11T18:00:00Z")).toBe("12 Okt 2026");
    expect(formatShortDateTime("2026-10-11T02:02:00Z")).toBe("11 Okt, 09.02");
    expect(formatDateTime(null)).toBe("-");
  });

  it("zona event sendiri (WITA/WIT) dapat ditampilkan", () => {
    expect(formatDateTime("2026-10-12T07:20:00Z", "Asia/Makassar")).toBe("12 Okt 2026, 15.20 WITA");
    expect(zoneLabel("Asia/Jayapura")).toBe("WIT");
  });

  it("isian datetime-local jam dinding WIB ↔ ISO UTC", () => {
    expect(fromZonedInputValue("2026-10-12T14:20")).toBe("2026-10-12T07:20:00.000Z");
    expect(toZonedInputValue("2026-10-12T07:20:00.000Z")).toBe("2026-10-12T14:20");
    expect(fromZonedInputValue("")).toBeNull();
  });

  it("usia antrean ringkas seperti prototipe screen_8", () => {
    const now = new Date("2026-10-12T10:00:00Z");
    expect(formatRelativeAge("2026-10-12T09:59:30Z", now)).toBe("baru saja");
    expect(formatRelativeAge("2026-10-12T09:46:00Z", now)).toBe("14 menit");
    expect(formatRelativeAge("2026-10-12T08:00:00Z", now)).toBe("2 jam");
    expect(formatRelativeAge("2026-10-09T10:00:00Z", now)).toBe("3 hari");
  });
});
