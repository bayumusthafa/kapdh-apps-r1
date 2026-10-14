// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMaintenance, applyStoreLinks, applySupport, mountConfigConsumers } from "./config-page";
import { API, fakeFetch, json, networkError, PUBLIC_CONFIG as CONFIG } from "./testing";

const MARKUP = `
  <div data-maintenance hidden><span data-maintenance-text></span></div>
  <a data-store="android" aria-disabled="true"><span data-store-status>Memuat tautan…</span></a>
  <a data-store="ios" aria-disabled="true"><span data-store-status>Memuat tautan…</span></a>
  <p data-store-note hidden><button type="button" data-config-retry>Coba lagi</button></p>
  <a data-support-email href="mailto:bantuan@kapdh.or.id">bantuan@kapdh.or.id</a>
  <p data-support-pending>Memuat kontak terbaru…</p>
  <p data-support-whatsapp hidden><a></a></p>
`;

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
});

describe("tombol toko dari /public/config (PRD 4.6)", () => {
  it("mengisi tautan yang tersedia dan menandai yang belum sebagai Segera tersedia", () => {
    applyStoreLinks(document, CONFIG, false);
    const android = $<HTMLAnchorElement>('a[data-store="android"]');
    const ios = $<HTMLAnchorElement>('a[data-store="ios"]');
    expect(android.href).toBe(CONFIG.store_links.android);
    expect(android.hasAttribute("aria-disabled")).toBe(false);
    expect(ios.hasAttribute("href")).toBe(false);
    expect(ios.getAttribute("aria-disabled")).toBe("true");
    expect(ios.textContent).toContain("Segera tersedia");
    expect($("[data-store-note]").hidden).toBe(true);
  });

  it("gagal memuat: tautan tetap nonaktif dan tombol coba lagi tampil", () => {
    applyStoreLinks(document, null, true);
    expect($('a[data-store="android"]').textContent).toContain("Tautan belum dapat dimuat");
    expect($("[data-store-note]").hidden).toBe(false);
  });

  it("tautan non-https dari konfigurasi tidak pernah dipasang", () => {
    applyStoreLinks(
      document,
      { ...CONFIG, store_links: { android: "javascript:alert(1)", ios: "http://x.y" } },
      false,
    );
    expect($('a[data-store="android"]').hasAttribute("href")).toBe(false);
    expect($('a[data-store="ios"]').hasAttribute("href")).toBe(false);
  });
});

describe("kontak bantuan (PRD 8.3)", () => {
  it("memakai email dan WhatsApp dari konfigurasi", () => {
    applySupport(document, {
      ...CONFIG,
      support: { email: "pengurus@kapdh.or.id", whatsapp: "0812-3456-7890" },
    });
    expect($<HTMLAnchorElement>("a[data-support-email]").href).toBe("mailto:pengurus@kapdh.or.id");
    expect($("a[data-support-email]").textContent).toBe("pengurus@kapdh.or.id");
    const wa = $("[data-support-whatsapp]");
    expect(wa.hidden).toBe(false);
    expect($<HTMLAnchorElement>("[data-support-whatsapp] a").href).toBe("https://wa.me/6281234567890");
    expect($("[data-support-pending]").hidden).toBe(true);
  });

  it("tanpa konfigurasi: email baku bantuan@kapdh.or.id, WhatsApp disembunyikan", () => {
    applySupport(document, null);
    expect($("a[data-support-email]").textContent).toBe("bantuan@kapdh.or.id");
    expect($("[data-support-whatsapp]").hidden).toBe(true);
  });
});

describe("banner maintenance (PRD 4.5)", () => {
  it("menampilkan perkiraan selesai dan pesan pengurus", () => {
    applyMaintenance(document, {
      ...CONFIG,
      maintenance: { active: true, message: "Peningkatan server.", until: "2026-10-13T03:00:00Z" },
    });
    expect($("[data-maintenance]").hidden).toBe(false);
    expect($("[data-maintenance-text]").textContent).toContain("13 Okt 2026, 10.00 WIB");
    expect($("[data-maintenance-text]").textContent).toContain("Peningkatan server.");
  });

  it("tersembunyi bila tidak aktif", () => {
    applyMaintenance(document, CONFIG);
    expect($("[data-maintenance]").hidden).toBe(true);
  });
});

describe("mountConfigConsumers", () => {
  it("memuat ulang lewat tombol coba lagi setelah gagal", async () => {
    const f = fakeFetch({ "GET /public/config": [networkError, () => json(200, CONFIG)] });
    await mountConfigConsumers(document, API, f.fetcher);
    expect($("[data-store-note]").hidden).toBe(false);
    $<HTMLButtonElement>("[data-config-retry]").click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect($<HTMLAnchorElement>('a[data-store="android"]').href).toBe(CONFIG.store_links.android);
    expect(f.callsTo("GET /public/config")).toHaveLength(2);
  });

  it("memakai permintaan yang sudah dimulai halaman (tanpa request kedua)", async () => {
    const f = fakeFetch({ "GET /public/config": () => json(200, CONFIG) });
    await mountConfigConsumers(
      document,
      API,
      f.fetcher,
      Promise.resolve({ ok: true, status: 200, data: CONFIG }),
    );
    expect(f.calls).toHaveLength(0);
    expect($<HTMLAnchorElement>('a[data-store="android"]').href).toBe(CONFIG.store_links.android);
  });
});

