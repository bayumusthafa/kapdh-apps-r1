import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { messages, payments, tickets, users } from "@kapdh/database";
import { and, count, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOADTEST_EMAIL_DOMAIN } from "../../src/cli/loadtest-dataset.js";
import { runLoadtestSeedCommand } from "../../src/cli/loadtest-seed-command.js";
import { createTestApp, type TestApp, testEnv } from "../support/test-app.js";

/**
 * Perkakas uji beban (PRD 2.4 N-01, N-02, N-04; docs/runbooks/load-test.md) dijalankan sungguhan dengan ukuran kecil
 * terhadap API uji yang mendengar (Fastify + gateway Socket.IO yang sama dengan production, PGlite):
 *   - CLI dataset `loadtest:seed` (penjaga production/nama database, kredensial 0600, invarian skema);
 *   - infra/loadtest/api-load.mjs mode N-01 dan mode kapasitas N-04 (laporan, ambang, titik jenuh);
 *   - infra/loadtest/realtime-load.mjs (latensi message.created, sinkron reconnect after=<jangkar>).
 * Ini membuktikan alat dan alurnya bekerja, BUKAN angka kinerja: N-01/N-02/N-04 hanya terbukti dari run di VPS
 * sasaran dengan dataset penuh (U-11).
 */
const LOADTEST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "loadtest");

let t: TestApp;
let base: string;
let work: string;
let credentials: string;
let clockTimer: NodeJS.Timeout;
const out: string[] = [];
const err: string[] = [];
const sink = (into: string[]) => ({ write: (text: string) => into.push(text) });

function run(script: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(LOADTEST, script), ...args], {
      env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
    });
    let text = "";
    child.stdout.on("data", (d: Buffer) => (text += d.toString()));
    child.stderr.on("data", (d: Buffer) => (text += d.toString()));
    child.on("close", (code) => resolve({ code, out: text }));
  });
}

function latestReport(dir: string, tool: string): Record<string, unknown> & { verdict: string } {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(tool) && f.endsWith(".json"))
    .sort();
  return JSON.parse(readFileSync(join(dir, files.at(-1)!), "utf8"));
}

