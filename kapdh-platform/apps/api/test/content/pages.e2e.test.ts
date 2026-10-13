import { appSettings, auditLogs } from "@kapdh/database";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_PAGES_LIMIT } from "../../src/modules/content/public-pages.controller.js";
import { expectOperation } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminSession, unique } from "./support.js";

/**
 * Halaman informasi dan legal berversi (F-08, F-01, PRD 3.8, 6.2): draf terpisah dari salinan tayang, terbit dalam
 * satu UPDATE bersyarat dengan versi legal naik, app_settings.legal dicerminkan, audit `page.published` menyimpan
 * teks tayang utuh, dan halaman tayang dapat dibaca tanpa login.
 */

let t: TestApp;
let admin: Awaited<ReturnType<typeof adminSession>>;

beforeAll(async () => {
  t = await createTestApp();
  admin = await adminSession(t, ["content.manage"]);
});
afterAll(async () => {
  await t.app.close();
});

type AdminInfoPage = {
  id: string;
  slug: string;
  title: string;
  body_html: string;
  version: string;
  system: boolean;
  legal_document: string | null;
  published_version: string | null;
  has_unpublished_changes: boolean;
  slug_locked: boolean;
  published: { title: string; body_html: string; version: string; published_at: string } | null;
};

const api = () => httpClient(t.app);

async function adminPages(query: Record<string, string> = {}) {
  const res = await api().get("/admin/content/pages", { token: admin.token, query });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/admin/content/pages", res) as {
    items: AdminInfoPage[];
    next_cursor: string | null;
    total: number;
  };
}

async function pageBySlug(slug: string): Promise<AdminInfoPage> {
  const list = await adminPages({ q: slug });
  const summary = list.items.find((p) => p.slug === slug)!;
  const res = await api().get(`/admin/content/pages/${summary.id}`, { token: admin.token });
  return expectOperation("get", "/admin/content/pages/{pageId}", res) as AdminInfoPage;
}

async function saveDraft(page: AdminInfoPage, body: Record<string, unknown>) {
  const res = await api().patch(`/admin/content/pages/${page.id}`, body, {
    token: admin.token,
    headers: { "if-match": page.version },
  });
  expectOperation("patch", "/admin/content/pages/{pageId}", res);
  return res;
}

async function publish(page: AdminInfoPage, changeNote?: string) {
  const res = await api().post(
    `/admin/content/pages/${page.id}/publish`,
    changeNote ? { change_note: changeNote } : {},
    { token: admin.token, headers: { "if-match": page.version } },
  );
  expectOperation("post", "/admin/content/pages/{pageId}/publish", res);
  return res;
}

async function legalSetting() {
  const [row] = await t.db.select().from(appSettings).where(eq(appSettings.key, "legal"));
  return row!.value as Record<string, string | null>;
}

