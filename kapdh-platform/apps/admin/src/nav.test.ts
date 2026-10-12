import { describe, expect, it } from "vitest";
import { visibleNav } from "./nav";

describe("visibleNav", () => {
  it("admin pembayaran tanpa izin konten hanya melihat menu pembayaran (AC F15-1)", () => {
    expect(visibleNav(["payments.read", "payments.decide"]).map((i) => i.to)).toEqual(["/", "/payments"]);
  });
  it("menu admin hanya untuk admins.manage", () => {
    expect(visibleNav(["audit.read"]).some((i) => i.to === "/admins")).toBe(false);
  });
});
