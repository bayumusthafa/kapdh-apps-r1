import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  barrier,
  connectAs,
  createPgTestDatabase,
  insertAdmin,
  insertAdminAccount,
  insertUser,
  type PgTestDatabase,
  pgError,
  sleep,
  type Sql,
  withLockWaitGate,
} from "./support.js";

let tdb: PgTestDatabase;
let sql: Sql;

beforeAll(async () => {
  tdb = await createPgTestDatabase("last_super_admin");
  sql = tdb.sql;
});
afterAll(async () => {
  await tdb.drop();
});

/** Kosongkan admins di antara skenario tanpa melewati penjaga (Super Admin dinonaktifkan dulu secara sah). */
beforeEach(async () => {
  await sql.begin(async (tx) => {
    await tx`alter table app.admins disable trigger admins_guard_last_super_admin`;
    await tx`delete from app.admins`;
    await tx`alter table app.admins enable trigger admins_guard_last_super_admin`;
  });
});

async function activeSuperAdmins(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from app.admins where role = 'super_admin' and status = 'active'`;
  return row!.n;
}

/** Super Admin yang dapat login: admin super_admin aktif DAN akun users aktif (AC F16-2, PRD 3.14). */
async function usableSuperAdmins(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from app.admins a join app.users u on u.id = a.user_id
    where a.role = 'super_admin' and a.status = 'active' and u.status = 'active'`;
  return row!.n;
}

/**
 * Dua transaksi pada koneksi berbeda menjalankan perubahan bersamaan: keduanya mulai, menunggu satu sama lain di
 * penghalang, menjalankan statement, lalu menahan transaksi terbuka sebentar sebelum commit.
 */
/** Transaksi bersamaan; `hold` menahan commit (gerbang lock-wait deterministik, atau jeda tetap). */
async function runConcurrently(
  statements: ((tx: Sql) => Promise<unknown>)[],
  hold: () => Promise<void> = () => sleep(250),
) {
  const ready = barrier(statements.length);
  return Promise.allSettled(
    statements.map((run) =>
      sql.begin(async (tx) => {
        await tx`select 1`;
        await ready();
        await run(tx as unknown as Sql);
        await hold();
      }),
    ),
  );
}

