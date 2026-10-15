/**
 * Kompatibilitas PGlite (jalur uji bawaan API, ARCHITECTURE §9.1): migrasi journal yang sama dengan production
 * berjalan di PGlite 0.5.x, trigger dan constraint skema bekerja, dan seed dapat diulang. Konkurensi nyata dan
 * PostgreSQL 17 dibuktikan di apps/api test/pg (pnpm test:pg).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/client.js";
import { schema } from "../src/client.js";
import { MIGRATIONS_FOLDER } from "../src/migrate.js";
import { APP_SETTING_KEYS } from "../src/schema/settings.js";
import { seedDev } from "../seeds/dev.js";
import { seedReference } from "../seeds/reference.js";

let pg: PGlite;
let db: Database;

const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
  entries: { tag: string; when: number }[];
};

/**
 * Salinan folder migrasi yang journal-nya berhenti di `lastTag`: mensimulasikan database lingkungan yang sudah
 * dimigrasi sebelum migrasi aditif berikutnya dirilis. Pemanggil menghapus folder setelah dipakai.
 */
function migrationsUpTo(lastTag: string): string {
  const cut = journal.entries.findIndex((e) => e.tag === lastTag);
  if (cut < 0) throw new Error(`Tag migrasi tidak ada di journal: ${lastTag}`);
  const entries = journal.entries.slice(0, cut + 1);
  const dir = mkdtempSync(join(tmpdir(), "kapdh-migrations-"));
  mkdirSync(join(dir, "meta"));
  for (const e of entries) copyFileSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return dir;
}

beforeAll(async () => {
  pg = new PGlite();
  const migrator = drizzle(pg, { schema });
  await migrate(migrator, { migrationsFolder: MIGRATIONS_FOLDER });
  db = migrator as unknown as Database;
});
afterAll(async () => {
  await pg.close();
});

async function errorOf(
  statement: string,
  params: unknown[] = [],
): Promise<{ code?: string; constraint?: string }> {
  try {
    await pg.query(statement, params);
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return { code: err.code, constraint: err.constraint };
  }
  throw new Error(`Statement seharusnya gagal: ${statement}`);
}

async function count(statement: string, params: unknown[] = []): Promise<number> {
  const result = await pg.query<{ n: number }>(statement, params);
  return result.rows[0]!.n;
}

async function insertUser(
  kind: "alumni" | "admin" = "alumni",
  email?: string,
  status = "active",
): Promise<string> {
  const id = uuidv7();
  await pg.query(
    "insert into app.users (id, email, password_hash, status, kind) values ($1, $2, 'hash', $3, $4)",
    [id, email ?? `u-${id}@contoh.test`, status, kind],
  );
  return id;
}

async function insertAdmin(
  role: "super_admin" | "admin" = "super_admin",
): Promise<{ id: string; userId: string }> {
  const userId = await insertUser("admin");
  const id = uuidv7();
  await pg.query(
    `insert into app.admins (id, user_id, display_name, role, status, activated_at)
     values ($1, $2, 'Admin Uji', $3, 'active', now())`,
    [id, userId, role],
  );
  return { id, userId };
}

async function insertSuperAdmin(): Promise<string> {
  return (await insertAdmin("super_admin")).id;
}

/** Kosongkan admins tanpa melewati penjaga lewat jalur aplikasi (hanya pemilik tabel di uji). */
async function resetAdmins(): Promise<void> {
  await pg.exec(`
    alter table app.admins disable trigger admins_guard_last_super_admin;
    delete from app.admins;
    alter table app.admins enable trigger admins_guard_last_super_admin;`);
}

/** Super Admin yang dapat login: admin super_admin aktif dengan akun users aktif (AC F16-2). */
function usableSuperAdmins(): Promise<number> {
  return count(`
    select count(*)::int as n from app.admins a join app.users u on u.id = a.user_id
    where a.role = 'super_admin' and a.status = 'active' and u.status = 'active'`);
}

/** Mengambil N dari sequence pada sesi ini (alokasi resmi PRD 3.5). */
async function nextMemberSeq(): Promise<number> {
  const result = await pg.query<{ n: string }>("select nextval('app.membership_no_seq')::text as n");
  return Number(result.rows[0]!.n);
}

/** Nomor AA.SS.JK.N untuk angkatan 12, kelas 1-3 (SS 02), laki-laki. */
const number12 = (seq: number, ss = "02") => `12.${ss}.01.${seq}`;

async function insertAlumni(userId: string, seq: number | null): Promise<void> {
  await pg.query(
    `insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out, member_seq, member_number)
     values ($1, 'Alumni Uji', 'male', 12, 1, 3, $2, $3)`,
    [userId, seq, seq === null ? null : number12(seq)],
  );
}

