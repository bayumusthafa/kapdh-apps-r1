/**
 * Modul konten di bawah konkurensi nyata PostgreSQL 17 (ARCHITECTURE §9.2). API berjalan sebagai role kapdh_app
 * (grant production); fixture dibuat dengan koneksi pemilik database uji.
 *
 * - AC F08-3: like bersamaan (banyak anggota, dan anggota yang sama berulang) -> maksimal satu like per pengguna per
 *   berita dan like_count sama dengan jumlah baris post_likes (trigger statement + kunci baris berita).
 * - AC F15-5: job content.announce berjalan bersamaan di beberapa worker -> berita diumumkan tepat sekali.
 * - AC F15-5: arsip bersamaan dengan pengumuman -> tidak pernah ada notifikasi tanpa klaim announced_at.
 * - F-01: penerbitan kebijakan privasi dan ketentuan bersamaan -> keduanya berhasil berurutan (kunci baris
 *   app_settings.legal), tidak saling menolak dan tidak kehilangan versi.
 */
import "reflect-metadata";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { JobRunner } from "../../src/core/jobs/job-runner.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { barrier, connectAs, createPgTestDatabase, id, type PgTestDatabase, withLockWaitGate } from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
let jobs: JobRunner;
const clock = new TestClock();
let owner: { db: Db; clock: TestClock };

