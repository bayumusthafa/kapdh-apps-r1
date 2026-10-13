import { describe, expect, it } from "vitest";
import { addBusinessDaysJakarta } from "./business-days.js";

/** Waktu Asia/Jakarta (UTC+7) sebagai Date UTC. */
const wib = (iso: string) => new Date(`${iso}+07:00`);

describe("Hari kerja Senin-Jumat Asia/Jakarta (kontrak C3 review_due_at, dasbor C7)", () => {
  it.each([
    // [awal (WIB), hari kerja, hasil (WIB)]
    ["2026-10-12T10:00:00", 1, "2026-10-13T10:00:00"], // Senin + 1 = Selasa
    ["2026-10-16T15:00:00", 1, "2026-10-19T15:00:00"], // Jumat + 1 = Senin
    ["2026-10-17T10:00:00", 1, "2026-10-19T10:00:00"], // Sabtu + 1 = Senin
    ["2026-10-18T23:30:00", 1, "2026-10-19T23:30:00"], // Minggu + 1 = Senin
    ["2026-10-15T09:00:00", 2, "2026-10-19T09:00:00"], // Kamis + 2 = Senin
    ["2026-10-12T08:00:00", 5, "2026-10-19T08:00:00"], // Senin + 5 = Senin depan
    ["2026-10-16T08:00:00", 6, "2026-10-26T08:00:00"], // Jumat + 6 = Senin dua pekan
    ["2026-10-14T12:00:00", 0, "2026-10-14T12:00:00"], // + 0 tetap
  ])("%s + %i hari kerja = %s", (start, days, expected) => {
    expect(addBusinessDaysJakarta(wib(start), days).toISOString()).toBe(wib(expected).toISOString());
  });

  it("tengah malam WIB yang masih hari sebelumnya di UTC memakai hari lokal Jakarta", () => {
    // Sabtu 00.30 WIB = Jumat 17.30 UTC; hari kerja dihitung dari Sabtu lokal.
    expect(addBusinessDaysJakarta(wib("2026-10-17T00:30:00"), 1).toISOString()).toBe(
      wib("2026-10-19T00:30:00").toISOString(),
    );
  });

  it("jumlah hari negatif atau pecahan ditolak", () => {
    expect(() => addBusinessDaysJakarta(new Date(), -1)).toThrow();
    expect(() => addBusinessDaysJakarta(new Date(), 1.5)).toThrow();
  });
});
