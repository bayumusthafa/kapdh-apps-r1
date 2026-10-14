import type { PublicConfig } from "./config";

/**
 * Pembantu uji (hanya diimpor berkas *.test.ts): fetch palsu berbasis rute "METHOD /path" yang mencatat setiap
 * panggilan. Respons mengikuti bentuk kontrak; tidak ada jaringan nyata.
 */

/** PublicConfig contoh sesuai public.yaml. */
export const PUBLIC_CONFIG: PublicConfig = {
  min_app_version: { android: "1.0.0", ios: "1.0.0" },
  maintenance: { active: false, message: null, until: null },
  store_links: {
    android: "https://play.google.com/store/apps/details?id=id.or.kapdh.app",
    ios: null,
  },
  support: { email: "bantuan@kapdh.or.id", whatsapp: "0812-3456-7890" },
  legal: { privacy_version: "1", terms_version: "1", community_version: null },
  server_time: "2026-10-13T00:00:00Z",
};

export interface RecordedCall {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  init: RequestInit;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

export const API = "https://api.test/api/v1";

/**
 * Respons minimal (status, headers, text) yang bodinya langsung tersedia, sehingga uji dengan timer palsu tidak
 * bergantung pada pembacaan stream internal fetch.
 */
export function response(status: number, body: string, headers: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return response(status, JSON.stringify(body), { "content-type": "application/json", ...headers });
}

export function text(status: number, body: string, contentType = "text/html"): Response {
  return response(status, body, { "content-type": contentType });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json(status, { code, message, request_id: "req-test", ...extra });
}

export const networkError: Handler = () => Promise.reject(new TypeError("Failed to fetch"));

/**
 * Setiap rute dapat berupa satu handler atau antrean handler (dipakai berurutan; yang terakhir diulang).
 * Rute yang tidak terdaftar menghasilkan galat uji yang jelas.
 */
export function fakeFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: RecordedCall[] = [];
  const counters = new Map<string, number>();
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const path = url.startsWith(API) ? url.slice(API.length) : url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string> | undefined) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const call: RecordedCall = { method, path, url, headers, body, init };
    calls.push(call);
    const key = `${method} ${path}`;
    const route = routes[key];
    if (!route) throw new Error(`rute uji tidak terdaftar: ${key}`);
    if (Array.isArray(route)) {
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      return route[Math.min(n, route.length - 1)]!(call);
    }
    return route(call);
  }) as typeof fetch;
  return { fetcher, calls, callsTo: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key) };
}

/** Menunggu antrean mikrotask/promise selesai (render setelah await fetch). */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
