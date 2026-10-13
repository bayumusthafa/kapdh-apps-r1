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
    expect(root.querySelector("[data-state='not_published']")!.getAttribute("role")).toBe("status");
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

  it("slug di-encode pada path request", async () => {
    const { page, f } = mount(() => apiError(404, "NOT_FOUND", "x"), "a b");
    await page.load();
    expect(f.calls[0]!.path).toBe("/public/pages/a%20b");
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
      retryAfterSeconds: null,
    });
    expect(pageMetaText({ ...PAGE, version: "12" })).toBe("Versi 12 · Diterbitkan 1 Oktober 2026");
  });
});
