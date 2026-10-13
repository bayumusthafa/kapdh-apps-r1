/**
 * Alur auth di bawah konkurensi nyata PostgreSQL 17 (PRD 2.5, 9.2; AC F01-4, F02-3, F02-4): burst verifikasi OTP
 * (percobaan dicadangkan atomik, tidak pernah 500), registrasi ganda bersamaan, refresh bersamaan dengan token yang
 * sama, lupa sandi bersamaan (challenge nyata dan pengganti), dan reset bersamaan dengan reset_token yang sama.
 * API berjalan dengan login role kapdh_app (grant production), bukan superuser.
 */
import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { sha256 } from "../../src/core/identity/crypto.js";
import { MemoryRateLimitStore } from "../../src/core/rate-limit/store.js";
import { createAlumni } from "../support/factories.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import {
  connectAs,
  createPgTestDatabase,
  id,
  type PgTestDatabase,
  PG_CONSENT_VERSION,
  publishLegalVersions,
  type Sql,
} from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
let sql: Sql;
const clock = new TestClock();
const mailer = new MemoryMailer();
const limits = new MemoryRateLimitStore();
let owner: { db: Db; clock: TestClock };

beforeAll(async () => {
  tdb = await createPgTestDatabase("auth_flows", 8);
  sql = tdb.sql;
  api = connectAs(tdb, "kapdh_app", 12);
  owner = { db: tdb.db as unknown as Db, clock };
  app = await createApp(
    { env: testEnv, db: api.db as unknown as Db, mailer, clock, push: new FakePush(), redis: null },
    { logger: false, rateLimitStore: limits },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await publishLegalVersions(sql);
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});
beforeEach(() => {
  limits.clear();
});

let ipSeq = 0;
/** Alamat IP berbeda per skenario agar batas per IP skenario lain tidak ikut terhitung. */
const nextIp = () => `198.51.100.${(ipSeq += 1) % 250}`;

const post = (url: string, payload: object, remoteAddress: string) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload, remoteAddress });

function tally(responses: { statusCode: number }[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const res of responses) counts[res.statusCode] = (counts[res.statusCode] ?? 0) + 1;
  return counts;
}

function registerBody(email: string, password = "Kapdh#2026") {
  return {
    full_name: "Alumni Uji Bersamaan",
    gender: "male",
    email,
    password,
    cohort: 22,
    class_in: 1,
    class_out: 6,
    accept_policy_version: PG_CONSENT_VERSION,
  };
}

async function otpRow(challengeId: string) {
  const [row] = await sql<{ attempts: number; consumed_at: Date | null }[]>`
    select attempts, consumed_at from app.otp_codes where id = ${challengeId}`;
  return row!;
}

const wrongCodes = (right: string, n: number) => {
  const codes: string[] = [];
  for (let i = 0; codes.length < n; i++) {
    const code = String(i).padStart(6, "0");
    if (code !== right) codes.push(code);
  }
  return codes;
};

