/**
 * Penerbitan challenge OTP bersamaan pada PostgreSQL 17 nyata (PRD 2.5, AC F01-4, PRD 9.2 "duplicate registration").
 * otp_codes_active_key menjamin satu challenge aktif per akun/tujuan; AuthService.issueOtp mengunci baris users
 * sebelum supersede + insert sehingga penerbit bersamaan berurutan dan tidak pernah berakhir 500.
 * API berjalan dengan login role kapdh_app (grant production), bukan superuser.
 */
import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
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
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
let clock: TestClock;
let mailer: MemoryMailer;
let sql: Sql;

beforeAll(async () => {
  tdb = await createPgTestDatabase("auth_otp");
  sql = tdb.sql;
  api = connectAs(tdb, "kapdh_app", 10);
  clock = new TestClock();
  mailer = new MemoryMailer();
  app = await createApp(
    { env: testEnv, db: api.db as unknown as Db, mailer, clock, push: new FakePush(), redis: null },
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});

const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, payload });

function registerBody(email: string) {
  return {
    full_name: "Alumni Uji Bersamaan",
    gender: "female",
    email,
    password: "Kapdh#2026",
    cohort: 20,
    class_in: 1,
    class_out: 6,
    accept_policy_version: "1",
  };
}

/** Menunggu sampai ada backend database ini yang menunggu lock (bukti transaksi kedua benar-benar terblokir). */
async function waitForLockWaiter(db: Sql, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`;
    if ((row?.n ?? 0) > 0) return true;
    await sleep(10);
  }
  return false;
}

async function activeChallenges(email: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from app.otp_codes o join app.users u on u.id = o.user_id
    where u.email = ${email} and o.consumed_at is null and o.superseded_at is null`;
  return row!.n;
}

describe("PRD 2.5 / AC F01-4: challenge OTP bersamaan (PostgreSQL 17, role kapdh_app)", () => {
  it("registrasi ganda bersamaan untuk email yang sama: semua 201, satu akun, tepat satu challenge aktif", async () => {
    for (let round = 0; round < 5; round++) {
      const email = `ganda-${round}-${id().slice(-12)}@contoh.test`;
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => post("/auth/register", registerBody(email))),
      );
      expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
      const [users] = await sql<
        { n: number }[]
      >`select count(*)::int as n from app.users where email = ${email}`;
      expect(users!.n).toBe(1);
      expect(await activeChallenges(email)).toBe(1);
    }
  });

  it("kirim ulang ganda bersamaan: satu kode baru (200), yang lain 410 seperti permintaan berurutan, tanpa 500", async () => {
    for (let round = 0; round < 5; round++) {
      const email = `resend-${round}-${id().slice(-12)}@contoh.test`;
      const reg = await post("/auth/register", registerBody(email));
      expect(reg.statusCode).toBe(201);
      clock.advance(61_000);
      const challengeId = reg.json().challenge_id as string;
      const responses = await Promise.all([
        post("/auth/otp/resend", { challenge_id: challengeId }),
        post("/auth/otp/resend", { challenge_id: challengeId }),
      ]);
      expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 410]);
      expect(await activeChallenges(email)).toBe(1);
    }
  });

  it("AC F01-2 / PRD 3.5: verifikasi OTP lewat API (kapdh_app) mengalokasikan N dari nextval dan nomor sesuai segmen", async () => {
    const email = `verifikasi-${id().slice(-12)}@contoh.test`;
    const reg = await post("/auth/register", registerBody(email));
    expect(reg.statusCode).toBe(201);
    const verify = await post("/auth/otp/verify", {
      challenge_id: reg.json().challenge_id,
      code: mailer.last(email)!,
    });
    expect(verify.statusCode).toBe(200);
    const [row] = await sql<{ member_seq: string; member_number: string; status: string }[]>`
      select a.member_seq::text as member_seq, a.member_number, u.status
      from app.alumni a join app.users u on u.id = a.user_id where u.email = ${email}`;
    expect(row!.status).toBe("active");
    // Angkatan 20, kelas 1 sampai 6 (SS 01), perempuan (JK 02); N dari sequence.
    expect(row!.member_number).toBe(`20.01.02.${row!.member_seq}`);
  });

  it("kontrak DB: penerbit yang mengunci baris users berurutan; tanpa kunci, penerbit kedua bentrok 23505", async () => {
    const issue = (userId: string, lockUser: boolean, ready: () => Promise<void>) =>
      sql.begin(async (tx) => {
        if (lockUser) await tx`select 1 from app.users where id = ${userId} for no key update`;
        await ready();
        await tx`
          update app.otp_codes set superseded_at = now()
          where user_id = ${userId} and purpose = 'signup' and consumed_at is null and superseded_at is null`;
        await tx`
          insert into app.otp_codes (id, user_id, purpose, code_hmac, expires_at, resend_available_at)
          values (${id()}, ${userId}, 'signup', 'hmac-uji', now() + interval '10 minutes', now())`;
        await sleep(150);
      });

    // Dengan kunci (perilaku AuthService.issueOtp): penerbit pertama menahan kunci baris users sampai penerbit kedua
    // terbukti menunggu (pg_stat_activity), lalu keduanya sukses dan yang kedua menggantikan challenge pertama.
    const locked = await insertUser(sql, { status: "pending_otp" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let signalLocked!: () => void;
    const firstHoldsLock = new Promise<void>((r) => (signalLocked = r));
    const first = issue(locked, true, async () => {
      signalLocked();
      await gate;
    });
    await firstHoldsLock;
    const second = issue(locked, true, async () => {});
    const secondWaited = await waitForLockWaiter(sql, 10_000);
    release();
    const result = await Promise.allSettled([first, second]);
    expect(secondWaited).toBe(true);
    expect(result.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const [active] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.otp_codes
      where user_id = ${locked} and consumed_at is null and superseded_at is null`;
    expect(active!.n).toBe(1);

    // Kontrol negatif: tanpa kunci baris users, keduanya lolos supersede lalu insert kedua melanggar indeks unik.
    const unlocked = await insertUser(sql, { status: "pending_otp" });
    const unlockedReady = barrier(2);
    const raced = await Promise.allSettled([
      issue(unlocked, false, unlockedReady),
      issue(unlocked, false, unlockedReady),
    ]);
    const rejected = raced.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(pgError(rejected[0]!.reason)).toMatchObject({ code: "23505", constraint: "otp_codes_active_key" });
  });
});
