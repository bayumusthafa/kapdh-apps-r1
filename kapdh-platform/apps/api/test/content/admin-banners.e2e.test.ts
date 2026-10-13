import { auditLogs, files, posts } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  adminSession,
  insertCategory,
  insertEvent,
  insertPost,
  uploadContentMedia,
  unique,
} from "./support.js";

/**
 * Banner Beranda untuk pengurus (F-08, AC F08-2, F15-4, guideline p13 tab Banner): target tervalidasi, jendela tayang,
 * state turunan, kolom kategori dari target, If-Match, dan pembersihan gambar yang dilepas.
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

type AdminBanner = {
  id: string;
  title: string;
  version: string;
  state: string;
  image: { file_id: string; url: string };
  target: {
    type: string;
    value: string | null;
    available: boolean;
    label: string | null;
    route: string | null;
    category: unknown;
  };
};

const api = () => httpClient(t.app);

/**
 * Membuat banner. Gambar banner hanya dapat dilampirkan oleh pengurus pengunggahnya dan kuota N-10 adalah 10 per
 * purpose per admin per 24 jam, sehingga tanpa `as` setiap banner dibuat pengurus baru yang mengunggah gambarnya.
 */
async function createBanner(body: Record<string, unknown>, as?: { token: string }) {
  const who = as ?? (await adminSession(t, ["content.manage"]));
  const token = who.token;
  const imageId =
    (body.image_file_id as string | undefined) ??
    (await uploadContentMedia(t, token, "banner_image")).file_id;
  const res = await api().post(
    "/admin/content/banners",
    {
      title: "Banner Uji",
      image_file_id: imageId,
      target_type: "none",
      target_value: null,
      starts_at: new Date(t.clock.now().getTime() - 60_000).toISOString(),
      ...body,
    },
    { token },
  );
  expectOperation("post", "/admin/content/banners", res);
  return res;
}

describe("AC F08-2: target banner tervalidasi saat disimpan", () => {
  it("AC F08-2: setiap jenis target yang sah diterima dan diselesaikan (label, rute, kategori tujuan)", async () => {
    const category = await insertCategory(t, { kind: "post", label: "Kabar" });
    const post = await insertPost(t, { categoryId: category.id, title: "Kabar Reuni" });
    const eventCategory = await insertCategory(t, { kind: "event", label: "Kajian" });
    const event = await insertEvent(t, { categoryId: eventCategory.id, title: "Kajian Akbar" });
    const cases: [string, string | null, Record<string, unknown>][] = [
      ["none", null, { value: null, available: true, label: null, route: null, category: null }],
      [
        "post",
        post.id,
        {
          value: post.id,
          available: true,
          label: "Kabar Reuni",
          route: `/news/${post.slug}`,
          category: { id: category.id, slug: category.slug, label: "Kabar" },
        },
      ],
      [
        "event",
        event.id.toUpperCase(),
        {
          value: event.id,
          available: true,
          label: "Kajian Akbar",
          route: `/events/${event.id}`,
          category: { id: eventCategory.id, slug: eventCategory.slug, label: "Kajian" },
        },
      ],
      [
        "page",
        "bantuan",
        { value: "bantuan", available: false, label: "Bantuan", route: null, category: null },
      ],
      [
        "url",
        "https://kapdh.or.id/donasi",
        { value: "https://kapdh.or.id/donasi", available: true, label: null, route: null, category: null },
      ],
    ];
    for (const [type, value, expected] of cases) {
      const res = await createBanner({ target_type: type, target_value: value });
      expect(res.statusCode, `${type}: ${res.body}`).toBe(201);
      const banner = res.json() as AdminBanner;
      expect(banner.target).toEqual({ type, ...expected });
      expect(banner).toMatchObject({ state: "live", version: "1" });
      const [file] = await t.db.select().from(files).where(eq(files.id, banner.image.file_id));
      expect(file!.attachedAt).not.toBeNull();
    }
  });

  it("AC F08-2: target tidak sah, jendela terbalik dan gambar salah jenis ditolak 400 dengan field_errors", async () => {
    const image = (await uploadContentMedia(t, admin.token, "banner_image")).file_id;
    const invalid: [Record<string, unknown>, string][] = [
      [{ target_type: "none", target_value: "x" }, "target_value"],
      [{ target_type: "post", target_value: uuidv7() }, "target_value"],
      [{ target_type: "post", target_value: "bukan-uuid" }, "target_value"],
      [{ target_type: "event", target_value: uuidv7() }, "target_value"],
      [{ target_type: "page", target_value: "halaman-tidak-ada" }, "target_value"],
      [{ target_type: "url", target_value: "http://kapdh.or.id" }, "target_value"],
      [{ target_type: "url", target_value: "javascript:alert(1)" }, "target_value"],
      [{ target_type: "url", target_value: "https://u:p@kapdh.or.id" }, "target_value"],
      [
        {
          starts_at: t.clock.now().toISOString(),
          ends_at: new Date(t.clock.now().getTime() - 1000).toISOString(),
        },
        "ends_at",
      ],
      [{ target_type: "lain" }, "target_type"],
    ];
    for (const [body, field] of invalid) {
      const res = await createBanner({ ...body, image_file_id: image }, admin);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().field_errors[field], JSON.stringify(body)).toBeDefined();
    }
    const cover = await uploadContentMedia(t, admin.token, "post_cover");
    const wrongImage = await createBanner({ image_file_id: cover.file_id }, admin);
    expect(wrongImage.statusCode).toBe(400);
    expect(wrongImage.json().field_errors.image_file_id).toBeDefined();
    // Gambar belum terpakai oleh percobaan yang gagal.
    const [file] = await t.db.select().from(files).where(eq(files.id, image));
    expect(file!.attachedAt).toBeNull();
  });
});

