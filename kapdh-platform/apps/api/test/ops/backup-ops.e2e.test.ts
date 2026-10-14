import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { files, outboxEvents, users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdmin, createAlumni, createMembershipPayment } from "../support/factories.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Perkakas operasi backup/restore (PRD 5.5, N-06, AC F14-6; infra/backup, docs/runbooks/backup-restore.md) di atas
 * skema migrasi sungguhan (PGlite):
 *   - SQL infra/backup/sql/*.sql yang dijalankan backup.sh, restore.sh dan verify-restore.sh lewat psql;
 *   - verify-http.mjs (login + MFA admin drill, health, akses berkas publik) terhadap API yang benar-benar mendengar.
 * Skrip shell sendiri diuji kering dengan alat tiruan (infra/backup/test/dry-run.sh); perilaku pg_dump/restic/rclone
 * sungguhan wajib dibuktikan restore drill di staging.
 */

const INFRA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "backup");
const sqlFile = (name: string) => readFileSync(join(INFRA, "sql", name), "utf8");

/** Interpolasi variabel psql `:'nama'` (literal) dan `:"nama"` (identifier) seperti `psql -v nama=nilai`. */
function psqlVars(sql: string, vars: Record<string, string>): string {
  return sql
    .replace(/:'([a-z_]+)'/g, (_, name: string) => `'${vars[name]!.replace(/'/g, "''")}'`)
    .replace(/:"([a-z_]+)"/g, (_, name: string) => `"${vars[name]!.replace(/"/g, '""')}"`);
}

let t: TestApp;

async function lines(sql: string): Promise<string[]> {
  const results = await t.pg.exec(sql);
  return results.flatMap((r) => r.rows.map((row) => String(Object.values(row)[0])));
}

