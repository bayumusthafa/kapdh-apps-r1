import { MIGRATIONS_FOLDER, runMigrations } from "@kapdh/database";
import { DEV_IDS, ProductionSeedRefused, seedDev } from "@kapdh/database/seeds/dev";
import { REFERENCE_SETTINGS, seedReference } from "@kapdh/database/seeds/reference";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  createEmptyPgDatabase,
  createPgTestDatabase,
  id,
  insertUser,
  type PgTestDatabase,
  pgError,
  sleep,
} from "./support.js";

/**
 * Paket database seperti di image production (`pnpm deploy`): dirujuk lewat symlink/junction pnpm
 * apps/api/node_modules/@kapdh/database, bukan path aslinya.
 */
const LINKED_DATABASE_PKG = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  "node_modules",
  "@kapdh",
  "database",
);

/** Menjalankan CLI paket database lewat symlink dengan env terkontrol; mengembalikan kode keluar dan output. */
function runLinkedBin(
  bin: "migrate" | "seed-reference" | "seed-dev",
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(LINKED_DATABASE_PKG, "dist", "bin", `${bin}.js`)], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};

/**
 * Salinan folder migrasi yang journal-nya berhenti di `lastTag`: database lingkungan yang sudah dimigrasi sebelum
 * migrasi aditif berikutnya dirilis. Pemanggil menghapus folder setelah dipakai.
 */
function migrationsUpTo(lastTag: string): { dir: string; count: number } {
  const cut = journal.entries.findIndex((e) => e.tag === lastTag);
  if (cut < 0) throw new Error(`Tag migrasi tidak ada di journal: ${lastTag}`);
  const entries = journal.entries.slice(0, cut + 1);
  const dir = mkdtempSync(join(tmpdir(), "kapdh-migrations-"));
  mkdirSync(join(dir, "meta"));
  for (const e of entries) copyFileSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return { dir, count: entries.length };
}

const databases: PgTestDatabase[] = [];
afterAll(async () => {
  for (const d of databases) await d.drop();
});

