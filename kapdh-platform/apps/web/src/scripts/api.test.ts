// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  failureAction,
  fieldMessage,
  isApiError,
  newIdempotencyKey,
  parseRetryAfter,
  readApiBase,
  requestJson,
  type ApiFailure,
} from "./api";
import { API, apiError, fakeFetch, json, networkError, text } from "./testing";

const isThing = (v: unknown): v is { ok: boolean } => !!v && typeof (v as { ok?: unknown }).ok === "boolean";

describe("requestJson", () => {
  it("mengirim JSON tanpa cookie, tanpa cache dan tanpa Referer", async () => {
    const f = fakeFetch({ "POST /x": () => json(200, { ok: true }) });
    const r = await requestJson(API, "/x", {
      method: "POST",
      body: { a: 1 },
      accept: isThing,
      fetcher: f.fetcher,
    });
    expect(r).toEqual({ ok: true, status: 200, data: { ok: true } });
    const call = f.calls[0]!;
    expect(call.body).toEqual({ a: 1 });
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.init.credentials).toBe("omit");
    expect(call.init.cache).toBe("no-store");
    expect(call.init.referrerPolicy).toBe("no-referrer");
  });

  it("AC F06-4: jaringan putus menjadi kind network, bukan jawaban bisnis", async () => {
    const f = fakeFetch({ "GET /x": networkError });
    expect(await requestJson(API, "/x", { fetcher: f.fetcher })).toMatchObject({
      ok: false,
      kind: "network",
      status: 0,
    });
  });

  it("AC F06-4: 200 non-JSON (captive portal) dan bentuk yang tidak sesuai kontrak menjadi invalid", async () => {
    const html = fakeFetch({ "GET /x": () => text(200, "<html>Login Wi-Fi</html>") });
    expect(await requestJson(API, "/x", { accept: isThing, fetcher: html.fetcher })).toMatchObject({
      ok: false,
      kind: "invalid",
    });
    const shape = fakeFetch({ "GET /x": () => json(200, { nope: 1 }) });
    expect(await requestJson(API, "/x", { accept: isThing, fetcher: shape.fetcher })).toMatchObject({
      ok: false,
      kind: "invalid",
    });
  });

  it("galat non-JSON (502 HTML proxy) menjadi http dengan error null", async () => {
    const f = fakeFetch({ "GET /x": () => text(502, "<h1>Bad Gateway</h1>") });
    expect(await requestJson(API, "/x", { fetcher: f.fetcher })).toEqual({
      ok: false,
      kind: "http",
      status: 502,
      error: null,
      retryAfterSeconds: null,
    });
  });

  it("membaca Error baku dan retry_after_seconds pada 429", async () => {
    const f = fakeFetch({
      "GET /x": () => apiError(429, "RATE_LIMITED", "Terlalu sering", { retry_after_seconds: 42 }),
    });
    const r = await requestJson(API, "/x", { fetcher: f.fetcher });
    expect(r).toMatchObject({
      ok: false,
      kind: "http",
      status: 429,
      retryAfterSeconds: 42,
      error: { code: "RATE_LIMITED" },
    });
  });

  it("429 tanpa body JSON memakai header Retry-After", async () => {
    const f = fakeFetch({
      "GET /x": () => new Response("slow down", { status: 429, headers: { "retry-after": "17" } }),
    });
    expect(await requestJson(API, "/x", { fetcher: f.fetcher })).toMatchObject({
      retryAfterSeconds: 17,
      error: null,
    });
  });

  it("PRD 4.3: retry_after_seconds di body dibaca untuk 409 IDEMPOTENCY_CONFLICT 'masih diproses'; header tanpa body hanya untuk 429", async () => {
    const f = fakeFetch({
      "POST /a": () =>
        apiError(409, "IDEMPOTENCY_CONFLICT", "Permintaan yang sama masih diproses.", {
          retry_after_seconds: 2,
        }),
      "POST /b": () => new Response("conflict", { status: 409, headers: { "retry-after": "30" } }),
    });
    expect(await requestJson(API, "/a", { method: "POST", fetcher: f.fetcher })).toMatchObject({
      status: 409,
      retryAfterSeconds: 2,
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
    expect(await requestJson(API, "/b", { method: "POST", fetcher: f.fetcher })).toMatchObject({
      status: 409,
      retryAfterSeconds: null,
      error: null,
    });
  });

  it("timeout membatalkan request dan menjadi network", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = ((_u: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as unknown as typeof fetch;
      const pending = requestJson(API, "/lambat", { fetcher, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toMatchObject({ ok: false, kind: "network" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseRetryAfter", () => {
  it("menerima detik atau tanggal HTTP dan membatasi 1..3600", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("0")).toBe(1);
    expect(parseRetryAfter("999999")).toBe(3600);
    const now = Date.parse("2026-10-13T00:00:00Z");
    expect(parseRetryAfter("Tue, 13 Oct 2026 00:01:00 GMT", now)).toBe(60);
    expect(parseRetryAfter("besok")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("failureAction: katalog galat tunggal @kapdh/shared (PRD 5.2)", () => {
  const http = (status: number, code: string | null): ApiFailure => ({
    ok: false,
    kind: "http",
    status,
    // Kode di luar enum kontrak (mis. kontrak lebih baru) dicoba lewat cast: server dapat mengirimnya.
    error: code ? ({ code, message: "m", request_id: "r" } as ApiFailure["error"]) : null,
    retryAfterSeconds: null,
  });

  it("perilaku mengikuti kode kontrak, bukan status saja", () => {
    expect(failureAction(http(400, "VALIDATION_ERROR"))).toBe("show_field_errors");
    expect(failureAction(http(404, "NOT_FOUND"))).toBe("show_not_found");
    expect(failureAction(http(410, "OTP_EXPIRED"))).toBe("offer_new_otp");
    expect(failureAction(http(409, "IDEMPOTENCY_CONFLICT"))).toBe("reload_latest");
    expect(failureAction(http(429, "RATE_LIMITED"))).toBe("show_countdown");
    expect(failureAction(http(503, "MAINTENANCE"))).toBe("show_maintenance");
    // Kode yang belum dikenal versi klien ini jatuh ke coba lagi.
    expect(failureAction(http(400, "KODE_BARU"))).toBe("show_retry");
  });

  it("AC F06-4: body bukan Error kontrak (HTML/teks dari proxy, WAF, router) tidak pernah menjadi jawaban bisnis", () => {
    expect(failureAction(http(400, null))).toBe("show_retry");
    expect(failureAction(http(404, null))).toBe("show_retry");
    expect(failureAction(http(410, null))).toBe("show_retry");
    // 429 tanpa body (limit_req nginx) tetap pembatasan laju.
    expect(failureAction(http(429, null))).toBe("show_countdown");
    expect(
      failureAction({ ok: false, kind: "network", status: 0, error: null, retryAfterSeconds: null }),
    ).toBe("show_offline");
    expect(
      failureAction({ ok: false, kind: "invalid", status: 200, error: null, retryAfterSeconds: null }),
    ).toBe("show_retry");
  });
});

describe("pembantu galat", () => {
  it("isApiError dan fieldMessage", () => {
    const err = {
      code: "VALIDATION_ERROR",
      message: "x",
      request_id: "r",
      field_errors: { code: ["Kode salah. Sisa 3."] },
    };
    expect(isApiError(err)).toBe(true);
    expect(isApiError({ message: "x" })).toBe(false);
    expect(fieldMessage(err as never, "code")).toBe("Kode salah. Sisa 3.");
    expect(fieldMessage(err as never, "email")).toBeNull();
    expect(fieldMessage({ ...err, field_errors: { _: ["akar"] } } as never, "email")).toBe("akar");
  });
});

describe("Idempotency-Key (PRD 4.3)", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  it("UUID v4 dari randomUUID maupun cadangan getRandomValues", () => {
    expect(newIdempotencyKey()).toMatch(UUID_V4);
    const fallback = {
      getRandomValues: <T extends ArrayBufferView | null>(a: T) => crypto.getRandomValues(a as never) as T,
    };
    expect(newIdempotencyKey(fallback as never)).toMatch(UUID_V4);
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});

describe("readApiBase", () => {
  it("membaca meta kapdh-api-base yang ditanam saat build", () => {
    document.head.innerHTML = '<meta name="kapdh-api-base" content="https://api.kapdh.or.id/api/v1/">';
    expect(readApiBase(document)).toBe("https://api.kapdh.or.id/api/v1");
    document.head.innerHTML = "";
    expect(() => readApiBase(document)).toThrow();
  });
});
