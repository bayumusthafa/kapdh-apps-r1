import { describe, expect, it } from "vitest";
import {
  methodSnapshotOf,
  type PaymentMethodRow,
  previousMethodIdsAfterChange,
  readMethodSnapshot,
} from "./payment-rules.js";

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
      qr_image_file_id: null,
    });
  });
});

const QR = "0190a000-0000-7000-8000-0000000000f1";

function methodRow(overrides: Partial<PaymentMethodRow> = {}): PaymentMethodRow {
  const at = new Date("2026-10-15T03:00:00Z");
  return {
    id: A,
    kind: "qris",
    provider: "QRIS",
    accountNumber: "ID1020304050607",
    accountHolder: "KAPDH Pusat",
    instructions: null,
    active: true,
    sortOrder: 0,
    qrImageFileId: QR,
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** Snapshot metode QRIS (ADR-026): gambar QR ikut identitas metode yang disalin ke payment. */
describe("snapshot metode QRIS", () => {
  it("ADR-026: methodSnapshotOf menyalin jenis qris dan id gambar QR; metode lain tanpa gambar", () => {
    expect(methodSnapshotOf(methodRow())).toEqual({
      id: A,
      kind: "qris",
      provider: "QRIS",
      account_number: "ID1020304050607",
      account_holder: "KAPDH Pusat",
      instructions: null,
      qr_image_file_id: QR,
    });
    expect(methodSnapshotOf(methodRow({ kind: "bank", qrImageFileId: null })).qr_image_file_id).toBeNull();
  });

  it("ADR-026: readMethodSnapshot mempertahankan bank/ewallet/qris dan id gambar; jenis tak dikenal menjadi bank", () => {
    const stored = { ...methodSnapshotOf(methodRow()), previous_method_ids: [B] };
    expect(readMethodSnapshot({ methodSnapshot: stored, paymentMethodId: A })).toEqual(
      methodSnapshotOf(methodRow()),
    );
    expect(
      readMethodSnapshot({
        methodSnapshot: { ...stored, kind: "ewallet", qr_image_file_id: null },
        paymentMethodId: A,
      }).kind,
    ).toBe("ewallet");
    // Nilai rusak/asing tidak pernah lolos ke kontrak.
    const odd = readMethodSnapshot({
      methodSnapshot: { id: A, kind: "virtual_account", provider: 7, qr_image_file_id: 42 },
      paymentMethodId: A,
    });
    expect(odd).toMatchObject({ kind: "bank", provider: "", qr_image_file_id: null });
  });

  it("ADR-026: snapshot sebelum QRIS (tanpa qr_image_file_id) tetap terbaca dengan gambar null", () => {
    expect(
      readMethodSnapshot({
        methodSnapshot: {
          id: C,
          kind: "ewallet",
          provider: "GoPay",
          account_number: "0812",
          account_holder: "KAPDH",
          instructions: "Tulis nama",
        },
        paymentMethodId: C,
      }),
    ).toEqual({
      id: C,
      kind: "ewallet",
      provider: "GoPay",
      account_number: "0812",
      account_holder: "KAPDH",
      instructions: "Tulis nama",
      qr_image_file_id: null,
    });
    // Snapshot kosong (data sangat lama) memakai metode tertaut dan nilai aman.
    expect(readMethodSnapshot({ methodSnapshot: null, paymentMethodId: C })).toEqual({
      id: C,
      kind: "bank",
      provider: "",
      account_number: "",
      account_holder: "",
      instructions: null,
      qr_image_file_id: null,
    });
  });
});