describe("AC F16-2: Super Admin aktif terakhir dijaga transaksi (PostgreSQL 17, koneksi bersamaan)", () => {
  it("dua demosi bersamaan atas dua Super Admin terakhir: tepat satu berhasil, minimal satu tersisa", async () => {
    const a = await insertAdmin(sql, { role: "super_admin" });
    const b = await insertAdmin(sql, { role: "super_admin" });
    expect(await activeSuperAdmins()).toBe(2);

    const { result: results, lockWaitObserved } = await withLockWaitGate(tdb, (hold) =>
      runConcurrently(
        [
          (tx) => tx`update app.admins set status = 'disabled', disabled_at = now() where id = ${a}`,
          (tx) => tx`update app.admins set role = 'admin' where id = ${b}`,
        ],
        hold,
      ),
    );
    // Transaksi kedua benar-benar menunggu transaksi pertama (bukan dieksekusi berurutan).
    expect(lockWaitObserved).toBe(true);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(pgError(rejected[0]!.reason)).toMatchObject({
      code: "23514",
      constraint: "admins_last_super_admin_chk",
    });
    expect(await activeSuperAdmins()).toBe(1);
  });

  it("dua penghapusan bersamaan tidak dapat menghapus seluruh Super Admin aktif", async () => {
    const a = await insertAdmin(sql, { role: "super_admin" });
    const b = await insertAdmin(sql, { role: "super_admin" });
    const { result: results, lockWaitObserved } = await withLockWaitGate(tdb, (hold) =>
      runConcurrently(
        [
          (tx) => tx`delete from app.admins where id = ${a}`,
          (tx) => tx`delete from app.admins where id = ${b}`,
        ],
        hold,
      ),
    );
    expect(lockWaitObserved).toBe(true);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await activeSuperAdmins()).toBe(1);
  });

  it("tiga Super Admin, dua demosi bersamaan: keduanya sah karena satu tetap tersisa", async () => {
    const a = await insertAdmin(sql, { role: "super_admin" });
    const b = await insertAdmin(sql, { role: "super_admin" });
    await insertAdmin(sql, { role: "super_admin" });
    const results = await runConcurrently([
      (tx) => tx`update app.admins set status = 'disabled', disabled_at = now() where id = ${a}`,
      (tx) => tx`update app.admins set status = 'disabled', disabled_at = now() where id = ${b}`,
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await activeSuperAdmins()).toBe(1);
  });

  it("satu statement yang menonaktifkan semua Super Admin ditolak seluruhnya", async () => {
    await insertAdmin(sql, { role: "super_admin" });
    await insertAdmin(sql, { role: "super_admin" });
    const err = await sql`
      update app.admins set status = 'disabled', disabled_at = now() where role = 'super_admin'`.catch(
      (e: unknown) => e,
    );
    expect(pgError(err)).toMatchObject({ code: "23514", constraint: "admins_last_super_admin_chk" });
    expect(await activeSuperAdmins()).toBe(2);
  });

  it("menghapus akun users milik Super Admin terakhir ditolak (penjaga akun users, PRD 3.14)", async () => {
    const a = await insertAdmin(sql, { role: "super_admin" });
    const err =
      await sql`delete from app.users where id = (select user_id from app.admins where id = ${a})`.catch(
        (e: unknown) => e,
      );
    expect(pgError(err).constraint).toBe("admins_last_super_admin_chk");
    expect(await activeSuperAdmins()).toBe(1);
  });

  it("perubahan yang tidak mengurangi Super Admin aktif tetap diizinkan", async () => {
    const a = await insertAdmin(sql, { role: "super_admin" });
    const admin = await insertAdmin(sql, { role: "admin" });
    await sql`update app.admins set display_name = 'Nama Baru', permissions_version = permissions_version + 1
              where id = ${a}`;
    await sql`update app.admins set status = 'disabled', disabled_at = now() where id = ${admin}`;
    await sql`update app.admins set role = 'super_admin' where id = ${admin}`;
    expect(await activeSuperAdmins()).toBe(1);
  });

  it("TRUNCATE admins ditolak selama ada Super Admin aktif", async () => {
    await insertAdmin(sql, { role: "super_admin" });
    const err = await sql`truncate app.admins cascade`.catch((e: unknown) => e);
    expect(pgError(err).constraint).toBe("admins_last_super_admin_chk");
  });

  it("penjaga juga berlaku untuk role aplikasi kapdh_app (grant DML, bukan pemilik)", async () => {
    const a = await insertAdmin(sql, { role: "super_admin" });
    const err = await sql
      .begin(async (tx) => {
        await tx`set local role kapdh_app`;
        await tx`update app.admins set status = 'disabled', disabled_at = now() where id = ${a}`;
      })
      .catch((e: unknown) => e);
    expect(pgError(err).constraint).toBe("admins_last_super_admin_chk");
  });

  it("pola layanan 'SELECT ... FOR UPDATE baris sendiri lalu UPDATE' (ARCHITECTURE §2.11): pihak kalah 23514, tidak pernah deadlock 40P01", async () => {
    for (let round = 0; round < 5; round++) {
      await sql.begin(async (tx) => {
        await tx`alter table app.admins disable trigger admins_guard_last_super_admin`;
        await tx`delete from app.admins`;
        await tx`alter table app.admins enable trigger admins_guard_last_super_admin`;
      });
      const a = await insertAdmin(sql, { role: "super_admin" });
      const b = await insertAdmin(sql, { role: "super_admin" });
      const locked = barrier(2);
      const results = await Promise.allSettled(
        [a, b].map((target, i) =>
          sql.begin(async (tx) => {
            // Kunci baris target dahulu (assertVersion / If-Match), tunggu lawan juga memegang kuncinya, lalu demosi.
            await tx`select id, version from app.admins where id = ${target} for update`;
            await locked();
            if (i === 0)
              await tx`update app.admins set status = 'disabled', disabled_at = now() where id = ${target}`;
            else await tx`update app.admins set role = 'admin' where id = ${target}`;
            await sleep(100);
          }),
        ),
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(pgError(rejected[0]!.reason)).toMatchObject({
        code: "23514",
        constraint: "admins_last_super_admin_chk",
      });
      expect(await activeSuperAdmins()).toBe(1);
    }
  });

  it("PRD 3.14: menonaktifkan akun login Super Admin bersamaan dengan demosi Super Admin lain: minimal satu tetap dapat login", async () => {
    const a = await insertAdminAccount(sql, { role: "super_admin" });
    const b = await insertAdminAccount(sql, { role: "super_admin" });
    const { result: results, lockWaitObserved } = await withLockWaitGate(tdb, (hold) =>
      runConcurrently(
        [
          (tx) => tx`update app.users set status = 'disabled' where id = ${a.userId}`,
          (tx) => tx`update app.admins set role = 'admin' where id = ${b.adminId}`,
        ],
        hold,
      ),
    );
    expect(lockWaitObserved).toBe(true);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(pgError(rejected[0]!.reason)).toMatchObject({
      code: "23514",
      constraint: "admins_last_super_admin_chk",
    });
    expect(await usableSuperAdmins()).toBe(1);
  });

  it("F-14: dua akun Super Admin ditandai deletion_pending bersamaan: tepat satu ditolak", async () => {
    const a = await insertAdminAccount(sql, { role: "super_admin" });
    const b = await insertAdminAccount(sql, { role: "super_admin" });
    const results = await runConcurrently([
      (tx) => tx`update app.users set status = 'deletion_pending' where id = ${a.userId}`,
      (tx) => tx`update app.users set status = 'deletion_pending' where id = ${b.userId}`,
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await usableSuperAdmins()).toBe(1);
    // Akun yang sudah deletion_pending bukan Super Admin yang dapat login: job penghapusan dapat menghapusnya.
    const pending = (
      await sql<{ id: string }[]>`
      select id from app.users where id in (${a.userId}, ${b.userId}) and status = 'deletion_pending'`
    )[0]!.id;
    await sql`delete from app.users where id = ${pending}`;
    expect(await usableSuperAdmins()).toBe(1);
  });

  it("REPEATABLE READ/SERIALIZABLE: pengurangan Super Admin ditolak eksplisit (0A000) agar snapshot basi tidak meloloskan dua demosi", async () => {
    const a = await insertAdminAccount(sql, { role: "super_admin" });
    const b = await insertAdminAccount(sql, { role: "super_admin" });
    const ready = barrier(2);
    const results = await Promise.allSettled(
      [a.adminId, b.adminId].map((target) =>
        sql.begin("isolation level repeatable read", async (tx) => {
          // Snapshot transaksi diambil sebelum lawan commit.
          await tx`select count(*) from app.admins`;
          await ready();
          await tx`update app.admins set status = 'disabled', disabled_at = now() where id = ${target}`;
          await sleep(150);
        }),
      ),
    );
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect(pgError((r as PromiseRejectedResult).reason).code).toBe("0A000");
    }
    const serializable = await sql
      .begin(
        "isolation level serializable",
        (tx) => tx`update app.users set status = 'disabled' where id = ${a.userId}`,
      )
      .catch((e: unknown) => e);
    expect(pgError(serializable).code).toBe("0A000");
    expect(await usableSuperAdmins()).toBe(2);
    // Perubahan yang tidak mengurangi (akun alumni, admin nonaktif) tetap boleh pada isolasi apa pun.
    const alumniUser = await insertUser(sql);
    await sql.begin(
      "isolation level repeatable read",
      (tx) => tx`update app.users set status = 'disabled' where id = ${alumniUser}`,
    );
  });

  it("login role kapdh_app nyata (bukan superuser): penjaga, advisory lock, dan pembacaan users berjalan dengan grant aplikasi", async () => {
    const a = await insertAdminAccount(sql, { role: "super_admin" });
    const api = connectAs(tdb, "kapdh_app");
    try {
      const [who] = await api.sql<{ s: string }[]>`select session_user as s`;
      expect(who!.s).toBe("kapdh_app");
      const err = await api.sql`update app.users set status = 'disabled' where id = ${a.userId}`.catch(
        (e: unknown) => e,
      );
      expect(pgError(err)).toMatchObject({ code: "23514", constraint: "admins_last_super_admin_chk" });
      const b = await insertAdminAccount(sql, { role: "super_admin" });
      await api.sql`update app.admins set role = 'admin' where id = ${b.adminId}`;
    } finally {
      await api.sql.end({ timeout: 5 });
    }
    expect(await usableSuperAdmins()).toBe(1);
  });
});
