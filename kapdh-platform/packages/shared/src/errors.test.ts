import { ERROR_CODE_VALUES } from "@kapdh/contracts";
import { describe, expect, it } from "vitest";
import { CLIENT_ERROR_UI, ERROR_UI, ERROR_UI_ACTIONS, errorUiFor, isErrorCode } from "./errors.js";

describe("katalog galat ERROR_UI (PRD 5.2, ARCHITECTURE §4.4)", () => {
  it("memuat tepat semua ErrorCode kontrak (21 kode)", () => {
    expect(ERROR_CODE_VALUES).toHaveLength(21);
    expect(Object.keys(ERROR_UI).sort()).toEqual([...ERROR_CODE_VALUES].sort());
  });

  it("setiap aksi terdaftar dipakai dan setiap entri memakai aksi terdaftar", () => {
    const used = new Set(
      [...Object.values(ERROR_UI), ...Object.values(CLIENT_ERROR_UI)].map((u) => u.action),
    );
    expect([...used].sort()).toEqual([...ERROR_UI_ACTIONS].sort());
  });

  it("setiap entri memiliki pesan cadangan berbahasa Indonesia yang tidak kosong", () => {
    for (const ui of [...Object.values(ERROR_UI), ...Object.values(CLIENT_ERROR_UI)]) {
      expect(ui.fallbackMessage.trim().length).toBeGreaterThan(5);
    }
  });

  it("MEMBERSHIP_REQUIRED memuat ulang status lalu mengarahkan sesuai effective_status, bukan selalu perpanjangan (PRD 2.2)", () => {
    expect(ERROR_UI.MEMBERSHIP_REQUIRED.action).toBe("refresh_status");
  });

  it("kode baru ARCHITECTURE §4.4 memiliki aksi khusus", () => {
    expect(ERROR_UI.REAUTH_REQUIRED.action).toBe("reauthenticate");
    expect(ERROR_UI.UPGRADE_REQUIRED.action).toBe("force_update");
    expect(ERROR_UI.NOT_FOUND.action).toBe("show_not_found");
    expect(ERROR_UI.ACCOUNT_SUSPENDED.action).toBe("go_to_restricted");
  });

  it("konflik versi dan keadaan menawarkan muat ulang data terbaru (PRD 4.5)", () => {
    for (const code of [
      "VERSION_CONFLICT",
      "PAYMENT_STATE_CONFLICT",
      "PROOF_VERSION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
    ] as const) {
      expect(ERROR_UI[code].action).toBe("reload_latest");
    }
  });

  it("kode yang belum dikenal jatuh ke UNKNOWN dan jaringan putus bukan 'tidak ditemukan' (PRD 4.5)", () => {
    expect(isErrorCode("VALIDATION_ERROR")).toBe(true);
    expect(isErrorCode("KODE_MASA_DEPAN")).toBe(false);
    expect(isErrorCode("toString")).toBe(false);
    expect(errorUiFor("KODE_MASA_DEPAN")).toBe(CLIENT_ERROR_UI.UNKNOWN);
    expect(errorUiFor("RATE_LIMITED").action).toBe("show_countdown");
    expect(CLIENT_ERROR_UI.NETWORK.action).toBe("show_offline");
  });
});