describe("PRD 2.5: burst verifikasi OTP paralel (percobaan dicadangkan atomik)", () => {
  it("AC F01-3: 12 kode salah paralel pada challenge signup: tepat 4×400 + 8×410, attempts = 5, tidak pernah 500", async () => {
    const ip = nextIp();
    const email = `burst-${id().slice(-12)}@contoh.test`;
    const reg = await post("/auth/register", registerBody(email), ip);
    expect(reg.statusCode).toBe(201);
    const challengeId = reg.json().challenge_id as string;
    const responses = await Promise.all(
      wrongCodes(mailer.last(email)!, 12).map((code) =>
        post("/auth/otp/verify", { challenge_id: challengeId, code }, ip),
      ),
    );
    expect(tally(responses)).toEqual({ 400: 4, 410: 8 });
    expect(await otpRow(challengeId)).toMatchObject({ attempts: 5, consumed_at: null });
  });

  it("AC F01-2: burst dengan kode benar di tengahnya: paling banyak satu aktivasi, ≤ 5 percobaan, tidak pernah 500", async () => {
    for (let round = 0; round < 3; round++) {
      const ip = nextIp();
      const email = `burst-benar-${round}-${id().slice(-12)}@contoh.test`;
      const reg = await post("/auth/register", registerBody(email), ip);
      const challengeId = reg.json().challenge_id as string;
      const right = mailer.last(email)!;
      const codes = wrongCodes(right, 15);
      codes.splice(round * 3, 0, right, right);
      const responses = await Promise.all(
        codes.map((code) => post("/auth/otp/verify", { challenge_id: challengeId, code }, ip)),
      );
      const counts = tally(responses);
      expect(Object.keys(counts).every((status) => ["200", "400", "410"].includes(status))).toBe(true);
      expect(counts[200] ?? 0).toBeLessThanOrEqual(1);
      expect(counts[400] ?? 0).toBeLessThanOrEqual(4);
      expect((await otpRow(challengeId)).attempts).toBeLessThanOrEqual(5);
      const [user] = await sql<{ status: string; n: number }[]>`
        select u.status, (select count(*)::int from app.sessions s where s.user_id = u.id) as n
        from app.users u where u.email = ${email}`;
      // Sesi hanya diterbitkan oleh aktivasi yang berhasil (tepat sekali).
      expect(user!.n).toBe(counts[200] ?? 0);
      expect(user!.status).toBe((counts[200] ?? 0) === 1 ? "active" : "pending_otp");
    }
  });

  it("AC F02-4: burst kode pemulihan (nyata dan pengganti): ≤ 5 percobaan, paling banyak satu reset_token", async () => {
    const ip = nextIp();
    const member = await createAlumni(owner, { status: "verified" });
    const real = await post("/auth/password/forgot", { email: member.email }, ip);
    expect(real.statusCode).toBe(202);
    const right = mailer.last(member.email)!;
    const codes = wrongCodes(right, 10);
    codes.splice(2, 0, right, right);
    const realResponses = await Promise.all(
      codes.map((code) =>
        post("/auth/password/forgot/verify", { challenge_id: real.json().challenge_id, code }, ip),
      ),
    );
    const realCounts = tally(realResponses);
    expect(Object.keys(realCounts).every((status) => ["200", "400", "410"].includes(status))).toBe(true);
    expect(realCounts[200] ?? 0).toBeLessThanOrEqual(1);
    expect((await otpRow(real.json().challenge_id as string)).attempts).toBeLessThanOrEqual(5);

    const decoy = await post("/auth/password/forgot", { email: `hantu-${id().slice(-12)}@contoh.test` }, ip);
    expect(decoy.statusCode).toBe(202);
    const decoyResponses = await Promise.all(
      wrongCodes("------", 12).map((code) =>
        post("/auth/password/forgot/verify", { challenge_id: decoy.json().challenge_id, code }, ip),
      ),
    );
    expect(tally(decoyResponses)).toEqual({ 400: 4, 410: 8 });
    const [row] = await sql<{ attempts: number }[]>`
      select attempts from app.otp_decoys where id = ${decoy.json().challenge_id as string}`;
    expect(row!.attempts).toBe(5);
  });
});

