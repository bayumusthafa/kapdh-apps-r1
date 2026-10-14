import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, inject, vi } from "vitest";
import { clearCookies, installCookieJar, nodeMultipartClasses } from "./http";

/**
 * Setup jalur `test:live` (vitest.live.config.ts). Halaman jsdom dipindah ke origin API nyata SEBELUM klien API
 * dimuat (API_BASE_URL bawaan = `${window.location.origin}/api/v1`), dan fetch diberi cookie jar agar cookie refresh
 * HttpOnly berperilaku seperti di peramban. Setiap tes mulai seperti peramban baru: tanpa cookie, token dan
 * penyimpanan lokal.
 */
// Mode `test`/`mock` memakai server tiruan (src/api/client.ts); jalur ini wajib menguji fetch sungguhan.
if (import.meta.env.MODE !== "live")
  throw new Error(
    "Jalur test:live wajib dijalankan dengan --mode live (pnpm --filter @kapdh/admin test:live).",
  );

const { origin } = inject("kapdhLive");
(globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom.reconfigure({
  url: `${origin}/`,
});
installCookieJar(origin);
const multipart = await nodeMultipartClasses();
vi.stubGlobal("FormData", multipart.FormData);
vi.stubGlobal("Blob", multipart.Blob);
vi.stubGlobal("File", multipart.File);

// Sinkronisasi antartab tidak diuji di sini; BroadcastChannel Node akan menahan proses uji tetap hidup.
vi.stubGlobal("BroadcastChannel", undefined);
// jsdom tidak mengimplementasikan scroll; router memanggilnya untuk pemulihan posisi gulir.
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
// Server sungguhan (bcrypt, PGlite, sharp) lebih lambat dari server tiruan.
configure({ asyncUtilTimeout: 20_000 });

const { setAccessToken } = await import("../api/client");

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
  try {
    window.localStorage.clear();
  } catch {
    // abaikan
  }
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});
