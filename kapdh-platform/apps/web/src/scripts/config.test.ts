import { describe, expect, it } from "vitest";
import {
  fetchPublicConfigTimed,
  isPublicConfig,
  mailtoHref,
  safeStoreUrl,
  serverOffsetMs,
  whatsappHref,
} from "./config";
import { API, fakeFetch, json, PUBLIC_CONFIG as CONFIG } from "./testing";

describe("GET /public/config", () => {
  it("guard menerima bentuk kontrak PublicConfig dan menolak yang lain", () => {
    expect(isPublicConfig(CONFIG)).toBe(true);
    expect(isPublicConfig({ ...CONFIG, store_links: null })).toBe(false);
    expect(isPublicConfig({ ...CONFIG, support: { email: 1, whatsapp: null } })).toBe(false);
    expect(isPublicConfig({ ...CONFIG, server_time: undefined })).toBe(false);
    expect(isPublicConfig("<html>")).toBe(false);
  });

  it("mengukur waktu tempuh untuk selisih jam server", async () => {
    const f = fakeFetch({ "GET /public/config": () => json(200, CONFIG) });
    let t = 1_000;
    const timed = await fetchPublicConfigTimed(API, f.fetcher, () => (t += 100));
    expect(timed.result.ok).toBe(true);
    expect(timed.receivedAt - timed.sentAt).toBe(100);
  });
});

describe("tautan toko dan kontak (PRD 4.6, 8.3)", () => {
  it("tautan toko hanya https tanpa kredensial", () => {
    expect(safeStoreUrl("https://apps.apple.com/id/app/kapdh/id1")).toBe(
      "https://apps.apple.com/id/app/kapdh/id1",
    );
    expect(safeStoreUrl("http://play.google.com/x")).toBeNull();
    expect(safeStoreUrl("javascript:alert(1)")).toBeNull();
    expect(safeStoreUrl("https://user:pw@evil.example")).toBeNull();
    expect(safeStoreUrl(null)).toBeNull();
    expect(safeStoreUrl("bukan url")).toBeNull();
  });

  it("mailto hanya untuk alamat sederhana (tanpa sisipan header)", () => {
    expect(mailtoHref(" bantuan@kapdh.or.id ")).toBe("mailto:bantuan@kapdh.or.id");
    expect(mailtoHref("a@b.co?bcc=x@y.z")).toBeNull();
    expect(mailtoHref("bukan-email")).toBeNull();
  });

  it("nomor WhatsApp lokal 08xx dan internasional menjadi wa.me", () => {
    expect(whatsappHref("0812-3456-7890")).toBe("https://wa.me/6281234567890");
    expect(whatsappHref("+62 812 3456 7890")).toBe("https://wa.me/6281234567890");
    expect(whatsappHref("6281234567890")).toBe("https://wa.me/6281234567890");
    expect(whatsappHref("(021) 555-1234")).toBe("https://wa.me/62215551234");
    expect(whatsappHref("wa.me/62812")).toBeNull();
    expect(whatsappHref("123")).toBeNull();
    expect(whatsappHref(null)).toBeNull();
  });

  it("selisih jam server memakai titik tengah waktu tempuh", () => {
    const server = Date.parse("2026-10-13T00:00:10Z");
    const sent = Date.parse("2026-10-13T00:00:00Z");
    expect(serverOffsetMs("2026-10-13T00:00:10Z", sent, sent + 2000)).toBe(server - (sent + 1000));
    expect(serverOffsetMs("rusak", sent, sent)).toBeNull();
  });
});