describe("PRD 5.5: job migrasi tunggal dengan advisory lock pada PostgreSQL 17", () => {
  it("dua job migrasi bersamaan pada database kosong: migrasi diterapkan tepat sekali, keduanya sukses", async () => {
    const empty = await createEmptyPgDatabase("migrate_lock");
    databases.push(empty);
    const results = await Promise.all([runMigrations({ url: empty.url }), runMigrations({ url: empty.url })]);
    const applied = results.map((r) => r.applied).sort((a, b) => a - b);
    expect(applied).toEqual([0, journal.entries.length]);

    const [recorded] = await empty.sql<
      { n: number }[]
    >`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(recorded!.n).toBe(journal.entries.length);
    expect((await runMigrations({ url: empty.url })).applied).toBe(0);
  });

  it("migrasi aditif 0006 pada database yang sudah sampai 0005: ADD VALUE enum aman di transaksi job migrasi", async () => {
    const existing = await createEmptyPgDatabase("upgrade_0006");
    databases.push(existing);
    // Lingkungan lama: 0000-0005 sudah di-commit, lalu job migrasi berikutnya hanya menerapkan sisa journal.
    const upTo0005 = migrationsUpTo("0005_post_like_count");
    try {
      expect((await runMigrations({ url: existing.url, migrationsFolder: upTo0005.dir })).applied).toBe(
        upTo0005.count,
      );
    } finally {
      rmSync(upTo0005.dir, { recursive: true, force: true });
    }
    expect((await runMigrations({ url: existing.url })).applied).toBe(
      journal.entries.length - upTo0005.count,
    );

    // Nilai enum baru dapat dipakai setelah transaksi migrasi di-commit (banding PRD 3.12).
    const userId = await insertUser(existing.sql);
    await existing.sql`
      insert into app.reports (id, reporter_id, target_type, target_user_id, category, due_at)
      values (${id()}, ${userId}, 'user', ${userId}, 'appeal', now() + interval '2 days')`;
    const constraints = await existing.sql<{ conname: string }[]>`
      select conname from pg_constraint
      where conrelid in ('app.reports'::regclass, 'app.payment_adjustments'::regclass)
        and conname in ('reports_claimed_chk', 'reports_member_message_chk', 'reports_claimed_by_admin_id_admins_id_fk',
                        'payment_adjustments_cancelled_chk', 'payment_adjustments_cancelled_by_admin_id_admins_id_fk')
      order by conname`;
    expect(constraints.map((c) => c.conname)).toEqual([
      "payment_adjustments_cancelled_by_admin_id_admins_id_fk",
      "payment_adjustments_cancelled_chk",
      "reports_claimed_by_admin_id_admins_id_fk",
      "reports_claimed_chk",
      "reports_member_message_chk",
    ]);
    const [dueAt] = await existing.sql<{ attnotnull: boolean }[]>`
      select attnotnull from pg_attribute where attrelid = 'app.reports'::regclass and attname = 'due_at'`;
    expect(dueAt!.attnotnull).toBe(true);
  });

  it("ADR-026: migrasi 0008 pada database yang sudah sampai 0007 berjalan di job tersendiri tanpa 55P04; literal enum baru akan gagal", async () => {
    const existing = await createEmptyPgDatabase("upgrade_0008");
    databases.push(existing);
    const upTo0007 = migrationsUpTo("0007_auth_otp_decoys");
    try {
      expect((await runMigrations({ url: existing.url, migrationsFolder: upTo0007.dir })).applied).toBe(
        upTo0007.count,
      );
    } finally {
      rmSync(upTo0007.dir, { recursive: true, force: true });
    }
    // Production saat ini: metode lama bernama QRIS berjenis e-wallet tanpa gambar (tetap sah setelah CHECK baru).
    const legacy = id();
    await existing.sql`
      insert into app.payment_methods (id, kind, provider, account_number, account_holder)
      values (${legacy}, 'ewallet', 'QRIS', 'ID1020304050607', 'KAPDH')`;

    // Bukti bahwa aturan README nyata di PostgreSQL 17: nilai enum yang ditambahkan di transaksi yang sama tidak boleh
    // dipakai sebagai literal enum (inilah alasan payment_methods_qr_image_chk memakai kind::text).
    await expect(
      existing.sql.begin(async (tx) => {
        await tx.unsafe("alter type app.payment_method_kind add value 'uji_nilai_baru'");
        await tx.unsafe("select 'uji_nilai_baru'::app.payment_method_kind");
      }),
    ).rejects.toMatchObject({ code: "55P04" });

    expect((await runMigrations({ url: existing.url })).applied).toBe(
      journal.entries.length - upTo0007.count,
    );
    const labels = await existing.sql<{ label: string }[]>`
      select e.enumlabel as label from pg_enum e join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'app' and t.typname = 'payment_method_kind' order by e.enumsortorder`;
    expect(labels.map((l) => l.label)).toEqual(["bank", "ewallet", "qris"]);
    const [old] = await existing.sql<{ kind: string; qr_image_file_id: string | null }[]>`
      select kind, qr_image_file_id from app.payment_methods where id = ${legacy}`;
    expect(old).toEqual({ kind: "ewallet", qr_image_file_id: null });

    // Setelah commit: qris dengan berkas payment_qr publik diterima; tanpa gambar ditolak CHECK teks.
    const fileId = id();
    await existing.sql`
      insert into app.files (id, purpose, storage_driver, object_key, mime, bytes, sha256, visibility, status)
      values (${fileId}, 'payment_qr', 'local', ${`payment_qr/2026/10/${fileId}`}, 'image/png', 10, ${"d".repeat(64)},
              'public', 'ready')`;
    await existing.sql`
      insert into app.payment_methods (id, kind, provider, account_number, account_holder, qr_image_file_id)
      values (${id()}, 'qris', 'QRIS', 'ID1020304050607', 'KAPDH', ${fileId})`;
    await expect(
      existing.sql`
        insert into app.payment_methods (id, kind, provider, account_number, account_holder)
        values (${id()}, 'qris', 'QRIS', 'ID1020304050607', 'KAPDH')`,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "payment_methods_qr_image_chk" });
    // FK RESTRICT pada PostgreSQL 17 melapor 23503.
    await expect(existing.sql`delete from app.files where id = ${fileId}`).rejects.toMatchObject({
      code: "23503",
      constraint_name: "payment_methods_qr_image_file_id_files_id_fk",
    });
    const [tables] = await existing.sql<{ n: number }[]>`
      select count(*)::int as n from pg_tables where schemaname = 'app'`;
    expect(tables!.n).toBe(43);
  });

  it("profil berulang 0009-0010 pada database sampai 0008: isi awal dari kolom lama, jembatan penulis lama, penanda API tidak bocor antar transaksi", async () => {
    const existing = await createEmptyPgDatabase("upgrade_0010");
    databases.push(existing);
    const upTo0008 = migrationsUpTo("0008_qris_payment_method");
    try {
      await runMigrations({ url: existing.url, migrationsFolder: upTo0008.dir });
    } finally {
      rmSync(upTo0008.dir, { recursive: true, force: true });
    }
    // Data production sebelum rilis: profesi lama, lulusan terakhir, dan tiga kolom sosial.
    const userId = await insertUser(existing.sql);
    const master = id();
    await existing.sql`insert into app.master_professions (id, label) values (${master}, 'Guru')`;
    await existing.sql`
      insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out, last_education_institution,
        last_education_city, social_instagram, social_facebook, social_linkedin)
      values (${userId}, 'Alumni Uji', 'male', 12, 1, 6, 'Universitas Contoh', 'Pekanbaru', 'ahmad.uji',
        'ahmad.fb', 'https://www.linkedin.com/in/ahmad.uji')`;
    await existing.sql`insert into app.alumni_professions (alumni_user_id, profession_id) values (${userId}, ${master})`;

    expect((await runMigrations({ url: existing.url })).applied).toBe(
      journal.entries.length - upTo0008.count,
    );
    const links = await existing.sql<{ platform: string; value: string }[]>`
      select platform, value from app.alumni_social_links where alumni_user_id = ${userId} order by position`;
    expect(links).toEqual([
      { platform: "instagram", value: "ahmad.uji" },
      { platform: "facebook", value: "ahmad.fb" },
      { platform: "linkedin", value: "https://www.linkedin.com/in/ahmad.uji" },
    ]);
    const [education] = await existing.sql<{ institution: string }[]>`
      select institution from app.alumni_education where alumni_user_id = ${userId}`;
    expect(education).toEqual({ institution: "Universitas Contoh" });
    const [profession] = await existing.sql<{ profession_id: string }[]>`
      select profession_id from app.alumni_profession_entries where alumni_user_id = ${userId}`;
    expect(profession).toEqual({ profession_id: master });

    // Image API lama (rollback) menulis kolom lama tanpa penanda: jembatan menerapkannya ke daftar.
    await existing.sql`update app.alumni set social_x = 'baru.x', social_facebook = null where user_id = ${userId}`;
    // Transaksi API baru: penanda lokal transaksi membuat jembatan diam. Satu koneksi dipesan agar terbukti penanda
    // tidak bocor ke transaksi berikutnya pada koneksi pool yang sama setelah commit.
    const conn = await existing.sql.reserve();
    try {
      await conn`begin`;
      await conn`select set_config('kapdh.profile_lists', 'api', true)`;
      await conn`update app.alumni set social_linkedin = null where user_id = ${userId}`;
      await conn`commit`;
      await conn`update app.alumni set social_instagram = 'ganti.ig' where user_id = ${userId}`;
    } finally {
      conn.release();
    }
    const after = await existing.sql<{ platform: string; value: string }[]>`
      select platform, value from app.alumni_social_links where alumni_user_id = ${userId} order by position`;
    expect(after).toEqual([
      { platform: "instagram", value: "ganti.ig" },
      { platform: "linkedin", value: "https://www.linkedin.com/in/ahmad.uji" },
      { platform: "x", value: "baru.x" },
    ]);
    // Proyeksi API: kolom lama dihitung ulang dari daftar.
    await existing.sql.begin(async (tx) => {
      await tx`select set_config('kapdh.profile_lists', 'api', true)`;
      await tx`select app.alumni_project_legacy_profile(${userId}::uuid)`;
    });
    const [legacy] = await existing.sql<Record<string, string | null>[]>`
      select social_instagram, social_x, social_facebook, social_linkedin, last_education_institution, last_education_city
      from app.alumni where user_id = ${userId}`;
    expect(legacy).toEqual({
      social_instagram: "ganti.ig",
      social_x: "baru.x",
      social_facebook: null,
      social_linkedin: "https://www.linkedin.com/in/ahmad.uji",
      last_education_institution: "Universitas Contoh",
      last_education_city: "Pekanbaru",
    });
  });

  it("0009 dengan batas tunggu kunci 15 detik: transaksi lama yang menggantung membuat job gagal 55P03, tulisan profil di belakang antrean lanjut, skema tetap 0008, job dapat diulang", async () => {
    const existing = await createEmptyPgDatabase("upgrade_0009_lock", 6);
    databases.push(existing);
    const upTo0008 = migrationsUpTo("0008_qris_payment_method");
    try {
      await runMigrations({ url: existing.url, migrationsFolder: upTo0008.dir });
    } finally {
      rmSync(upTo0008.dir, { recursive: true, force: true });
    }
    const hung = await insertUser(existing.sql);
    const writer = await insertUser(existing.sql);
    for (const userId of [hung, writer])
      await existing.sql`
        insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out)
        values (${userId}, 'Alumni Uji', 'male', 12, 1, 6)`;
    const lockWaiters = async () => {
      const [row] = await existing.sql<{ job: number; total: number }[]>`
        select count(*) filter (where application_name = 'kapdh-migrate')::int as job, count(*)::int as total
        from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
      return row!;
    };
    const waitFor = async (done: (w: { job: number; total: number }) => boolean) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (done(await lockWaiters())) return true;
        await sleep(20);
      }
      return false;
    };

    // API lama: transaksi profil yang tidak pernah selesai memegang ROW EXCLUSIVE pada alumni.
    const holder = await existing.sql.reserve();
    try {
      await holder`begin`;
      await holder`update app.alumni set city = 'Pekanbaru' where user_id = ${hung}`;
      const started = Date.now();
      const job = runMigrations({ url: existing.url }).then(
        () => ({ error: null as unknown, at: Date.now() }),
        (error: unknown) => ({ error, at: Date.now() }),
      );
      expect(await waitFor((w) => w.job === 1), "job menunggu LOCK TABLE").toBe(true);
      // Simpan profil anggota lain mengantre di belakang permintaan EXCLUSIVE job (bukan di belakang baris lama).
      const write = existing.sql`update app.alumni set bio = 'Tulisan baru' where user_id = ${writer}`.then(
        () => Date.now(),
      );
      expect(await waitFor((w) => w.total === 2), "tulisan profil tertahan di belakang job").toBe(true);

      const outcome = await job;
      expect(pgError(outcome.error).code).toBe("55P03");
      expect(outcome.at - started).toBeGreaterThanOrEqual(14_500);
      expect(outcome.at - started).toBeLessThan(45_000);
      // Antrean lepas begitu job menyerah (bukan saat transaksi lama selesai; transaksi itu masih terbuka).
      expect((await write) - started).toBeGreaterThanOrEqual(14_500);

      // Seluruh transaksi migrasi dibatalkan: skema dan journal tetap 0008.
      const [state] = await existing.sql<{ links: string | null; applied: number }[]>`
        select to_regclass('app.alumni_social_links')::text as links,
               (select count(*)::int from drizzle.__drizzle_migrations) as applied`;
      expect(state).toEqual({ links: null, applied: upTo0008.count });
    } finally {
      await holder`rollback`.catch(() => {});
      holder.release();
    }
    // Tiga statement pertama 0009 apa adanya: batas 15 detik hanya untuk LOCK TABLE, lalu kembali ke nilai bawaan
    // untuk sisa transaksi, dan nilai sesi tidak berubah setelah transaksi selesai.
    const [limit, lock, restore] = readFileSync(
      join(MIGRATIONS_FOLDER, "0009_profile_lists.sql"),
      "utf8",
    ).split("--> statement-breakpoint");
    const conn = await existing.sql.reserve();
    const timeout = async () => (await conn<{ lock_timeout: string }[]>`show lock_timeout`)[0]!.lock_timeout;
    try {
      await conn`set lock_timeout = '7s'`;
      await conn`begin`;
      await conn.unsafe(limit!);
      expect(await timeout()).toBe("15s");
      await conn.unsafe(lock!);
      await conn.unsafe(restore!);
      expect(await timeout()).toBe("0");
      await conn`rollback`;
      expect(await timeout()).toBe("7s");
    } finally {
      await conn`rollback`.catch(() => {});
      await conn`reset lock_timeout`.catch(() => {});
      conn.release();
    }
    // Setelah transaksi lama selesai, job diulang dan menerapkan 0009-0010.
    expect((await runMigrations({ url: existing.url })).applied).toBe(
      journal.entries.length - upTo0008.count,
    );
    const [bio] = await existing.sql<{ bio: string | null }[]>`
      select bio from app.alumni where user_id = ${writer}`;
    expect(bio).toEqual({ bio: "Tulisan baru" });
  }, 120_000);

  it("skema hasil migrasi lengkap: 43 tabel (39 + otp_decoys 0007 + 3 daftar profil 0009), sequence nomor anggota, trigger penjaga", async () => {
    const tdb = await createPgTestDatabase("schema_shape");
    databases.push(tdb);
    const [tables] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from pg_tables where schemaname = 'app'`;
    expect(tables!.n).toBe(43);
    const [fee] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from pg_tables where schemaname = 'app' and tablename = 'fee_settings'`;
    expect(fee!.n).toBe(0);
    const [seq] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from pg_sequences where schemaname = 'app' and sequencename = 'membership_no_seq'`;
    expect(seq!.n).toBe(1);
    const triggers = await tdb.sql<{ tgname: string }[]>`
      select tgname from pg_trigger where not tgisinternal order by tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual([
      "admins_check_user_kind",
      "admins_guard_last_super_admin",
      "admins_guard_truncate",
      "alumni_check_user_kind",
      "alumni_education_limit",
      "alumni_guard_member_seq",
      "alumni_legacy_profile_bridge",
      "alumni_legacy_reproject",
      "alumni_profession_entries_limit",
      "alumni_professions_legacy_bridge",
      "alumni_professions_legacy_reproject",
      "alumni_skills_limit",
      "alumni_social_links_limit",
      "audit_logs_append_only",
      "audit_logs_no_truncate",
      "payment_events_append_only",
      "payment_events_no_truncate",
      "post_likes_count_delete",
      "post_likes_count_insert",
      "post_likes_forbid_update",
      "post_likes_truncate_count",
      "users_guard_last_super_admin",
      "users_kind_immutable",
    ]);
  });
});

