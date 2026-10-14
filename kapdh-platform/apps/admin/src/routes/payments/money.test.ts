import { describe, expect, it } from "vitest";
import { addMoney, compareMoney, fromCents, subtractMoney, sumMoney, toCents } from "./money";
import { refundableRemaining } from "./CreateAdjustmentDialog";

describe("aritmetika Money tanpa floating point (ARCHITECTURE §2 butir 5)", () => {
  it("mengubah Money ke sen dan kembali tanpa kehilangan presisi", () => {
    expect(toCents("60000.00")).toBe(6_000_000n);
    expect(toCents("999999999999.99")).toBe(99_999_999_999_999n);
    expect(fromCents(99_999_999_999_999n)).toBe("999999999999.99");
    expect(fromCents(5n)).toBe("0.05");
    expect(fromCents(-150n)).toBe("-1.50");
    expect(toCents("60000")).toBeNull();
    expect(toCents("abc")).toBeNull();
  });

  it("D4: total pendaftaran = register + KTA, termasuk pecahan sen yang rawan floating point", () => {
    expect(addMoney("50000.00", "10000.00")).toBe("60000.00");
    expect(addMoney("0.10", "0.20")).toBe("0.30");
    expect(addMoney("999999999999.98", "0.01")).toBe("999999999999.99");
    expect(addMoney("50000.00", "x")).toBeNull();
  });

  it("selisih, perbandingan dan jumlah", () => {
    expect(subtractMoney("75000.00", "75000.00")).toBe("0.00");
    expect(subtractMoney("10000.00", "15000.00")).toBe("-5000.00");
    expect(compareMoney("10000.00", "9999.99")).toBe(1);
    expect(compareMoney("0.00", "0.00")).toBe(0);
    expect(compareMoney("1.00", "1.01")).toBe(-1);
    expect(compareMoney("1", "1.00")).toBeNull();
    expect(sumMoney(["0.10", "0.20", "0.30"])).toBe("0.60");
    expect(sumMoney([])).toBe("0.00");
  });

  it("D6: sisa refund = nominal dikurangi refund pending dan selesai; refund batal dan koreksi tidak dihitung", () => {
    const adjustment = (
      kind: "refund" | "correction",
      status: "pending" | "completed" | "cancelled",
      amount: string,
    ) => ({ kind, status, amount }) as Parameters<typeof refundableRemaining>[0]["adjustments"][number];
    expect(
      refundableRemaining({
        amount: "75000.00",
        adjustments: [
          adjustment("refund", "completed", "25000.00"),
          adjustment("refund", "pending", "10000.00"),
          adjustment("refund", "cancelled", "75000.00"),
          adjustment("correction", "pending", "5000.00"),
        ],
      }),
    ).toBe("40000.00");
    expect(refundableRemaining({ amount: "10000.00", adjustments: [] })).toBe("10000.00");
  });
});
