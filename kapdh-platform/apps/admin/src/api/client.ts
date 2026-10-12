import createClient, { type Middleware } from "openapi-fetch";
import type { ApiError, components, paths } from "@kapdh/contracts";
import { mockFetch } from "./mock";

/**
 * Klien API bertipe dari kontrak OpenAPI.
 * - Access token disimpan di memori saja (PRD 5.2); refresh token ada di cookie HttpOnly `kapdh_admin_rt`
 *   yang dikirim browser otomatis (credentials: include).
 * - Token diperbarui sebelum kedaluwarsa, dan sekali lagi bila server membalas 401 (single-flight).
 * - Bila pembaruan gagal (sesi dicabut, idle 30 menit, atau cookie hilang) `onSessionExpired` dipanggil.
 */
type TokenPair = components["schemas"]["TokenPair"];

const useMock = import.meta.env.MODE === "mock" || import.meta.env.MODE === "test";
const transport: (input: Request) => Promise<Response> = useMock ? mockFetch : (input) => fetch(input);

/** Produksi: https://api.kapdh.or.id/api/v1. Lokal: proxy Vite `/api` ke localhost:3000. */
export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  new URL("/api/v1", window.location.origin).toString();

let accessToken: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let inflightRefresh: Promise<TokenPair | null> | null = null;
let sessionExpiredHandler: (() => void) | null = null;

/** Diperbarui 60 detik sebelum access token habis. */
const REFRESH_LEEWAY_MS = 60_000;

export function setAccessToken(token: string | null, expiresAt?: string): void {
  accessToken = token;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  if (token && expiresAt) {
    const delay = Math.max(5_000, new Date(expiresAt).getTime() - Date.now() - REFRESH_LEEWAY_MS);
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
        setAccessToken(null);
        return null;
      }
      const pair = (await res.json()) as TokenPair;
      setAccessToken(pair.access_token, pair.access_expires_at);
      return pair;
    } catch {
      return null;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/** Endpoint yang tidak boleh memicu refresh otomatis saat 401. */
const NO_RETRY = [/\/auth\/refresh$/, /\/admin\/auth\//, /\/auth\/logout/];
const pending = new WeakMap<Request, Request>();

const authMiddleware: Middleware = {
  onRequest({ request }) {
    if (accessToken) request.headers.set("Authorization", `Bearer ${accessToken}`);
    request.headers.set("X-Request-Id", crypto.randomUUID());
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
 * Header untuk permintaan latar (polling, refetch otomatis). Server tidak menghitungnya sebagai aktivitas
 * sehingga idle timeout admin 30 menit tetap berjalan (AC F02-5).
 */
export const BACKGROUND_HEADERS = { "X-Background-Request": "1" } as const;

export function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "code" in value && "request_id" in value;
}
