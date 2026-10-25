// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicPage, mountInfoPage, pageMetaText, toInfoPageView, type PublicPage } from "./info-page";
import { API, apiError, fakeFetch, flush, json, networkError, text, type Handler } from "./testing";

const PAGE: PublicPage = {
  slug: "kebijakan-privasi",
  title: "Kebijakan Privasi",
  body_html:
    '<h1>Ringkasan</h1><p>Kami tidak mengumpulkan NIK.</p><p><a href="https://contoh.id">Mitra</a></p><script>alert(1)</script><img src="x" onerror="alert(1)">',
  version: "3",
  published_at: "2026-10-01T02:00:00Z",
  legal_document: "privacy",
};

let root: HTMLElement;

beforeEach(() => {
  document.title = "Kebijakan Privasi | KAPDH";
  document.body.innerHTML =
    '<h1 id="info-title">Kebijakan Privasi</h1><p id="info-meta"></p><article id="info-body" data-slug="kebijakan-privasi"></article>';
  root = document.getElementById("info-body")!;
});

afterEach(() => vi.useRealTimers());

function mount(handler: Handler | Handler[], slug = "kebijakan-privasi") {
  const f = fakeFetch({ [`GET /public/pages/${slug}`]: handler });
  const page = mountInfoPage({
    doc: document,
    root,
    apiBase: API,
    slug,
    siteOrigin: "https://kapdh.or.id",
    fetcher: f.fetcher,
  });
  return { page, f };
}

const state = () => root.querySelector("[data-state]")?.getAttribute("data-state");

describe("F-08: halaman legal/informasi dibaca saat runtime dari GET /public/pages/{slug}", () => {
  it("menampilkan judul tayang, versi dan tanggal terbit serta isi yang tersanitasi", async () => {
    const { page } = mount(() => json(200, PAGE));
    await page.load();
    expect(state()).toBe("ready");
    expect(document.getElementById("info-title")!.textContent).toBe("Kebijakan Privasi");
    expect(document.getElementById("info-meta")!.textContent).toBe("Versi 3 · Diterbitkan 1 Oktober 2026");
    expect(document.title).toBe("Kebijakan Privasi | KAPDH");
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.querySelector("h2")!.textContent).toBe("Ringkasan");
    expect(root.querySelector('a[data-external="true"]')!.getAttribute("rel")).toContain("noopener");
  });

  it("loading menampilkan kerangka dan aria-busy", async () => {
    let release: (r: Response) => void = () => {};
    const { page } = mount(() => new Promise<Response>((resolve) => (release = resolve)));
    const pending = page.load();
    expect(state()).toBe("loading");
    expect(root.getAttribute("aria-busy")).toBe("true");
    release(json(200, PAGE));
    await pending;
    expect(root.getAttribute("aria-busy")).toBe("false");
  });

  it("404 berarti belum diterbitkan pengurus (bukan galat jaringan)", async () => {
    const { page } = mount(() => apiError(404, "NOT_FOUND", "Tidak ditemukan"));
    await page.load();
    expect(state()).toBe("not_published");
    expect(root.textContent).toContain("Belum diterbitkan");
    const live = root.querySelector("[data-state='not_published'] [role='status']")!;
    expect(live.textContent).toContain("Belum diterbitkan");
    // Tautan tindakan berada di luar wilayah live (N-11).
    expect(live.querySelector("a")).toBeNull();
    expect(root.querySelector("[data-state='not_published'] a[href='/kontak']")).not.toBeNull();
  });

  it("PRD 5.2: 404 tanpa body Error kontrak (router/proxy saat deploy) -> tidak terjangkau dengan coba lagi, bukan belum diterbitkan", async () => {
    for (const handler of [
      () => text(404, "Not Found", "text/plain"),
      () => text(404, "<html><body>404 Not Found</body></html>"),
      () => json(404, { message: "no route" }),
      () => apiError(404, "INTERNAL_ERROR", "x"),
    ]) {
      const { page } = mount([handler, () => json(200, PAGE)]);
      await page.load();
      expect(state()).toBe("unreachable");
      expect(root.textContent).not.toContain("Belum diterbitkan");
      expect(root.textContent).toContain("Server KAPDH tidak dapat dihubungi");
      root.querySelector("button")!.click();
      await flush();
      expect(state()).toBe("ready");
    }
  });

  it("jaringan putus atau respons non-JSON -> tidak dapat memuat dengan coba lagi yang berhasil", async () => {
    const { page, f } = mount([networkError, () => text(200, "<html>portal</html>"), () => json(200, PAGE)]);
    await page.load();
    expect(state()).toBe("unreachable");
    root.querySelector("button")!.click();
    await flush();
    expect(state()).toBe("unreachable");
    root.querySelector("button")!.click();
    await flush();
    expect(state()).toBe("ready");
    expect(f.calls).toHaveLength(3);
  });

  it("429 menahan coba lagi selama retry_after_seconds", async () => {
    vi.useFakeTimers();
    const { page } = mount(() => apiError(429, "RATE_LIMITED", "Terlalu sering", { retry_after_seconds: 2 }));
    await page.load();
    const button = root.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Coba lagi (0:02)");
    await vi.advanceTimersByTimeAsync(2000);
    expect(button.disabled).toBe(false);
  });

  it("N-11: hitung mundur 429 tidak mengubah wilayah live tiap detik; tombol coba lagi di luar role=status", async () => {
    vi.useFakeTimers();
    const { page } = mount(() =>
      apiError(429, "RATE_LIMITED", "Terlalu sering", { retry_after_seconds: 30 }),
    );
    await page.load();
    const live = root.querySelector<HTMLElement>("[role='status']")!;
    expect(live.textContent).toContain("Terlalu banyak permintaan");
    const button = root.querySelector("button")!;
    expect(button.closest("[role='status'], [role='alert'], [aria-live]")).toBeNull();
    const before = live.textContent;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(live, { subtree: true, childList: true, characterData: true, attributes: true });
    await vi.advanceTimersByTimeAsync(5000);
    observer.disconnect();
    expect(mutations).toHaveLength(0);
    expect(live.textContent).toBe(before);
    // Hitung mundur tetap terlihat pada label tombol.
    expect(button.textContent).toBe("Coba lagi (0:25)");
  });

  it("slug di-encode pada path request", async () => {
    const { page, f } = mount(() => apiError(404, "NOT_FOUND", "x"), "a b");
    await page.load();
    expect(f.calls[0]!.path).toBe("/public/pages/a%20b");
  });
});

