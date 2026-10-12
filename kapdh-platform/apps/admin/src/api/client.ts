import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "@kapdh/contracts";
import { ApiError } from "./errors";
import {
  type ChannelLike,
  classifyRefreshFailure,
  type LockManagerLike,
  type LogoutHandoff,
  type RefreshResult,
  SessionTokens,
} from "./session-tokens";

/**
 * Klien API bertipe dari kontrak OpenAPI (PRD 5.2).
 * - Access token disimpan di memori saja (PRD 5.2); refresh token ada di cookie HttpOnly `kapdh_admin_rt`
 *   yang dikirim browser otomatis (credentials: include). Tidak ada token di localStorage.
 * - Token diperbarui 60 detik sebelum kedaluwarsa, dan sekali lagi bila server membalas 401. Penukaran digabung
 *   di dalam tab dan diserialkan antartab (Web Locks + BroadcastChannel, lihat session-tokens.ts) agar rotasi
 *   tidak dianggap reuse (AC F02-3) dan tab-tab tidak saling membatalkan token.
 * - Sesi hanya dinyatakan berakhir (`onSessionExpired`) bila server MENOLAK penukaran. Jaringan putus, 5xx atau
 *   429 tidak mengeluarkan admin: token dipertahankan dan penukaran dicoba lagi (PRD 4.5, AC F02-5).
 * - Mode mock (dev:mock dan uji) memuat server tiruan lewat import dinamis sehingga build produksi tidak
 *   membawa data contoh (src/api/mocks).
 */
type TokenPair = components["schemas"]["TokenPair"];
type Transport = (input: Request) => Promise<Response>;

const IS_MOCK = import.meta.env.MODE === "mock" || import.meta.env.MODE === "test";

const transport: Transport = IS_MOCK
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
/** Penukaran yang menggantung (koneksi tertahan) dihentikan agar kunci antartab tidak tertahan selamanya. */
const REFRESH_TIMEOUT_MS = 15_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(ms) : undefined;
}

