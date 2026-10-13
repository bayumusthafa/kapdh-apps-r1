// @vitest-environment jsdom
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