describe("migrasi journal pada PGlite", () => {
  it("menerapkan seluruh entri _journal.json berurutan dan mencatatnya seperti migrator production", async () => {
    const recorded = await pg.query<{ created_at: string }>(
      "select created_at from drizzle.__drizzle_migrations order by id",
    );
    expect(recorded.rows.map((r) => Number(r.created_at))).toEqual(journal.entries.map((e) => e.when));
    expect(await count("select count(*)::int as n from pg_tables where schemaname = 'app'")).toBe(40);
  });

  it("journal berurutan naik dan setiap migrasi memisahkan satu statement per breakpoint", () => {
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    for (const entry of journal.entries) {
      const text = readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8");
      for (const chunk of text.split("--> statement-breakpoint")) {
        const body = chunk.replace(/\$\$[\s\S]*?\$\$/g, "$$$$").replace(/--[^\n]*/g, "");
        expect(body.split(";").filter((s) => s.trim()).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("0006 sebagai migrasi aditif pada database yang sudah sampai 0005: enum appeal, kolom, dan CHECK baru", async () => {
    const dir = migrationsUpTo("0005_post_like_count");
    const existing = new PGlite();
    try {
      // Lingkungan lama: 0000-0005 sudah di-commit, sehingga ADD VALUE berjalan pada tipe enum yang sudah ada dan
      // migrator berikutnya hanya menerapkan 0006 dalam transaksinya sendiri (seperti job migrasi production).
      await migrate(drizzle(existing), { migrationsFolder: dir });
      await migrate(drizzle(existing), { migrationsFolder: MIGRATIONS_FOLDER });
      const recorded = await existing.query<{ n: number }>(
        "select count(*)::int as n from drizzle.__drizzle_migrations",
      );
      expect(recorded.rows[0]!.n).toBe(journal.entries.length);
      const labels = await existing.query<{ label: string }>(
        `select e.enumlabel as label from pg_enum e join pg_type t on t.oid = e.enumtypid
         join pg_namespace n on n.oid = t.typnamespace
         where n.nspname = 'app' and t.typname = 'report_category' order by e.enumsortorder`,
      );
      expect(labels.rows.map((r) => r.label).at(-1)).toBe("appeal");
      const userId = uuidv7();
      await existing.query(
        "insert into app.users (id, email, password_hash, kind) values ($1, $2, 'hash', 'alumni')",
        [userId, `banding-${userId}@contoh.test`],
      );
      await existing.query(
        `insert into app.reports (id, reporter_id, target_type, target_user_id, category, due_at)
         values ($1, $2, 'user', $2, 'appeal', now() + interval '2 days')`,
        [uuidv7(), userId],
      );
      const notNull = await existing.query<{ attnotnull: boolean }>(
        `select attnotnull from pg_attribute where attrelid = 'app.reports'::regclass and attname = 'due_at'`,
      );
      expect(notNull.rows[0]!.attnotnull).toBe(true);
    } finally {
      await existing.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("0008 sebagai migrasi aditif pada database yang sudah sampai 0007: enum qris, kolom gambar QR, CHECK teks (ADR-026)", async () => {
    const dir = migrationsUpTo("0007_auth_otp_decoys");
    const existing = new PGlite();
    try {
      // Lingkungan production saat ini: 0000-0007 sudah di-commit dan sudah ada metode bayar lama (termasuk metode
      // bernama "QRIS" berjenis ewallet tanpa gambar). Job migrasi berikutnya hanya menerapkan 0008 dalam
      // transaksinya sendiri: ADD VALUE dan CHECK teks berjalan bersama tanpa 55P04.
      await migrate(drizzle(existing), { migrationsFolder: dir });
      const legacy = uuidv7();
      await existing.query(
        `insert into app.payment_methods (id, kind, provider, account_number, account_holder)
         values ($1, 'ewallet', 'QRIS', 'ID1020304050607', 'KAPDH')`,
        [legacy],
      );
      await migrate(drizzle(existing), { migrationsFolder: MIGRATIONS_FOLDER });
      const recorded = await existing.query<{ n: number }>(
        "select count(*)::int as n from drizzle.__drizzle_migrations",
      );
      expect(recorded.rows[0]!.n).toBe(journal.entries.length);
      const labels = await existing.query<{ label: string }>(
        `select e.enumlabel as label from pg_enum e join pg_type t on t.oid = e.enumtypid
         join pg_namespace n on n.oid = t.typnamespace
         where n.nspname = 'app' and t.typname = 'payment_method_kind' order by e.enumsortorder`,
      );
      expect(labels.rows.map((r) => r.label)).toEqual(["bank", "ewallet", "qris"]);
      // Baris lama tetap sah (bukan qris, tanpa gambar) dan kolom baru kosong.
      const old = await existing.query<{ kind: string; qr_image_file_id: string | null }>(
        "select kind, qr_image_file_id from app.payment_methods where id = $1",
        [legacy],
      );
      expect(old.rows).toEqual([{ kind: "ewallet", qr_image_file_id: null }]);
      // Nilai enum baru dapat dipakai setelah transaksi migrasi di-commit.
      const fileId = uuidv7();
      await existing.query(
        `insert into app.files (id, purpose, storage_driver, object_key, mime, bytes, sha256, visibility, status)
         values ($1, 'payment_qr', 'local', $2, 'image/png', 10, $3, 'public', 'ready')`,
        [fileId, `payment_qr/2026/10/${fileId}`, "a".repeat(64)],
      );
      await existing.query(
        `insert into app.payment_methods (id, kind, provider, account_number, account_holder, qr_image_file_id)
         values ($1, 'qris', 'QRIS', 'ID1020304050607', 'KAPDH', $2)`,
        [uuidv7(), fileId],
      );
      const constraints = await existing.query<{ conname: string }>(
        `select conname from pg_constraint
         where conrelid in ('app.payment_methods'::regclass, 'app.files'::regclass)
           and conname in ('payment_methods_qr_image_chk', 'payment_methods_qr_image_file_id_files_id_fk',
                           'files_purpose_chk', 'files_private_purpose_chk')
         order by conname`,
      );
      expect(constraints.rows.map((r) => r.conname)).toEqual([
        "files_private_purpose_chk",
        "files_purpose_chk",
        "payment_methods_qr_image_chk",
        "payment_methods_qr_image_file_id_files_id_fk",
      ]);
      // CHECK memakai perbandingan teks (bukan literal enum) sehingga aman di job migrasi yang sama dengan ADD VALUE.
      const definition = await existing.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'payment_methods_qr_image_chk'`,
      );
      expect(definition.rows[0]!.def).toContain("::text = 'qris'::text");
      expect(definition.rows[0]!.def).not.toContain("payment_method_kind");
    } finally {
      await existing.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrasi 0008 tidak memakai nilai enum qris sebagai literal enum (README: aturan nilai enum baru)", () => {
    const text = readFileSync(join(MIGRATIONS_FOLDER, "0008_qris_payment_method.sql"), "utf8");
    const statements = text.split("--> statement-breakpoint").map((s) => s.trim());
    expect(statements[0]).toBe(`ALTER TYPE "app"."payment_method_kind" ADD VALUE 'qris';`);
    for (const statement of statements.slice(1)) {
      expect(statement).not.toMatch(/'qris'::/);
      expect(statement).not.toMatch(/payment_method_kind/);
      if (statement.includes("'qris'")) expect(statement).toContain(`"kind"::text = 'qris'`);
    }
  });
});

describe("AC F16-2: penjaga Super Admin terakhir yang dapat login (PGlite)", () => {
  it("Super Admin aktif terakhir tidak dapat dinonaktifkan, diturunkan, atau dihapus", async () => {
    await resetAdmins();
    const only = await insertSuperAdmin();
    const last = { code: "23514", constraint: "admins_last_super_admin_chk" };
    expect(
      await errorOf("update app.admins set status = 'disabled', disabled_at = now() where id = $1", [only]),
    ).toMatchObject(last);
    expect(await errorOf("update app.admins set role = 'admin' where id = $1", [only])).toMatchObject(last);
    expect(await errorOf("delete from app.admins where id = $1", [only])).toMatchObject(last);
    expect(await errorOf("truncate app.admins cascade")).toMatchObject(last);
    const second = await insertSuperAdmin();
    await pg.query("update app.admins set role = 'admin' where id = $1", [second]);
    expect(await usableSuperAdmins()).toBe(1);
  });

  it("PRD 3.14: akun login Super Admin terakhir tidak dapat dinonaktifkan, ditandai hapus, atau dihapus", async () => {
    await resetAdmins();
    const a = await insertAdmin();
    const last = { code: "23514", constraint: "admins_last_super_admin_chk" };
    for (const status of ["disabled", "deletion_pending", "deleted", "pending_otp"]) {
      expect(
        await errorOf("update app.users set status = $2 where id = $1", [a.userId, status]),
      ).toMatchObject(last);
    }
    expect(await errorOf("delete from app.users where id = $1", [a.userId])).toMatchObject(last);
    expect(await usableSuperAdmins()).toBe(1);

    // Serah kewenangan: Super Admin kedua aktif, lalu akun pertama boleh ditandai hapus (F-14).
    const b = await insertAdmin();
    await pg.query("update app.users set status = 'deletion_pending' where id = $1", [a.userId]);
    expect(await usableSuperAdmins()).toBe(1);
    // Super Admin yang akunnya tidak aktif tidak dihitung: b kini satu-satunya yang dapat login.
    expect(await errorOf("update app.admins set role = 'admin' where id = $1", [b.id])).toMatchObject(last);
    expect(await errorOf("update app.users set status = 'disabled' where id = $1", [b.userId])).toMatchObject(
      last,
    );
    // Job penghapusan akun a tidak lagi terhalang: baris admin a memang tidak dapat dipakai.
    await pg.query("delete from app.users where id = $1", [a.userId]);
    expect(await count("select count(*)::int as n from app.admins where id = $1", [a.id])).toBe(0);
    expect(await usableSuperAdmins()).toBe(1);
  });

  it("memindahkan Super Admin ke akun admin aktif lain tetap diizinkan; ke akun nonaktif ditolak", async () => {
    await resetAdmins();
    const a = await insertAdmin();
    const activeUser = await insertUser("admin");
    const disabledUser = await insertUser("admin", undefined, "disabled");
    expect(
      await errorOf("update app.admins set user_id = $2 where id = $1", [a.id, disabledUser]),
    ).toMatchObject({ constraint: "admins_last_super_admin_chk" });
    await pg.query("update app.admins set user_id = $2 where id = $1", [a.id, activeUser]);
    expect(await usableSuperAdmins()).toBe(1);
  });

  it("perubahan akun alumni dan admin biasa tidak dipengaruhi penjaga", async () => {
    const alumniUser = await insertUser("alumni");
    await pg.query("update app.users set status = 'deletion_pending' where id = $1", [alumniUser]);
    await pg.query("delete from app.users where id = $1", [alumniUser]);
    const plain = await insertAdmin("admin");
    await pg.query("update app.users set status = 'disabled' where id = $1", [plain.userId]);
    await pg.query("update app.admins set status = 'disabled', disabled_at = now() where id = $1", [
      plain.id,
    ]);
  });
});

describe("trigger skema pada PGlite", () => {
  it("F-17: audit_logs dan payment_events append-only", async () => {
    const id = uuidv7();
    await pg.query(
      "insert into app.audit_logs (id, effective_role, action, entity_type, request_id) values ($1, 'system', 'uji', 'x', 'req-1')",
      [id],
    );
    expect((await errorOf("update app.audit_logs set reason = 'ubah' where id = $1", [id])).code).toBe(
      "42501",
    );
    expect((await errorOf("delete from app.audit_logs where id = $1", [id])).code).toBe("42501");
    expect((await errorOf("truncate app.payment_events")).code).toBe("42501");
  });

  it("maksimal 10 keahlian per alumni", async () => {
    const userId = await insertUser();
    await insertAlumni(userId, null);
    const skillIds: string[] = [];
    for (let i = 0; i < 11; i++) {
      const id = uuidv7();
      skillIds.push(id);
      await pg.query("insert into app.master_skills (id, label) values ($1, $2)", [id, `Keahlian Uji ${i}`]);
    }
    for (const skillId of skillIds.slice(0, 10)) {
      await pg.query("insert into app.alumni_skills (alumni_user_id, skill_id) values ($1, $2)", [
        userId,
        skillId,
      ]);
    }
    expect(
      await errorOf("insert into app.alumni_skills (alumni_user_id, skill_id) values ($1, $2)", [
        userId,
        skillIds[10],
      ]),
    ).toMatchObject({ code: "23514", constraint: "alumni_skills_limit_chk" });
    // Master yang dipakai tidak dapat dihapus (AC F10-4). ON DELETE RESTRICT: PostgreSQL 17 melaporkan 23503,
    // PostgreSQL 18 (PGlite) melaporkan 23001 restrict_violation; helper galat API wajib menerima keduanya.
    const restricted = await errorOf("delete from app.master_skills where id = $1", [skillIds[0]]);
    expect(["23503", "23001"]).toContain(restricted.code);
    expect(restricted.constraint).toBe("alumni_skills_skill_id_master_skills_id_fk");
  });

  it("PRD 2.3 / F-16: jenis akun tidak dapat diubah dan rujukan alumni/admin wajib berjenis sesuai", async () => {
    const alumniUser = await insertUser("alumni");
    const adminUser = await insertUser("admin");
    expect(await errorOf("update app.users set kind = 'admin' where id = $1", [alumniUser])).toMatchObject({
      code: "23514",
      constraint: "users_kind_immutable_chk",
    });
    // Profil alumni di atas akun admin ditolak.
    expect(
      await errorOf(
        `insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out)
         values ($1, 'Alumni Uji', 'male', 12, 1, 3)`,
        [adminUser],
      ),
    ).toMatchObject({ code: "23514", constraint: "alumni_user_kind_chk" });
    // Baris admin di atas akun alumni ditolak.
    expect(
      await errorOf(
        `insert into app.admins (id, user_id, display_name, role, status, activated_at)
         values ($1, $2, 'Admin Uji', 'admin', 'active', now())`,
        [uuidv7(), alumniUser],
      ),
    ).toMatchObject({ code: "23514", constraint: "admins_user_kind_chk" });
    // Tautan alumni (cek konflik kepentingan) wajib akun alumni.
    const admin = await insertAdmin("admin");
    const otherAdminUser = await insertUser("admin");
    expect(
      await errorOf("update app.admins set linked_alumni_user_id = $2 where id = $1", [
        admin.id,
        otherAdminUser,
      ]),
    ).toMatchObject({ code: "23514", constraint: "admins_linked_alumni_kind_chk" });
    await pg.query("update app.admins set linked_alumni_user_id = $2 where id = $1", [admin.id, alumniUser]);
    // Akun alumni tertaut dihapus (F-14): tautan dikosongkan (SET NULL) tanpa ditolak trigger.
    await pg.query("delete from app.users where id = $1", [alumniUser]);
    expect(
      await count(
        "select count(*)::int as n from app.admins where id = $1 and linked_alumni_user_id is null",
        [admin.id],
      ),
    ).toBe(1);
  });

  it("PRD 3.5 / AC F05-6: N hanya dari nextval, tidak dapat diubah, dan N anggota terhapus tidak didaur ulang", async () => {
    // Nilai ketikan (tanpa nextval pada sesi ini / bukan nilai terakhir) ditolak.
    const typed = await insertUser();
    const lastDrawn = await nextMemberSeq();
    expect(
      await errorOf(
        `insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out, member_seq, member_number)
         values ($1, 'Alumni Uji', 'male', 12, 1, 3, $2, $3)`,
        [typed, lastDrawn + 1000, number12(lastDrawn + 1000)],
      ),
    ).toMatchObject({ code: "23514", constraint: "alumni_member_seq_source_chk" });

    const userA = await insertUser();
    const seqA = await nextMemberSeq();
    await insertAlumni(userA, seqA);
    const userB = await insertUser();
    await insertAlumni(userB, null);
    const seqB = await nextMemberSeq();
    await pg.query("update app.alumni set member_seq = $2, member_number = $3 where user_id = $1", [
      userB,
      seqB,
      number12(seqB),
    ]);

    // N yang sudah dialokasikan tidak dapat diubah atau dikosongkan.
    const immutable = { code: "23514", constraint: "alumni_member_seq_immutable_chk" };
    expect(
      await errorOf("update app.alumni set member_seq = null, member_number = null where user_id = $1", [
        userB,
      ]),
    ).toMatchObject(immutable);

    // Akun A dihapus (F-14): N milik A tidak dapat dipasang ke B lewat UPDATE maupun ke anggota baru lewat INSERT.
    await pg.query("delete from app.users where id = $1", [userA]);
    expect(
      await errorOf("update app.alumni set member_seq = $2, member_number = $3 where user_id = $1", [
        userB,
        seqA,
        number12(seqA),
      ]),
    ).toMatchObject(immutable);
    const userC = await insertUser();
    expect(
      await errorOf(
        `insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out, member_seq, member_number)
         values ($1, 'Alumni Uji', 'male', 12, 1, 3, $2, $3)`,
        [userC, seqA, number12(seqA)],
      ),
    ).toMatchObject({ code: "23514", constraint: "alumni_member_seq_source_chk" });

    // Koreksi admin (AC F05-6): prefix dihitung ulang dalam satu UPDATE, N tetap.
    await pg.query("update app.alumni set class_out = 6, member_number = $2 where user_id = $1", [
      userB,
      number12(seqB, "01"),
    ]);
  });

  it("AC F08-3: like_count selalu sama dengan jumlah post_likes, termasuk saat akun dihapus", async () => {
    const posts = [uuidv7(), uuidv7()];
    for (const [i, id] of posts.entries()) {
      await pg.query(
        "insert into app.posts (id, slug, title, body_html) values ($1, $2, 'Berita Uji', '<p>x</p>')",
        [id, `berita-uji-like-${i}-${id.slice(-6)}`],
      );
    }
    const [u1, u2] = [await insertUser(), await insertUser()];
    await pg.query(
      `insert into app.post_likes (post_id, user_id) values ($1, $3), ($2, $3), ($1, $4)
       on conflict do nothing`,
      [posts[0], posts[1], u1, u2],
    );
    // Like ulang (request diulang) idempoten: penghitung tidak bertambah.
    await pg.query("insert into app.post_likes (post_id, user_id) values ($1, $2) on conflict do nothing", [
      posts[0],
      u1,
    ]);
    const counts = async () =>
      (
        await pg.query<{ id: string; like_count: number; actual: number }>(
          `select p.id, p.like_count, (select count(*)::int from app.post_likes l where l.post_id = p.id) as actual
           from app.posts p where p.id = any($1::uuid[]) order by p.id`,
          [posts],
        )
      ).rows;
    expect((await counts()).map((r) => r.like_count)).toEqual([2, 1]);

    await pg.query("delete from app.post_likes where post_id = $1 and user_id = $2", [posts[0], u2]);
    // Penghapusan akun (F-14): like ikut terhapus kaskade dan penghitung tetap konsisten.
    await pg.query("delete from app.users where id = $1", [u1]);
    for (const row of await counts()) expect(row.like_count).toBe(row.actual);
    expect((await counts()).map((r) => r.like_count)).toEqual([0, 0]);

    // Like baru setelahnya tetap dihitung.
    await pg.query("insert into app.post_likes (post_id, user_id) values ($1, $2)", [posts[0], u2]);
    expect((await counts()).map((r) => r.like_count)).toEqual([1, 0]);
    // Baris like hanya ditambah/dihapus, tidak pernah diubah.
    expect(
      await errorOf("update app.post_likes set user_id = user_id where post_id = $1", [posts[0]]),
    ).toMatchObject({ code: "23514", constraint: "post_likes_immutable_chk" });
    // Berita dihapus: kaskade post_likes tidak gagal walaupun baris posts sudah hilang.
    await pg.query("delete from app.posts where id = $1", [posts[0]]);
    expect(await count("select count(*)::int as n from app.post_likes where post_id = $1", [posts[0]])).toBe(
      0,
    );
  });
});

describe("constraint data pada PGlite", () => {
  it("nomor anggota harus sama dengan segmen AA.SS.JK.N yang tersimpan (PRD 3.5)", async () => {
    const userId = await insertUser();
    const seq = await nextMemberSeq();
    const insert = (number: string) =>
      errorOf(
        `insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out, member_seq, member_number)
         values ($1, 'Alumni Uji', 'male', 12, 1, 3, $2, $3)`,
        [userId, seq, number],
      );
    expect((await insert(number12(seq, "01"))).constraint).toBe("alumni_member_number_chk");
    expect((await insert(number12(seq + 1))).constraint).toBe("alumni_member_number_chk");
    await insertAlumni(userId, seq);
  });

  it("email tersimpan ternormalisasi dan unik per jenis identitas selama belum terhapus", async () => {
    expect(
      (
        await errorOf("insert into app.users (id, email, password_hash) values ($1, 'A@Contoh.test', 'h')", [
          uuidv7(),
        ])
      ).constraint,
    ).toBe("users_email_normalized_chk");
    await insertUser("alumni", "sama@contoh.test");
    await insertUser("admin", "sama@contoh.test");
    expect(
      (
        await errorOf(
          "insert into app.users (id, email, password_hash, kind) values ($1, 'sama@contoh.test', 'h', 'alumni')",
          [uuidv7()],
        )
      ).constraint,
    ).toBe("users_kind_email_key");
  });

  it("preferensi keamanan tidak dapat dibuat/dimatikan dan email hanya untuk kategori yang didukung", async () => {
    const userId = await insertUser();
    const insert = (category: string, channel: string) =>
      errorOf(
        "insert into app.notification_preferences (user_id, category, channel, enabled) values ($1, $2, $3, false)",
        [userId, category, channel],
      );
    expect((await insert("security", "push")).constraint).toBe("notification_preferences_category_chk");
    expect((await insert("chat", "email")).constraint).toBe("notification_preferences_category_chk");
  });

  it("direct_key harus kanonik min:max", async () => {
    const [a, b] = [uuidv7(), uuidv7()].sort();
    expect(
      (
        await errorOf("insert into app.rooms (id, kind, direct_key) values ($1, 'direct', $2)", [
          uuidv7(),
          `${b}:${a}`,
        ])
      ).constraint,
    ).toBe("rooms_direct_key_canonical_chk");
    await pg.query("insert into app.rooms (id, kind, direct_key) values ($1, 'direct', $2)", [
      uuidv7(),
      `${a}:${b}`,
    ]);
  });

  it("AC F12-3: laporan yang diselesaikan atau ditolak wajib memiliki alasan", async () => {
    const insert = (status: string, action: string, note: string | null) =>
      pg.query(
        `insert into app.reports (id, target_type, category, status, action, resolution_note, resolved_at, due_at)
         values ($1, 'user', 'harassment', $2, $3, $4, now(), now() + interval '2 days')`,
        [uuidv7(), status, action, note],
      );
    for (const note of [null, "   "]) {
      await expect(insert("resolved", "suspend", note)).rejects.toMatchObject({
        code: "23514",
        constraint: "reports_resolution_note_chk",
      });
      await expect(insert("dismissed", "dismiss", note)).rejects.toMatchObject({
        constraint: "reports_resolution_note_chk",
      });
    }
    await insert("resolved", "warn", "Pesan melanggar pedoman komunitas; peringatan pertama.");
  });

  it("kontrak C6 (migrasi 0006): due_at wajib, klaim in_review, pesan anggota maks. 500, kategori appeal", async () => {
    const reporter = await insertUser();
    const insert = (columns: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        id: uuidv7(),
        reporter_id: reporter,
        target_type: "user",
        target_user_id: reporter,
        category: "harassment",
        due_at: new Date(),
        ...columns,
      };
      const names = Object.keys(row);
      return pg.query(
        `insert into app.reports (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(row),
      );
    };
    // Kontrak: due_at selalu dihitung server saat insert.
    await expect(insert({ due_at: null })).rejects.toMatchObject({ code: "23502" });
    // in_review hanya setelah klaim.
    await expect(insert({ status: "in_review" })).rejects.toMatchObject({
      code: "23514",
      constraint: "reports_claimed_chk",
    });
    await expect(insert({ member_message: "x".repeat(501) })).rejects.toMatchObject({
      code: "23514",
      constraint: "reports_member_message_chk",
    });
    await insert({ member_message: "x".repeat(500) });

    // Banding (PRD 3.12): kategori appeal atas diri sendiri; nilai enum dapat dipakai setelah migrasi di-commit.
    const claimer = await insertAdmin("admin");
    const appealId = uuidv7();
    await insert({
      id: appealId,
      category: "appeal",
      status: "in_review",
      claimed_by_admin_id: claimer.id,
      claimed_at: new Date(),
      message_removed_at: null,
    });
    // Pengurus pengklaim dihapus: FK SET NULL, klaim tetap tercatat lewat claimed_at sehingga CHECK tetap lolos.
    await pg.query("delete from app.admins where id = $1", [claimer.id]);
    const row = (
      await pg.query<{ category: string; claimed_by_admin_id: string | null; claimed: boolean }>(
        `select category, claimed_by_admin_id, claimed_at is not null as claimed from app.reports where id = $1`,
        [appealId],
      )
    ).rows[0]!;
    expect(row).toEqual({ category: "appeal", claimed_by_admin_id: null, claimed: true });
  });

  it("kontrak C3 (migrasi 0006): pembatalan penyesuaian wajib beralasan; pengurus pembatal SET NULL", async () => {
    const paymentId = uuidv7();
    await pg.query(
      `insert into app.payments (id, user_id, type, status, amount, lines_snapshot, method_snapshot, settings_version,
                                 proof_version, decided_at)
       values ($1, $2, 'registration', 'paid', 60000, '[]', '{}', 1, 1, now())`,
      [paymentId, await insertUser()],
    );
    const insert = (columns: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        id: uuidv7(),
        payment_id: paymentId,
        kind: "refund",
        amount: "60000.00",
        reason: "Event dibatalkan panitia (D6).",
        ...columns,
      };
      const names = Object.keys(row);
      return pg.query(
        `insert into app.payment_adjustments (${names.join(", ")})
         values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(row),
      );
    };
    const cancelled = { code: "23514", constraint: "payment_adjustments_cancelled_chk" };
    for (const cancel_reason of [null, "", "   "]) {
      await expect(
        insert({ status: "cancelled", cancelled_at: new Date(), cancel_reason }),
      ).rejects.toMatchObject(cancelled);
    }
    await expect(insert({ status: "cancelled", cancel_reason: "Dobel input." })).rejects.toMatchObject(
      cancelled,
    );

    const admin = await insertAdmin("admin");
    const id = uuidv7();
    await insert({
      id,
      status: "cancelled",
      cancelled_at: new Date(),
      cancel_reason: "Dana sudah dikembalikan lewat jalur lain.",
      cancelled_by_admin_id: admin.id,
    });
    await pg.query("delete from app.admins where id = $1", [admin.id]);
    const row = (
      await pg.query<{ cancel_reason: string; cancelled_by_admin_id: string | null }>(
        "select cancel_reason, cancelled_by_admin_id from app.payment_adjustments where id = $1",
        [id],
      )
    ).rows[0]!;
    expect(row).toEqual({
      cancel_reason: "Dana sudah dikembalikan lewat jalur lain.",
      cancelled_by_admin_id: null,
    });
  });

  it("ADR-026 (migrasi 0008): gambar QR wajib untuk qris dan dilarang untuk jenis lain; payment_qr boleh publik; FK RESTRICT", async () => {
    const insertFile = async (purpose: string, visibility: "public" | "private") => {
      const fileId = uuidv7();
      await pg.query(
        `insert into app.files (id, purpose, storage_driver, object_key, mime, bytes, sha256, visibility, status)
         values ($1, $2, 'local', $3, 'image/png', 10, $4, $5, 'ready')`,
        [fileId, purpose, `${purpose}/2026/10/${fileId}`, "b".repeat(64), visibility],
      );
      return fileId;
    };
    // Purpose baru diterima files_purpose_chk dan boleh publik (files_private_purpose_chk).
    const qr = await insertFile("payment_qr", "public");
    await expect(insertFile("purpose_lain", "private")).rejects.toMatchObject({
      code: "23514",
      constraint: "files_purpose_chk",
    });
    await expect(insertFile("payment_proof", "public")).rejects.toMatchObject({
      code: "23514",
      constraint: "files_private_purpose_chk",
    });

    const insertMethod = (kind: string, qrImageFileId: string | null) =>
      pg.query(
        `insert into app.payment_methods (id, kind, provider, account_number, account_holder, qr_image_file_id)
         values ($1, $2, 'QRIS', 'ID1020304050607', 'KAPDH', $3)`,
        [uuidv7(), kind, qrImageFileId],
      );
    const qrCheck = { code: "23514", constraint: "payment_methods_qr_image_chk" };
    await expect(insertMethod("qris", null)).rejects.toMatchObject(qrCheck);
    await expect(insertMethod("bank", qr)).rejects.toMatchObject(qrCheck);
    await expect(insertMethod("ewallet", qr)).rejects.toMatchObject(qrCheck);
    await insertMethod("bank", null);
    await insertMethod("qris", qr);
    // Ganti jenis tanpa gambar juga ditolak.
    await expect(
      pg.query("update app.payment_methods set kind = 'bank' where qr_image_file_id = $1", [qr]),
    ).rejects.toMatchObject(qrCheck);
    // Baris berkas yang masih dirujuk metode tidak dapat dihapus (ON DELETE RESTRICT; 23503 di PG17, 23001 di PG18).
    const deleted = await errorOf("delete from app.files where id = $1", [qr]);
    expect(["23503", "23001"]).toContain(deleted.code);
    expect(deleted.constraint).toBe("payment_methods_qr_image_file_id_files_id_fk");
  });

  it("F-01 / PRD 6.2: salinan tayang halaman legal lengkap dan versi legal terpisah dari version draf", async () => {
    const id = uuidv7();
    await pg.query(
      "insert into app.pages (id, slug, title, body_html) values ($1, 'kebijakan-uji', 'Kebijakan Uji', '<p>draf</p>')",
      [id],
    );
    await expect(
      pg.query("update app.pages set published_version = 1, published_at = now() where id = $1", [id]),
    ).rejects.toMatchObject({ code: "23514", constraint: "pages_published_chk" });
    // Terbit: draf disalin ke salinan tayang, versi legal 1.
    await pg.query(
      `update app.pages set published_title = title, published_body_html = body_html, published_version = 1,
              published_at = now() where id = $1`,
      [id],
    );
    // Simpan draf berikutnya menaikkan version (If-Match) tanpa mengubah teks tayang atau versi legal.
    await pg.query(
      "update app.pages set body_html = '<p>draf baru</p>', version = version + 1 where id = $1",
      [id],
    );
    const row = (
      await pg.query<{ version: number; published_version: number; published_body_html: string }>(
        "select version, published_version, published_body_html from app.pages where id = $1",
        [id],
      )
    ).rows[0]!;
    expect(row).toEqual({ version: 2, published_version: 1, published_body_html: "<p>draf</p>" });
  });

  it("PRD 6.5: setiap FK memiliki indeks yang dapat dipakai pemeriksaan dan kaskade referensial", async () => {
    const fks = await pg.query<{ conname: string; tbl: string; cols: string }>(`
      select c.conname, c.conrelid::regclass::text as tbl,
             (select string_agg(quote_ident(a.attname), ',' order by k.ord)
              from unnest(c.conkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'app'
      order by 1`);
    expect(fks.rows.length).toBeGreaterThan(50);
    const withoutIndex: string[] = [];
    await pg.exec("set enable_seqscan = off");
    try {
      for (const fk of fks.rows) {
        const where = fk.cols
          .split(",")
          .map((col, i) => `${col} = $${i + 1}`)
          .join(" and ");
        // Rencana generik = rencana yang dipakai pemicu FK (RI) dengan parameter, tanpa nilai konkret. Protokol
        // query sederhana (exec) agar $n tidak dianggap parameter bind.
        const [plan] = await pg.exec(
          `explain (generic_plan, format json) select 1 from only ${fk.tbl} x where ${where}`,
        );
        if (JSON.stringify(plan?.rows).includes('"Seq Scan"')) withoutIndex.push(fk.conname);
      }
    } finally {
      await pg.exec("reset enable_seqscan");
    }
    expect(withoutIndex).toEqual([]);
  });
});

describe("seed pada PGlite", () => {
  it("seed referensi dan dev idempoten; halaman dev terbit dengan versi legal yang dicerminkan app_settings", async () => {
    const first = await seedReference(db);
    expect(first.settings_inserted).toBe(APP_SETTING_KEYS.length);
    expect((await seedReference(db)).settings_inserted).toBe(0);
    const dev = await seedDev(db);
    expect(dev.alumni_inserted).toBe(3);
    expect((await seedDev(db)).alumni_inserted).toBe(0);
    const published = await pg.query<{ slug: string; published_version: number; same: boolean }>(
      `select slug, published_version, published_body_html = body_html as same from app.pages
       where slug in ('kebijakan-privasi', 'ketentuan', 'ketentuan-komunitas') order by slug`,
    );
    expect(published.rows).toEqual([
      { slug: "kebijakan-privasi", published_version: 1, same: true },
      { slug: "ketentuan", published_version: 1, same: true },
      { slug: "ketentuan-komunitas", published_version: 1, same: true },
    ]);
  });

  it("kunci baru payment_instructions ditambahkan ke lingkungan yang sudah di-seed tanpa menimpa nilai lain", async () => {
    await seedReference(db);
    // Lingkungan yang di-seed sebelum kunci D13 ada, lalu pengurus mengubah biaya.
    await pg.query("delete from app.app_settings where key = 'payment_instructions'");
    await pg.query(
      `update app.app_settings set value = jsonb_set(value, '{renewal_fee}', '"15000.00"'), version = 2
       where key = 'fees'`,
    );
    expect((await seedReference(db)).settings_inserted).toBe(1);
    const rows = await pg.query<{ key: string; value: Record<string, unknown>; version: number }>(
      "select key, value, version from app.app_settings where key in ('fees', 'payment_instructions') order by key",
    );
    expect(rows.rows).toEqual([
      {
        key: "fees",
        value: { registration_fee: "50000.00", card_fee: "10000.00", renewal_fee: "15000.00" },
        version: 2,
      },
      { key: "payment_instructions", value: { dues_hidden_platforms: [] }, version: 1 },
    ]);
    // Pengurus mengubah nilainya (D13 iOS): seed berikutnya tidak menimpa.
    await pg.query(
      `update app.app_settings set value = '{"dues_hidden_platforms": ["ios"]}', version = 2
       where key = 'payment_instructions'`,
    );
    expect((await seedReference(db)).settings_inserted).toBe(0);
    const edited = await pg.query<{ value: Record<string, unknown> }>(
      "select value from app.app_settings where key = 'payment_instructions'",
    );
    expect(edited.rows[0]!.value).toEqual({ dues_hidden_platforms: ["ios"] });
  });
});
