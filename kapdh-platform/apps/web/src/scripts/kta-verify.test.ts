import { describe, expect, it } from "vitest";
import type { ApiResult } from "./api";
import {
  describeKta,
  isKtaVerification,
  parseKtaLocation,
  safeAvatarUrl,
  toKtaView,
  verifyKta,
  type KtaVerification,
} from "./kta-verify";
import { API, apiError, fakeFetch, json, networkError, response, text } from "./testing";

const TOKEN = "eyJhbGciOiJIUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
const MEMBER = {
  full_name: "Ahmad Islam",
  cohort_code: "KAPDH 25",
  member_number: "25.01.01.7",
  expires_at: "2027-05-20T00:00:00Z",
  avatar_url: "https://api.kapdh.or.id/api/v1/files/content/abc",
};
const ok = (v: KtaVerification): ApiResult<KtaVerification> => ({ ok: true, status: 200, data: v });
const CHECKED = "2026-10-13T03:15:00Z";

describe("parseKtaLocation (F-06: nomor di path, token di fragmen)", () => {
  it("membaca nomor dari path dan token dari fragmen #t=", () => {
    expect(parseKtaLocation("/kta/25.01.01.7", `#t=${TOKEN}`)).toEqual({
      status: "ok",
      memberNumber: "25.01.01.7",
      token: TOKEN,
    });
    expect(parseKtaLocation("/kta/25.01.01.7/", `#t=${TOKEN}`).status).toBe("ok");
    expect(parseKtaLocation("/kta/25%2E01%2E01%2E7", `#t=${TOKEN}`)).toMatchObject({
      memberNumber: "25.01.01.7",
    });
  });

  it("audit: percent-encoding rusak menjadi invalid, bukan galat yang menghentikan skrip", () => {
    expect(() => parseKtaLocation("/kta/%E0%A4%A", `#t=${TOKEN}`)).not.toThrow();
    expect(parseKtaLocation("/kta/%E0%A4%A", `#t=${TOKEN}`)).toEqual({ status: "invalid" });
    expect(parseKtaLocation("/kta/%", `#t=${TOKEN}`)).toEqual({ status: "invalid" });
    expect(parseKtaLocation("/kta/25.01.01.7", "#t=%E0%A4%A.x.y")).toEqual({ status: "invalid" });
  });

  it("nomor dengan format salah atau token tidak lengkap menjadi invalid", () => {
    expect(parseKtaLocation("/kta/25.01.01.007", `#t=${TOKEN}`).status).toBe("invalid");
    expect(parseKtaLocation("/kta/25.04.01.7", `#t=${TOKEN}`).status).toBe("invalid");
    expect(parseKtaLocation("/kta/25.01.01.7", "").status).toBe("invalid");
    expect(parseKtaLocation("/kta/25.01.01.7", "#t=pendek").status).toBe("invalid");
    expect(parseKtaLocation("/kta/25.01.01.7", "#t=bukan-jwt-tetapi-panjang-sekali").status).toBe("invalid");
    expect(parseKtaLocation("/kta/25.01.01.7", `#t=${"a".repeat(1100)}.${"b".repeat(1000)}.c`).status).toBe(
      "invalid",
    );
    expect(parseKtaLocation("/kta/", `#t=${TOKEN}`).status).toBe("invalid");
    expect(parseKtaLocation("/lain/25.01.01.7", `#t=${TOKEN}`).status).toBe("invalid");
  });

  it("/kta tanpa nomor dan token adalah halaman petunjuk, bukan hasil", () => {
    expect(parseKtaLocation("/kta", "")).toEqual({ status: "missing" });
    expect(parseKtaLocation("/kta/", "")).toEqual({ status: "missing" });
  });
});

describe("verifyKta", () => {
  it("mengirim member_number dan token ke POST /public/kta/verify", async () => {
    const f = fakeFetch({
      "POST /public/kta/verify": () =>
        json(200, { result: "not_found", checked_at: CHECKED, expiring: false, member: null }),
    });
    const r = await verifyKta(API, "25.01.01.7", TOKEN, f.fetcher);
    expect(r.ok).toBe(true);
    expect(f.calls[0]!.body).toEqual({ member_number: "25.01.01.7", token: TOKEN });
    expect(f.calls[0]!.url).not.toContain(TOKEN);
  });
});

