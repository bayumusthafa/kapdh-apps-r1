import { PERMISSION_VALUES } from "@kapdh/contracts";
import { describe, expect, it } from "vitest";
import { IN_PAGE_PERMISSIONS, ROUTE_ACCESS } from "./auth/access";
import { NAV_SECTIONS, navPermissions, visibleNav } from "./nav";
import { createAppRouter } from "./router";

/** Rute di luar layout admin terautentikasi (tidak memerlukan izin). */
const PUBLIC_PATHS = ["/login", "/login/mfa", "/login/enroll", "/invite"];

describe("menu admin (AC F15-1)", () => {
  it("admin pembayaran tanpa izin konten hanya melihat Dashboard dan Verifikasi Pembayaran", () => {
    expect(visibleNav(["payments.read", "payments.decide"]).map((s) => s.label)).toEqual([
      "Dashboard",
      "Verifikasi Pembayaran",
    ]);
  });

  it("menu admin hanya untuk admins.manage; audit terlihat untuk audit.export saja", () => {
    expect(visibleNav(["audit.read"]).some((s) => s.id === "admins")).toBe(false);
    expect(visibleNav(["audit.export"]).some((s) => s.id === "audit")).toBe(true);
  });

  it("grup dengan beberapa tautan menuju tautan pertama yang diizinkan", () => {
    const events = visibleNav(["events.checkin"]).find((s) => s.id === "events");
    expect(events?.to).toBe("/events/checkin");
    expect(events?.links.map((l) => l.to)).toEqual(["/events/checkin"]);
    const members = visibleNav(["master.manage"]).find((s) => s.id === "members");
    expect(members?.to).toBe("/members/masters");
  });

  it("urutan grup mengikuti guidelines hlm. 12 lalu menu F-15 tambahan", () => {
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
      "Dashboard",
      "Manajemen Konten",
      "Manajemen Event & Tiket",
      "Manajemen Admin",
      "Manajemen Users",
      "Verifikasi Pembayaran",
      "Moderasi",
      "Audit",
      "Notifikasi",
      "Pengaturan",
    ]);
  });

  it("setiap izin enum Permission memiliki permukaan UI (menu atau tombol di halaman)", () => {
    const covered = new Set([...navPermissions(), ...Object.keys(IN_PAGE_PERMISSIONS)]);
    expect([...PERMISSION_VALUES].filter((p) => !covered.has(p))).toEqual([]);
  });
});

describe("rute admin (ARCHITECTURE §7)", () => {
  const router = createAppRouter({ initialPath: "/login" });
  const registered = Object.keys(router.routesByPath).filter((p) => p !== "" && p !== "/app");

  it("semua rute ARCHITECTURE §7 terdaftar", () => {
    for (const path of [...Object.keys(ROUTE_ACCESS), ...PUBLIC_PATHS]) expect(registered).toContain(path);
  });

  it("setiap rute di dalam layout admin memiliki aturan izin di ROUTE_ACCESS", () => {
    const guarded = registered.filter((p) => !PUBLIC_PATHS.includes(p));
    expect(guarded.filter((p) => !(p in ROUTE_ACCESS))).toEqual([]);
  });
});
