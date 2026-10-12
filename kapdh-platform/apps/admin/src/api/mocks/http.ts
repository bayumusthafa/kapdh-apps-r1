import type { components } from "@kapdh/contracts";

/**
 * Perangkat bersama server tiruan web admin (ARCHITECTURE §7). Setiap area menulis `src/api/mocks/<area>.ts`
 * yang mengekspor `routes` (dan opsional `reset`). Berkas area dimuat otomatis oleh `index.ts`; tidak perlu
 * mendaftarkan apa pun di tempat lain. Bentuk JSON wajib mengikuti kontrak. Mock bukan bukti AC (PRD 7.3).
 */
export type S = components["schemas"];

export interface MockRequest {
  method: string;
  /** Path tanpa awalan /api/v1, mis. "/admin/payments/123". */
  path: string;
  url: URL;
  headers: Headers;
  /** Body JSON yang sudah di-parse (null bila tidak ada/ bukan JSON). */
  body: Record<string, unknown> | null;
  /** Request asli, mis. untuk multipart (`await req.raw.formData()`). */
  raw: Request;
  params: Record<string, string>;
}

export type MockHandler = (req: MockRequest) => Response | Promise<Response>;

export interface MockRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Template path seperti kontrak: "/admin/payments/{paymentId}". */
  path: string;
  handler: MockHandler;
}

export interface MockModule {
  routes?: MockRoute[];
  reset?: () => void;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

let requestCounter = 0;

export function error(
  status: number,
  code: S["ErrorCode"],
  message: string,
  extra: Partial<Pick<S["Error"], "field_errors" | "retry_after_seconds" | "current">> = {},
): Response {
  requestCounter += 1;
  return json(status, { code, message, request_id: `mock-${requestCounter.toString(16)}`, ...extra });
}

/** Cursor opaque tiruan: base64 dari offset. Server asli memakai keyset (ARCHITECTURE §4.2). */
export function encodeCursor(offset: number): string {
  return btoa(`o:${offset}`);
}

export function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const m = /^o:(\d+)$/.exec(atob(cursor));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** Potong daftar sesuai `cursor`/`limit` (bawaan 30, maks 100) dan bentuk halaman admin `{items, next_cursor, total}`. */
export function paginate<T>(items: T[], url: URL): { items: T[]; next_cursor: string | null; total: number } {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
  const offset = decodeCursor(url.searchParams.get("cursor"));
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor(offset + limit) : null;
  return { items: page, next_cursor: next, total: items.length };
}

function compile(template: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = template
    .split("/")
    .map((seg) => {
      const m = /^\{(\w+)\}$/.exec(seg);
      if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      keys.push(m[1]!);
      return "([^/]+)";
    })
    .join("/");
  return { re: new RegExp(`^${source}$`), keys };
}

export interface CompiledRoute extends MockRoute {
  re: RegExp;
  keys: string[];
}

export function compileRoutes(routes: MockRoute[]): CompiledRoute[] {
  return routes.map((r) => ({ ...r, ...compile(r.path) }));
}

export function matchRoute(
  routes: CompiledRoute[],
  method: string,
  path: string,
): { route: CompiledRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
    return { route, params };
  }
  return null;
}