describe("AC F06-1..F06-4: keadaan hasil verifikasi", () => {
  it("AC F06-1: token valid dan anggota aktif -> Aktif dengan identitas minimum dan checked_at", () => {
    const view = toKtaView(ok({ result: "active", checked_at: CHECKED, expiring: false, member: MEMBER }));
    expect(view.kind).toBe("active");
    const d = describeKta(view);
    expect(d.title).toBe("Aktif");
    expect(d.tone).toBe("success");
    expect(d.facts).toEqual([
      { label: "Nama", value: "Ahmad Islam" },
      { label: "Angkatan", value: "KAPDH 25" },
      { label: "Nomor anggota", value: "25.01.01.7" },
      { label: "Berlaku sampai", value: "20 Mei 2027" },
    ]);
    expect(d.checked).toBe("Diperiksa 13 Okt 2026, 10.15 WIB dari server KAPDH.");
    expect(d.avatarUrl).toBe(MEMBER.avatar_url);
    expect(d.retry).toBe(false);
  });

  it("AC F06-1: expiring tetap Aktif dengan tanggal habis", () => {
    const d = describeKta(
      toKtaView(ok({ result: "active", checked_at: CHECKED, expiring: true, member: MEMBER })),
    );
    expect(d.title).toBe("Aktif, segera berakhir");
    expect(d.detail).toContain("20 Mei 2027");
    expect(d.checked).toContain("WIB");
  });

  it("AC F06-2: expired -> Kedaluwarsa, identitas hanya bila diberikan server", () => {
    const withMember = describeKta(
      toKtaView(
        ok({
          result: "expired",
          checked_at: CHECKED,
          expiring: false,
          member: { ...MEMBER, avatar_url: null },
        }),
      ),
    );
    expect(withMember.title).toBe("Kedaluwarsa");
    expect(withMember.facts.find((f) => f.label === "Berakhir pada")?.value).toBe("20 Mei 2027");
    expect(withMember.avatarUrl).toBeNull();
    const without = describeKta(
      toKtaView(ok({ result: "expired", checked_at: CHECKED, expiring: false, member: null })),
    );
    expect(without.facts).toEqual([]);
    expect(without.checked).toContain("Diperiksa");
  });

  it("AC F06-2: unverified/suspended/disabled -> Tidak aktif tanpa alasan privat", () => {
    const d = describeKta(
      toKtaView(ok({ result: "inactive", checked_at: CHECKED, expiring: false, member: null })),
    );
    expect(d.title).toBe("Tidak aktif");
    expect(d.detail).not.toMatch(/suspend|alasan|bayar|iuran/i);
    expect(d.facts).toEqual([]);
    expect(d.checked).toContain("Diperiksa");
  });

  it("AC F06-2: nomor tidak ada (termasuk setelah penghapusan akun) -> Tidak ditemukan", () => {
    const d = describeKta(
      toKtaView(ok({ result: "not_found", checked_at: CHECKED, expiring: false, member: null })),
    );
    expect(d.title).toBe("Tidak ditemukan");
    expect(d.checked).toContain("Diperiksa");
  });

  it("AC F06-3: token diubah atau kedaluwarsa -> tidak ada Aktif; QR tidak valid atau perlu diperbarui", () => {
    const d = describeKta(
      toKtaView(ok({ result: "invalid_token", checked_at: CHECKED, expiring: false, member: null })),
    );
    expect(d.title).toBe("QR tidak valid atau perlu diperbarui");
    expect(d.tone).toBe("danger");
    expect(d.checked).toContain("Diperiksa");
    // 400 VALIDATION_ERROR dari server (token/nomor tidak sah) juga bukan Aktif.
    const bad = describeKta(
      toKtaView({
        ok: false,
        kind: "http",
        status: 400,
        error: { code: "VALIDATION_ERROR", message: "Token tidak sah", request_id: "r" },
        retryAfterSeconds: null,
      }),
    );
    expect(bad.title).toBe("QR tidak valid atau perlu diperbarui");
    expect(bad.retry).toBe(false);
  });

  it("AC F06-3/F06-4 (PRD 5.2): 400 tanpa body Error kontrak (HTML dari WAF/proxy) bukan putusan; tetap coba lagi", async () => {
    const handlers: Array<() => Response> = [
      () => text(400, "<html><h1>400 Bad Request</h1>nginx</html>"),
      () => text(400, "Request blocked", "text/plain"),
      // JSON tetapi bukan bentuk Error kontrak (tanpa code/message).
      () => json(400, { error: "bad request" }),
      // Kode galat lain pada 400 tidak dianggap "QR tidak valid".
      () => apiError(400, "INTERNAL_ERROR", "x"),
    ];
    for (const handler of handlers) {
      const f = fakeFetch({ "POST /public/kta/verify": handler });
      const view = toKtaView(await verifyKta(API, "25.01.01.7", TOKEN, f.fetcher));
      expect(view).toEqual({ kind: "unreachable", rateLimited: false, retryAfterSeconds: null });
      const d = describeKta(view);
      expect(d.title).toBe("Tidak dapat memverifikasi");
      expect(d.retry).toBe(true);
    }
    const f = fakeFetch({
      "POST /public/kta/verify": () =>
        apiError(400, "VALIDATION_ERROR", "Token tidak sah", { field_errors: { token: ["Tidak sah"] } }),
    });
    expect(toKtaView(await verifyKta(API, "25.01.01.7", TOKEN, f.fetcher))).toEqual({
      kind: "invalid",
      checkedAt: null,
      cause: "token",
    });
  });

  it("AC F06-3: respons yang mengaku active tanpa identitas tidak dipercaya", () => {
    expect(isKtaVerification({ result: "active", checked_at: CHECKED, expiring: false, member: null })).toBe(
      false,
    );
  });

  it("AC F06-4: API tidak terjangkau -> Tidak dapat memverifikasi dengan coba lagi, tidak pernah Tidak ditemukan", async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      networkError as () => Promise<Response>,
      () => text(502, "<h1>Bad Gateway</h1>"),
      () => text(200, "<html>captive portal</html>"),
      () => json(200, { result: "not_found" }),
      () => apiError(503, "MAINTENANCE", "Pemeliharaan"),
      () => apiError(500, "INTERNAL_ERROR", "Galat"),
    ];
    for (const handler of failures) {
      const f = fakeFetch({ "POST /public/kta/verify": handler });
      const view = toKtaView(await verifyKta(API, "25.01.01.7", TOKEN, f.fetcher));
      expect(view.kind).toBe("unreachable");
      const d = describeKta(view);
      expect(d.title).toBe("Tidak dapat memverifikasi");
      expect(d.title).not.toBe("Tidak ditemukan");
      expect(d.retry).toBe(true);
    }
  });

  it("AC F06-4: 429 -> Tidak dapat memverifikasi dengan jeda retry_after_seconds", async () => {
    const f = fakeFetch({
      "POST /public/kta/verify": () =>
        apiError(429, "RATE_LIMITED", "Terlalu sering", { retry_after_seconds: 30 }),
    });
    const view = toKtaView(await verifyKta(API, "25.01.01.7", TOKEN, f.fetcher));
    expect(view).toEqual({ kind: "unreachable", rateLimited: true, retryAfterSeconds: 30 });
    expect(describeKta(view).detail).toContain("Terlalu banyak pemeriksaan");
    expect(describeKta(view).detail).toContain("bukan berarti anggota tidak terdaftar");
    // 429 tanpa body (limit_req nginx) tetap pembatasan laju dengan header Retry-After.
    const proxy = fakeFetch({
      "POST /public/kta/verify": () =>
        response(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "12" }),
    });
    expect(toKtaView(await verifyKta(API, "25.01.01.7", TOKEN, proxy.fetcher))).toEqual({
      kind: "unreachable",
      rateLimited: true,
      retryAfterSeconds: 12,
    });
    // 503 dengan retry_after_seconds bukan pembatasan laju: pesan jaringan, tanpa hitung mundur.
    const busy = fakeFetch({
      "POST /public/kta/verify": () =>
        apiError(503, "MAINTENANCE", "Pemeliharaan", { retry_after_seconds: 120 }),
    });
    expect(toKtaView(await verifyKta(API, "25.01.01.7", TOKEN, busy.fetcher))).toEqual({
      kind: "unreachable",
      rateLimited: false,
      retryAfterSeconds: null,
    });
  });

  it("loading tidak menawarkan coba lagi", () => {
    expect(describeKta({ kind: "loading" }).retry).toBe(false);
    expect(describeKta({ kind: "missing" }).retry).toBe(false);
  });
});

describe("safeAvatarUrl", () => {
  it("hanya https (http hanya localhost untuk pengembangan)", () => {
    expect(safeAvatarUrl("https://api.kapdh.or.id/x")).toBe("https://api.kapdh.or.id/x");
    expect(safeAvatarUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(safeAvatarUrl("http://evil.example/x")).toBeNull();
    expect(safeAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(safeAvatarUrl(null)).toBeNull();
  });
});