describe("AC F01-4 / PRD 9.2: registrasi ganda bersamaan", () => {
  it("AC F01-4: email sama dengan sandi berbeda: satu akun, satu challenge aktif yang terikat sandi tersimpan, tanpa 500", async () => {
    for (let round = 0; round < 4; round++) {
      const ip = nextIp();
      const email = `ganda-sandi-${round}-${id().slice(-12)}@contoh.test`;
      const responses = await Promise.all(
        ["Kapdh#2026a", "Kapdh#2026b", "Kapdh#2026c", "Kapdh#2026d"].map((password) =>
          post("/auth/register", registerBody(email, password), ip),
        ),
      );
      const counts = tally(responses);
      expect(Object.keys(counts).every((status) => ["201", "429"].includes(status))).toBe(true);
      expect(counts[201]).toBeGreaterThanOrEqual(1);
      const accounts = await sql<{ id: string; password_hash: string }[]>`
        select id, password_hash from app.users where email = ${email}`;
      expect(accounts).toHaveLength(1);
      const active = await sql<{ id: string; binding: string }[]>`
        select id, binding from app.otp_codes
        where user_id = ${accounts[0]!.id} and consumed_at is null and superseded_at is null`;
      expect(active).toHaveLength(1);
      // Challenge aktif terikat hash sandi yang tersimpan: kode yang dikirim mengaktifkan sandi yang benar-benar tersimpan.
      expect(active[0]!.binding).toBe(sha256(accounts[0]!.password_hash));
      const verify = await post(
        "/auth/otp/verify",
        { challenge_id: active[0]!.id, code: mailer.last(email)! },
        ip,
      );
      expect(verify.statusCode).toBe(200);
    }
  });
});

