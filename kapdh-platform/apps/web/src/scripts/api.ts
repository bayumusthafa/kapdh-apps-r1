import type { components } from "@kapdh/contracts";
import { CLIENT_ERROR_UI, errorUiFor, type ErrorUiAction } from "@kapdh/shared";

/** Bentuk galat baku API (PRD 5.2, root.yaml `Error`). */
export type ApiError = components["schemas"]["Error"];

/**
 * Hasil panggilan API tanpa melempar. `network` = tidak terjangkau/timeout; `invalid` = respons yang tidak dapat
 * dipercaya (bukan JSON, bentuk tidak sesuai kontrak, mis. halaman captive portal atau proxy); `http` = API
 * membalas status galat. Klien TIDAK PERNAH menafsirkan `network`/`invalid` sebagai jawaban bisnis (AC F06-4).
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; kind: "network" | "invalid"; status: number; error: null; retryAfterSeconds: null }
  | { ok: false; kind: "http"; status: number; error: ApiError | null; retryAfterSeconds: number | null };

export type ApiFailure = Extract<ApiResult<unknown>, { ok: false }>;

export interface RequestOptions<T> {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  /** Penjaga bentuk respons 2xx; false -> `invalid`. */
  accept?: (data: unknown) => data is T;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
/** Batas atas tampilan hitung mundur 429 agar header yang janggal tidak mengunci UI berjam-jam. */
export const MAX_RETRY_AFTER_SECONDS = 3600;

/** Basis URL API yang ditanam Base.astro saat build (meta `kapdh-api-base`). */
export function readApiBase(doc: Document = document): string {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="kapdh-api-base"]');
  const value = meta?.content?.trim();
  if (!value) throw new Error("meta kapdh-api-base tidak ada");
  return value.replace(/\/+$/, "");
}

export function isApiError(value: unknown): value is ApiError {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === "string" && typeof v.message === "string";
}

/** Retry-After dalam detik (angka atau tanggal HTTP), dibatasi 1..3600; null bila tidak terbaca. */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    seconds = Math.ceil((at - nowMs) / 1000);
  }
  if (!Number.isFinite(seconds)) return null;
  return Math.min(Math.max(seconds, 1), MAX_RETRY_AFTER_SECONDS);
}

function retryAfterFrom(error: ApiError | null, header: string | null): number | null {
  const fromBody = error?.retry_after_seconds;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) {
    return Math.min(Math.max(Math.ceil(fromBody), 1), MAX_RETRY_AFTER_SECONDS);
  }
  return parseRetryAfter(header);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Memanggil API publik (tanpa cookie, tanpa Referer, tanpa cache) dan mengembalikan ApiResult. Body galat yang
 * bukan JSON (mis. 502 HTML dari proxy) menghasilkan `kind: "http"` dengan `error: null`.
 */
export async function requestJson<T>(
  apiBase: string,
  path: string,
  options: RequestOptions<T> = {},
): Promise<ApiResult<T>> {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  let text: string;
  try {
    res = await fetcher(`${apiBase}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    text = await res.text();
  } catch {
    return { ok: false, kind: "network", status: 0, error: null, retryAfterSeconds: null };
  } finally {
    clearTimeout(timer);
  }
  const data = parseJson(text);
  if (res.ok) {
    if (data === undefined || (options.accept && !options.accept(data))) {
      return { ok: false, kind: "invalid", status: res.status, error: null, retryAfterSeconds: null };
    }
    return { ok: true, status: res.status, data: data as T };
  }
  const error = isApiError(data) ? data : null;
  return {
    ok: false,
    kind: "http",
    status: res.status,
    error,
    // `retry_after_seconds` di body berlaku untuk status apa pun (mis. 409 IDEMPOTENCY_CONFLICT "masih diproses"
    // membawa 2 detik); header Retry-After tanpa body hanya dipercaya pada 429 (limit_req proxy).
    retryAfterSeconds: retryAfterFrom(error, res.status === 429 ? res.headers.get("retry-after") : null),
  };
}

const ERROR_UI_RATE_LIMITED: ErrorUiAction = errorUiFor("RATE_LIMITED").action;

/**
 * Perilaku UI untuk kegagalan menurut katalog galat tunggal @kapdh/shared (PRD 5.2, PRD 4.5), sama dengan web
 * admin dan aplikasi. Jaringan putus -> `show_offline`; respons yang tidak dapat dipercaya atau body galat yang bukan
 * kontrak `Error` (HTML 400/404 dari WAF, proxy atau router saat deploy) -> `show_retry`, sehingga TIDAK PERNAH
 * ditafsirkan sebagai jawaban bisnis seperti "QR tidak valid" atau "belum diterbitkan". Pengecualian: 429 tanpa
 * body (limit_req nginx) tetap pembatasan laju karena statusnya tidak ambigu.
 */
export function failureAction(failure: ApiFailure): ErrorUiAction {
  if (failure.kind === "network") return CLIENT_ERROR_UI.NETWORK.action;
  if (failure.kind === "invalid") return CLIENT_ERROR_UI.UNKNOWN.action;
  if (failure.error) return errorUiFor(failure.error.code).action;
  return failure.status === 429 ? ERROR_UI_RATE_LIMITED : CLIENT_ERROR_UI.UNKNOWN.action;
}


/** Kode galat kontrak dari server, atau null bila kegagalan bukan body `Error` yang sah. */
export function failureCode(failure: ApiFailure): string | null {
  return failure.kind === "http" ? (failure.error?.code ?? null) : null;
}

/** Pesan pertama `field_errors[field]` (atau `_`) dari galat validasi. */
export function fieldMessage(error: ApiError | null, field: string): string | null {
  const list = error?.field_errors?.[field] ?? error?.field_errors?.["_"];
  return list && list.length > 0 && typeof list[0] === "string" ? list[0] : null;
}

/** Idempotency-Key UUID v4 (PRD 4.3); memakai crypto.randomUUID bila ada. */
export function newIdempotencyKey(
  cryptoImpl: Pick<Crypto, "getRandomValues"> & Partial<Crypto> = crypto,
): string {
  if (typeof cryptoImpl.randomUUID === "function") return cryptoImpl.randomUUID();
  const b = cryptoImpl.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