describe("F-08, F-01: halaman baku dari seed dan alur draf -> terbit", () => {
  it("PRD 8.2: halaman baku urut system_first, berstatus draf, slug terkunci; belum tayang publik", async () => {
    const list = await adminPages();
    expect(list.items.slice(0, 5).map((p) => p.slug)).toEqual([
      "kebijakan-privasi",
      "ketentuan",
      "ketentuan-komunitas",
      "bantuan",
      "tentang",
    ]);
    expect(list.items[0]).toMatchObject({
      system: true,
      legal_document: "privacy",
      published_version: null,
      has_unpublished_changes: true,
    });
    const publicList = await api().get("/public/pages");
    expect(expectOperation("get", "/public/pages", publicList)).toEqual({
      items: [],
      consent: { policy_version: null, privacy_version: null, terms_version: null },
    });
    const missing = await api().get("/public/pages/kebijakan-privasi");
    expect(missing.statusCode).toBe(404);
    expectOperation("get", "/public/pages/{slug}", missing);
  });

  it("F-01: terbit menyalin draf, versi legal naik, app_settings.legal dicerminkan, audit menyimpan teks utuh", async () => {
    let privacy = await pageBySlug("kebijakan-privasi");
    // Naskah panjang (> batas audit biasa 16 KB) tetap tersimpan utuh di audit page.published.
    const paragraph = `<p>${"Data pribadi anggota dilindungi sesuai kebijakan KAPDH. ".repeat(20)}</p>`;
    const longBody = `<h2>Kebijakan Privasi</h2>${paragraph.repeat(30)}<script>alert(1)</script>`;
    const saved = await saveDraft(privacy, { title: "Kebijakan Privasi KAPDH", body_html: longBody });
    expect(saved.statusCode).toBe(200);
    privacy = saved.json();
    expect(privacy.body_html).not.toContain("script");
    expect(privacy).toMatchObject({ published: null, published_version: null, has_unpublished_changes: true });
    // Draf tidak pernah terlihat publik sebelum terbit.
    expect((await api().get("/public/pages/kebijakan-privasi")).statusCode).toBe(404);

    const published = await publish(privacy, "Naskah awal disahkan pengurus");
    expect(published.statusCode).toBe(200);
    const page = published.json() as AdminInfoPage;
    expect(page).toMatchObject({
      published_version: "1",
      has_unpublished_changes: false,
      slug_locked: true,
      published: { title: "Kebijakan Privasi KAPDH", body_html: privacy.body_html, version: "1" },
    });
    expect(Number(page.version)).toBe(Number(privacy.version) + 1);
    expect(await legalSetting()).toMatchObject({ privacy_version: "1", terms_version: null });

    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, page.id), eq(auditLogs.action, "page.published")));
    expect(audit).toMatchObject({ reason: "Naskah awal disahkan pengurus", actorAdminId: admin.adminId });
    expect(audit!.after).toMatchObject({
      published_version: 1,
      legal_document: "privacy",
      title: "Kebijakan Privasi KAPDH",
      body_html: privacy.body_html,
    });
    expect(privacy.body_html.length).toBeGreaterThan(16 * 1024);
    const settingsAudit = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, "legal"), eq(auditLogs.action, "settings.updated")));
    expect(settingsAudit).toHaveLength(1);

    const publicPage = await api().get("/public/pages/kebijakan-privasi");
    expect(expectOperation("get", "/public/pages/{slug}", publicPage)).toMatchObject({
      slug: "kebijakan-privasi",
      title: "Kebijakan Privasi KAPDH",
      body_html: privacy.body_html,
      version: "1",
      legal_document: "privacy",
    });
    // Persetujuan registrasi baru tersedia setelah privasi DAN ketentuan terbit (F-01).
    expect((await api().get("/public/pages")).json().consent).toEqual({
      policy_version: null,
      privacy_version: "1",
      terms_version: null,
    });
    const terms = await pageBySlug("ketentuan");
    expect((await publish(terms)).statusCode).toBe(200);
    expect((await api().get("/public/pages")).json().consent).toEqual({
      policy_version: "privacy:1;terms:1",
      privacy_version: "1",
      terms_version: "1",
    });
  });

  it("F-01: tanpa perubahan -> 409 VALIDATION_ERROR; draf baru tidak tayang sampai terbit; versi lama dapat direproduksi", async () => {
    let privacy = await pageBySlug("kebijakan-privasi");
    const firstText = privacy.published!.body_html;
    const noChange = await publish(privacy);
    expect(noChange.statusCode).toBe(409);
    expect(noChange.json()).toMatchObject({ code: "VALIDATION_ERROR", field_errors: { _: expect.any(Array) } });
    expect(await legalSetting()).toMatchObject({ privacy_version: "1" });

    privacy = (await saveDraft(privacy, { body_html: "<p>Versi kedua kebijakan privasi.</p>" })).json();
    expect(privacy).toMatchObject({ has_unpublished_changes: true, published_version: "1" });
    expect((await api().get("/public/pages/kebijakan-privasi")).json().body_html).toBe(firstText);

    const stale = await api().post(
      `/admin/content/pages/${privacy.id}/publish`,
      {},
      { token: admin.token, headers: { "if-match": String(Number(privacy.version) - 1) } },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT", current: { id: privacy.id } });

    const second = (await publish(privacy)).json() as AdminInfoPage;
    expect(second.published).toMatchObject({ version: "2", body_html: "<p>Versi kedua kebijakan privasi.</p>" });
    expect(await legalSetting()).toMatchObject({ privacy_version: "2", terms_version: "1" });
    expect((await api().get("/public/pages")).json().consent.policy_version).toBe("privacy:2;terms:1");

    const history = await t.db
      .select({ after: auditLogs.after })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, privacy.id), eq(auditLogs.action, "page.published")))
      .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id));
    expect(history.map((h) => (h.after as { published_version: number }).published_version)).toEqual([1, 2]);
    expect((history[0]!.after as { body_html: string }).body_html).toBe(firstText);
  });

  it("PRD 3.8: daftar publik urut dokumen legal lebih dahulu lalu halaman lain menurut judul", async () => {
    for (const slug of ["tentang", "ketentuan-komunitas", "bantuan"]) {
      const page = await pageBySlug(slug);
      expect((await publish(page)).statusCode).toBe(200);
    }
    const res = await api().get("/public/pages");
    const body = expectOperation("get", "/public/pages", res) as {
      items: { slug: string; legal_document: string | null }[];
    };
    expect(body.items.map((p) => p.slug)).toEqual([
      "kebijakan-privasi",
      "ketentuan",
      "ketentuan-komunitas",
      "bantuan",
      "tentang",
    ]);
    expect(body.items.map((p) => p.legal_document)).toEqual(["privacy", "terms", "community", null, null]);
    expect(await legalSetting()).toMatchObject({ community_version: "1" });
    const long = await api().get(`/public/pages/${"a".repeat(121)}`);
    expect(long.statusCode).toBe(400);
    expectOperation("get", "/public/pages/{slug}", long);
  });
});