describe("AC F02-3: refresh bersamaan dengan token yang sama", () => {
  it("AC F02-3: tepat satu rotasi; yang kalah = pemakaian ulang: seluruh keluarga dicabut dan diaudit, tanpa 500", async () => {
    for (let round = 0; round < 3; round++) {
      const ip = nextIp();
      const member = await createAlumni(owner, { status: "verified" });
      const login = await post("/auth/login", { email: member.email, password: member.password }, ip);
      expect(login.statusCode).toBe(200);
      const refreshToken = login.json().session.refresh_token as string;
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => post("/auth/refresh", { refresh_token: refreshToken }, ip)),
      );
      expect(tally(responses)).toEqual({ 200: 1, 401: 5 });
      const winner = responses.find((r) => r.statusCode === 200)!.json() as {
        access_token: string;
        refresh_token: string;
      };
      const [family] = await sql<{ total: number; live: number }[]>`
        select count(*)::int as total, count(*) filter (where revoked_at is null)::int as live
        from app.sessions where user_id = ${member.userId}`;
      expect(family).toEqual({ total: 2, live: 0 });
      const audits = await sql<{ after: { concurrent: boolean } }[]>`
        select after from app.audit_logs
        where action = 'session.refresh_reuse_detected' and entity_id = ${member.userId}`;
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const me = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${winner.access_token}` },
        remoteAddress: ip,
      });
      expect(me.statusCode).toBe(401);
      expect((await post("/auth/refresh", { refresh_token: winner.refresh_token }, ip)).statusCode).toBe(401);
    }
  });
});

describe("PRD 2.5: lupa sandi bersamaan", () => {
  it("AC F02-4: akun nyata: semua 202 dengan challenge yang sama, satu email, satu challenge aktif", async () => {
    const ip = nextIp();
    const member = await createAlumni(owner, { status: "verified" });
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => post("/auth/password/forgot", { email: member.email }, ip)),
    );
    expect(tally(responses)).toEqual({ 202: 6 });
    expect(new Set(responses.map((r) => r.json().challenge_id as string)).size).toBe(1);
    expect(mailer.sent.filter((m) => m.to === member.email)).toHaveLength(1);
    const [active] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.otp_codes
      where user_id = ${member.userId} and purpose = 'password_reset'
        and consumed_at is null and superseded_at is null`;
    expect(active!.n).toBe(1);
  });

  it("AC F02-4: email tidak terdaftar: perilaku sama (semua 202, satu challenge pengganti aktif), tanpa email dan tanpa 500", async () => {
    const ip = nextIp();
    const email = `hantu-bersamaan-${id().slice(-12)}@contoh.test`;
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => post("/auth/password/forgot", { email }, ip)),
    );
    expect(tally(responses)).toEqual({ 202: 6 });
    const ids = new Set(responses.map((r) => r.json().challenge_id as string));
    expect(ids.size).toBe(1);
    const [active] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.otp_decoys
      where id = ${[...ids][0]!} and superseded_at is null`;
    expect(active!.n).toBe(1);
    expect(mailer.sent.filter((m) => m.to === email)).toHaveLength(0);
  });

  it("AC F01-3: kirim ulang bersamaan pada challenge pengganti: satu 200, yang lain 410 seperti challenge nyata", async () => {
    const ip = nextIp();
    const email = `hantu-resend-${id().slice(-12)}@contoh.test`;
    const first = await post("/auth/password/forgot", { email }, ip);
    clock.advance(61_000);
    const responses = await Promise.all([
      post("/auth/otp/resend", { challenge_id: first.json().challenge_id }, ip),
      post("/auth/otp/resend", { challenge_id: first.json().challenge_id }, ip),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 410]);
  });
});

describe("driver postgres-js: kueri sesi dan pembersihan challenge pengganti", () => {
  it("F-02: daftar sesi (agregat per keluarga + keyset cursor) di PostgreSQL 17 nyata", async () => {
    const ip = nextIp();
    const member = await createAlumni(owner, { status: "verified" });
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      const login = await post(
        "/auth/login",
        { email: member.email, password: member.password, device_name: `Perangkat ${i}` },
        ip,
      );
      tokens.push(login.json().session.access_token as string);
      clock.advance(1_000);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/sessions",
        query: { limit: "2", ...(cursor ? { cursor } : {}) },
        headers: { authorization: `Bearer ${tokens[0]!}` },
        remoteAddress: ip,
      });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as {
        items: { device_name: string; current: boolean }[];
        next_cursor: string | null;
      };
      seen.push(...page.items.map((item) => `${item.device_name}${item.current ? "*" : ""}`));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual(["Perangkat 2", "Perangkat 1", "Perangkat 0*"]);
  });

  it("PRD 2.5: challenge lebih tua dari masa simpan diperlakukan tidak dikenal; baris pengganti lama dibersihkan", async () => {
    const ip = nextIp();
    const staleId = id();
    const old = new Date(clock.now().getTime() - 25 * 3600_000).toISOString();
    await sql`
      insert into app.otp_decoys (id, purpose, email_key, email_masked, expires_at, resend_available_at, created_at)
      values (${staleId}, 'password_reset', ${"a".repeat(64)}, 'ha***@contoh.test', ${old}::timestamptz,
              ${old}::timestamptz, ${old}::timestamptz)`;
    const status = await post("/auth/otp/status", { challenge_id: staleId }, ip);
    expect(status.statusCode).toBe(410);
    expect(
      (await post("/auth/password/forgot", { email: `bersih-${id().slice(-12)}@contoh.test` }, ip))
        .statusCode,
    ).toBe(202);
    const [left] = await sql<
      { n: number }[]
    >`select count(*)::int as n from app.otp_decoys where id = ${staleId}`;
    expect(left!.n).toBe(0);
  });
});

describe("AC F02-4: reset bersamaan dengan reset_token yang sama", () => {
  it("AC F02-4: tepat satu 204, sisanya 410; hanya satu sandi baru yang tersimpan", async () => {
    const ip = nextIp();
    const member = await createAlumni(owner, { status: "verified" });
    const challenge = await post("/auth/password/forgot", { email: member.email }, ip);
    const grant = await post(
      "/auth/password/forgot/verify",
      { challenge_id: challenge.json().challenge_id, code: mailer.last(member.email)! },
      ip,
    );
    expect(grant.statusCode).toBe(200);
    const passwords = ["Baru#2026a", "Baru#2026b", "Baru#2026c", "Baru#2026d", "Baru#2026e"];
    const responses = await Promise.all(
      passwords.map((password) =>
        post("/auth/password/reset", { reset_token: grant.json().reset_token, new_password: password }, ip),
      ),
    );
    expect(tally(responses)).toEqual({ 204: 1, 410: 4 });
    const winner = passwords[responses.findIndex((r) => r.statusCode === 204)]!;
    limits.clear();
    for (const password of passwords) {
      const login = await post("/auth/login", { email: member.email, password }, nextIp());
      expect(login.statusCode, password).toBe(password === winner ? 200 : 401);
    }
  });
});
