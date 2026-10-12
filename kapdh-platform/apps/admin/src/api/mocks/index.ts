import { compileRoutes, error, matchRoute, type MockModule } from "./http";

/**
 * Router server tiruan web admin (mode `dev:mock` dan uji, ARCHITECTURE §7). Setiap berkas area
 * `src/api/mocks/<area>.ts` yang mengekspor `routes`/`reset` dimuat otomatis; area baru tidak perlu menyunting
 * berkas ini. Modul ini hanya dimuat lewat import dinamis dari api/client.ts sehingga tidak masuk build produksi.
 */
const modules = import.meta.glob<MockModule>(["./*.ts", "!./index.ts", "!./http.ts", "!./*.test.ts"], {
  eager: true,
});
const ordered = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, m]) => m);
const routes = compileRoutes(ordered.flatMap((m) => m.routes ?? []));

/** Kembalikan semua area tiruan ke keadaan awal (dipanggil di beforeEach uji). */
export function resetMockServer(): void {
  for (const m of ordered) m.reset?.();
}

/** Latensi buatan di dev:mock agar keadaan memuat terlihat; uji berjalan tanpa jeda. */
const LATENCY_MS = import.meta.env.MODE === "mock" ? 250 : 0;

export async function mockFetch(request: Request): Promise<Response> {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname.replace(/^\/api\/v1/, "");
  const match = matchRoute(routes, request.method, path);
  if (LATENCY_MS > 0) await new Promise((r) => setTimeout(r, LATENCY_MS));
  if (!match) return error(404, "NOT_FOUND", "Data tidak ditemukan.");
  const isJson = (request.headers.get("content-type") ?? "").includes("application/json");
  const parsed: unknown =
    request.method !== "GET" && isJson
      ? await request
          .clone()
          .json()
          .catch(() => null)
      : null;
  const body =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  return match.route.handler({
    method: request.method,
    path,
    url,
    headers: request.headers,
    body,
    raw: request,
    params: match.params,
  });
}

export { authRequests, MOCK_CREDENTIALS, mockAuth } from "./auth";
export { mockPayments, paymentRequests } from "./payments";