describe("PRD 5.5: CLI migrasi dan seed dipanggil lewat symlink pnpm (tata letak image production)", () => {
  it("paket @kapdh/database di apps/api memang symlink ke lokasi lain", () => {
    expect(lstatSync(LINKED_DATABASE_PKG).isSymbolicLink()).toBe(true);
    expect(realpathSync(LINKED_DATABASE_PKG)).not.toBe(LINKED_DATABASE_PKG);
  });

  it("database tidak terjangkau atau DATABASE_URL kosong: setiap CLI keluar bukan nol tanpa mencetak URL", async () => {
    const unreachable = "postgres://kapdh_migrator:rahasia-uji@127.0.0.1:1/kapdh";
    for (const bin of ["migrate", "seed-reference", "seed-dev"] as const) {
      const result = await runLinkedBin(bin, { DATABASE_URL: unreachable, NODE_ENV: "development" });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/gagal/i);
      expect(result.stdout + result.stderr).not.toContain("rahasia-uji");
      expect((await runLinkedBin(bin, { NODE_ENV: "development" })).code).toBe(1);
    }
  });

  it("migrate lewat symlink menerapkan journal lalu idempoten; seed lewat symlink berjalan; seed dev menolak production", async () => {
    const empty = await createEmptyPgDatabase("cli_symlink");
    databases.push(empty);
    const first = await runLinkedBin("migrate", { DATABASE_URL: empty.url });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`Diterapkan: ${journal.entries.length}.`);
    const second = await runLinkedBin("migrate", { DATABASE_URL: empty.url });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("Diterapkan: 0.");

    const reference = await runLinkedBin("seed-reference", {
      DATABASE_URL: empty.url,
      NODE_ENV: "production",
    });
    expect(reference.code).toBe(0);
    const refused = await runLinkedBin("seed-dev", { DATABASE_URL: empty.url, NODE_ENV: "production" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("NODE_ENV=production");
    const [users] = await empty.sql<{ n: number }[]>`select count(*)::int as n from app.users`;
    expect(users!.n).toBe(0);
    const dev = await runLinkedBin("seed-dev", { DATABASE_URL: empty.url, NODE_ENV: "development" });
    expect(dev.code).toBe(0);
    const [seeded] = await empty.sql<{ n: number }[]>`select count(*)::int as n from app.alumni`;
    expect(seeded!.n).toBe(3);
  });
});