/** Markup banner maintenance (Base.astro) dan kartu WhatsApp halaman kontak (kontak.astro). */
const KONTAK_MARKUP = `
  <div data-maintenance hidden role="status">
    <span data-maintenance-text></span>
    <span>Butuh bantuan? Hubungi
      <a data-support-email href="mailto:bantuan@kapdh.or.id">bantuan@kapdh.or.id</a><span data-support-whatsapp hidden>
      atau WhatsApp <a></a></span>.
      <button type="button" data-config-retry data-maintenance-retry>Periksa lagi</button>
    </span>
  </div>
  <a data-support-email id="kontak-email" href="mailto:bantuan@kapdh.or.id">bantuan@kapdh.or.id</a>
  <p data-support-pending>Memuat kontak terbaru…</p>
  <p data-support-error hidden>Kontak terbaru belum dapat dimuat.
    <button type="button" data-config-retry id="kontak-retry">Coba lagi</button></p>
  <p data-support-whatsapp id="kontak-wa" hidden><a></a></p>
`;

const MAINTENANCE = {
  ...CONFIG,
  maintenance: { active: true, message: "Peningkatan server.", until: "2026-10-13T03:00:00Z" },
};

async function settleClicks() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("PRD 4.5: keadaan gagal dan maintenance punya pesan, retry dan kanal dukungan", () => {
  beforeEach(() => {
    document.body.innerHTML = KONTAK_MARKUP;
  });

  it("PRD 4.5: banner maintenance memuat rentang estimasi, retry dan kanal dukungan dari konfigurasi", async () => {
    const f = fakeFetch({ "GET /public/config": [() => json(200, MAINTENANCE), () => json(200, CONFIG)] });
    await mountConfigConsumers(document, API, f.fetcher);
    const banner = $("[data-maintenance]");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("Perkiraan selesai 13 Okt 2026, 10.00 WIB");
    expect(banner.textContent).toContain("Coba lagi setelah pemeliharaan selesai.");
    expect(banner.querySelector<HTMLAnchorElement>("a[data-support-email]")!.href).toBe(
      "mailto:bantuan@kapdh.or.id",
    );
    const wa = banner.querySelector<HTMLElement>("[data-support-whatsapp]")!;
    expect(wa.hidden).toBe(false);
    expect(wa.querySelector<HTMLAnchorElement>("a")!.href).toBe("https://wa.me/6281234567890");
    // Periksa lagi: pemeliharaan selesai -> banner hilang.
    banner.querySelector<HTMLButtonElement>("[data-maintenance-retry]")!.click();
    await settleClicks();
    expect(f.callsTo("GET /public/config")).toHaveLength(2);
    expect(banner.hidden).toBe(true);
  });

  it("PRD 4.5: memeriksa ulang yang gagal tidak menghapus banner dan kontak yang sudah tampil", async () => {
    const f = fakeFetch({ "GET /public/config": [() => json(200, MAINTENANCE), networkError] });
    await mountConfigConsumers(document, API, f.fetcher);
    $<HTMLButtonElement>("[data-maintenance-retry]").click();
    await settleClicks();
    expect(f.callsTo("GET /public/config")).toHaveLength(2);
    expect($("[data-maintenance]").hidden).toBe(false);
    expect($("#kontak-wa").hidden).toBe(false);
    expect($("[data-support-error]").hidden).toBe(true);
  });

  it("PRD 4.5/8.3: /kontak gagal memuat konfigurasi -> pesan 'Kontak terbaru belum dapat dimuat' dan coba lagi yang berhasil", async () => {
    const f = fakeFetch({ "GET /public/config": [networkError, () => json(200, CONFIG)] });
    await mountConfigConsumers(document, API, f.fetcher);
    expect($("[data-support-pending]").hidden).toBe(true);
    const error = $("[data-support-error]");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("Kontak terbaru belum dapat dimuat");
    // Email baku tetap dapat dipakai.
    expect($<HTMLAnchorElement>("#kontak-email").href).toBe("mailto:bantuan@kapdh.or.id");
    expect($("#kontak-wa").hidden).toBe(true);
    $<HTMLButtonElement>("#kontak-retry").click();
    await settleClicks();
    expect(error.hidden).toBe(true);
    expect($("#kontak-wa").hidden).toBe(false);
    expect($<HTMLAnchorElement>("#kontak-wa a").textContent).toBe("0812-3456-7890");
  });

  it("markup Base.astro dan kontak.astro memuat kait yang diisi config-page.ts", () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const base = read("../layouts/Base.astro");
    const banner = base.slice(base.indexOf("data-maintenance hidden"), base.indexOf("<main"));
    for (const hook of [
      "data-maintenance-text",
      "data-support-email",
      "data-support-whatsapp",
      "data-config-retry",
    ]) {
      expect(banner).toContain(hook);
    }
    const kontak = read("../pages/kontak.astro");
    const errorBlock = kontak.slice(
      kontak.indexOf("data-support-error"),
      kontak.indexOf("data-support-whatsapp"),
    );
    expect(errorBlock).toContain("Kontak terbaru belum dapat dimuat");
    expect(errorBlock).toContain("data-config-retry");
  });
});
