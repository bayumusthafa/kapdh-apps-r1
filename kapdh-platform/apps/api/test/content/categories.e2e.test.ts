import { auditLogs, categories } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminSession, insertCategory, insertEvent, insertPost, memberSession, unique } from "./support.js";

/**
 * Kategori berita/event ("Manajemen Kategori" guideline p13/p14; F-08, F-15): daftar aktif untuk anggota, CRUD
 * pengurus per jenis (content.manage / events.manage), If-Match (AC F15-4), kategori terpakai tidak dapat dihapus.
 */

let t: TestApp;
let content: Awaited<ReturnType<typeof adminSession>>;
let eventsAdmin: Awaited<ReturnType<typeof adminSession>>;

beforeAll(async () => {
  t = await createTestApp();
  content = await adminSession(t, ["content.manage"]);
  eventsAdmin = await adminSession(t, ["events.manage"]);
});
afterAll(async () => {
  await t.app.close();
});

type AdminCategory = {
  id: string;
  kind: string;
  slug: string;
  label: string;
  sort_order: number;
  active: boolean;
  usage_count: number;
  version: string;
};

const api = () => httpClient(t.app);

describe("F-08: GET /categories untuk tab berita/event", () => {
  it("F-08: hanya kategori aktif, urut sort_order lalu label, filter jenis; jenis tidak sah 400", async () => {
    await t.db.update(categories).set({ active: false });
    const b = await insertCategory(t, { kind: "post", label: "Beta", sortOrder: 1 });
    const a = await insertCategory(t, { kind: "post", label: "Alfa", sortOrder: 1 });
    const first = await insertCategory(t, { kind: "post", label: "Zeta", sortOrder: 0 });
    await insertCategory(t, { kind: "post", label: "Nonaktif", active: false });
    const event = await insertCategory(t, { kind: "event", label: "Kajian" });
    const member = await memberSession(t, "unverified");
    const res = await api().get("/categories", { token: member.token, query: { kind: "post" } });
    const body = expectOperation("get", "/categories", res) as { items: { id: string }[] };
    expect(body.items.map((c) => c.id)).toEqual([first.id, a.id, b.id]);
    const all = (await api().get("/categories", { token: member.token })).json() as { items: { id: string }[] };
    expect(all.items.map((c) => c.id)).toContain(event.id);
    const bad = await api().get("/categories", { token: member.token, query: { kind: "lain" } });
    expect(bad.statusCode).toBe(400);
    expectOperation("get", "/categories", bad);
  });
});

