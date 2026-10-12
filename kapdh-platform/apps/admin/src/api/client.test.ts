import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, onSessionExpired, refreshAccessToken, setAccessToken } from "./client";
import { MOCK_CREDENTIALS, resetMockSession } from "./mock";

async function signInViaApi() {
  const login = await api.POST("/admin/auth/login", {
    body: { email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password },
  });
  const mfa = await api.POST("/admin/auth/mfa", {
    body: { mfa_token: login.data!.mfa_token, totp_code: MOCK_CREDENTIALS.totp },
  });
  setAccessToken(mfa.data!.access_token, mfa.data!.access_expires_at);
}

beforeEach(() => {
  resetMockSession();
  setAccessToken(null);
  onSessionExpired(null);
});

describe("klien API admin", () => {
  it("access token kedaluwarsa diperbarui lewat cookie lalu permintaan diulang sekali", async () => {
    await signInViaApi();
    setAccessToken("token-basi");
    const me = await api.GET("/admin/me");
    expect(me.response.status).toBe(200);
    expect(me.data?.display_name).toBe("Bayu Musthafa");
  });

  it("permintaan refresh serentak digabung menjadi satu (mencegah deteksi reuse)", async () => {
    await signInViaApi();
    const spy = vi.spyOn(globalThis, "Request");
    const [a, b, c] = await Promise.all([refreshAccessToken(), refreshAccessToken(), refreshAccessToken()]);
    const refreshCalls = spy.mock.calls.filter(([input]) => String(input).endsWith("/auth/refresh"));
    expect(refreshCalls).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    spy.mockRestore();
  });

  it("bila refresh ditolak, sesi dinyatakan berakhir", async () => {
    const expired = vi.fn();
    onSessionExpired(expired);
    setAccessToken("token-basi");
    const me = await api.GET("/admin/me");
    expect(me.response.status).toBe(401);
    expect(expired).toHaveBeenCalledOnce();
  });
});
