import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAlumni, DEFAULT_PASSWORD, setSetting, signInAlumni } from "../support/factories.js";
import { type HttpClient, httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { ProbeModule } from "./probe.js";

describe("PRD 4.5: mode maintenance menolak mutasi (503 MAINTENANCE)", () => {
  let t: TestApp;
  let api: HttpClient;

  beforeAll(async () => {
    t = await createTestApp({ extraModules: [ProbeModule] });
    api = httpClient(t.app);
  });
  afterEach(async () => {
    await setSetting(t, "maintenance", { active: false, message: null, until: null });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it("mutasi anggota ditolak dengan pesan pengurus dan Retry-After dari perkiraan selesai", async () => {
    const until = new Date(t.clock.now().getTime() + 30 * 60_000).toISOString();
    await setSetting(t, "maintenance", { active: true, message: "Pemeliharaan server malam ini.", until });
    const res = await api.post("/auth/login", { email: "x@contoh.test", password: DEFAULT_PASSWORD });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: "MAINTENANCE",
      message: "Pemeliharaan server malam ini.",
      retry_after_seconds: 1800,
    });
    expect(res.headers["retry-after"]).toBe("1800");
    expect((await api.post("/auth/register", {})).statusCode).toBe(503);
  });

  it("baca tetap berjalan; /public/config memuat status maintenance", async () => {
    await setSetting(t, "maintenance", { active: true, message: null, until: null });
    expect((await api.get("/health")).statusCode).toBe(200);
    const config = await api.get("/public/config");
    expect(config.statusCode).toBe(200);
    expect(config.json().maintenance.active).toBe(true);
  });

  it("pengecualian: refresh/logout, seluruh /admin/**, dan verifikasi KTA publik tetap diproses", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    await setSetting(t, "maintenance", { active: true, message: null, until: null });
    const refreshed = await api.post("/auth/refresh", { refresh_token: session.refreshToken });
    expect(refreshed.statusCode).toBe(200);
    expect(
      (await api.post("/admin/auth/login", { email: "admin@contoh.test", password: "Salah#2026" }))
        .statusCode,
    ).toBe(401);
    expect((await api.post("/public/kta/verify", {})).statusCode).not.toBe(503);
    // Refresh merotasi sesi (AC F02-3): logout memakai access token sesi baru.
    expect((await api.post("/auth/logout", {}, { token: refreshed.json().access_token })).statusCode).toBe(
      204,
    );
    // Mutasi lain tetap ditolak selama maintenance.
    expect((await api.post("/auth/otp/resend", { challenge_id: session.refreshToken })).statusCode).toBe(503);
  });
});

describe("PRD 4.5: gerbang versi aplikasi minimum (426 UPGRADE_REQUIRED)", () => {
  let t: TestApp;
  let api: HttpClient;

  beforeAll(async () => {
    t = await createTestApp({ extraModules: [ProbeModule] });
    api = httpClient(t.app);
    await setSetting(t, "min_app_version", { android: "1.2.0", ios: "1.1.0" });
    await setSetting(t, "store_links", {
      android: "https://play.google.com/store/apps/details?id=id.or.kapdh",
      ios: null,
    });
  });
  afterAll(async () => {
    await t.app.close();
  });

  const app = (platform: string, version?: string) => ({
    "x-app-platform": platform,
    ...(version === undefined ? {} : { "x-app-version": version }),
  });

  it("mutasi dari versi di bawah minimum ditolak dengan tautan toko", async () => {
    const res = await api.post(
      "/auth/login",
      { email: "x@contoh.test", password: DEFAULT_PASSWORD },
      { headers: app("android", "1.1.9") },
    );
    expect(res.statusCode).toBe(426);
    expect(res.json()).toMatchObject({
      code: "UPGRADE_REQUIRED",
      current: {
        platform: "android",
        min_version: "1.2.0",
        store_url: "https://play.google.com/store/apps/details?id=id.or.kapdh",
      },
    });
  });

  it("versi sama/lebih baru, prarilis lebih baru, dan platform lain diproses", async () => {
    const body = { email: "x@contoh.test", password: "Salah#2026" };
    expect((await api.post("/auth/login", body, { headers: app("android", "1.2.0") })).statusCode).toBe(401);
    expect((await api.post("/auth/login", body, { headers: app("ios", "1.1.0") })).statusCode).toBe(401);
    expect((await api.post("/auth/login", body, { headers: app("ios", "2.0.0-beta.1") })).statusCode).toBe(
      401,
    );
    // Web admin/situs publik tidak mengirim X-App-Platform: tidak ada gerbang versi.
    expect((await api.post("/auth/login", body)).statusCode).toBe(401);
  });

  it("versi tidak valid atau tidak dikirim dari aplikasi mobile ditolak (fail closed)", async () => {
    const body = { email: "x@contoh.test", password: "Salah#2026" };
    expect((await api.post("/auth/login", body, { headers: app("android", "abc") })).statusCode).toBe(426);
    expect((await api.post("/auth/login", body, { headers: app("ios") })).statusCode).toBe(426);
    expect((await api.post("/auth/login", body, { headers: app("android", "1.1.0-rc.9") })).statusCode).toBe(
      426,
    );
  });

  it("baca dan logout dari versi lama tetap diproses", async () => {
    expect((await api.get("/public/config", { headers: app("android", "0.9.0") })).statusCode).toBe(200);
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    const logout = await api.post(
      "/auth/logout",
      {},
      { token: session.accessToken, headers: app("android", "0.9.0") },
    );
    expect(logout.statusCode).toBe(204);
  });
});