beforeAll(async () => {
  t = await createTestApp();
  // Alat beban memakai jam nyata (TOTP admin, kedaluwarsa token): jam uji mengikuti jam dinding.
  t.clock.set(new Date());
  clockTimer = setInterval(() => t.clock.set(new Date()), 500);
  await t.app.listen(0, "127.0.0.1");
  const { port } = t.app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${port}`;
  work = mkdtempSync(join(tmpdir(), "kapdh-loadtest-"));
  credentials = join(work, "kredensial.json");
});
afterAll(async () => {
  clearInterval(clockTimer);
  await t.app.close();
  // KAPDH_LOADTEST_KEEP=1 menyimpan laporan contoh untuk ditinjau (folder dicetak ke stderr).
  if (process.env.KAPDH_LOADTEST_KEEP === "1") process.stderr.write(`laporan uji beban: ${work}\n`);
  else rmSync(work, { recursive: true, force: true });
});

async function databaseName(): Promise<string> {
  const result = await t.pg.query<{ name: string }>("select current_database() as name");
  return result.rows[0]!.name;
}

describe("loadtest:seed (dataset sintetis PRD 2.4, staging saja)", () => {
  it("PRD 5.3, 8.2: menolak production dan nama database yang tidak cocok tanpa menulis data", async () => {
    const deps = { db: t.db, now: t.clock.now(), stdout: sink(out), stderr: sink(err) };
    const prod = await runLoadtestSeedCommand(
      ["--confirm-database", await databaseName(), "--out", join(work, "x.json")],
      {
        ...deps,
        env: { NODE_ENV: "production", BCRYPT_COST: 4, TOTP_ENC_KEY: testEnv.TOTP_ENC_KEY },
      },
    );
    expect(prod).toBe(1);
    const wrong = await runLoadtestSeedCommand(
      ["--confirm-database", "kapdh_production", "--out", join(work, "y.json")],
      {
        ...deps,
        env: { NODE_ENV: "test", BCRYPT_COST: 4, TOTP_ENC_KEY: testEnv.TOTP_ENC_KEY },
      },
    );
    expect(wrong).toBe(1);
    expect(err.join("")).toMatch(/berbeda dari database tujuan/);
    const [row] = await t.db
      .select({ n: count() })
      .from(users)
      .where(like(users.email, `%@${LOADTEST_EMAIL_DOMAIN}`));
    expect(row!.n).toBe(0);
  });

  it("membuat profil, admin ber-TOTP, room/pesan, event dan antrean payment; kredensial 0600; menolak dijalankan ulang", async () => {
    const args = [
      "--confirm-database",
      await databaseName(),
      "--out",
      credentials,
      ...["--profiles", "40", "--login-members", "8", "--admins", "2", "--messages", "600"],
      ...[
        "--group-rooms",
        "3",
        "--direct-rooms",
        "6",
        "--events",
        "3",
        "--pending-payments",
        "25",
        "--posts",
        "3",
      ],
    ];
    const deps = {
      db: t.db,
      env: { NODE_ENV: "test", BCRYPT_COST: 4, TOTP_ENC_KEY: testEnv.TOTP_ENC_KEY },
      now: t.clock.now(),
      stdout: sink(out),
      stderr: sink(err),
    };
    expect(await runLoadtestSeedCommand(args, deps), err.join("")).toBe(0);
    const creds = JSON.parse(readFileSync(credentials, "utf8"));
    expect(creds.kind).toBe("kapdh.loadtest_credentials");
    expect(creds.members).toHaveLength(8);
    expect(creds.admins).toHaveLength(2);
    expect(creds.realtime_room_ids).toHaveLength(1);
    expect(creds.counts).toMatchObject({ profiles: 40, messages: 600, pending_payments: 25 });
    if (process.platform !== "win32") expect(statSync(credentials).mode & 0o077).toBe(0);
    // Sandi tidak pernah dicetak.
    expect(out.join("")).not.toContain(creds.member_password);
    const [msg] = await t.db.select({ n: count() }).from(messages);
    expect(msg!.n).toBeGreaterThanOrEqual(600);
    const [pending] = await t.db
      .select({ n: count() })
      .from(payments)
      .where(and(eq(payments.status, "pending"), eq(payments.type, "renewal")));
    expect(pending!.n).toBe(25);
    // Dijalankan ulang tanpa reset database: ditolak.
    expect(await runLoadtestSeedCommand([...args.slice(0, 2), "--out", join(work, "lagi.json")], deps)).toBe(
      1,
    );
    expect(err.join("")).toMatch(/sudah ada/);
  });
});

describe("infra/loadtest/api-load.mjs (N-01, N-04)", () => {
  it("N-01: mode laju tetap menjalankan baca, keputusan payment, reservasi dan pembatalan tiket; laporan LULUS; data berubah lewat API", async () => {
    const reports = join(work, "n01");
    const result = await run("api-load.mjs", [
      ...["--credentials", credentials, "--base-url", base, "--report-dir", reports],
      ...["--rate", "6", "--duration", "10", "--warmup", "2", "--members", "8", "--admins", "2"],
      // Ambang dilonggarkan: uji ini membuktikan alat, bukan kinerja PGlite.
      ...["--read-p95-ms", "10000", "--decision-p95-ms", "20000"],
    ]);
    expect(result.code, result.out).toBe(0);
    const report = latestReport(reports, "api-load") as unknown as {
      verdict: string;
      phases: {
        classes: Record<string, { count: number; error: number }>;
        total: { error: number };
        ops: Record<string, { ok: number }>;
      }[];
    };
    expect(report.verdict).toBe("LULUS");
    const [measure] = report.phases;
    expect(measure!.total.error, JSON.stringify(measure!.ops)).toBe(0);
    expect(measure!.classes.read!.count).toBeGreaterThan(20);
    expect(measure!.classes.decision!.count).toBeGreaterThan(0);
    expect(result.out).not.toContain(JSON.parse(readFileSync(credentials, "utf8")).member_password);
    // Efek nyata: tiket dibuat lewat reservasi dan/atau payment diputus lewat API.
    const [ticketRows] = await t.db.select({ n: count() }).from(tickets);
    const [paid] = await t.db
      .select({ n: count() })
      .from(payments)
      .where(and(eq(payments.status, "paid"), eq(payments.type, "renewal")));
    expect(ticketRows!.n + paid!.n).toBeGreaterThan(0);
  }, 120_000);

  it("N-04: mode kapasitas melaporkan titik gagal pertama dan kapasitas; ambang yang mustahil -> titik jenuh di tingkat pertama", async () => {
    const reports = join(work, "n04");
    const result = await run("api-load.mjs", [
      ...["--credentials", credentials, "--base-url", base, "--report-dir", reports],
      ...["--steps", "2,4", "--step-duration", "4", "--warmup", "0", "--members", "8", "--admins", "2"],
      ...["--read-p95-ms", "1", "--decision-p95-ms", "1"],
    ]);
    expect(result.code, result.out).toBe(0);
    const report = latestReport(reports, "api-load") as unknown as {
      verdict: string;
      capacity: { knee_rate: number | null; capacity_rps: number | null };
      phases: { phase: string; pass: boolean }[];
    };
    expect(report.verdict).toBe("SELESAI");
    expect(report.phases.map((p) => p.phase)).toEqual(["step-2", "step-4"]);
    expect(report.capacity.knee_rate).toBe(2);
    expect(report.capacity.capacity_rps).toBeNull();
  }, 120_000);

  it("N-01: ambang terlampaui -> GAGAL dengan kode keluar 1", async () => {
    const reports = join(work, "n01-gagal");
    const result = await run("api-load.mjs", [
      ...["--credentials", credentials, "--base-url", base, "--report-dir", reports],
      ...["--rate", "4", "--duration", "4", "--warmup", "0", "--members", "8", "--admins", "2"],
      ...["--read-p95-ms", "1", "--decision-p95-ms", "20000"],
    ]);
    expect(result.code, result.out).toBe(1);
    expect(latestReport(reports, "api-load").verdict).toBe("GAGAL");
  }, 120_000);
});

describe("infra/loadtest/realtime-load.mjs (N-02)", () => {
  it("N-02, AC F11-3: setiap pesan sampai ke penerima online, latensi tercatat, sinkron reconnect after=<jangkar> lengkap tanpa duplikat", async () => {
    const reports = join(work, "n02");
    const result = await run("realtime-load.mjs", [
      ...["--credentials", credentials, "--base-url", base, "--report-dir", reports],
      ...["--sessions", "8", "--rate", "3", "--duration", "9", "--warmup", "0", "--grace-ms", "2000"],
      ...["--reconnect-fraction", "0.25", "--reconnect-gap", "2", "--threshold-ms", "10000"],
    ]);
    expect(result.code, result.out).toBe(0);
    const report = latestReport(reports, "realtime-load") as unknown as {
      verdict: string;
      delivery: { expected: number; missing: number; duplicates: number };
      reconnect: { sessions: number; rooms_synced: number; expected: number; missing: number };
    };
    expect(report.verdict).toBe("LULUS");
    expect(report.delivery.expected).toBeGreaterThan(10);
    expect(report.delivery.missing).toBe(0);
    expect(report.reconnect.sessions).toBe(2);
    expect(report.reconnect.rooms_synced).toBeGreaterThan(0);
    expect(report.reconnect.expected).toBeGreaterThan(0);
    expect(report.reconnect.missing).toBe(0);
  }, 120_000);
});
