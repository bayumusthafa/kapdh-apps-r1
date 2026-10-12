/**
 * Penjaga data PostgreSQL 17 dengan koneksi bersamaan dan login role aplikasi nyata:
 * - AC F08-3 / PRD 6.2: posts.like_count = jumlah post_likes di bawah like bersamaan dan penghapusan akun (F-14).
 * - PRD 3.5 / AC F05-6: N anggota dialokasikan API (kapdh_app) dari nextval, tidak dapat diubah atau didaur ulang.
 * - PRD 2.3 / F-16: jenis akun yang dirujuk alumni/admins.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  barrier,
  connectAs,
  createPgTestDatabase,
  id,
  insertUser,
  type PgTestDatabase,
  pgError,
  sleep,
  type Sql,
} from "./support.js";

let tdb: PgTestDatabase;
let sql: Sql;

beforeAll(async () => {
  tdb = await createPgTestDatabase("data_guards");
  sql = tdb.sql;
});
afterAll(async () => {
  await tdb.drop();
});

async function insertPost(): Promise<string> {
  const postId = id();
  await sql`
    insert into app.posts (id, slug, title, body_html, status, published_at)
    values (${postId}, ${`berita-${postId.slice(-12)}`}, 'Berita Uji', '<p>isi</p>', 'published', now())`;
  return postId;
}

async function likeCounts(postIds: string[]) {
  return sql<{ id: string; like_count: number; actual: number }[]>`
    select p.id, p.like_count, (select count(*)::int from app.post_likes l where l.post_id = p.id) as actual
    from app.posts p where p.id in ${sql(postIds)} order by p.id`;
}

describe("AC F08-3: like_count konsisten pada PostgreSQL 17", () => {
  it("like bersamaan dari banyak anggota (role kapdh_app) termasuk request ganda: penghitung = jumlah baris", async () => {
    const postId = await insertPost();
    const members = await Promise.all(Array.from({ length: 8 }, () => insertUser(sql)));
    const api = connectAs(tdb, "kapdh_app", members.length * 2);
    try {
      const ready = barrier(members.length * 2);
      // Setiap anggota menekan like dua kali bersamaan (AC F08-3: tekan berulang / request diulang).
      await Promise.all(
        [...members, ...members].map((userId) =>
          api.sql.begin(async (tx) => {
            await ready();
            await tx`
              insert into app.post_likes (post_id, user_id) values (${postId}, ${userId}) on conflict do nothing`;
          }),
        ),
      );
    } finally {
      await api.sql.end({ timeout: 5 });
    }
    const [row] = await likeCounts([postId]);
    expect(row).toMatchObject({ like_count: members.length, actual: members.length });
  });

  it("dua akun dihapus bersamaan (role kapdh_worker, kaskade F-14) dengan like pada berita yang sama: tanpa deadlock, penghitung tetap benar", async () => {
    const posts = [await insertPost(), await insertPost(), await insertPost()];
    const [a, b, keep] = [await insertUser(sql), await insertUser(sql), await insertUser(sql)];
    for (const userId of [a, b, keep]) {
      for (const postId of userId === b ? [...posts].reverse() : posts) {
        await sql`insert into app.post_likes (post_id, user_id) values (${postId}, ${userId})`;
      }
    }
    const worker = connectAs(tdb, "kapdh_worker", 2);
    try {
      const ready = barrier(2);
      const results = await Promise.allSettled(
        [a, b].map((userId) =>
          worker.sql.begin(async (tx) => {
            await ready();
            await tx`delete from app.users where id = ${userId}`;
            await sleep(100);
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      await worker.sql.end({ timeout: 5 });
    }
    for (const row of await likeCounts(posts)) expect(row).toMatchObject({ like_count: 1, actual: 1 });
  });
});

describe("PRD 3.5 / AC F05-6: nomor urut N anggota pada PostgreSQL 17", () => {
  it("API (kapdh_app) mengalokasikan N dengan nextval lalu UPDATE; worker tidak dapat; N tidak dapat diubah atau dipakai ulang", async () => {
    const [first, second] = [await insertUser(sql), await insertUser(sql)];
    for (const userId of [first, second]) {
      await sql`
        insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out)
        values (${userId}, 'Alumni Uji', 'female', 20, 4, 6)`;
    }
    const api = connectAs(tdb, "kapdh_app", 1);
    let seqFirst = 0;
    try {
      // Pola AuthService.allocateMemberNumber: nextval + UPDATE dalam satu transaksi (AC F01-2).
      await api.sql.begin(async (tx) => {
        const [row] = await tx<{ n: string }[]>`select nextval('app.membership_no_seq')::text as n`;
        seqFirst = Number(row!.n);
        await tx`
          update app.alumni set member_seq = ${seqFirst}, member_number = ${`20.02.02.${seqFirst}`}
          where user_id = ${first}`;
      });
      const immutable = await api.sql`
        update app.alumni set member_seq = member_seq + 1000, member_number = '20.02.02.' || (member_seq + 1000)
        where user_id = ${first}`.catch((e: unknown) => e);
      expect(pgError(immutable)).toMatchObject({
        code: "23514",
        constraint: "alumni_member_seq_immutable_chk",
      });
    } finally {
      await api.sql.end({ timeout: 5 });
    }

    const worker = connectAs(tdb, "kapdh_worker", 1);
    try {
      const denied = await worker.sql`select nextval('app.membership_no_seq')`.catch((e: unknown) => e);
      expect(pgError(denied).code).toBe("42501");
    } finally {
      await worker.sql.end({ timeout: 5 });
    }

    // N anggota yang dihapus tidak dapat dipasang ke anggota lain (tidak didaur ulang).
    await sql`delete from app.users where id = ${first}`;
    const reused = await sql
      .begin(async (tx) => {
        await tx`select nextval('app.membership_no_seq')`;
        await tx`
          update app.alumni set member_seq = ${seqFirst}, member_number = ${`20.02.02.${seqFirst}`}
          where user_id = ${second}`;
      })
      .catch((e: unknown) => e);
    expect(pgError(reused)).toMatchObject({ code: "23514", constraint: "alumni_member_seq_source_chk" });
  });
});

describe("PRD 2.3 / F-16: jenis akun yang dirujuk pada PostgreSQL 17", () => {
  it("alumni pada akun admin, admin pada akun alumni, tautan alumni ke akun admin, dan ubah kind ditolak", async () => {
    const alumniUser = await insertUser(sql);
    const adminUser = await insertUser(sql, { kind: "admin" });
    const alumniOnAdmin = await sql`
      insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out)
      values (${adminUser}, 'Alumni Uji', 'male', 20, 1, 6)`.catch((e: unknown) => e);
    expect(pgError(alumniOnAdmin).constraint).toBe("alumni_user_kind_chk");
    const adminOnAlumni = await sql`
      insert into app.admins (id, user_id, display_name, role, status, activated_at)
      values (${id()}, ${alumniUser}, 'Admin Uji', 'admin', 'active', now())`.catch((e: unknown) => e);
    expect(pgError(adminOnAlumni).constraint).toBe("admins_user_kind_chk");
    const linkedAdmin = await sql`
      insert into app.admins (id, user_id, linked_alumni_user_id, display_name, role, status, activated_at)
      values (${id()}, ${adminUser}, ${await insertUser(sql, { kind: "admin" })}, 'Admin Uji', 'admin', 'active', now())`.catch(
      (e: unknown) => e,
    );
    expect(pgError(linkedAdmin).constraint).toBe("admins_linked_alumni_kind_chk");
    const kindChange = await sql`update app.users set kind = 'admin' where id = ${alumniUser}`.catch(
      (e: unknown) => e,
    );
    expect(pgError(kindChange)).toMatchObject({ code: "23514", constraint: "users_kind_immutable_chk" });
  });
});