/** POST /auth/refresh mentah: hanya menukar cookie dan mengklasifikasikan hasilnya. */
async function requestRefresh(): Promise<RefreshResult> {
  try {
    const res = await transport(
      new Request(`${API_BASE_URL}/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Request-Id": crypto.randomUUID() },
        body: "{}",
        signal: timeoutSignal(REFRESH_TIMEOUT_MS),
      }),
    );
    if (!res.ok) return classifyRefreshFailure(res.status);
    return { kind: "ok", pair: (await res.json()) as TokenPair };
  } catch {
    // Jaringan putus, DNS/CORS gagal atau batas waktu: hasil belum diketahui, sesi dipertahankan.
    return { kind: "unavailable" };
  }
}

/** Kunci dan kanal antartab hanya di peramban sungguhan; uji memakai implementasi tiruan yang diinjeksi. */
function browserLocks(): LockManagerLike | null {
  if (import.meta.env.MODE === "test" || typeof navigator === "undefined" || !navigator.locks) return null;
  const locks = navigator.locks;
  return {
    // Tipe lib DOM menulis Promise<Promise<T>>; saat runtime promise hasil callback sudah diratakan.
    request: <T>(name: string, callback: () => Promise<T>) =>
      locks.request(name, () => callback()) as unknown as Promise<T>,
  };
}

function browserChannel(): ChannelLike | null {
  if (import.meta.env.MODE === "test" || typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel("kapdh-admin-session");
  } catch {
    return null;
  }
}

const tokens = new SessionTokens({
  requestRefresh,
  locks: browserLocks(),
  channel: browserChannel(),
  leewayMs: REFRESH_LEEWAY_MS,
});

let sessionExpiredHandler: (() => void) | null = null;
let lastForegroundRequestAt = 0;

tokens.onExpired(() => sessionExpiredHandler?.());
if (typeof window !== "undefined") window.addEventListener("online", () => tokens.retryNow());

/** Pasang access token sesi baru (login MFA); null mengakhiri sesi lokal. */
export function setAccessToken(token: string | null, expiresAt?: string): void {
  if (token) tokens.start(token, expiresAt);
  else tokens.clear();
}

/** Identitas admin pemilik sesi (admin_id), untuk menyaring pesan antartab dari sesi admin lain. */
export function setSessionOwner(adminId: string | null): void {
  tokens.setOwner(adminId);
}

export function onSessionExpired(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

/** Tab lain mengakhiri sesi yang sama (logout/idle); `reason` berasal dari tab tersebut. */
export function onLoggedOutElsewhere(handler: ((reason: string) => void) | null): void {
  tokens.onLoggedOutElsewhere(handler);
}

/** Waktu (epoch ms) permintaan terakhir yang BUKAN permintaan latar; dipakai heartbeat aktivitas idle. */
export function lastForegroundRequestTime(): number {
  return lastForegroundRequestAt;
}

/** Access token ada dan tidak akan habis dalam `marginMs` (token tanpa waktu kedaluwarsa dianggap segar). */
export function hasFreshAccessToken(marginMs = REFRESH_LEEWAY_MS): boolean {
  return tokens.hasFresh(marginMs);
}

/** Tukar cookie refresh dengan access token baru; null bila ditolak, tidak terjangkau atau sesi berganti. */
export async function refreshAccessToken(): Promise<TokenPair | null> {
  const result = await tokens.refresh();
  return result.kind === "ok" ? result.pair : null;
}

/**
 * Periksa sesi lewat GET /admin/me (dengan refresh otomatis bila token ditolak):
 * - `valid`: token yang dipegang masih berlaku;
 * - `renewed`: token lama ditolak (mis. diputar tab lain) dan sudah diganti token baru;
 * - `ended`: sesi berakhir (refresh ditolak; `onSessionExpired` sudah dipanggil);
 * - `unavailable`: server tidak terjangkau atau menjawab lain; hasil belum diketahui.
 */
export async function probeSession(): Promise<"valid" | "renewed" | "ended" | "unavailable"> {
  const before = tokens.accessToken;
  try {
    const res = await api.GET("/admin/me");
    if (res.response.ok) return tokens.accessToken === before ? "valid" : "renewed";
    return res.response.status === 401 ? "ended" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Endpoint yang tidak boleh memicu refresh otomatis saat 401:
 * - /auth/refresh dan /admin/auth/* (login tahap sandi/TOTP) tidak memakai access token;
 * - /auth/logout memakai token yang ditangkap saat logout dimulai (`revokeSession`);
 * - /auth/reauth: 401 berarti sandi/TOTP salah; ReauthDialog memeriksa sesi sendiri (`probeSession`).
 */
const NO_RETRY = [/\/auth\/refresh$/, /\/admin\/auth\//, /\/auth\/logout/, /\/auth\/reauth$/];
const pending = new WeakMap<Request, Request>();

function bearer(request: Request): string | null {
  return request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? null;
}

const authMiddleware: Middleware = {
  onRequest({ request }) {
    // Header Authorization eksplisit (mis. logout dengan token yang ditangkap) tidak ditimpa token sesi baru.
    const token = tokens.accessToken;
    if (token && !request.headers.has("Authorization"))
      request.headers.set("Authorization", `Bearer ${token}`);
    request.headers.set("X-Request-Id", crypto.randomUUID());
    if (request.headers.get("X-Background-Request") !== "1") lastForegroundRequestAt = Date.now();
    if (!NO_RETRY.some((re) => re.test(new URL(request.url).pathname))) pending.set(request, request.clone());
    return request;
  },
  async onResponse({ request, response }) {
    const copy = pending.get(request);
    pending.delete(request);
    if (response.status !== 401 || !copy) return response;
    const result = await tokens.refresh(bearer(request));
    if (result.kind === "ok") {
      copy.headers.set("Authorization", `Bearer ${result.pair.access_token}`);
      copy.headers.set("X-Request-Id", crypto.randomUUID());
      return transport(copy);
    }
    if (result.kind === "rejected") {
      sessionExpiredHandler?.();
      return response;
    }
    if (result.kind === "unavailable") {
      // Token tidak dapat diperbarui karena server tidak terjangkau: tampilkan sebagai galat jaringan
      // ("Tidak dapat terhubung"), bukan "sesi berakhir"; sesi dipertahankan dan dicoba lagi otomatis.
      throw ApiError.network(new Error("Penukaran token tidak terjangkau"));
    }
    return response;
  },
};

export const api = createClient<paths>({
  baseUrl: API_BASE_URL,
  credentials: "include",
  fetch: transport,
});
api.use(authMiddleware);

/** Logout di tab ini: token dibuang sekarang, tab lain diberi tahu. Lanjutkan dengan `revokeSession`. */
export function beginLogout(reason: string): LogoutHandoff {
  return tokens.beginLogout(reason);
}

async function postLogout(token: string): Promise<Response> {
  const res = await api.POST("/auth/logout", { headers: { Authorization: `Bearer ${token}` } });
  return res.response;
}

/**
 * Cabut sesi di server setelah sesi lokal diakhiri (POST /auth/logout membutuhkan access token yang berlaku).
 * Bila token yang ditangkap sudah habis/ditolak, cookie refresh ditukar dulu (tanpa memasang tokennya di tab
 * ini) lalu logout diulang sekali. Mengembalikan true bila server mengonfirmasi pencabutan atau MENOLAK refresh
 * (sesi memang sudah mati); false bila hasilnya belum diketahui (jaringan, 5xx, 429) atau admin sudah masuk lagi
 * di tab ini (sesi baru tidak boleh ikut dicabut).
 */
export async function revokeSession(handoff: LogoutHandoff): Promise<boolean> {
  try {
    if (handoff.token) {
      const res = await postLogout(handoff.token);
      if (res.ok) return true;
      if (res.status !== 401) return false;
    }
    if (!tokens.isSameLogin(handoff)) return false;
    const refreshed = await tokens.refreshDetached();
    if (refreshed.kind === "rejected") return true;
    if (refreshed.kind !== "ok" || !tokens.isSameLogin(handoff)) return false;
    return (await postLogout(refreshed.pair.access_token)).ok;
  } catch {
    return false;
  }
}