describe("PRD 8.2: seed referensi dan seed dev idempoten", () => {
  it("seed referensi: semua kunci app_settings, master usulan nonaktif, halaman legal draf, tercatat di audit", async () => {
    // Database kosong yang baru dimigrasi (template jalur ini sudah berisi seed referensi, lihat global-setup.ts).
    const tdb = await createEmptyPgDatabase("seed_reference");
    databases.push(tdb);
    await runMigrations({ url: tdb.url });
    const first = await seedReference(tdb.db);
    expect(first.settings_inserted).toBe(Object.keys(REFERENCE_SETTINGS).length);
    expect(first.professions_inserted).toBeGreaterThan(0);
    expect(first.skills_inserted).toBeGreaterThan(0);
    expect(first.pages_inserted).toBe(5);

    const second = await seedReference(tdb.db);
    expect(second).toEqual({
      settings_inserted: 0,
      professions_inserted: 0,
      skills_inserted: 0,
      pages_inserted: 0,
    });

    const [fees] = await tdb.sql<{ value: Record<string, string> }[]>`
      select value from app.app_settings where key = 'fees'`;
    expect(fees!.value).toEqual({
      registration_fee: "50000.00",
      card_fee: "10000.00",
      renewal_fee: "10000.00",
    });
    const [activeMasters] = await tdb.sql<{ n: number }[]>`
      select (select count(*) from app.master_professions where active)::int
           + (select count(*) from app.master_skills where active)::int as n`;
    expect(activeMasters!.n).toBe(0);
    const [published] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from app.pages where published_at is not null`;
    expect(published!.n).toBe(0);
    const [paymentMethods] = await tdb.sql<
      { n: number }[]
    >`select count(*)::int as n from app.payment_methods`;
    expect(paymentMethods!.n).toBe(0);
    const [users] = await tdb.sql<{ n: number }[]>`select count(*)::int as n from app.users`;
    expect(users!.n).toBe(0);
    const [audits] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from app.audit_logs where action = 'seed.reference'`;
    expect(audits!.n).toBe(2);
  });

  it("nilai yang sudah diubah pengurus tidak ditimpa seed referensi", async () => {
    const tdb = await createPgTestDatabase("seed_no_overwrite");
    databases.push(tdb);
    await seedReference(tdb.db);
    await tdb.sql`
      update app.app_settings set value = jsonb_set(value, '{renewal_fee}', '"15000.00"'), version = 2
      where key = 'fees'`;
    await seedReference(tdb.db);
    const [fees] = await tdb.sql<{ value: Record<string, string>; version: number }[]>`
      select value, version from app.app_settings where key = 'fees'`;
    expect(fees).toMatchObject({ version: 2, value: { renewal_fee: "15000.00" } });
  });

  it("seed dev: fixture sintetis bertanda [Contoh], idempoten, nomor anggota valid", async () => {
    const tdb = await createPgTestDatabase("seed_dev");
    databases.push(tdb);
    const first = await seedDev(tdb.db);
    expect(first.alumni_inserted).toBe(3);
    const second = await seedDev(tdb.db);
    expect(second.alumni_inserted).toBe(0);

    const alumni = await tdb.sql<{ full_name: string; member_number: string }[]>`
      select full_name, member_number from app.alumni order by member_seq`;
    expect(alumni).toHaveLength(3);
    for (const a of alumni) {
      expect(a.full_name.startsWith("[Contoh]")).toBe(true);
      expect(a.member_number).toMatch(/^\d{2}\.0[1-3]\.0[12]\.[1-9]\d*$/);
    }
    const [method] = await tdb.sql<{ provider: string }[]>`
      select provider from app.payment_methods where id = ${DEV_IDS.paymentMethod}`;
    expect(method!.provider).toBe("[Bank Contoh]");
    const [verified] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from app.membership_events where payment_id = ${DEV_IDS.paymentVerified}`;
    expect(verified!.n).toBe(1);
  });

  it("seed dev menolak berjalan pada NODE_ENV=production", async () => {
    const tdb = await createPgTestDatabase("seed_dev_prod");
    databases.push(tdb);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(seedDev(tdb.db)).rejects.toBeInstanceOf(ProductionSeedRefused);
    } finally {
      process.env.NODE_ENV = previous;
    }
    const [users] = await tdb.sql<{ n: number }[]>`select count(*)::int as n from app.users`;
    expect(users!.n).toBe(0);
  });
});
