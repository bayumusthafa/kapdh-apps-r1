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
 * - PRD 2.5, 3.8: simpan konten yang merujuk gambar dan pembuangan gambar yang sama berurutan lewat kunci baris
 *   berkas (gambar yang dirujuk tidak pernah terhapus; rujukan ke gambar terhapus ditolak 400), dan dua draf yang
 *   merujuk gambar yang sama dalam urutan berlawanan tidak deadlock (kunci berkas urut id).
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
import {
  barrier,
  connectAs,
  createPgTestDatabase,
  id,
  type PgTestDatabase,
  withLockWaitGate,
} from "./support.js";

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

async function insertPost(opts: {
  publishedAt: Date;
  status?: string;
}): Promise<{ id: string; slug: string }> {
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
      Array.from({ length: 12 }, async () =>
        signInAlumni({ app }, await createAlumni(owner, { status: "verified" })),
      ),
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
      Array.from({ length: 8 }, async () =>
        signInAlumni({ app }, await createAlumni(owner, { status: "verified" })),
      ),
    );
    const client = httpClient(app);
    for (const m of members.slice(0, 4))
      await client.put(`/posts/${post.slug}/like`, {}, { token: m.accessToken });
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
          return httpClient(app).post(
            `/admin/content/posts/${post.id}/archive`,
            {},
            {
              token: session.accessToken,
              headers: { "if-match": "1" },
            },
          );
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
        return httpClient(app).post(
          `/admin/content/pages/${pageId}/publish`,
          {},
          {
            token: session.accessToken,
            headers: { "if-match": "1" },
          },
        );
      }),
    );
    for (const res of results) expect(res.statusCode, res.body).toBe(200);
    const [legal] = await tdb.sql<{ value: Record<string, string | null>; version: number }[]>`
      select value, version from app.app_settings where key = 'legal'`;
    expect(legal!.value).toMatchObject({ privacy_version: "1", terms_version: "1" });
    expect(legal!.version).toBe(3);
  });
});

// ------------------------------------------------------------------------------------------ gambar konten

/** Kunci advisory penahan: trigger uji menunggu kunci ini (shared) selama penahan memegangnya (exclusive). */
const HOLD_KEY = 7_340_001;

/** Gambar konten publik siap pakai milik pengurus (setara hasil POST /admin/content/media). */
async function insertContentImage(ownerUserId: string): Promise<string> {
  const fileId = id();
  await tdb.sql`
    insert into app.files (id, owner_user_id, purpose, storage_driver, object_key, mime, bytes, sha256,
                           visibility, status, width, height)
    values (${fileId}, ${ownerUserId}, 'post_cover', 'local', ${`post_cover/2026/10/${fileId}`}, 'image/jpeg',
            100, ${"a".repeat(64)}, 'public', 'ready', 120, 60)`;
  return fileId;
}

/** Jumlah backend database uji yang sedang menunggu kunci (opsional hanya kunci advisory). */
async function lockWaiters(event?: "advisory"): Promise<number> {
  const rows = await tdb.sql<{ wait_event: string }[]>`
    select wait_event from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'`;
  return rows.filter((row) => !event || row.wait_event === event).length;
}

/** Menunggu sampai kondisi terpenuhi (true), atau `stop()` / batas waktu (false); tanpa jendela sleep tetap. */
async function until(condition: () => Promise<boolean>, stop: () => boolean = () => false): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    if (stop()) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

/**
 * Menahan transaksi API di titik tertentu secara deterministik: trigger AFTER UPDATE (tabel + syarat WHEN) memanggil
 * pg_advisory_xact_lock_shared(HOLD_KEY) selama penahan memegang kunci itu, sehingga transaksi berhenti SESUDAH
 * pernyataan tersebut dengan semua kunci barisnya tetap dipegang. Trigger dibuang sesudah uji.
 */
