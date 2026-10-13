import { auditLogs, files, postLikes } from "@kapdh/database";
import { and, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  adminSession,
  insertCategory,
  insertPost,
  memberSession,
  postRow,
  unique,
  uploadContentMedia,
} from "./support.js";

/**
 * Berita untuk pengurus (F-08, F-15, kontrak admin-content): draft, terbit/terjadwal, batal jadwal, arsip,
 * pulihkan, hapus dengan If-Match (AC F15-4), sanitasi server (PRD 3.8), invarian waktu terbit (AC F08-1, F15-5).
 */

let t: TestApp;
let admin: Awaited<ReturnType<typeof adminSession>>;

beforeAll(async () => {
  t = await createTestApp();
  admin = await adminSession(t, ["content.manage"], { displayName: "Pengurus Konten" });
});
afterAll(async () => {
  await t.app.close();
});

type AdminPost = {
  id: string;
  slug: string;
  state: string;
  version: string;
  published_at: string | null;
  slug_locked: boolean;
  body_html: string;
  announced_at: string | null;
  cover: { file_id: string; url: string } | null;
  category: { id: string } | null;
  author: { admin_id: string; display_name: string } | null;
  like_count: number;
};

const api = () => httpClient(t.app);

async function createPost(body: Record<string, unknown> = {}): Promise<AdminPost> {
  const res = await api().post(
    "/admin/content/posts",
    { title: "Kabar Alumni", body_html: "<p>Isi berita</p>", ...body },
    { token: admin.token },
  );
  expect(res.statusCode, res.body).toBe(201);
  return expectOperation("post", "/admin/content/posts", res) as AdminPost;
}

async function action(post: AdminPost, name: "publish" | "unschedule" | "archive" | "restore", body: unknown = {}) {
  const res = await api().post(`/admin/content/posts/${post.id}/${name}`, body, {
    token: admin.token,
    headers: { "if-match": post.version },
  });
  expectOperation("post", `/admin/content/posts/{postId}/${name}`, res);
  return res;
}

async function lastAudit(entityId: string) {
  const [row] = await t.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.entityId, entityId))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(1);
  return row;
}