describe("PRD 2.5: TRUST_PROXY_HOPS menentukan req.ip (X-Forwarded-For klien tidak dipercaya)", () => {
  it("TRUST_PROXY_HOPS=0: X-Forwarded-For diabaikan", async () => {
    const t = await createTestApp({ extraModules: [ProbeModule] });
    try {
      const res = await httpClient(t.app).get("/__probe/public", {
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      expect(res.json().ip).toBe("127.0.0.1");
    } finally {
      await t.app.close();
    }
  });

  it("TRUST_PROXY_HOPS=1: hanya alamat yang ditambahkan proxy tepercaya terakhir yang dipakai", async () => {
    const t = await createTestApp({ extraModules: [ProbeModule], env: { TRUST_PROXY_HOPS: 1 } });
    try {
      // Klien memalsukan 198.51.100.7; Traefik menambahkan alamat klien sebenarnya 203.0.113.9.
      const res = await httpClient(t.app).get("/__probe/public", {
        headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" },
      });
      expect(res.json().ip).toBe("203.0.113.9");
    } finally {
      await t.app.close();
    }
  });

  it("TRUST_PROXY_HOPS=1: klien publik yang terhubung langsung (bukan lewat Traefik) tidak dapat memalsukan IP", async () => {
    // GHSA-3m5p-2c4r-xxw2: hop-count tanpa memeriksa peer langsung. Peer langsung wajib alamat privat (trust-proxy.ts).
    const t = await createTestApp({ extraModules: [ProbeModule], env: { TRUST_PROXY_HOPS: 1 } });
    try {
      const res = await t.app.inject({
        method: "GET",
        url: "/api/v1/__probe/public",
        remoteAddress: "198.51.100.20",
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      expect(res.json().ip).toBe("198.51.100.20");
    } finally {
      await t.app.close();
    }
  });

  it("rate limit IP login tidak dapat dilewati dengan memutar X-Forwarded-For (TRUST_PROXY_HOPS=0)", async () => {
    const t = await createTestApp();
    try {
      const api = httpClient(t.app);
      for (let i = 0; i < 50; i++)
        await api.post(
          "/auth/login",
          { email: `acak-${i}@contoh.test`, password: "Salah#2026" },
          { headers: { "x-forwarded-for": `198.51.100.${i}` } },
        );
      const blocked = await api.post(
        "/auth/login",
        { email: "lain@contoh.test", password: "Salah#2026" },
        { headers: { "x-forwarded-for": "198.51.100.200" } },
      );
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe("RATE_LIMITED");
    } finally {
      await t.app.close();
    }
  });
});

describe("N-14: konteks request", () => {
  it("request_id server, X-Request-Id klien hanya sebagai client_request_id, header aplikasi terbaca", async () => {
    const t = await createTestApp({ extraModules: [ProbeModule] });
    try {
      const res = await httpClient(t.app).get("/__probe/public", {
        headers: { "x-request-id": "klien-abc-123", "x-app-platform": "Android", "x-app-version": "1.0.3" },
      });
      const body = res.json();
      expect(body.request_id).toBe(res.headers["x-request-id"]);
      expect(body.client_request_id).toBe("klien-abc-123");
      expect(body.app_platform).toBe("android");
      expect(body.app_version).toBe("1.0.3");
      const weird = await httpClient(t.app).get("/__probe/public", {
        headers: { "x-request-id": "a b<script>" },
      });
      expect(weird.json().client_request_id).toBeNull();
    } finally {
      await t.app.close();
    }
  });
});
