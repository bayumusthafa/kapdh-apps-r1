import { postLikes, posts, users } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { insertCategory, insertPost, memberSession, postRow, unique } from "./support.js";

/**
 * Feed, detail dan like berita anggota aktif (F-08, PRD 3.8): AC F08-1 (hanya published yang sudah waktunya), AC
 * F08-3 (like idempoten, penghitung konsisten), AC F08-4 (daftar kosong sah, paging keyset tanpa duplikasi).
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

type FeedItem = { id: string; slug: string; like_count: number; liked_by_me: boolean; category: unknown };

async function feed(token: string, query: Record<string, string> = {}) {
  const res = await httpClient(t.app).get("/posts", { token, query });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/posts", res) as { items: FeedItem[]; next_cursor: string | null };
}

async function allFeed(token: string, query: Record<string, string> = {}): Promise<FeedItem[]> {
  const items: FeedItem[] = [];
  let cursor: string | null = null;
  do {
    const page = await feed(token, { ...query, limit: "2", ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

describe("AC F08-1: feed hanya menampilkan berita published yang sudah waktunya tampil", () => {
  it("AC F08-1: draft, terjadwal masa depan dan archived tidak pernah tampil di feed maupun detail", async () => {
    const member = await memberSession(t);
    const now = t.clock.now();
    const visible = await insertPost(t, { publishedAt: new Date(now.getTime() - 60_000) });
    const draft = await insertPost(t, { status: "draft" });
    const scheduled = await insertPost(t, { publishedAt: new Date(now.getTime() + 3600_000) });
    const archived = await insertPost(t, { status: "archived", publishedAt: new Date(now.getTime() - 7200_000) });

    const ids = (await allFeed(member.token)).map((item) => item.id);
    expect(ids).toContain(visible.id);
    for (const hidden of [draft, scheduled, archived]) expect(ids).not.toContain(hidden.id);

    const api = httpClient(t.app);
    const detail = await api.get(`/posts/${visible.slug}`, { token: member.token });
    expect(detail.statusCode).toBe(200);
    expect(expectOperation("get", "/posts/{slug}", detail)).toMatchObject({
      id: visible.id,
      body_html: "<p>Isi berita uji.</p>",
    });
    for (const hidden of [draft, scheduled, archived]) {
      const res = await api.get(`/posts/${hidden.slug}`, { token: member.token });
      expect(res.statusCode, hidden.slug).toBe(404);
      expectOperation("get", "/posts/{slug}", res);
    }
    expect((await api.get("/posts/tidak-ada-berita", { token: member.token })).statusCode).toBe(404);
  });

  it("AC F08-1: berita terjadwal tampil tepat ketika published_at tiba (waktu server)", async () => {
    const member = await memberSession(t);
    const scheduled = await insertPost(t, { publishedAt: new Date(t.clock.now().getTime() + 5 * 60_000) });
    expect((await allFeed(member.token)).map((i) => i.id)).not.toContain(scheduled.id);
    t.clock.advance(5 * 60_000);
    expect((await allFeed(member.token)).map((i) => i.id)).toContain(scheduled.id);
  });

  it("AC F08-4: paging keyset published_at turun tanpa duplikasi; filter kategori; slug kategori tak dikenal kosong", async () => {
    const member = await memberSession(t);
    const category = await insertCategory(t, { kind: "post", label: "Pengumuman" });
    const base = t.clock.now().getTime() - 24 * 3600_000;
    const created = [];
    for (let i = 0; i < 5; i++)
      created.push(
        await insertPost(t, { publishedAt: new Date(base + i * 1000), categoryId: category.id }),
      );
    const filtered = await allFeed(member.token, { category: category.slug });
    expect(filtered.map((i) => i.id)).toEqual(created.map((p) => p.id).reverse());
    expect(filtered[0]!.category).toEqual({ id: category.id, slug: category.slug, label: "Pengumuman" });
    const everything = await allFeed(member.token);
    expect(new Set(everything.map((i) => i.id)).size).toBe(everything.length);
    const empty = await feed(member.token, { category: "kategori-tidak-ada" });
    expect(empty).toEqual({ items: [], next_cursor: null });
  });

  it("AC F08-1: cursor rusak dan slug terlalu panjang ditolak 400", async () => {
    const member = await memberSession(t);
    const api = httpClient(t.app);
    const badCursor = await api.get("/posts", { token: member.token, query: { cursor: "bukan-cursor" } });
    expect(badCursor.statusCode).toBe(400);
    expectOperation("get", "/posts", badCursor);
    const longSlug = await api.get(`/posts/${"a".repeat(161)}`, { token: member.token });
    expect(longSlug.statusCode).toBe(400);
    expectOperation("get", "/posts/{slug}", longSlug);
  });
});

describe("AC F08-3: like idempoten, maksimal satu like per pengguna per berita", () => {
  it("AC F08-3: like berulang dan request diulang tetap satu like; penghitung konsisten; unlike idempoten", async () => {
    const [a, b] = [await memberSession(t), await memberSession(t)];
    const post = await insertPost(t);
    const api = httpClient(t.app);
    const like = (token: string) => api.put(`/posts/${post.slug}/like`, {}, { token });
    const unlike = (token: string) => api.delete(`/posts/${post.slug}/like`, { token });

    for (let i = 0; i < 3; i++) {
      const res = await like(a.token);
      expect(res.statusCode).toBe(200);
      expect(expectOperation("put", "/posts/{slug}/like", res)).toEqual({ liked: true, like_count: 1 });
    }
    // Request paralel dari pengguna yang sama tetap satu like.
    const parallel = await Promise.all(Array.from({ length: 5 }, () => like(b.token)));
    for (const res of parallel) expect(res.statusCode).toBe(200);
    expect(parallel.at(-1)!.json()).toEqual({ liked: true, like_count: 2 });

    const likes = await t.db.select().from(postLikes).where(eq(postLikes.postId, post.id));
    expect(likes).toHaveLength(2);
    expect((await postRow(t, post.id))!.likeCount).toBe(2);

    const detail = await api.get(`/posts/${post.slug}`, { token: a.token });
    expect(detail.json()).toMatchObject({ liked_by_me: true, like_count: 2 });

    for (let i = 0; i < 2; i++) {
      const res = await unlike(a.token);
      expect(res.statusCode).toBe(200);
      expect(expectOperation("delete", "/posts/{slug}/like", res)).toEqual({ liked: false, like_count: 1 });
    }
    const never = await memberSession(t);
    expect((await unlike(never.token)).json()).toEqual({ liked: false, like_count: 1 });
    expect((await postRow(t, post.id))!.likeCount).toBe(1);
  });

  it("AC F08-3: like pada berita yang tidak tampil (draft/terjadwal/archived) -> 404; slug tidak valid -> 400", async () => {
    const member = await memberSession(t);
    const api = httpClient(t.app);
    for (const hidden of [
      await insertPost(t, { status: "draft" }),
      await insertPost(t, { publishedAt: new Date(t.clock.now().getTime() + 3600_000) }),
      await insertPost(t, { status: "archived" }),
    ]) {
      const res = await api.put(`/posts/${hidden.slug}/like`, {}, { token: member.token });
      expect(res.statusCode).toBe(404);
      expectOperation("put", "/posts/{slug}/like", res);
      const del = await api.delete(`/posts/${hidden.slug}/like`, { token: member.token });
      expect(del.statusCode).toBe(404);
    }
    const tooLong = await api.put(`/posts/${"b".repeat(161)}/like`, {}, { token: member.token });
    expect(tooLong.statusCode).toBe(400);
    expectOperation("put", "/posts/{slug}/like", tooLong);
  });

  it("AC F08-3: penghapusan akun menghapus like dan penghitung tetap sama dengan jumlah like (trigger)", async () => {
    const member = await memberSession(t);
    const post = await insertPost(t, { slug: unique("berita-hapus-akun") });
    await httpClient(t.app).put(`/posts/${post.slug}/like`, {}, { token: member.token });
    expect((await postRow(t, post.id))!.likeCount).toBe(1);
    await t.db.delete(users).where(eq(users.id, member.userId));
    expect((await postRow(t, post.id))!.likeCount).toBe(0);
    expect(
      await t.db
        .select()
        .from(postLikes)
        .where(and(eq(postLikes.postId, post.id), eq(postLikes.userId, member.userId))),
    ).toHaveLength(0);
  });

  it("AC F08-3: layanan tidak pernah menulis like_count (nilai hanya dari trigger)", async () => {
    const member = await memberSession(t);
    const post = await insertPost(t);
    await t.db.update(posts).set({ title: "Judul baru" }).where(eq(posts.id, post.id));
    const res = await httpClient(t.app).put(`/posts/${post.slug}/like`, {}, { token: member.token });
    expect(res.json()).toEqual({ liked: true, like_count: 1 });
  });
});