beforeAll(async () => {
  tdb = await createPgTestDatabase("content", 16);
  api = connectAs(tdb, "kapdh_app", 16);
  owner = { db: tdb.db as unknown as Db, clock };
  app = await createApp(
    {
      env: testEnv,
      db: api.db as unknown as Db,
      mailer: new MemoryMailer(),
      clock,
      push: new FakePush(),
      storage: new MemoryDriver(),
      redis: null,
    },
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  jobs = app.get(JobRunner);
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});

async function insertPost(opts: { publishedAt: Date; status?: string }): Promise<{ id: string; slug: string }> {
  const postId = id();
  const slug = `berita-${postId.slice(-12)}`;
  await tdb.sql`
    insert into app.posts (id, slug, title, body_html, status, published_at, created_at, updated_at)
    values (${postId}, ${slug}, 'Berita Uji', '<p>x</p>', ${opts.status ?? "published"},
            ${opts.publishedAt.toISOString()}::timestamptz, ${clock.now().toISOString()}::timestamptz,
            ${clock.now().toISOString()}::timestamptz)`;
  return { id: postId, slug };
}

/**
 * Penahan memegang kunci baris berita (FOR UPDATE) sampai transaksi lain teramati menunggu, sehingga pekerjaan
 * bersamaan PASTI berebut kunci yang sama (deterministik, tanpa jendela sleep).
 */
async function contended<T>(postId: string, work: () => Promise<T>) {
  return withLockWaitGate(tdb, async (hold) => {
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const blocker = tdb.sql.begin(async (tx) => {
      await tx`select id from app.posts where id = ${postId} for update`;
      signalLocked();
      await hold();
    });
    await locked;
    const result = work();
    await blocker;
    return result;
  });
}

describe("AC F08-3: like bersamaan pada PostgreSQL 17", () => {
  it("AC F08-3: 12 anggota like bersamaan + anggota yang sama 6x bersamaan -> like_count = jumlah baris = 13", async () => {
    const post = await insertPost({ publishedAt: new Date(clock.now().getTime() - 60_000) });
    const members = await Promise.all(
      Array.from({ length: 12 }, async () => signInAlumni({ app }, await createAlumni(owner, { status: "verified" }))),
    );
    const repeat = await signInAlumni({ app }, await createAlumni(owner, { status: "expiring" }));
    const client = httpClient(app);
    const like = (token: string) => client.put(`/posts/${post.slug}/like`, {}, { token });
    const { result, lockWaitObserved } = await contended(post.id, () =>
      Promise.all([
        ...members.map((m) => like(m.accessToken)),
        ...Array.from({ length: 6 }, () => like(repeat.accessToken)),
      ]),
    );
    expect(lockWaitObserved, "like benar-benar menunggu kunci baris berita").toBe(true);
    for (const res of result) expect(res.statusCode, res.body).toBe(200);
    const [row] = await tdb.sql<{ like_count: number; rows: number }[]>`
      select p.like_count, (select count(*)::int from app.post_likes l where l.post_id = p.id) as rows
      from app.posts p where p.id = ${post.id}`;
    expect(row).toEqual({ like_count: 13, rows: 13 });
  });

  it("AC F08-3: like dan unlike bercampur bersamaan -> penghitung tetap sama dengan jumlah like", async () => {
    const post = await insertPost({ publishedAt: new Date(clock.now().getTime() - 60_000) });
    const members = await Promise.all(
      Array.from({ length: 8 }, async () => signInAlumni({ app }, await createAlumni(owner, { status: "verified" }))),
    );
    const client = httpClient(app);
    for (const m of members.slice(0, 4)) await client.put(`/posts/${post.slug}/like`, {}, { token: m.accessToken });
    const gate = barrier(members.length * 2);
    await Promise.all(
      members.flatMap((m, i) => [
        (async () => {
          await gate();
          return i % 2 === 0
            ? client.delete(`/posts/${post.slug}/like`, { token: m.accessToken })
            : client.put(`/posts/${post.slug}/like`, {}, { token: m.accessToken });
        })(),
        (async () => {
          await gate();
          return client.put(`/posts/${post.slug}/like`, {}, { token: m.accessToken });
        })(),
      ]),
    );
    const [row] = await tdb.sql<{ like_count: number; rows: number }[]>`
      select p.like_count, (select count(*)::int from app.post_likes l where l.post_id = p.id) as rows
      from app.posts p where p.id = ${post.id}`;
    expect(row!.like_count).toBe(row!.rows);
  });
});

describe("AC F15-5: job content.announce bersamaan pada PostgreSQL 17", () => {
  it("AC F15-5: 4 eksekusi bersamaan -> satu klaim, satu notifikasi per anggota aktif, satu audit", async () => {
    const recipients = await Promise.all(
      Array.from({ length: 5 }, () => createAlumni(owner, { status: "verified" })),
    );
    const post = await insertPost({ publishedAt: new Date(clock.now().getTime() - 1000) });
    const { result, lockWaitObserved } = await contended(post.id, () =>
      Promise.allSettled(Array.from({ length: 4 }, () => jobs.runScheduled("content.announce"))),
    );
    expect(lockWaitObserved, "klaim benar-benar berebut kunci baris berita").toBe(true);
    expect(result.filter((r) => r.status === "rejected")).toEqual([]);
    const [claim] = await tdb.sql<{ announced: boolean }[]>`
      select announced_at is not null as announced from app.posts where id = ${post.id}`;
    expect(claim!.announced).toBe(true);
    for (const member of recipients) {
      const [count] = await tdb.sql<{ n: number }[]>`
        select count(*)::int as n from app.notifications
        where user_id = ${member.userId} and category = 'news' and data->>'post_id' = ${post.id}`;
      expect(count!.n, member.userId).toBe(1);
    }
    const [audit] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from app.audit_logs where entity_id = ${post.id} and action = 'post.announced'`;
    expect(audit!.n).toBe(1);
  });

  it("AC F15-5: arsip bersamaan dengan pengumuman tidak pernah menghasilkan notifikasi tanpa klaim", async () => {
    const admin = await createAdmin(owner, { permissions: ["content.manage"] });
    const session = await signInAdmin({ app, clock }, admin);
    await createAlumni(owner, { status: "verified" });
    for (let round = 0; round < 3; round++) {
      const post = await insertPost({ publishedAt: new Date(clock.now().getTime() - 1000) });
      const gate = barrier(2);
      await Promise.allSettled([
        (async () => {
          await gate();
          return jobs.runScheduled("content.announce");
        })(),
        (async () => {
          await gate();
          return httpClient(app).post(`/admin/content/posts/${post.id}/archive`, {}, {
            token: session.accessToken,
            headers: { "if-match": "1" },
          });
        })(),
      ]);
      const [row] = await tdb.sql<{ status: string; announced: boolean; notified: number }[]>`
        select p.status, p.announced_at is not null as announced,
               (select count(*)::int from app.notifications n where n.data->>'post_id' = p.id::text) as notified
        from app.posts p where p.id = ${post.id}`;
      expect(row!.status, `putaran ${round}`).toBe("archived");
      if (!row!.announced) expect(row!.notified, `putaran ${round}`).toBe(0);
      else expect(row!.notified, `putaran ${round}`).toBeGreaterThan(0);
    }
  });
});

describe("F-01: penerbitan dokumen legal bersamaan pada PostgreSQL 17", () => {
  it("F-01: privasi dan ketentuan diterbitkan bersamaan -> keduanya berhasil, app_settings.legal memuat kedua versi", async () => {
    await tdb.sql`
      insert into app.app_settings (key, value, version, updated_at)
      values ('legal', '{"privacy_version": null, "terms_version": null, "community_version": null}'::jsonb, 1, now())
      on conflict (key) do nothing`;
    const pageIds: string[] = [];
    for (const slug of ["kebijakan-privasi", "ketentuan"]) {
      const pageId = id();
      pageIds.push(pageId);
      await tdb.sql`
        insert into app.pages (id, slug, title, body_html, version)
        values (${pageId}, ${slug}, ${`Naskah ${slug}`}, '<p>Naskah resmi.</p>', 1)
        on conflict (slug) do update set title = excluded.title, body_html = excluded.body_html, version = 1,
          published_title = null, published_body_html = null, published_version = null, published_at = null`;
    }
    const rows = await tdb.sql<{ id: string }[]>`
      select id from app.pages where slug in ('kebijakan-privasi', 'ketentuan') order by slug`;
    const admin = await createAdmin(owner, { permissions: ["content.manage"] });
    const session = await signInAdmin({ app, clock }, admin);
    const gate = barrier(2);
    const results = await Promise.all(
      rows.map(async ({ id: pageId }) => {
        await gate();
        return httpClient(app).post(`/admin/content/pages/${pageId}/publish`, {}, {
          token: session.accessToken,
          headers: { "if-match": "1" },
        });
      }),
    );
    for (const res of results) expect(res.statusCode, res.body).toBe(200);
    const [legal] = await tdb.sql<{ value: Record<string, string | null>; version: number }[]>`
      select value, version from app.app_settings where key = 'legal'`;
    expect(legal!.value).toMatchObject({ privacy_version: "1", terms_version: "1" });
    expect(legal!.version).toBe(3);
  });
});
