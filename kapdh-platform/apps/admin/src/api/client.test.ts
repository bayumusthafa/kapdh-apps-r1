import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  beginLogout,
  hasFreshAccessToken,
  onSessionExpired,
  refreshAccessToken,
  revokeSession,
  setAccessToken,
} from "./client";
import { ApiError } from "./errors";
import { authRequests, MOCK_CREDENTIALS, mockAuth } from "./mocks";

async function signInViaApi(expiresAt?: string) {
  const login = await api.POST("/admin/auth/login", {
    body: { email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password },
  });
  const mfa = await api.POST("/admin/auth/mfa", {
    body: { mfa_token: login.data!.mfa_token, totp_code: MOCK_CREDENTIALS.totp },
  });
  setAccessToken(mfa.data!.access_token, expiresAt ?? mfa.data!.access_expires_at);
  return mfa.data!.access_token;
}

const refreshCalls = () => authRequests.filter((r) => r.path === "/auth/refresh");

beforeEach(() => {
  onSessionExpired(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("klien API admin", () => {
  it("access token kedaluwarsa diperbarui lewat cookie lalu permintaan diulang sekali", async () => {
    await signInViaApi();
    setAccessToken("token-basi");
    const me = await api.GET("/admin/me");
    expect(me.response.status).toBe(200);
    expect(me.data?.display_name).toBe("Fikri");
  });

  it("permintaan refresh serentak digabung menjadi satu (mencegah deteksi reuse)", async () => {
    await signInViaApi();
    const [a, b, c] = await Promise.all([refreshAccessToken(), refreshAccessToken(), refreshAccessToken()]);
    expect(refreshCalls()).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("bila refresh DITOLAK server (401), sesi dinyatakan berakhir", async () => {
    const expired = vi.fn();
    onSessionExpired(expired);
    setAccessToken("token-basi");
    const me = await api.GET("/admin/me");
    expect(me.response.status).toBe(401);
    expect(expired).toHaveBeenCalledOnce();
  });
});

describe("refresh gagal karena jaringan/5xx tidak mengeluarkan admin (PRD 4.5, AC F02-5)", () => {
  it("refresh terjadwal gagal jaringan: sesi dipertahankan lalu dicoba lagi sampai berhasil", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expired = vi.fn();
    onSessionExpired(expired);
    // Token habis dalam 61 detik: refresh terjadwal berjalan ~5 detik lagi (60 detik sebelum habis).
    const first = await signInViaApi(new Date(Date.now() + 61_000).toISOString());
    mockAuth.failRefresh("network", 1);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(refreshCalls()).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
    expect(mockAuth.isSessionActive()).toBe(true);
    // Token lama tetap dipegang (masih berlaku ~55 detik), percobaan ulang setelah backoff.
    expect(hasFreshAccessToken(0)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_500);
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(2));
    // Percobaan ulang berhasil: token baru dipakai untuk permintaan berikutnya.
    const me = await api.GET("/admin/me");
    expect(me.response.status).toBe(200);
    expect((await refreshAccessToken())?.access_token).not.toBe(first);
    expect(expired).not.toHaveBeenCalled();
  });

  it.each([502, 503, 429])("refresh terjadwal dijawab %i: bukan logout", async (status) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expired = vi.fn();
    onSessionExpired(expired);
    await signInViaApi(new Date(Date.now() + 61_000).toISOString());
    mockAuth.failRefresh(status, 1);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(refreshCalls()).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
    expect(mockAuth.isSessionActive()).toBe(true);
  });

  it("401 lalu refresh tidak terjangkau: galat jaringan (bukan 'sesi berakhir') dan sesi tetap", async () => {
    const expired = vi.fn();
    onSessionExpired(expired);
    await signInViaApi();
    mockAuth.expireAccessTokens();
    mockAuth.failRefresh("network", 1);
    const failure = await api.GET("/admin/me").then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("NETWORK");
    expect(expired).not.toHaveBeenCalled();
    // Jaringan pulih: permintaan berikutnya memperbarui token dan berhasil.
    expect((await api.GET("/admin/me")).response.status).toBe(200);
  });
});

describe("logout: sesi lokal diakhiri dulu, sesi server dicabut di latar (F-02, N-08)", () => {
  it("token yang ditangkap dipakai untuk POST /auth/logout; sesi lokal sudah kosong", async () => {
    await signInViaApi();
    const handoff = beginLogout("manual");
    expect(hasFreshAccessToken(0)).toBe(false);
    expect(await revokeSession(handoff)).toBe(true);
    expect(mockAuth.isSessionActive()).toBe(false);
  });

  it("token habis: refresh dulu lewat cookie (tanpa memasang token di tab) lalu logout", async () => {
    await signInViaApi();
    mockAuth.expireAccessTokens();
    const handoff = beginLogout("manual");
    expect(await revokeSession(handoff)).toBe(true);
    expect(mockAuth.isSessionActive()).toBe(false);
    expect(hasFreshAccessToken(0)).toBe(false);
  });

  it.each(["network", 503, 429] as const)(
    "refresh sebelum logout gagal (%s): TIDAK dilaporkan berhasil",
    async (mode) => {
      await signInViaApi();
      mockAuth.expireAccessTokens();
      mockAuth.failRefresh(mode);
      const handoff = beginLogout("manual");
      expect(await revokeSession(handoff)).toBe(false);
      expect(mockAuth.isSessionActive()).toBe(true);
    },
  );

  it("sesi memang sudah mati (refresh ditolak 401): dianggap tercabut", async () => {
    await signInViaApi();
    mockAuth.revokeSession();
    const handoff = beginLogout("manual");
    expect(await revokeSession(handoff)).toBe(true);
  });

  it("admin masuk lagi sebelum pencabutan latar selesai: sesi baru tidak ikut dicabut", async () => {
    await signInViaApi();
    mockAuth.expireAccessTokens();
    const handoff = beginLogout("manual");
    // Login baru di tab yang sama sebelum revoke berjalan.
    await signInViaApi();
    expect(await revokeSession(handoff)).toBe(false);
    expect(mockAuth.isSessionActive()).toBe(true);
    expect((await api.GET("/admin/me")).response.status).toBe(200);
  });
});