describe("F-08: membuat berita draft (PRD 3.8 sanitasi server)", () => {
  it("PRD 3.8: berita baru selalu draft, body disanitasi, tautan luar ditandai, slug dibangkitkan unik, audit tercatat", async () => {
    const title = `Reuni Akbar ${unique("x")}`;
    const first = await createPost({
      title: `  ${title}  `,
      body_html:
        `<p onclick="x()">Halo <script>alert(1)</script><a href="https://contoh.test/info">info</a> ` +
        `<a href="javascript:alert(1)">jahat</a></p><iframe src="https://evil.test"></iframe>`,
    });
    expect(first).toMatchObject({ state: "draft", published_at: null, slug_locked: false, version: "1" });
    expect(first.body_html).toBe(
      '<p>Halo <a href="https://contoh.test/info" target="_blank" rel="noopener noreferrer nofollow" ' +
        'data-external="true" class="kapdh-external-link">info</a> jahat</p>',
    );
    expect(first.author).toEqual({ admin_id: admin.adminId, display_name: "Pengurus Konten" });
    const second = await createPost({ title });
    expect(second.slug).toBe(`${first.slug}-2`);
    expect(first.slug).toMatch(/^reuni-akbar-x-/);
    const audit = await lastAudit(first.id);
    expect(audit).toMatchObject({ action: "post.created", entityType: "post", actorAdminId: admin.adminId });
  });

  it("PRD 3.8: isi kosong setelah sanitasi ditolak 400; slug manual yang dipakai -> 409 VALIDATION_ERROR", async () => {
    const empty = await api().post(
      "/admin/content/posts",
      { title: "Kosong", body_html: "<script>x</script><p> </p>" },
      { token: admin.token },
    );
    expect(empty.statusCode).toBe(400);
    expect(empty.json().field_errors.body_html).toBeDefined();
    expectOperation("post", "/admin/content/posts", empty);

    const slug = unique("slug-manual");
    await createPost({ slug });
    const taken = await api().post(
      "/admin/content/posts",
      { title: "Lain", body_html: "<p>x</p>", slug },
      { token: admin.token },
    );
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: "VALIDATION_ERROR", field_errors: { slug: expect.any(Array) } });
    expectOperation("post", "/admin/content/posts", taken);

    const invalid = await api().post(
      "/admin/content/posts",
      { title: "", body_html: "<p>x</p>", slug: "Slug Salah" },
      { token: admin.token },
    );
    expect(invalid.statusCode).toBe(400);
    expect(Object.keys(invalid.json().field_errors).sort()).toEqual(["slug", "title"]);
  });

  it("F-08: kategori harus kategori berita aktif; cover harus post_cover milik pemanggil yang belum dipakai", async () => {
    const inactive = await insertCategory(t, { kind: "post", active: false });
    const eventCategory = await insertCategory(t, { kind: "event" });
    for (const categoryId of [inactive.id, eventCategory.id, uuidv7()]) {
      const res = await api().post(
        "/admin/content/posts",
        { title: "K", body_html: "<p>x</p>", category_id: categoryId },
        { token: admin.token },
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().field_errors.category_id).toBeDefined();
    }
    const banner = await uploadContentMedia(t, admin.token, "banner_image");
    const wrongPurpose = await api().post(
      "/admin/content/posts",
      { title: "K", body_html: "<p>x</p>", cover_file_id: banner.file_id },
      { token: admin.token },
    );
    expect(wrongPurpose.statusCode).toBe(400);
    expect(wrongPurpose.json().field_errors.cover_file_id).toBeDefined();

    const otherAdmin = await adminSession(t, ["content.manage"]);
    const othersCover = await uploadContentMedia(t, otherAdmin.token, "post_cover");
    const notMine = await api().post(
      "/admin/content/posts",
      { title: "K", body_html: "<p>x</p>", cover_file_id: othersCover.file_id },
      { token: admin.token },
    );
    expect(notMine.statusCode).toBe(400);

    const cover = await uploadContentMedia(t, admin.token, "post_cover");
    const category = await insertCategory(t, { kind: "post" });
    const post = await createPost({ cover_file_id: cover.file_id, category_id: category.id });
    expect(post.cover).toEqual({ file_id: cover.file_id, url: cover.url });
    expect(post.category?.id).toBe(category.id);
    const [file] = await t.db.select().from(files).where(eq(files.id, cover.file_id));
    expect(file!.attachedAt).not.toBeNull();
    // Satu berkas = satu objek: cover yang sudah dipakai tidak dapat dipakai berita lain.
    const reused = await api().post(
      "/admin/content/posts",
      { title: "K", body_html: "<p>x</p>", cover_file_id: cover.file_id },
      { token: admin.token },
    );
    expect(reused.statusCode).toBe(400);
  });

  it("PRD 3.8: gambar body hanya berkas konten KAPDH; berkas dirujuk dilampirkan agar tidak dibersihkan job", async () => {
    const image = await uploadContentMedia(t, admin.token, "post_cover");
    const post = await createPost({ body_html: `<p>Foto</p><img src="${image.url}" alt="Foto kegiatan">` });
    expect(post.body_html).toContain(`<img src="${image.url}" alt="Foto kegiatan" />`);
    const [file] = await t.db.select().from(files).where(eq(files.id, image.file_id));
    expect(file!.attachedAt).not.toBeNull();
    const missing = await api().post(
      "/admin/content/posts",
      { title: "K", body_html: `<img src="${t.env.API_PUBLIC_URL}/api/v1/files/public/${uuidv7()}" alt="x">` },
      { token: admin.token },
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.json().field_errors.body_html).toBeDefined();
  });

  it("AC F15-4: Idempotency-Key mencegah draf ganda saat tombol simpan terkirim dua kali", async () => {
    const key = uuidv7();
    const body = { title: unique("Idempoten"), body_html: "<p>x</p>" };
    const first = await api().post("/admin/content/posts", body, {
      token: admin.token,
      headers: { "idempotency-key": key },
    });
    const replay = await api().post("/admin/content/posts", body, {
      token: admin.token,
      headers: { "idempotency-key": key },
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json().id).toBe(first.json().id);
    const conflict = await api().post(
      "/admin/content/posts",
      { ...body, title: "Beda" },
      { token: admin.token, headers: { "idempotency-key": key } },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("AC F15-4: perubahan berita memakai If-Match", () => {
  it("AC F15-4: versi lama -> 409 VERSION_CONFLICT dengan current; If-Match kosong -> 400; id bukan uuid -> 400", async () => {
    const post = await createPost();
    const ok = await api().patch(
      `/admin/content/posts/${post.id}`,
      { title: "Judul baru", excerpt: "  Ringkasan  " },
      { token: admin.token, headers: { "if-match": post.version } },
    );
    expect(ok.statusCode).toBe(200);
    expect(expectOperation("patch", "/admin/content/posts/{postId}", ok)).toMatchObject({
      title: "Judul baru",
      excerpt: "Ringkasan",
      version: "2",
    });
    const stale = await api().patch(
      `/admin/content/posts/${post.id}`,
      { title: "Menimpa diam-diam" },
      { token: admin.token, headers: { "if-match": post.version } },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT", current: { id: post.id, title: "Judul baru", version: "2" } });
    expectOperation("patch", "/admin/content/posts/{postId}", stale);

    const missing = await api().patch(`/admin/content/posts/${post.id}`, { title: "x" }, { token: admin.token });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().field_errors["If-Match"]).toBeDefined();
    const badId = await api().get("/admin/content/posts/bukan-uuid", { token: admin.token });
    expect(badId.statusCode).toBe(400);
    expectOperation("get", "/admin/content/posts/{postId}", badId);
    const unknown = await api().get(`/admin/content/posts/${uuidv7()}`, { token: admin.token });
    expect(unknown.statusCode).toBe(404);
    const empty = await api().patch(
      `/admin/content/posts/${post.id}`,
      {},
      { token: admin.token, headers: { "if-match": "2" } },
    );
    expect(empty.statusCode).toBe(400);
  });

  it("AC F15-4: slug dapat diubah selama belum pernah tampil, terkunci setelah tampil (tautan notifikasi tetap)", async () => {
    let post = await createPost();
    const slug = unique("slug-baru");
    const renamed = await api().patch(
      `/admin/content/posts/${post.id}`,
      { slug },
      { token: admin.token, headers: { "if-match": post.version } },
    );
    expect(renamed.json().slug).toBe(slug);
    post = renamed.json();
    post = (await action(post, "publish", {})).json();
    expect(post).toMatchObject({ state: "published", slug_locked: true });
    const locked = await api().patch(
      `/admin/content/posts/${post.id}`,
      { slug: unique("slug-lain") },
      { token: admin.token, headers: { "if-match": post.version } },
    );
    expect(locked.statusCode).toBe(400);
    expect(locked.json().field_errors.slug).toBeDefined();
  });

  it("F-08: mengganti cover membuang cover lama yang tidak dirujuk lagi", async () => {
    const oldCover = await uploadContentMedia(t, admin.token, "post_cover");
    const post = await createPost({ cover_file_id: oldCover.file_id });
    const newCover = await uploadContentMedia(t, admin.token, "post_cover");
    const res = await api().patch(
      `/admin/content/posts/${post.id}`,
      { cover_file_id: newCover.file_id },
      { token: admin.token, headers: { "if-match": post.version } },
    );
    expect(res.json().cover.file_id).toBe(newCover.file_id);
    const [old] = await t.db.select().from(files).where(eq(files.id, oldCover.file_id));
    expect(old!.status).toBe("deleted");
  });
});

describe("AC F08-1, F15-5: siklus terbit berita", () => {
  it("AC F08-1: terbit sekarang, jadwal masa depan, jadwal ulang; waktu lampau ditolak 400", async () => {
    const draft = await createPost();
    const past = await action(draft, "publish", { published_at: new Date(t.clock.now().getTime() - 60_000).toISOString() });
    expect(past.statusCode).toBe(400);
    expect(past.json().field_errors.published_at).toBeDefined();

    const at = new Date(t.clock.now().getTime() + 3600_000);
    const scheduled = (await action(draft, "publish", { published_at: at.toISOString() })).json();
    expect(scheduled).toMatchObject({ state: "scheduled", published_at: at.toISOString(), slug_locked: false });
    expect((await lastAudit(draft.id))!.action).toBe("post.scheduled");

    const later = new Date(at.getTime() + 3600_000);
    const rescheduled = (await action(scheduled, "publish", { published_at: later.toISOString() })).json();
    expect(rescheduled).toMatchObject({ state: "scheduled", published_at: later.toISOString() });

    const now = (await action(rescheduled, "publish", { published_at: null })).json();
    expect(now).toMatchObject({ state: "published", published_at: t.clock.now().toISOString(), slug_locked: true });
    expect((await lastAudit(draft.id))!.action).toBe("post.published");

    const again = await action(now, "publish", {});
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "VERSION_CONFLICT", current: { state: "published" } });
  });

  it("AC F15-5: batal jadwal mengembalikan draft dan mengosongkan published_at; berita tampil tidak dapat dibatalkan jadwalnya", async () => {
    const draft = await createPost();
    const at = new Date(t.clock.now().getTime() + 600_000);
    const scheduled = (await action(draft, "publish", { published_at: at.toISOString() })).json();
    const unscheduled = await action(scheduled, "unschedule");
    expect(unscheduled.statusCode).toBe(200);
    expect(unscheduled.json()).toMatchObject({ state: "draft", published_at: null, announced_at: null });

    const published = (await action(unscheduled.json(), "publish", {})).json();
    const refused = await action(published, "unschedule");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("VERSION_CONFLICT");
  });

  it("AC F15-5: jadwal yang lewat tanpa tindakan menjadikan berita tampil; batal jadwal setelah itu ditolak", async () => {
    const draft = await createPost();
    const scheduled = (
      await action(draft, "publish", { published_at: new Date(t.clock.now().getTime() + 60_000).toISOString() })
    ).json();
    t.clock.advance(61_000);
    const res = await action(scheduled, "unschedule");
    expect(res.statusCode).toBe(409);
    expect(res.json().current).toMatchObject({ state: "published", slug_locked: true });
  });

  it("AC F15-5: arsip terjadwal mengosongkan jadwal; arsip berita tampil menyimpan Tgl Publikasi; pulihkan -> draft", async () => {
    const scheduled = (
      await action(await createPost(), "publish", {
        published_at: new Date(t.clock.now().getTime() + 3600_000).toISOString(),
      })
    ).json();
    const archivedScheduled = (await action(scheduled, "archive")).json();
    expect(archivedScheduled).toMatchObject({ state: "archived", published_at: null });

    const published = (await action(await createPost(), "publish", {})).json();
    const firstPublishedAt = published.published_at;
    t.clock.advance(5_000);
    const archived = (await action(published, "archive")).json();
    expect(archived).toMatchObject({ state: "archived", published_at: firstPublishedAt, slug_locked: true });
    const twice = await action(archived, "archive");
    expect(twice.statusCode).toBe(409);

    const restored = (await action(archived, "restore")).json();
    expect(restored).toMatchObject({ state: "draft", published_at: firstPublishedAt, slug_locked: true });
    const notArchived = await action(restored, "restore");
    expect(notArchived.statusCode).toBe(409);

    // Pernah tampil: tidak dapat dijadwalkan ulang, hanya terbit sekarang dengan Tgl Publikasi aslinya.
    const future = await action(restored, "publish", {
      published_at: new Date(t.clock.now().getTime() + 3600_000).toISOString(),
    });
    expect(future.statusCode).toBe(409);
    expect(future.json()).toMatchObject({ code: "VALIDATION_ERROR", field_errors: { published_at: expect.any(Array) } });
    const republished = (await action(restored, "publish", {})).json();
    expect(republished).toMatchObject({ state: "published", published_at: firstPublishedAt });
    // Arsip tidak pernah dihidupkan kembali oleh job: hanya publish eksplisit yang menerbitkan.
    const member = await memberSession(t);
    const detail = await api().get(`/posts/${republished.slug}`, { token: member.token });
    expect(detail.statusCode).toBe(200);
  });

  it("PRD 4.5: hapus hanya draft/archived; like ikut terhapus; berita tampil -> 409", async () => {
    const member = await memberSession(t);
    const published = (await action(await createPost(), "publish", {})).json();
    await api().put(`/posts/${published.slug}/like`, {}, { token: member.token });
    const refused = await api().delete(`/admin/content/posts/${published.id}`, {
      token: admin.token,
      headers: { "if-match": published.version },
    });
    expect(refused.statusCode).toBe(409);
    expectOperation("delete", "/admin/content/posts/{postId}", refused);
    const archived = (await action(published, "archive")).json();
    const stale = await api().delete(`/admin/content/posts/${published.id}`, {
      token: admin.token,
      headers: { "if-match": published.version },
    });
    expect(stale.statusCode).toBe(409);
    const removed = await api().delete(`/admin/content/posts/${published.id}`, {
      token: admin.token,
      headers: { "if-match": archived.version },
    });
    expect(removed.statusCode).toBe(204);
    expectOperation("delete", "/admin/content/posts/{postId}", removed);
    expect(await postRow(t, published.id)).toBeUndefined();
    expect(await t.db.select().from(postLikes).where(eq(postLikes.postId, published.id))).toHaveLength(0);
    expect((await lastAudit(published.id))!.action).toBe("post.deleted");
  });
});

describe("F-15: tabel berita dengan pencarian, filter, urutan dan paging server", () => {
  it("F-15: filter state/q/kategori, total, paging keyset semua urutan tanpa duplikasi", async () => {
    const category = await insertCategory(t, { kind: "post" });
    const marker = unique("penanda");
    const now = t.clock.now();
    await insertPost(t, { status: "draft", title: `${marker} draft`, categoryId: category.id });
    await insertPost(t, { title: `${marker} tampil`, categoryId: category.id });
    await insertPost(t, {
      title: `${marker} terjadwal`,
      publishedAt: new Date(now.getTime() + 3600_000),
      categoryId: category.id,
    });
    await insertPost(t, { status: "archived", title: `${marker} arsip`, categoryId: category.id });

    const list = async (query: Record<string, string>) => {
      const res = await api().get("/admin/content/posts", { token: admin.token, query });
      expect(res.statusCode, res.body).toBe(200);
      return expectOperation("get", "/admin/content/posts", res) as {
        items: { title: string; state: string }[];
        next_cursor: string | null;
        total: number;
      };
    };
    for (const state of ["draft", "scheduled", "published", "archived"]) {
      const page = await list({ q: marker, state });
      expect(page.total).toBe(1);
      expect(page.items[0]!.state).toBe(state);
    }
    expect((await list({ category_id: category.id })).total).toBe(4);
    for (const sort of ["updated_at_desc", "published_at_desc", "created_at_desc", "title_asc"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await list({ q: marker, sort, limit: "1", ...(cursor ? { cursor } : {}) });
        expect(page.total).toBe(4);
        seen.push(...page.items.map((i) => i.title));
        cursor = page.next_cursor;
      } while (cursor);
      expect(new Set(seen).size, sort).toBe(4);
      if (sort === "title_asc") expect(seen).toEqual([...seen].sort());
    }
    const otherSortCursor = (await list({ q: marker, sort: "title_asc", limit: "1" })).next_cursor!;
    const mixed = await api().get("/admin/content/posts", {
      token: admin.token,
      query: { q: marker, sort: "updated_at_desc", cursor: otherSortCursor },
    });
    expect(mixed.statusCode).toBe(400);
    const badSort = await api().get("/admin/content/posts", { token: admin.token, query: { sort: "acak" } });
    expect(badSort.statusCode).toBe(400);
  });

  it("F-15: tabel memuat like_count dari trigger dan cover/kategori", async () => {
    const member = await memberSession(t);
    const published = (await action(await createPost(), "publish", {})).json();
    await api().put(`/posts/${published.slug}/like`, {}, { token: member.token });
    const res = await api().get(`/admin/content/posts/${published.id}`, { token: admin.token });
    expect(expectOperation("get", "/admin/content/posts/{postId}", res)).toMatchObject({ like_count: 1 });
    const audit = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, published.id), eq(auditLogs.action, "post.published")));
    expect(audit).toHaveLength(1);
  });
});
