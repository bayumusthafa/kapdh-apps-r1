import createClient, { type Middleware } from "openapi-fetch";
import type { ApiError as ApiErrorBody, components, paths } from "@kapdh/contracts";

/**
 * Klien API bertipe dari kontrak OpenAPI (PRD 5.2).
 * - Access token disimpan di memori saja (PRD 5.2); refresh token ada di cookie HttpOnly `kapdh_admin_rt`
 *   yang dikirim browser otomatis (credentials: include). Tidak ada token di localStorage.
 * - Token diperbarui 60 detik sebelum kedaluwarsa, dan sekali lagi bila server membalas 401 (single-flight agar
 *   rotasi tidak dianggap reuse, AC F02-3).
 * - Bila pembaruan gagal (sesi dicabut, idle 30 menit, cookie hilang) `onSessionExpired` dipanggil.
 * - Mode mock (dev:mock dan uji) memuat server tiruan lewat import dinamis sehingga build produksi tidak
 *   membawa data contoh (src/api/mocks).
 */
type TokenPair = components["schemas"]["TokenPair"];
type Transport = (input: Request) => Promise<Response>;

const transport: Transport =
  import.meta.env.MODE === "mock" || import.meta.env.MODE === "test"
    ? async (input) => (await import("./mocks")).mockFetch(input)
    : (input) => fetch(input);

/** Produksi: https://api.kapdh.or.id/api/v1 (VITE_API_BASE_URL). Lokal: proxy Vite `/api` ke localhost:3000. */
export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  new URL("/api/v1", window.location.origin).toString();

/**
 * Header untuk permintaan latar (polling, refetch otomatis). Server tidak menghitungnya sebagai aktivitas
 * sehingga idle timeout admin 30 menit tetap berjalan (AC F02-5). Permintaan karena tindakan admin TIDAK boleh
 * memakainya; gunakan `pollMs` pada useApiQuery agar header ini hanya terpasang pada refetch polling.
 */
export const BACKGROUND_HEADERS = { "X-Background-Request": "1" } as const;

/** Diperbarui 60 detik sebelum access token habis. */
const REFRESH_LEEWAY_MS = 60_000;

let accessToken: string | null = null;
let accessExpiresAtMs = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let inflightRefresh: Promise<TokenPair | null> | null = null;
let sessionExpiredHandler: (() => void) | null = null;
let lastForegroundRequestAt = 0;
/** True bila refresh terakhir ditolak server (sesi memang sudah mati), false bila gagal karena jaringan. */
let lastRefreshRejected = false;

export function setAccessToken(token: string | null, expiresAt?: string): void {
  accessToken = token;
  accessExpiresAtMs = token && expiresAt ? Date.parse(expiresAt) : 0;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  if (token && expiresAt) {
    const delay = Math.max(5_000, accessExpiresAtMs - Date.now() - REFRESH_LEEWAY_MS);
    refreshTimer = setTimeout(() => {
      void refreshAccessToken().then((pair) => {
        if (!pair) sessionExpiredHandler?.();
      });
    }, delay);
  }
}

export function onSessionExpired(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

/** Waktu (epoch ms) permintaan terakhir yang BUKAN permintaan latar; dipakai heartbeat aktivitas idle. */
export function lastForegroundRequestTime(): number {
  return lastForegroundRequestAt;
}

/** Access token ada dan tidak akan habis dalam `marginMs` (token tanpa waktu kedaluwarsa dianggap segar). */
export function hasFreshAccessToken(marginMs = REFRESH_LEEWAY_MS): boolean {
  if (!accessToken) return false;
  return accessExpiresAtMs === 0 || accessExpiresAtMs - Date.now() > marginMs;
}

/**
 * Tukar cookie refresh dengan access token baru. Beberapa pemanggil serentak berbagi satu permintaan
 * agar rotasi tidak dianggap reuse oleh server (yang akan mencabut seluruh keluarga sesi).
 */
export function refreshAccessToken(): Promise<TokenPair | null> {
  inflightRefresh ??= (async () => {
    try {
      const res = await transport(
        new Request(`${API_BASE_URL}/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-Request-Id": crypto.randomUUID() },
          body: "{}",
        }),
      );
      if (!res.ok) {
        lastRefreshRejected = true;
        setAccessToken(null);
        return null;
      }
      const pair = (await res.json()) as TokenPair;
      lastRefreshRejected = false;
      setAccessToken(pair.access_token, pair.access_expires_at);
      return pair;
    } catch {
      lastRefreshRejected = false;
      return null;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/** Pastikan access token segar sebelum permintaan yang 401-nya bermakna "kredensial salah" (mis. reauth). */
export async function ensureFreshAccessToken(): Promise<boolean> {
  if (hasFreshAccessToken()) return true;
  return (await refreshAccessToken()) !== null;
}

/**
 * Endpoint yang tidak boleh memicu refresh otomatis saat 401:
 * - /auth/refresh dan /admin/auth/* (login tahap sandi/TOTP) tidak memakai access token;
 * - /auth/logout ditangani `revokeCurrentSession` (refresh dulu lalu ulang sekali);
 * - /auth/reauth: 401 berarti sandi/TOTP salah, bukan sesi habis (token disegarkan sebelum dipanggil).
 */
const NO_RETRY = [/\/auth\/refresh$/, /\/admin\/auth\//, /\/auth\/logout/, /\/auth\/reauth$/];
const pending = new WeakMap<Request, Request>();

const authMiddleware: Middleware = {
  onRequest({ request }) {
    if (accessToken) request.headers.set("Authorization", `Bearer ${accessToken}`);
    request.headers.set("X-Request-Id", crypto.randomUUID());
    if (request.headers.get("X-Background-Request") !== "1") lastForegroundRequestAt = Date.now();
    if (!NO_RETRY.some((re) => re.test(new URL(request.url).pathname))) pending.set(request, request.clone());
    return request;
  },
  async onResponse({ request, response }) {
    const copy = pending.get(request);
    pending.delete(request);
    if (response.status !== 401 || !copy) return response;
    const pair = await refreshAccessToken();
    if (!pair) {
      sessionExpiredHandler?.();
      return response;
    }
    copy.headers.set("Authorization", `Bearer ${pair.access_token}`);
    copy.headers.set("X-Request-Id", crypto.randomUUID());
    return transport(copy);
  },
};

export const api = createClient<paths>({
  baseUrl: API_BASE_URL,
  credentials: "include",
  fetch: transport,
});
api.use(authMiddleware);

/**
 * Cabut sesi saat ini di server (POST /auth/logout membutuhkan access token yang berlaku). Bila access token
 * sudah habis, misalnya laptop tertidur sehingga timer refresh tidak berjalan, token disegarkan dulu lewat cookie
 * refresh lalu logout diulang sekali. Mengembalikan true bila server mengonfirmasi pencabutan atau sesi memang
 * sudah tidak berlaku (refresh ditolak server); false bila hasilnya tidak diketahui (jaringan putus).
 */
export async function revokeCurrentSession(): Promise<boolean> {
  try {
    if (!hasFreshAccessToken(5_000) && !(await refreshAccessToken())) return lastRefreshRejected;
    let res = await api.POST("/auth/logout");
    if (res.response.status === 401) {
      if (!(await refreshAccessToken())) return lastRefreshRejected;
      res = await api.POST("/auth/logout");
    }
    return res.response.ok;
  } catch {
    return false;
  }
}

/** Body galat kontrak dari openapi-fetch (untuk kode lama); kode baru memakai ApiError dari ./errors. */
export function isApiError(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null && "code" in value && "request_id" in value;
}
