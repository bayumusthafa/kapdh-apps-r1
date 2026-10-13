import { describe, expect, it } from "vitest";
import { previousMethodIdsAfterChange, readMethodSnapshot } from "./payment-rules.js";

const A = "0190a000-0000-7000-8000-00000000000a";
const B = "0190a000-0000-7000-8000-00000000000b";
const C = "0190a000-0000-7000-8000-00000000000c";

/** Rujukan metode yang permanen untuk AdminPaymentMethod.in_use "pernah dirujuk payment" (AC F15-3, PRD 4.3). */
describe("previousMethodIdsAfterChange", () => {
  it("AC F15-3: ganti rekening menambahkan metode yang berlaku ke daftar sebelumnya, tanpa duplikat", () => {
    expect(previousMethodIdsAfterChange({ methodSnapshot: { id: A }, paymentMethodId: A })).toEqual([A]);
    expect(
      previousMethodIdsAfterChange({
        methodSnapshot: { id: B, previous_method_ids: [A] },
        paymentMethodId: B,
      }),
    ).toEqual([A, B]);
    // A → B → A → B: tetap [A, B].
    expect(
      previousMethodIdsAfterChange({
        methodSnapshot: { id: A, previous_method_ids: [A, B] },
        paymentMethodId: A,
      }),
    ).toEqual([A, B]);
  });

  it("AC F15-3: snapshot lama tanpa id memakai metode tertaut; tautan kosong (metode dihapus) tetap memakai id snapshot", () => {
    expect(previousMethodIdsAfterChange({ methodSnapshot: {}, paymentMethodId: C })).toEqual([C]);
    expect(previousMethodIdsAfterChange({ methodSnapshot: { id: A }, paymentMethodId: null })).toEqual([A]);
    expect(
      previousMethodIdsAfterChange({
        methodSnapshot: { id: A, previous_method_ids: "rusak" },
        paymentMethodId: A,
      }),
    ).toEqual([A]);
  });

  it("D13: daftar rujukan lama tidak pernah ikut dalam snapshot kontrak", () => {
    const method = readMethodSnapshot({
      methodSnapshot: {
        id: B,
        kind: "bank",
        provider: "BSI",
        account_number: "7000123456",
        account_holder: "KAPDH",
        instructions: null,
        previous_method_ids: [A],
      },
      paymentMethodId: B,
    });
    expect(method).toEqual({
      id: B,
      kind: "bank",
      provider: "BSI",
      account_number: "7000123456",
      account_holder: "KAPDH",
      instructions: null,
    });
  });
});
