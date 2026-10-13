import { describe, expect, it } from "vitest";
import type { SettingsService } from "../settings/settings.service.js";
import { apiPath, RequestGate } from "./request-gate.js";

const NOW = new Date("2026-10-13T02:00:00Z");

function gate(settings: { maintenance?: boolean; until?: string | null; android?: string; ios?: string }) {
  const values = {
    maintenance: { active: settings.maintenance ?? false, message: null, until: settings.until ?? null },
    min_app_version: { android: settings.android ?? "1.0.0", ios: settings.ios ?? "1.0.0" },
    store_links: { android: "https://play.google.com/store/apps/details?id=id.or.kapdh", ios: null },
  };
  const fake = { get: async (key: keyof typeof values) => values[key] } as unknown as SettingsService;
  return new RequestGate(fake, { now: () => NOW });
}

const check = (
  g: RequestGate,
  method: string,
  url: string,
  app?: { platform: "android" | "ios"; version?: string },
) =>
  g.check({ method, url, appPlatform: app?.platform ?? null, appVersion: app?.version }).then(
    () => "lolos",
    (e: { code: string }) => e.code,
  );

describe("apiPath", () => {
  it("memotong prefix /api/v1 dan query string; di luar prefix null", () => {
    expect(apiPath("/api/v1/auth/login?x=1")).toBe("/auth/login");
    expect(apiPath("/api/v1")).toBe("/");
    expect(apiPath("/api/v1/admin/payments/:paymentId/approve")).toBe("/admin/payments/:paymentId/approve");
    expect(apiPath("/api/v10/auth")).toBeNull();
    expect(apiPath("/lain")).toBeNull();
  });
});

describe("RequestGate (ARCHITECTURE §4.3, PRD 4.5)", () => {
  it("maintenance: mutasi ditolak kecuali refresh/logout, /admin/**, dan verifikasi KTA; baca selalu lolos", async () => {
    const g = gate({ maintenance: true });
    expect(await check(g, "POST", "/api/v1/auth/login")).toBe("MAINTENANCE");
    expect(await check(g, "PATCH", "/api/v1/me/profile")).toBe("MAINTENANCE");
    expect(await check(g, "DELETE", "/api/v1/chat/rooms/:roomId/members/me")).toBe("MAINTENANCE");
    expect(await check(g, "POST", "/api/v1/administrator")).toBe("MAINTENANCE");
    expect(await check(g, "GET", "/api/v1/me")).toBe("lolos");
    expect(await check(g, "HEAD", "/api/v1/health")).toBe("lolos");
    for (const url of [
      "/api/v1/auth/refresh",
      "/api/v1/auth/logout",
      "/api/v1/auth/logout-all",
      "/api/v1/admin/auth/login",
      "/api/v1/admin/settings/:key",
      "/api/v1/public/kta/verify",
    ])
      expect(await check(g, "POST", url), url).toBe("lolos");
  });

  it("maintenance dengan perkiraan selesai memberi retry_after_seconds", async () => {
    const g = gate({ maintenance: true, until: new Date(NOW.getTime() + 90_000).toISOString() });
    await expect(
      g.check({ method: "POST", url: "/api/v1/auth/login", appPlatform: null, appVersion: undefined }),
    ).rejects.toMatchObject({
      status: 503,
      extra: { retryAfterSeconds: 90 },
    });
  });

  it("gerbang versi: semver di bawah minimum, tidak valid, atau kosong → 426; logout dikecualikan", async () => {
    const g = gate({ android: "1.2.0", ios: "2.0.0" });
    expect(await check(g, "POST", "/api/v1/auth/login", { platform: "android", version: "1.1.9" })).toBe(
      "UPGRADE_REQUIRED",
    );
    expect(await check(g, "POST", "/api/v1/auth/login", { platform: "android", version: "1.2.0" })).toBe(
      "lolos",
    );
    expect(await check(g, "POST", "/api/v1/auth/login", { platform: "android", version: "1.10.0" })).toBe(
      "lolos",
    );
    expect(await check(g, "POST", "/api/v1/auth/login", { platform: "ios", version: "1.9.9" })).toBe(
      "UPGRADE_REQUIRED",
    );
    expect(await check(g, "POST", "/api/v1/auth/login", { platform: "ios", version: "v2" })).toBe(
      "UPGRADE_REQUIRED",
    );
    expect(await check(g, "POST", "/api/v1/auth/login", { platform: "ios" })).toBe("UPGRADE_REQUIRED");
    expect(await check(g, "POST", "/api/v1/auth/logout", { platform: "ios", version: "0.1.0" })).toBe(
      "lolos",
    );
    expect(await check(g, "GET", "/api/v1/me", { platform: "ios", version: "0.1.0" })).toBe("lolos");
    // Klien tanpa X-App-Platform (web admin, situs publik) tidak terkena gerbang versi.
    expect(await check(g, "POST", "/api/v1/auth/login")).toBe("lolos");
  });
});