describe("F-08: halaman informasi buatan pengurus", () => {
  it("F-08: halaman baru draf; slug unik (409); slug dapat diubah sebelum terbit lalu terkunci", async () => {
    const slug = unique("info");
    const created = await api().post(
      "/admin/content/pages",
      { slug, title: "Info Iuran", body_html: "<p>Cara bayar iuran.</p>" },
      { token: admin.token },
    );
    expect(created.statusCode).toBe(201);
    let page = expectOperation("post", "/admin/content/pages", created) as AdminInfoPage;
    expect(page).toMatchObject({ system: false, legal_document: null, slug_locked: false, published: null });
    const duplicate = await api().post(
      "/admin/content/pages",
      { slug, title: "Lain", body_html: "<p>x</p>" },
      { token: admin.token },
    );
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().field_errors.slug).toBeDefined();

    const renamed = unique("info-baru");
    page = (await saveDraft(page, { slug: renamed })).json();
    expect(page.slug).toBe(renamed);
    page = (await publish(page)).json();
    expect(page.slug_locked).toBe(true);
    const locked = await saveDraft(page, { slug: unique("x") });
    expect(locked.statusCode).toBe(400);
    expect((await api().get(`/public/pages/${renamed}`)).json()).toMatchObject({ legal_document: null, version: "1" });

    const systemPage = await pageBySlug("bantuan");
    const systemSlug = await saveDraft(systemPage, { slug: "bantuan-baru" });
    expect(systemSlug.statusCode).toBe(400);
  });

  it("PRD 8.2: halaman baku tidak dapat dihapus (409); halaman lain dihapus dengan If-Match (204)", async () => {
    const systemPage = await pageBySlug("tentang");
    const refused = await api().delete(`/admin/content/pages/${systemPage.id}`, {
      token: admin.token,
      headers: { "if-match": systemPage.version },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("VALIDATION_ERROR");
    expectOperation("delete", "/admin/content/pages/{pageId}", refused);

    const created = (
      await api().post(
        "/admin/content/pages",
        { slug: unique("hapus"), title: "Sementara", body_html: "<p>x</p>" },
        { token: admin.token },
      )
    ).json() as AdminInfoPage;
    const stale = await api().delete(`/admin/content/pages/${created.id}`, {
      token: admin.token,
      headers: { "if-match": "99" },
    });
    expect(stale.statusCode).toBe(409);
    const removed = await api().delete(`/admin/content/pages/${created.id}`, {
      token: admin.token,
      headers: { "if-match": created.version },
    });
    expect(removed.statusCode).toBe(204);
    expectOperation("delete", "/admin/content/pages/{pageId}", removed);
    expect((await api().get(`/admin/content/pages/${created.id}`, { token: admin.token })).statusCode).toBe(404);
  });

  it("F-15: tabel halaman mendukung pencarian, semua urutan dan paging tanpa duplikasi", async () => {
    for (const sort of ["system_first", "title_asc", "updated_at_desc", "published_at_desc"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let total = 0;
      do {
        const page = await adminPages({ sort, limit: "2", ...(cursor ? { cursor } : {}) });
        total = page.total;
        seen.push(...page.items.map((p) => p.id));
        cursor = page.next_cursor;
      } while (cursor);
      expect(new Set(seen).size, sort).toBe(total);
    }
    expect((await adminPages({ q: "ketentuan" })).total).toBe(2);
  });
});

describe("PRD 3.8: halaman publik dibatasi rate limit per IP", () => {
  it("PRD 2.5: melewati batas per IP -> 429 RATE_LIMITED dengan retry_after_seconds", async () => {
    for (let i = 0; i < PUBLIC_PAGES_LIMIT; i++)
      expect((await api().get("/public/pages/kebijakan-privasi")).statusCode).toBe(200);
    const limited = await api().get("/public/pages");
    expect(limited.statusCode).toBe(429);
    expect(limited.json().retry_after_seconds).toBeGreaterThan(0);
    expectOperation("get", "/public/pages", limited);
  });
});
