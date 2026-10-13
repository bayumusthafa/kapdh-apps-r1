import { describe, expect, it } from "vitest";
import { addBusinessDaysJakarta, dueAtFor, priorityFor } from "./due-at.js";

/** Jam dinding WIB → instant UTC (WIB = UTC+7). */
const wib = (iso: string) => new Date(new Date(`${iso}Z`).getTime() - 7 * 3600_000);

describe("Target penanganan laporan (PRD 3.12 v3.2: urgent 24 jam, lainnya 2 hari kerja WIB)", () => {
  it("AC F12-2: violence_threat urgent; kategori lain dan banding normal", () => {
    expect(priorityFor("violence_threat")).toBe("urgent");
    for (const category of ["spam", "harassment", "hate", "sexual", "scam", "other", "appeal"])
      expect(priorityFor(category)).toBe("normal");
  });

  it("urgent = 24 jam kalender, termasuk akhir pekan", () => {
    const saturday = wib("2026-10-17T10:00:00");
    expect(dueAtFor("urgent", saturday)).toEqual(wib("2026-10-18T10:00:00"));
  });

  it("2 hari kerja dari hari kerja: jam dinding sama, akhir pekan dilewati", () => {
    // Selasa 13 Okt 2026 09:00 WIB → Kamis 09:00.
    expect(dueAtFor("normal", wib("2026-10-13T09:00:00"))).toEqual(wib("2026-10-15T09:00:00"));
    // Jumat 10:00 → Selasa 10:00.
    expect(addBusinessDaysJakarta(wib("2026-10-16T10:00:00"), 2)).toEqual(wib("2026-10-20T10:00:00"));
    // Kamis 23:30 WIB (= Kamis 16:30 UTC) → Senin 23:30 WIB; hari dihitung menurut WIB, bukan UTC.
    expect(addBusinessDaysJakarta(wib("2026-10-15T23:30:00"), 2)).toEqual(wib("2026-10-19T23:30:00"));
  });

  it("laporan akhir pekan mulai dihitung Senin 00:00 WIB (berakhir Selasa 24:00)", () => {
    expect(addBusinessDaysJakarta(wib("2026-10-17T10:00:00"), 2)).toEqual(wib("2026-10-21T00:00:00"));
    expect(addBusinessDaysJakarta(wib("2026-10-18T23:59:00"), 2)).toEqual(wib("2026-10-21T00:00:00"));
  });

  it("menolak jumlah hari tidak valid", () => {
    expect(() => addBusinessDaysJakarta(new Date(), -1)).toThrow();
    expect(() => addBusinessDaysJakarta(new Date(), 1.5)).toThrow();
  });
});
