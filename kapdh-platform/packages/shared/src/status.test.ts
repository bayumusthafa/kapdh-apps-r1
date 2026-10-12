import { EFFECTIVE_STATUS_VALUES } from "@kapdh/contracts";
import { describe, expect, it } from "vitest";
import {
  MEMBER_ROUTE_PATH,
  MEMBER_ROUTES,
  MEMBERSHIP_LABEL,
  MEMBERSHIP_LABEL_UNKNOWN,
  membershipLabelFor,
  routeForStatus,
} from "./status.js";

describe("routeForStatus (PRD 2.2)", () => {
  it("memetakan setiap status ke rute awal", () => {
    expect(routeForStatus("pending_otp")).toBe("verify_otp");
    expect(routeForStatus("unverified")).toBe("onboarding_payment");
    expect(routeForStatus("verified")).toBe("home");
    expect(routeForStatus("expiring")).toBe("home");
    expect(routeForStatus("expired")).toBe("renewal");
    expect(routeForStatus("suspended")).toBe("restricted");
    expect(routeForStatus("disabled")).toBe("deletion_status");
    expect(routeForStatus("deletion_pending")).toBe("deletion_status");
  });

  it("mencakup semua EffectiveStatus kontrak dan hanya menghasilkan rute terdaftar", () => {
    for (const status of EFFECTIVE_STATUS_VALUES) {
      expect(MEMBER_ROUTES).toContain(routeForStatus(status));
    }
  });

  it("setiap rute memiliki path go_router aplikasi (ARCHITECTURE §8.4)", () => {
    expect(Object.keys(MEMBER_ROUTE_PATH).sort()).toEqual([...MEMBER_ROUTES].sort());
    for (const path of Object.values(MEMBER_ROUTE_PATH)) expect(path).toMatch(/^\/[a-z/-]+$/);
  });
});

describe("MEMBERSHIP_LABEL (PRD 4.5: status tidak dengan warna saja)", () => {
  it("memiliki label untuk semua EffectiveStatus kontrak", () => {
    expect(Object.keys(MEMBERSHIP_LABEL).sort()).toEqual([...EFFECTIVE_STATUS_VALUES].sort());
  });

  it("status yang belum dikenal tetap berlabel", () => {
    expect(membershipLabelFor("verified")).toBe("KTA Aktif");
    expect(membershipLabelFor("status_baru")).toBe(MEMBERSHIP_LABEL_UNKNOWN);
    expect(membershipLabelFor("constructor")).toBe(MEMBERSHIP_LABEL_UNKNOWN);
  });
});
