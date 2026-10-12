import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  barrier,
  createPgTestDatabase,
  insertAdmin,
  type PgTestDatabase,
  pgError,
  sleep,
  type Sql,
  withLockWaitProbe,
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

/**
 * Dua transaksi pada koneksi berbeda menjalankan perubahan bersamaan: keduanya mulai, menunggu satu sama lain di
 * penghalang, menjalankan statement, lalu menahan transaksi terbuka sebentar sebelum commit.
 */
async function runConcurrently(statements: ((tx: Sql) => Promise<unknown>)[]) {
  const ready = barrier(statements.length);
  return Promise.allSettled(
    statements.map((run) =>
      sql.begin(async (tx) => {
        await tx`select 1`;
        await ready();
        await run(tx as unknown as Sql);
        await sleep(250);
      }),
    ),
  );
}

describe("AC F16-2: Super Admin aktif terakhir dijaga transaksi (PostgreSQL 17, koneksi bersamaan)", () => {
  it("dua demosi bersamaan atas dua Super Admin terakhir: tepat satu berhasil, minimal satu tersisa", async () => {
    const a = await insertAdmin(sql, { role: "super_admin" });
    const b = await insertAdmin(sql, { role: "super_admin" });
    expect(await activeSuperAdmins()).toBe(2);

    const { result: results, maxWaiting } = await withLockWaitProbe(
      sql,
      runConcurrently([
        (tx) => tx`update app.admins set status = 'disabled', disabled_at = now() where id = ${a}`,
        (tx) => tx`update app.admins set role = 'admin' where id = ${b}`,
      ]),
    );
    // Transaksi kedua benar-benar menunggu transaksi pertama (bukan dieksekusi berurutan).
    expect(maxWaiting).toBeGreaterThanOrEqual(1);

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
    const { result: results, maxWaiting } = await withLockWaitProbe(
      sql,
      runConcurrently([
        (tx) => tx`delete from app.admins where id = ${a}`,
        (tx) => tx`delete from app.admins where id = ${b}`,
      ]),
    );
    expect(maxWaiting).toBeGreaterThanOrEqual(1);
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

  it("menghapus akun users milik Super Admin terakhir ikut ditolak (kaskade FK memicu penjaga)", async () => {
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
});
