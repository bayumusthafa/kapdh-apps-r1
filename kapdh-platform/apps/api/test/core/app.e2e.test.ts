import { outboxEvents } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { expectOperation } from "../support/contract.js";
import { setSetting } from "../support/factories.js";
import { type HttpClient, httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("API dasar (PRD 5.2, 5.5, N-14)", () => {
  let t: TestApp;
  let api: HttpClient;

  beforeAll(async () => {
    t = await createTestApp();
    api = httpClient(t.app);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it("GET /health: liveness dengan waktu dari Clock dan x-request-id", async () => {
    const res = await api.get("/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", time: t.clock.now().toISOString(), commit: null });
    expect(String(res.headers["x-request-id"])).toMatch(UUID);
    expectOperation("get", "/health", res);
  });

  it("GET /health melaporkan commit sumber image (KAPDH_COMMIT) untuk uji asap deploy (PRD 5.5)", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const built = await createTestApp({ env: { KAPDH_COMMIT: commit } });
    try {
      const res = await httpClient(built.app).get("/health");
      expect(res.statusCode).toBe(200);
      expect(expectOperation("get", "/health", res)).toMatchObject({ status: "ok", commit });
    } finally {
      await built.app.close();
    }
  });

  it("GET /health/ready: ping database dan storage, Redis dilewati, umur outbox pending tertua (PRD 5.5)", async () => {
    const empty = await api.get("/health/ready");
    expect(empty.statusCode).toBe(200);
    expect(empty.headers["cache-control"]).toBe("no-store");
    expect(expectOperation("get", "/health/ready", empty)).toEqual({
      status: "ok",
      time: t.clock.now().toISOString(),
      checks: {
        database: "ok",
        redis: "skipped",
        storage: "ok",
        // Deletion ledger sudah diterapkan (tanpa kepala ledger di storage: belum ada penghapusan, AC F14-6).
        deletion_ledger: "ok",
        outbox_oldest_pending_seconds: null,
      },
    });
    const created = new Date(t.clock.now().getTime() - 90_000);
    await t.db.insert(outboxEvents).values({
      id: uuidv7(),
      topic: "event.cancelled",
      dedupKey: `ready-${uuidv7()}`,
      payload: { event_id: uuidv7() },
      nextAttemptAt: created,
      createdAt: created,
    });
    const res = await api.get("/health/ready");
    expect(res.json().checks.outbox_oldest_pending_seconds).toBe(90);
  });

  it("GET /public/config dari app_settings (seed referensi) sesuai kontrak", async () => {
    const res = await api.get("/public/config");
    expect(res.statusCode).toBe(200);
    expect(expectOperation("get", "/public/config", res)).toEqual({
      min_app_version: { android: "1.0.0", ios: "1.0.0" },
      maintenance: { active: false, message: null, until: null },
      store_links: { android: null, ios: null },
      support: { email: "bantuan@kapdh.or.id", whatsapp: null },
      legal: { privacy_version: null, terms_version: null, community_version: null },
      server_time: t.clock.now().toISOString(),
    });
  });

  it("GET /public/config mengikuti perubahan app_settings (cache dibuang saat pembaruan)", async () => {
    await setSetting(t, "min_app_version", { android: "1.2.0", ios: "1.1.0" });
    await setSetting(t, "store_links", {
      android: "https://play.google.com/store/apps/details?id=id.or.kapdh",
      ios: null,
    });
    const body = (await api.get("/public/config")).json();
    expect(body.min_app_version).toEqual({ android: "1.2.0", ios: "1.1.0" });
    expect(body.store_links.android).toContain("play.google.com");
    await setSetting(t, "min_app_version", { android: "1.0.0", ios: "1.0.0" });
    await setSetting(t, "store_links", { android: null, ios: null });
  });

  it("rute tidak dikenal memakai format galat baku dengan request_id server", async () => {
    const res = await api.get("/tidak-ada", { headers: { "x-request-id": "klien-req-12345" } });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).toEqual({
      code: "NOT_FOUND",
      message: "Data tidak ditemukan.",
      request_id: body.request_id,
    });
    // X-Request-Id klien tidak dipakai sebagai korelasi audit (hanya dicatat di log sebagai client_request_id).
    expect(body.request_id).toMatch(UUID);
    expect(body.request_id).not.toBe("klien-req-12345");
    expect(res.headers["x-request-id"]).toBe(body.request_id);
  });

  it("CORS hanya untuk origin web admin dan situs publik", async () => {
    const preflight = (origin: string) =>
      t.app.inject({
        method: "OPTIONS",
        url: "/api/v1/health",
        headers: { origin, "access-control-request-method": "GET" },
      });
    expect((await preflight("https://evil.example")).headers["access-control-allow-origin"]).toBeUndefined();
    const admin = await preflight(t.env.ADMIN_ORIGIN);
    expect(admin.headers["access-control-allow-origin"]).toBe(t.env.ADMIN_ORIGIN);
    expect(admin.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("N-07: HSTS tidak dikirim selama HSTS_ENABLED=false", async () => {
    const res = await api.get("/health");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("PRD 5.5: readiness gagal bila dependensi wajib tidak siap", () => {
  it("storage tidak terjangkau → 503 dengan status per komponen tanpa pesan galat", async () => {
    const broken = new MemoryDriver();
    broken.stat = () => Promise.reject(new Error("ECONNREFUSED 10.0.0.5:9000 rahasia-host"));
    const t = await createTestApp({ storage: broken });
    try {
      const res = await httpClient(t.app).get("/health/ready");
      expect(res.statusCode).toBe(503);
      expect(expectOperation("get", "/health/ready", res)).toMatchObject({
        status: "unavailable",
        checks: { database: "ok", redis: "skipped", storage: "fail" },
      });
      expect(res.body).not.toContain("rahasia-host");
      // Liveness tetap 200: proses hidup walau dependensi bermasalah.
      expect((await httpClient(t.app).get("/health")).statusCode).toBe(200);
    } finally {
      await t.app.close();
    }
  });
});

describe("Header keamanan dan proxy (N-07, PRD 2.5)", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ env: { HSTS_ENABLED: true, TRUST_PROXY_HOPS: 1 } });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it("HSTS aktif bila HSTS_ENABLED=true", async () => {
    const res = await httpClient(t.app).get("/health");
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
  });
});