async function stats(): Promise<Record<string, Record<string, unknown>>> {
  const [line] = await lines(`SELECT 'STATS=' || (${sqlFile("stats.sql")})::text;`);
  expect(line).toMatch(/^STATS=\{/);
  return JSON.parse(line!.slice("STATS=".length)) as Record<string, Record<string, unknown>>;
}

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

describe("SQL backup/restore (infra/backup/sql, PRD 5.5, N-06)", () => {
  it("N-06, PRD 9.2 #8: stats.sql menghitung jumlah, total uang per jenis dan versi skema migrasi tanpa data pribadi", async () => {
    const before = await stats();
    const member = await createAlumni(t, { status: "verified" });
    await createMembershipPayment(t, { userId: member.userId });
    await createAlumni(t, { status: "unverified" });
    const s = await stats();
    expect(Object.keys(s).sort()).toEqual(["captured_at", "info", "invariant", "latest", "schema"]);
    expect(s.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Versi skema dari journal migrasi Drizzle (tabel drizzle.__drizzle_migrations).
    const journal = JSON.parse(
      readFileSync(
        join(INFRA, "..", "..", "packages", "database", "migrations", "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: { when: number }[] };
    expect(s.schema).toEqual({
      applied: journal.entries.length,
      last_created_at: journal.entries[journal.entries.length - 1]!.when,
    });
    expect(Number(s.invariant!.users)).toBe(Number(before.invariant!.users) + 2);
    expect(s.invariant!.paid_total).toMatch(/^\d+\.\d{2}$/);
    const paid = await t.pg.query<{ total: string }>(
      "select coalesce(sum(amount), 0)::numeric(14,2)::text as total from app.payments where status = 'paid'",
    );
    expect(s.invariant!.paid_total).toBe(paid.rows[0]!.total);
    expect(Number(s.invariant!.payments_paid)).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toContain(member.email);
  });

  it("compare-stats.sql: selisih per kunci invariant/info/schema dari dua JSON statistik", async () => {
    const expected = await stats();
    const actual = structuredClone(expected);
    actual.invariant!.paid_total = "1.00";
    actual.info!.alumni = Number(actual.info!.alumni) - 1;
    const out = await lines(
      psqlVars(sqlFile("compare-stats.sql"), {
        expected: JSON.stringify(expected),
        actual: JSON.stringify(actual),
      }),
    );
    const rows = new Map(
      out.map((line) => [line.split("|").slice(0, 2).join("|"), line.split("|").slice(2)]),
    );
    expect(rows.get("invariant|paid_total")).toEqual([String(expected.invariant!.paid_total), "1.00"]);
    expect(rows.get("invariant|users")).toEqual([
      String(expected.invariant!.users),
      String(expected.invariant!.users),
    ]);
    expect(rows.get("info|alumni")).toEqual([String(expected.info!.alumni), String(actual.info!.alumni)]);
    expect(rows.get("schema|applied")).toEqual([
      String(expected.schema!.applied),
      String(expected.schema!.applied),
    ]);
    expect(out.every((line) => line.split("|").length === 4)).toBe(true);
  });

  it("AC F14-6: verify-checks.sql menandai akun ledger yang belum deleted; ledger kosong = 0; Super Admin dihitung dari akun aktif", async () => {
    const member = await createAlumni(t, { status: "verified" });
    await createAdmin(t, { role: "super_admin" });
    const check = async (ids: string) =>
      Object.fromEntries(
        (await lines(psqlVars(sqlFile("verify-checks.sql"), { ledger_user_ids: ids }))).map((line) =>
          line.split("="),
        ),
      );
    const empty = await check("{}");
    expect(empty).toMatchObject({ ledger_users_present: "0", ledger_users_not_deleted: "0" });
    expect(Number(empty.super_admins_active)).toBeGreaterThanOrEqual(1);
    const missing = uuidv7();
    const flagged = await check(`{${member.userId},${missing}}`);
    expect(flagged).toMatchObject({
      ledger_users_present: "1",
      ledger_users_not_deleted: "1",
      ledger_users_with_profile: "1",
    });
    await t.db.update(users).set({ status: "deleted" }).where(eq(users.id, member.userId));
    expect(await check(`{${member.userId}}`)).toMatchObject({ ledger_users_not_deleted: "0" });
    expect(Object.keys(empty)).toEqual([
      "super_admins_active",
      "ledger_users_present",
      "ledger_users_not_deleted",
      "ledger_users_with_profile",
      "deletions_completed_not_deleted",
      "deletions_open",
      "outbox_dead",
      "outbox_leased",
    ]);
  });

  it("PRD 5.1, 8.4: release-outbox.sql melepas lease instance lama tanpa menyentuh event dead/terkirim", async () => {
    const now = t.clock.now();
    const leased = uuidv7();
    const dead = uuidv7();
    await t.db.insert(outboxEvents).values([
      {
        id: leased,
        topic: "notification.created",
        dedupKey: `uji-restore-${leased}`,
        payload: {},
        status: "pending",
        lockedUntil: new Date(now.getTime() + 300_000),
        nextAttemptAt: now,
        createdAt: now,
      },
      {
        id: dead,
        topic: "notification.created",
        dedupKey: `uji-restore-${dead}`,
        payload: {},
        status: "dead",
        lockedUntil: new Date(now.getTime() + 300_000),
        nextAttemptAt: now,
        createdAt: now,
      },
    ]);
    const out = await lines(sqlFile("release-outbox.sql"));
    expect(out.some((line) => /^outbox_pending=\d+$/.test(line))).toBe(true);
    expect(out.some((line) => /^outbox_dead=\d+$/.test(line))).toBe(true);
    const [l] = await t.db.select().from(outboxEvents).where(eq(outboxEvents.id, leased));
    const [d] = await t.db.select().from(outboxEvents).where(eq(outboxEvents.id, dead));
    expect(l!.lockedUntil).toBeNull();
    expect(d!.lockedUntil).not.toBeNull();
    const checks = await lines(psqlVars(sqlFile("verify-checks.sql"), { ledger_user_ids: "{}" }));
    expect(checks).toContain("outbox_leased=0");
  });

  it("files-local.sql dan public-file.sql: hanya key, sha256 dan status; berkas publik ready dipilih untuk uji HTTP", async () => {
    const id = uuidv7();
    const now = t.clock.now();
    await t.db.insert(files).values({
      id,
      ownerUserId: null,
      purpose: "banner_image",
      storageDriver: "local",
      objectKey: `banner_image/2026/10/${id}`,
      mime: "image/png",
      bytes: 3,
      sha256: "a".repeat(64),
      visibility: "public",
      status: "ready",
      attachedAt: now,
      createdAt: new Date(now.getTime() + 86_400_000),
      updatedAt: now,
    });
    const local = await lines(sqlFile("files-local.sql"));
    expect(local).toContain(`banner_image/2026/10/${id} ${"a".repeat(64)} ready`);
    expect(local.every((line) => /^[a-z0-9._/-]+ [0-9a-f]{64} (pending|ready|failed)$/.test(line))).toBe(
      true,
    );
    expect(await lines(sqlFile("public-file.sql"))).toEqual([id]);
  });
});

describe("verify-http.mjs: smoke test HTTP lingkungan pulihan (PRD 5.5 login/MFA, berkas)", () => {
  const script = readFileSync(join(INFRA, "verify-http.mjs"), "utf8");

  function run(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-"], {
        env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", ...env },
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      child.on("close", (code) => resolve({ code, out }));
      child.stdin.end(script);
    });
  }

  it("PRD 5.5, AC F02-2: health, ready, login + TOTP admin drill, /admin/me, berkas publik lulus; kode TOTP salah atau sandi salah gagal; keluaran tanpa sandi/token", async () => {
    await t.app.listen(0, "127.0.0.1");
    const address = t.app.getHttpServer().address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    // TOTP dihitung skrip dari jam nyata; jam API uji disamakan.
    t.clock.set(new Date());
    const admin = await createAdmin(t, { role: "admin", permissions: [] });
    const id = uuidv7();
    const objectKey = `banner_image/2026/10/${id}`;
    await t.storage.put(objectKey, Buffer.from("png-uji"), { contentType: "image/png" });
    await t.db.insert(files).values({
      id,
      ownerUserId: null,
      purpose: "banner_image",
      storageDriver: "local",
      objectKey,
      mime: "image/png",
      bytes: 7,
      sha256: "b".repeat(64),
      visibility: "public",
      status: "ready",
      attachedAt: t.clock.now(),
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });

    const ok = await run({
      VERIFY_API_URL: base,
      DRILL_ADMIN_EMAIL: admin.email,
      DRILL_ADMIN_PASSWORD: admin.password,
      DRILL_ADMIN_TOTP_SECRET: admin.totpSecret!,
      VERIFY_PUBLIC_FILE_ID: id,
    });
    expect(ok.code, ok.out).toBe(0);
    for (const name of ["health", "ready", "admin.login", "admin.mfa", "admin.me", "berkas.publik"])
      expect(ok.out).toMatch(new RegExp(`^PASS ${name.replace(".", "\\.")} `, "m"));
    // Gerbang deletion ledger readiness (AC F14-6) ikut dilaporkan di bukti restore.
    expect(ok.out).toMatch(/^PASS ready HTTP 200 .*deletion_ledger=ok/m);
    expect(ok.out).not.toContain(admin.password);
    expect(ok.out).not.toContain(admin.totpSecret!);

    const wrongCode = await run({
      VERIFY_API_URL: base,
      DRILL_ADMIN_EMAIL: admin.email,
      DRILL_ADMIN_PASSWORD: admin.password,
      DRILL_ADMIN_TOTP_CODE: "000000",
    });
    expect(wrongCode.code).toBe(1);
    expect(wrongCode.out).toMatch(/^FAIL admin\.mfa HTTP 400 VALIDATION_ERROR/m);
    expect(wrongCode.out).toMatch(/^WARN berkas\.publik /m);

    const wrongPassword = await run({
      VERIFY_API_URL: base,
      DRILL_ADMIN_EMAIL: admin.email,
      DRILL_ADMIN_PASSWORD: "Salah#2026x",
      DRILL_ADMIN_TOTP_CODE: "000000",
    });
    expect(wrongPassword.code).toBe(1);
    expect(wrongPassword.out).toMatch(/^FAIL admin\.login HTTP 401 UNAUTHENTICATED/m);
    expect(wrongPassword.out).not.toContain("Salah#2026x");

    const unreachable = await run({ VERIFY_API_URL: "http://127.0.0.1:9" });
    expect(unreachable.code).toBe(1);
    expect(unreachable.out).toMatch(/^FAIL health /m);
  });
});