describe("AC F15-4: banner diubah/dihapus dengan If-Match", () => {
  it("AC F15-4: versi lama 409 dengan current; target wajib dikirim berpasangan; gambar lama dibuang saat diganti", async () => {
    const created = (await createBanner({})).json() as AdminBanner;
    const unpaired = await api().patch(
      `/admin/content/banners/${created.id}`,
      { target_type: "url" },
      { token: admin.token, headers: { "if-match": created.version } },
    );
    expect(unpaired.statusCode).toBe(400);
    expectOperation("patch", "/admin/content/banners/{bannerId}", unpaired);

    const newImage = await uploadContentMedia(t, admin.token, "banner_image");
    const updated = await api().patch(
      `/admin/content/banners/${created.id}`,
      {
        title: "Banner Baru",
        target_type: "url",
        target_value: "https://kapdh.or.id/info",
        image_file_id: newImage.file_id,
        active: false,
        sort_order: 5,
      },
      { token: admin.token, headers: { "if-match": created.version } },
    );
    expect(updated.statusCode, updated.body).toBe(200);
    expect(expectOperation("patch", "/admin/content/banners/{bannerId}", updated)).toMatchObject({
      title: "Banner Baru",
      state: "inactive",
      version: "2",
      image: { file_id: newImage.file_id },
      target: { type: "url", value: "https://kapdh.or.id/info" },
    });
    const [old] = await t.db.select().from(files).where(eq(files.id, created.image.file_id));
    expect(old!.status).toBe("deleted");

    const stale = await api().patch(
      `/admin/content/banners/${created.id}`,
      { title: "Menimpa" },
      { token: admin.token, headers: { "if-match": created.version } },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { title: "Banner Baru", version: "2" },
    });

    const window = await api().patch(
      `/admin/content/banners/${created.id}`,
      { ends_at: new Date(t.clock.now().getTime() - 3600_000).toISOString() },
      { token: admin.token, headers: { "if-match": "2" } },
    );
    expect(window.statusCode).toBe(400);
    expect(window.json().field_errors.ends_at).toBeDefined();

    const removed = await api().delete(`/admin/content/banners/${created.id}`, {
      token: admin.token,
      headers: { "if-match": "2" },
    });
    expect(removed.statusCode).toBe(204);
    expectOperation("delete", "/admin/content/banners/{bannerId}", removed);
    const [image] = await t.db.select().from(files).where(eq(files.id, newImage.file_id));
    expect(image!.status).toBe("deleted");
    const audits = await t.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, "banner"), eq(auditLogs.entityId, created.id)));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "banner.created",
      "banner.deleted",
      "banner.updated",
    ]);
    expect((await api().get(`/admin/content/banners/${created.id}`, { token: admin.token })).statusCode).toBe(
      404,
    );
  });

  it("AC F08-2: berita tujuan dihapus/diarsipkan -> pengurus melihat available=false", async () => {
    const post = await insertPost(t);
    const banner = (await createBanner({ target_type: "post", target_value: post.id })).json() as AdminBanner;
    expect(banner.target.available).toBe(true);
    await t.db.update(posts).set({ status: "archived" }).where(eq(posts.id, post.id));
    const archived = await api().get(`/admin/content/banners/${banner.id}`, { token: admin.token });
    expect(expectOperation("get", "/admin/content/banners/{bannerId}", archived)).toMatchObject({
      target: { available: false, route: null, label: post.title },
    });
    await t.db.delete(posts).where(eq(posts.id, post.id));
    const deleted = await api().get(`/admin/content/banners/${banner.id}`, { token: admin.token });
    expect(deleted.json().target).toMatchObject({ available: false, label: null, category: null });
  });
});

describe("F-15: tabel banner dengan state, pencarian, urutan dan paging server", () => {
  it("F-15: state turunan (inactive/scheduled/live/ended), q, total dan paging tanpa duplikasi", async () => {
    const marker = unique("penanda-banner");
    const now = t.clock.now().getTime();
    const states: [string, Record<string, unknown>][] = [
      ["live", {}],
      ["scheduled", { starts_at: new Date(now + 3600_000).toISOString() }],
      [
        "ended",
        {
          starts_at: new Date(now - 7200_000).toISOString(),
          ends_at: new Date(now - 3600_000).toISOString(),
        },
      ],
      ["inactive", { active: false }],
    ];
    for (const [state, extra] of states) {
      const res = await createBanner({ title: `${marker} ${state}`, ...extra });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().state).toBe(state);
    }
    const list = async (query: Record<string, string>) => {
      const res = await api().get("/admin/content/banners", { token: admin.token, query });
      expect(res.statusCode, res.body).toBe(200);
      return expectOperation("get", "/admin/content/banners", res) as {
        items: AdminBanner[];
        next_cursor: string | null;
        total: number;
      };
    };
    for (const [state] of states) {
      const page = await list({ q: marker, state });
      expect(page.total, state).toBe(1);
      expect(page.items[0]!.state).toBe(state);
    }
    for (const sort of ["sort_order_asc", "starts_at_desc", "updated_at_desc", "title_asc"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await list({ q: marker, sort, limit: "1", ...(cursor ? { cursor } : {}) });
        expect(page.total).toBe(4);
        seen.push(...page.items.map((b) => b.id));
        cursor = page.next_cursor;
      } while (cursor);
      expect(new Set(seen).size, sort).toBe(4);
    }
  });
});