async function withHold<T>(
  table: "pages" | "files",
  when: string,
  work: (release: () => void) => Promise<T>,
): Promise<T> {
  await tdb.sql.unsafe(
    "create or replace function app.test_content_hold() returns trigger language plpgsql as $$ " +
      `begin perform pg_advisory_xact_lock_shared(${HOLD_KEY}); return null; end $$`,
  );
  await tdb.sql.unsafe(
    `create trigger test_content_hold after update on app.${table} for each row when (${when}) ` +
      "execute function app.test_content_hold()",
  );
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => (signalHeld = resolve));
  const holder = tdb.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${HOLD_KEY})`;
    signalHeld();
    await released;
  });
  try {
    await held;
    return await work(release);
  } finally {
    release();
    await holder;
    await tdb.sql.unsafe(`drop trigger if exists test_content_hold on app.${table}`);
  }
}

async function contentAdmin() {
  const admin = await createAdmin(owner, { permissions: ["content.manage"] });
  const session = await signInAdmin({ app, clock }, admin);
  const client = httpClient(app);
  const as = { token: session.accessToken };
  const createPost = async (body: Record<string, unknown>) => {
    const res = await client.post(
      "/admin/content/posts",
      { title: "Berita Bersampul", body_html: "<p>Isi.</p>", ...body },
      as,
    );
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; version: string };
  };
  const createPage = async () => {
    const res = await client.post(
      "/admin/content/pages",
      { slug: `info-${id().slice(-12)}`, title: "Info", body_html: "<p>Awal.</p>" },
      as,
    );
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; version: string };
  };
  const patch = (path: string, version: string, body: Record<string, unknown>) =>
    client.patch(path, body, { ...as, headers: { "if-match": version } });
  return { admin, createPost, createPage, patch };
}

const imgTag = (fileId: string, alt: string) =>
  `<img src="${testEnv.API_PUBLIC_URL}/api/v1/files/public/${fileId}" alt="${alt}">`;

async function fileStatus(fileId: string) {
  const [row] = await tdb.sql<{ status: string; attached: boolean }[]>`
    select status, attached_at is not null as attached from app.files where id = ${fileId}`;
  return row!;
}

describe("PRD 2.5, 3.8: gambar konten di bawah konkurensi nyata PostgreSQL 17", () => {
  it("PRD 3.8: simpan halaman yang merujuk cover berita bersamaan dengan penggantian cover itu -> gambar dipertahankan", async () => {
    const { admin, createPost, createPage, patch } = await contentAdmin();
    const oldCover = await insertContentImage(admin.userId);
    const newCover = await insertContentImage(admin.userId);
    const post = await createPost({ cover_file_id: oldCover });
    const page = await createPage();
    const body = `<p>Lihat sampul berita.</p>${imgTag(oldCover, "Sampul berita")}`;

    const outcome = await withHold("pages", `new.id = '${page.id}'`, async (release) => {
      // 1) Simpan halaman berhenti SESUDAH UPDATE pages (kunci berkas yang dirujuk tetap dipegang).
      const pageSave = patch(`/admin/content/pages/${page.id}`, page.version, { body_html: body });
      expect(await until(async () => (await lockWaiters("advisory")) >= 1)).toBe(true);
      // 2) Ganti cover berita: cover lama dibuang hanya bila tidak dirujuk konten lain.
      let swapSettled = false;
      const coverSwap = patch(`/admin/content/posts/${post.id}`, post.version, {
        cover_file_id: newCover,
      }).finally(() => (swapSettled = true));
      const swapWaited = await until(
        async () => (await lockWaiters()) >= 2,
        () => swapSettled,
      );
      release();
      return { pageSave: await pageSave, coverSwap: await coverSwap, swapWaited };
    });

    expect(outcome.pageSave.statusCode, outcome.pageSave.body).toBe(200);
    expect(outcome.coverSwap.statusCode, outcome.coverSwap.body).toBe(200);
    expect(outcome.swapWaited, "pembuangan cover menunggu kunci berkas milik penyimpanan halaman").toBe(true);
    expect((outcome.pageSave.json() as { body_html: string }).body_html).toContain(oldCover);
    // Cover lama masih dirujuk halaman: tidak dibuang.
    expect(await fileStatus(oldCover)).toEqual({ status: "ready", attached: true });
    expect(await fileStatus(newCover)).toEqual({ status: "ready", attached: true });
  });

  it("PRD 3.8: cover dibuang lebih dahulu lalu halaman yang merujuknya disimpan bersamaan -> simpan ditolak 400", async () => {
    const { admin, createPost, createPage, patch } = await contentAdmin();
    const oldCover = await insertContentImage(admin.userId);
    const newCover = await insertContentImage(admin.userId);
    const post = await createPost({ cover_file_id: oldCover });
    const page = await createPage();

    const outcome = await withHold(
      "files",
      `new.id = '${oldCover}' and new.status = 'deleted'`,
      async (release) => {
        // 1) Ganti cover berhenti SESUDAH menandai cover lama `deleted` (baris berkas tetap terkunci).
        const coverSwap = patch(`/admin/content/posts/${post.id}`, post.version, { cover_file_id: newCover });
        expect(await until(async () => (await lockWaiters("advisory")) >= 1)).toBe(true);
        // 2) Simpan halaman yang merujuk cover lama.
        let saveSettled = false;
        const pageSave = patch(`/admin/content/pages/${page.id}`, page.version, {
          body_html: `<p>Sampul lama.</p>${imgTag(oldCover, "Sampul lama")}`,
        }).finally(() => (saveSettled = true));
        const saveWaited = await until(
          async () => (await lockWaiters()) >= 2,
          () => saveSettled,
        );
        release();
        return { pageSave: await pageSave, coverSwap: await coverSwap, saveWaited };
      },
    );

    expect(outcome.coverSwap.statusCode, outcome.coverSwap.body).toBe(200);
    expect(outcome.saveWaited, "penyimpanan halaman menunggu kunci berkas milik pembuangan").toBe(true);
    expect(outcome.pageSave.statusCode, outcome.pageSave.body).toBe(400);
    expect(outcome.pageSave.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { body_html: expect.any(Array) },
    });
    expect(await fileStatus(oldCover)).toMatchObject({ status: "deleted" });
    const [stored] = await tdb.sql<{ body_html: string; version: number }[]>`
      select body_html, version from app.pages where id = ${page.id}`;
    expect(stored).toEqual({ body_html: "<p>Awal.</p>", version: Number(page.version) });
  });

  it("ARCHITECTURE §2: dua draf merujuk dua gambar baru dalam urutan berlawanan bersamaan -> keduanya 200 tanpa deadlock", async () => {
    const { admin, createPage, patch } = await contentAdmin();
    const first = await insertContentImage(admin.userId);
    const second = await insertContentImage(admin.userId);
    const pageA = await createPage();
    const pageB = await createPage();

    const results = await withHold(
      "files",
      `new.id in ('${first}', '${second}') and old.attached_at is null and new.attached_at is not null`,
      async (release) => {
        const saves = [
          patch(`/admin/content/pages/${pageA.id}`, pageA.version, {
            body_html: `${imgTag(first, "Satu")}${imgTag(second, "Dua")}`,
          }),
          patch(`/admin/content/pages/${pageB.id}`, pageB.version, {
            body_html: `${imgTag(second, "Dua")}${imgTag(first, "Satu")}`,
          }),
        ];
        // Kedua penyimpanan sudah berebut sebelum dilepas. Urutan lama (lampirkan menurut urutan di body): masing-
        // masing memegang satu gambar lalu menunggu gambar lainnya -> deadlock 40P01 -> 500.
        expect(await until(async () => (await lockWaiters()) >= 2)).toBe(true);
        release();
        return Promise.all(saves);
      },
    );

    for (const res of results) expect(res.statusCode, res.body).toBe(200);
    expect(await fileStatus(first)).toEqual({ status: "ready", attached: true });
    expect(await fileStatus(second)).toEqual({ status: "ready", attached: true });
  });
});
