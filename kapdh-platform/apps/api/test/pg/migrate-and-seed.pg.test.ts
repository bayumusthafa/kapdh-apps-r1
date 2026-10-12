import { MIGRATIONS_FOLDER, runMigrations } from "@kapdh/database";
import { DEV_IDS, ProductionSeedRefused, seedDev } from "@kapdh/database/seeds/dev";
import { REFERENCE_SETTINGS, seedReference } from "@kapdh/database/seeds/reference";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createEmptyPgDatabase, createPgTestDatabase, type PgTestDatabase } from "./support.js";

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

  it("skema hasil migrasi lengkap: 39 tabel, sequence nomor anggota, trigger penjaga", async () => {
    const tdb = await createPgTestDatabase("schema_shape");
    databases.push(tdb);
    const [tables] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from pg_tables where schemaname = 'app'`;
    expect(tables!.n).toBe(39);
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
      "alumni_guard_member_seq",
      "alumni_skills_limit",
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
    const tdb = await createPgTestDatabase("seed_reference");
    databases.push(tdb);
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
