import { describe, expect, it } from "vitest";
import { addCalendarMonthsJakarta, isExpiring, registrationPeriod, renewalPeriod } from "./period.js";
import { effectiveStatus } from "./effective-status.js";

// Waktu ditulis dalam WIB (+07:00) agar mudah dibaca.
const wib = (s: string) => new Date(`${s}+07:00`);

describe("addCalendarMonthsJakarta", () => {
  it("menambah 12 bulan kalender dengan jam yang sama", () => {
    expect(addCalendarMonthsJakarta(wib("2026-10-13T09:15:00"), 12)).toEqual(wib("2027-10-13T09:15:00"));
  });
  it("29 Februari menjadi 28 Februari pada tahun bukan kabisat", () => {
    expect(addCalendarMonthsJakarta(wib("2028-02-29T10:00:00"), 12)).toEqual(wib("2029-02-28T10:00:00"));
  });
  it("31 Januari + 1 bulan menjadi hari terakhir Februari", () => {
    expect(addCalendarMonthsJakarta(wib("2027-01-31T08:00:00"), 1)).toEqual(wib("2027-02-28T08:00:00"));
  });
  it("memakai tanggal Jakarta, bukan UTC, di dekat tengah malam", () => {
    // 1 Maret 00.30 WIB = 28 Februari 17.30 UTC
    expect(addCalendarMonthsJakarta(wib("2027-03-01T00:30:00"), 12)).toEqual(wib("2028-03-01T00:30:00"));
  });
});

describe("periode keanggotaan F-07", () => {
  it("registration dimulai dari approved_at", () => {
    const p = registrationPeriod(wib("2026-10-13T09:00:00"));
    expect(p.expiresAt).toEqual(wib("2027-10-13T09:00:00"));
  });
  it("renewal sebelum habis tidak menghilangkan sisa masa aktif (AC F07-1)", () => {
    const p = renewalPeriod(wib("2027-10-13T09:00:00"), wib("2027-09-20T10:00:00"));
    expect(p.startsAt).toEqual(wib("2027-10-13T09:00:00"));
    expect(p.expiresAt).toEqual(wib("2028-10-13T09:00:00"));
  });
  it("renewal setelah expired dihitung dari approved_at (AC F07-2)", () => {
    const p = renewalPeriod(wib("2027-10-13T09:00:00"), wib("2027-12-01T14:00:00"));
    expect(p.expiresAt).toEqual(wib("2028-12-01T14:00:00"));
  });
  it("expiring hanya bila sisa <= 30 hari dan > 0", () => {
    const exp = wib("2027-10-13T09:00:00");
    expect(isExpiring(exp, wib("2027-09-13T09:00:00"))).toBe(true);
    expect(isExpiring(exp, wib("2027-09-13T08:59:59"))).toBe(false);
    expect(isExpiring(exp, exp)).toBe(false);
  });
});

describe("effectiveStatus", () => {
  const exp = wib("2027-10-13T09:00:00");
  const active = { accountStatus: "active" as const, expiresAt: exp, suspendedAt: null };
  it("verified sebelum jendela expiring", () => {
    expect(effectiveStatus(active, wib("2027-01-01T00:00:00"))).toBe("verified");
  });
  it("expired tepat saat now >= expires_at tanpa menunggu worker (AC F07-3)", () => {
    expect(effectiveStatus(active, exp)).toBe("expired");
  });
  it("suspend mengalahkan masa aktif (AC F07-4)", () => {
    expect(
      effectiveStatus({ ...active, suspendedAt: wib("2027-01-01T00:00:00") }, wib("2027-02-01T00:00:00")),
    ).toBe("suspended");
  });
  it("unsuspend menghitung ulang dari expires_at, bukan otomatis verified (AC F12-5)", () => {
    expect(effectiveStatus({ ...active, suspendedAt: null }, wib("2027-11-01T00:00:00"))).toBe("expired");
  });
  it("akun aktif tanpa periode adalah unverified", () => {
    expect(effectiveStatus({ accountStatus: "active", expiresAt: null, suspendedAt: null }, new Date())).toBe(
      "unverified",
    );
  });
});