describe("naskah statis dari build ([slug].astro) tetap terbaca dan hanya diganti versi lain", () => {
  const STATIC_META = "Versi 3 · Diterbitkan 1 Oktober 2026";

  beforeEach(() => {
    document.getElementById("info-meta")!.textContent = STATIC_META;
    root.innerHTML =
      '<div class="prose-kapdh" data-state="static" data-version="3"><p>Naskah statis versi 3.</p></div>';
  });

  const staticBody = () => root.querySelector<HTMLElement>("[data-version]");

  it("saat memuat tidak ada kerangka loading; versi tayang yang sama dipertahankan apa adanya", async () => {
    const before = staticBody();
    let release: (r: Response) => void = () => {};
    const { page } = mount(() => new Promise<Response>((resolve) => (release = resolve)));
    const pending = page.load();
    expect(state()).toBe("static");
    expect(root.getAttribute("aria-busy")).toBe("false");
    expect(document.getElementById("info-meta")!.textContent).toBe(STATIC_META);
    release(json(200, PAGE));
    await pending;
    expect(staticBody()).toBe(before);
    expect(state()).toBe("ready");
    expect(root.textContent).toBe("Naskah statis versi 3.");
  });

  it("terbitan versi lain menggantikan isi statis tanpa menunggu build ulang", async () => {
    const { page } = mount(() => json(200, { ...PAGE, version: "4", published_at: "2026-10-21T15:59:41Z" }));
    await page.load();
    expect(state()).toBe("ready");
    expect(root.textContent).not.toContain("Naskah statis");
    expect(root.querySelector("h2")!.textContent).toBe("Ringkasan");
    expect(document.getElementById("info-meta")!.textContent).toBe("Versi 4 · Diterbitkan 21 Oktober 2026");
  });

  it.each([
    ["404 belum diterbitkan", () => apiError(404, "NOT_FOUND", "Tidak ditemukan")],
    ["jaringan putus", networkError],
    ["429", () => apiError(429, "RATE_LIMITED", "Terlalu sering", { retry_after_seconds: 30 })],
  ] as const)("%s: isi statis tetap tampil tanpa pemberitahuan galat", async (_label, handler) => {
    const { page } = mount(handler);
    await page.load();
    expect(state()).toBe("static");
    expect(root.textContent).toBe("Naskah statis versi 3.");
    expect(root.querySelector("[role='status'], button")).toBeNull();
    expect(root.getAttribute("aria-busy")).toBe("false");
    expect(document.getElementById("info-meta")!.textContent).toBe(STATIC_META);
  });
});

describe("guard dan teks meta", () => {
  it("menolak bentuk yang tidak sesuai kontrak PublicPage", () => {
    expect(isPublicPage(PAGE)).toBe(true);
    expect(isPublicPage({ ...PAGE, legal_document: "lain" })).toBe(false);
    expect(isPublicPage({ ...PAGE, published_at: "bukan" })).toBe(false);
    expect(isPublicPage({ ...PAGE, body_html: null })).toBe(false);
  });

  it("toInfoPageView memetakan hasil", () => {
    expect(
      toInfoPageView({ ok: false, kind: "network", status: 0, error: null, retryAfterSeconds: null }),
    ).toEqual({
      kind: "unreachable",
      rateLimited: false,
      retryAfterSeconds: null,
    });
    expect(
      toInfoPageView({
        ok: false,
        kind: "http",
        status: 404,
        error: { code: "NOT_FOUND", message: "x", request_id: "r" },
        retryAfterSeconds: null,
      }),
    ).toEqual({ kind: "not_published" });
    expect(
      toInfoPageView({ ok: false, kind: "http", status: 404, error: null, retryAfterSeconds: null }),
    ).toEqual({ kind: "unreachable", rateLimited: false, retryAfterSeconds: null });
    expect(
      toInfoPageView({ ok: false, kind: "http", status: 429, error: null, retryAfterSeconds: 9 }),
    ).toEqual({ kind: "unreachable", rateLimited: true, retryAfterSeconds: 9 });
    expect(pageMetaText({ ...PAGE, version: "12" })).toBe("Versi 12 · Diterbitkan 1 Oktober 2026");
  });
});