describe("F-15: kategori berita (content.manage)", () => {
  it("F-15: buat dengan slug otomatis unik per jenis; slug manual dipakai -> 409; audit tercatat", async () => {
    const label = `Info Kegiatan ${unique("k")}`;
    const res = await api().post(
      "/admin/content/post-categories",
      { label: `  ${label} ` },
      { token: content.token },
    );
    expect(res.statusCode, res.body).toBe(201);
    const created = expectOperation("post", "/admin/content/post-categories", res) as AdminCategory;
    expect(created).toMatchObject({ kind: "post", label, active: true, sort_order: 0, usage_count: 0, version: "1" });
    const again = (
      await api().post("/admin/content/post-categories", { label }, { token: content.token })
    ).json() as AdminCategory;
    expect(again.slug).toBe(`${created.slug}-2`);
    // Slug yang sama boleh dipakai jenis lain (unik per jenis).
    const sameSlugEvent = await api().post(
      "/admin/content/event-categories",
      { label, slug: created.slug },
      { token: eventsAdmin.token },
    );
    expect(sameSlugEvent.statusCode).toBe(201);
    const taken = await api().post(
      "/admin/content/post-categories",
      { label: "Lain", slug: created.slug },
      { token: content.token },
    );
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: "VALIDATION_ERROR", field_errors: { slug: expect.any(Array) } });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.id), eq(auditLogs.action, "category.created")));
    expect(audit).toBeDefined();
  });

  it("AC F15-4: ubah dengan If-Match; versi lama 409 dengan current; jenis lain di path -> 404", async () => {
    const category = (
      await api().post("/admin/content/post-categories", { label: unique("Ubah") }, { token: content.token })
    ).json() as AdminCategory;
    const updated = await api().patch(
      `/admin/content/post-categories/${category.id}`,
      { label: "Pengumuman Resmi", active: false, sort_order: 3 },
      { token: content.token, headers: { "if-match": category.version } },
    );
    expect(updated.statusCode).toBe(200);
    expect(expectOperation("patch", "/admin/content/post-categories/{categoryId}", updated)).toMatchObject({
      label: "Pengumuman Resmi",
      active: false,
      sort_order: 3,
      version: "2",
    });
    const stale = await api().patch(
      `/admin/content/post-categories/${category.id}`,
      { label: "Menimpa" },
      { token: content.token, headers: { "if-match": category.version } },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT", current: { label: "Pengumuman Resmi" } });

    const eventCategory = await insertCategory(t, { kind: "event" });
    const crossGet = await api().get(`/admin/content/post-categories/${eventCategory.id}`, { token: content.token });
    expect(crossGet.statusCode).toBe(404);
    expectOperation("get", "/admin/content/post-categories/{categoryId}", crossGet);
    const crossPatch = await api().patch(
      `/admin/content/event-categories/${category.id}`,
      { label: "x" },
      { token: eventsAdmin.token, headers: { "if-match": "2" } },
    );
    expect(crossPatch.statusCode).toBe(404);
  });

  it("PRD 4.5: kategori terpakai tidak dapat dihapus (409, sarankan nonaktifkan); tidak terpakai 204", async () => {
    const used = (
      await api().post("/admin/content/post-categories", { label: unique("Dipakai") }, { token: content.token })
    ).json() as AdminCategory;
    await insertPost(t, { status: "archived", categoryId: used.id });
    const detail = await api().get(`/admin/content/post-categories/${used.id}`, { token: content.token });
    expect(detail.json().usage_count).toBe(1);
    const refused = await api().delete(`/admin/content/post-categories/${used.id}`, {
      token: content.token,
      headers: { "if-match": used.version },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("VALIDATION_ERROR");
    expectOperation("delete", "/admin/content/post-categories/{categoryId}", refused);
    expect(await t.db.select().from(categories).where(eq(categories.id, used.id))).toHaveLength(1);

    const unused = (
      await api().post("/admin/content/post-categories", { label: unique("Bebas") }, { token: content.token })
    ).json() as AdminCategory;
    const removed = await api().delete(`/admin/content/post-categories/${unused.id}`, {
      token: content.token,
      headers: { "if-match": unused.version },
    });
    expect(removed.statusCode).toBe(204);
    expectOperation("delete", "/admin/content/post-categories/{categoryId}", removed);
  });

  it("F-15: tabel kategori: filter aktif, pencarian, urutan (termasuk pemakaian) dan paging tanpa duplikasi", async () => {
    const marker = unique("tabel");
    const made: AdminCategory[] = [];
    for (let i = 0; i < 3; i++)
      made.push(
        (
          await api().post(
            "/admin/content/post-categories",
            { label: `${marker} ${i}`, sort_order: 3 - i, active: i !== 1 },
            { token: content.token },
          )
        ).json() as AdminCategory,
      );
    await insertPost(t, { categoryId: made[2]!.id });
    await insertPost(t, { categoryId: made[2]!.id });
    await insertPost(t, { categoryId: made[0]!.id });
    const list = async (query: Record<string, string>) => {
      const res = await api().get("/admin/content/post-categories", { token: content.token, query });
      expect(res.statusCode, res.body).toBe(200);
      return expectOperation("get", "/admin/content/post-categories", res) as {
        items: AdminCategory[];
        next_cursor: string | null;
        total: number;
      };
    };
    expect((await list({ q: marker })).total).toBe(3);
    expect((await list({ q: marker, active: "false" })).items.map((c) => c.id)).toEqual([made[1]!.id]);
    const byUsage = await list({ q: marker, sort: "usage_desc" });
    expect(byUsage.items.map((c) => c.usage_count)).toEqual([2, 1, 0]);
    expect((await list({ q: marker })).items.map((c) => c.id)).toEqual([made[2]!.id, made[1]!.id, made[0]!.id]);
    for (const sort of ["sort_order_asc", "label_asc", "usage_desc", "updated_at_desc"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await list({ q: marker, sort, limit: "1", ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((c) => c.id));
        cursor = page.next_cursor;
      } while (cursor);
      expect(seen.sort(), sort).toEqual(made.map((c) => c.id).sort());
    }
  });
});

describe("F-15: kategori event (events.manage, guideline p14)", () => {
  it("F-15: usage_count menghitung event semua status; kategori event terpakai tidak dapat dihapus", async () => {
    const created = (
      await api().post(
        "/admin/content/event-categories",
        { label: unique("Kajian"), sort_order: 2 },
        { token: eventsAdmin.token },
      )
    ).json() as AdminCategory;
    expect(created.kind).toBe("event");
    await insertEvent(t, { status: "cancelled", categoryId: created.id });
    await insertEvent(t, { status: "draft", categoryId: created.id });
    const detail = await api().get(`/admin/content/event-categories/${created.id}`, { token: eventsAdmin.token });
    expect(expectOperation("get", "/admin/content/event-categories/{categoryId}", detail)).toMatchObject({
      usage_count: 2,
    });
    const refused = await api().delete(`/admin/content/event-categories/${created.id}`, {
      token: eventsAdmin.token,
      headers: { "if-match": created.version },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("VALIDATION_ERROR");
  });
});
