/**
 * Interleaving deterministik sesi auth di PostgreSQL 17 nyata (AC F02-3, F02-4, F02-6, F13-5; N-08): pencabutan sesi
 * (logout semua, pencabutan satu sesi, logout, deteksi pemakaian ulang) yang berlomba dengan rotasi refresh yang
 * SEDANG berjalan, dan login dengan sandi lama yang sedang berjalan saat reset/ganti sandi commit.
 *
 * Gerbang: satu baris device_tokens dikunci FOR UPDATE oleh transaksi uji sehingga transaksi target berhenti tepat di
 * tengah (rotasi di moveDeviceTokensToSession sesudah baris lama terkunci dan baris baru disisipkan; reset/ganti
 * sandi/logout semua di revokeDeviceTokens sesudah users terkunci), lalu operasi pesaing dikirim dan gerbang dibuka
 * setelah probe melihat pesaing menunggu kunci. Tanpa urutan kunci users (session-locks.ts) uji-uji ini gagal:
 * baris hasil rotasi lolos dari pencabutan, atau login dengan sandi lama memperoleh sesi yang bertahan.
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
  LOCK_WAIT_TIMEOUT_MS,
  type PgTestDatabase,
  type Sql,
  sleep,
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
  tdb = await createPgTestDatabase("auth_races", 8);
  sql = tdb.sql;
  api = connectAs(tdb, "kapdh_app", 12);
  owner = { db: tdb.db as unknown as Db, clock };
  app = await createApp(
    { env: testEnv, db: api.db as unknown as Db, mailer, clock, push: new FakePush(), redis: null },
    { logger: false, rateLimitStore: limits },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
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
const nextIp = () => `192.0.2.${(ipSeq += 1) % 250}`;

function client(ip: string) {
  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object, token?: string) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      ...(payload ? { payload } : {}),
      remoteAddress: ip,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  return {
    post: (url: string, payload: object, token?: string) => call("POST", url, payload, token),
    get: (url: string, token: string) => call("GET", url, undefined, token),
    delete: (url: string, token: string) => call("DELETE", url, undefined, token),
  };
}

/** Jumlah backend database uji yang sedang menunggu kunci (baris, transaksi, atau advisory). */
async function lockWaiters(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'`;
  return row?.n ?? 0;
}

async function untilLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await lockWaiters()) >= n) return;
    await sleep(5);
  }
  throw new Error(`kurang dari ${n} backend menunggu kunci`);
}

/**
 * Gerbang: token push milik `userId` (terikat baris sesi `sessionRowId`, atau tanpa sesi) dikunci FOR UPDATE oleh
 * transaksi uji sampai `release()`. Transaksi API yang memperbarui token ini (rotasi: moveDeviceTokensToSession;
 * pencabutan: revokeDeviceTokens) berhenti di situ sambil memegang kunci-kunci sebelumnya.
 */
async function deviceTokenGate(userId: string, sessionRowId: string | null) {
  const tokenId = id();
  await sql`
    insert into app.device_tokens (id, user_id, session_id, platform, token)
    values (${tokenId}, ${userId}, ${sessionRowId}, 'android', ${`gerbang-${tokenId}`})`;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => (locked = resolve));
  const done = sql.begin(async (tx) => {
    await tx`select id from app.device_tokens where id = ${tokenId} for update`;
    locked();
    await released;
  });
  await holding;
  return {
    async open() {
      release();
      await done;
    },
  };
}

async function sessionRowOf(refreshToken: string) {
  const [row] = await sql<{ id: string; family_id: string; revoked_at: Date | null }[]>`
    select id, family_id, revoked_at from app.sessions where refresh_hash = ${sha256(refreshToken)}`;
  return row!;
}

async function liveSessions(userId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from app.sessions where user_id = ${userId} and revoked_at is null`;
  return row!.n;
}

async function login(http: ReturnType<typeof client>, member: { email: string; password: string }) {
  const res = await http.post("/auth/login", { email: member.email, password: member.password });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().session as { access_token: string; refresh_token: string };
}

describe("AC F02-6 / AC F02-3: pencabutan sesi vs rotasi refresh yang sedang berjalan", () => {
  it("AC F02-6: logout semua saat rotasi perangkat lain berjalan → baris hasil rotasi ikut dicabut (refresh berikutnya 401)", async () => {
    const http = client(nextIp());
    const member = await createAlumni(owner, { status: "verified" });
    const victim = await login(http, member);
    const stolen = await login(http, member);
    const gate = await deviceTokenGate(member.userId, (await sessionRowOf(stolen.refresh_token)).id);

    const refreshing = http.post("/auth/refresh", { refresh_token: stolen.refresh_token });
    await untilLockWaiters(1); // rotasi berhenti: baris lama terkunci, baris baru sudah disisipkan
    const loggingOut = http.post("/auth/logout-all", {}, victim.access_token);
    await untilLockWaiters(2); // logout semua menunggu kunci users (session-locks.ts)
    await gate.open();
    const [refreshed, logoutAll] = await Promise.all([refreshing, loggingOut]);

    expect(refreshed.statusCode).toBe(200);
    expect(logoutAll.statusCode).toBe(204);
    const rotated = refreshed.json() as { access_token: string; refresh_token: string };
    expect((await sessionRowOf(rotated.refresh_token)).revoked_at).not.toBeNull();
    expect(await liveSessions(member.userId)).toBe(0);
    expect((await http.post("/auth/refresh", { refresh_token: rotated.refresh_token })).statusCode).toBe(401);
    expect((await http.get("/auth/sessions", rotated.access_token)).statusCode).toBe(401);
    const [audit] = await sql<{ after: { sessions_revoked: number } }[]>`
      select after from app.audit_logs where action = 'session.logout_all' and entity_id = ${member.userId}`;
    // victim + baris hasil rotasi (baris lama sudah dicabut oleh rotasi).
    expect(audit!.after.sessions_revoked).toBe(2);
    // Token push yang dipindahkan rotasi ke baris baru juga dicabut (AC F13-5).
    const [tokens] = await sql<{ live: number }[]>`
      select count(*) filter (where revoked_at is null)::int as live from app.device_tokens
      where user_id = ${member.userId}`;
    expect(tokens!.live).toBe(0);
  });

  it("AC F02-6: logout semua lebih dulu, rotasi menunggu lalu kalah → 401 dan tidak ada sesi hidup", async () => {
    const http = client(nextIp());
    const member = await createAlumni(owner, { status: "verified" });
    const victim = await login(http, member);
    const stolen = await login(http, member);
    // Logout semua berhenti di revokeDeviceTokens sambil memegang kunci users FOR UPDATE.
    const gate = await deviceTokenGate(member.userId, null);
    const loggingOut = http.post("/auth/logout-all", {}, victim.access_token);
    await untilLockWaiters(1);
    const refreshing = http.post("/auth/refresh", { refresh_token: stolen.refresh_token });
    await untilLockWaiters(2); // rotasi menunggu kunci users (FOR SHARE vs FOR UPDATE)
    await gate.open();
    const [logoutAll, refreshed] = await Promise.all([loggingOut, refreshing]);
    expect(logoutAll.statusCode).toBe(204);
    expect(refreshed.statusCode).toBe(401);
    expect(await liveSessions(member.userId)).toBe(0);
  });

  it("AC F02-3: pemakaian ulang token lama saat rotasi pencuri berjalan → seluruh keluarga dicabut, audit menghitung baris barunya", async () => {
    const http = client(nextIp());
    const member = await createAlumni(owner, { status: "verified" });
    const r0 = (await login(http, member)).refresh_token;
    const first = await http.post("/auth/refresh", { refresh_token: r0 });
    expect(first.statusCode).toBe(200);
    const r1 = first.json().refresh_token as string;
    const gate = await deviceTokenGate(member.userId, (await sessionRowOf(r1)).id);

    const thief = http.post("/auth/refresh", { refresh_token: r1 });
    await untilLockWaiters(1);
    const replay = http.post("/auth/refresh", { refresh_token: r0 });
    await untilLockWaiters(2);
    await gate.open();
    const [thiefRes, replayRes] = await Promise.all([thief, replay]);

    expect(thiefRes.statusCode).toBe(200);
    expect(replayRes.statusCode).toBe(401);
    const r2 = thiefRes.json().refresh_token as string;
    expect((await sessionRowOf(r2)).revoked_at).not.toBeNull();
    expect(await liveSessions(member.userId)).toBe(0);
    expect((await http.post("/auth/refresh", { refresh_token: r2 })).statusCode).toBe(401);
    const audits = await sql<{ after: { sessions_revoked: number; concurrent: boolean } }[]>`
      select after from app.audit_logs
      where action = 'session.refresh_reuse_detected' and entity_id = ${member.userId}`;
    expect(audits.map((row) => row.after)).toEqual([
      expect.objectContaining({ sessions_revoked: 1, concurrent: false }),
    ]);
  });

  it("kontrak revokeSession: mencabut sesi perangkat lain saat rotasinya berjalan → 204 dan baris hasil rotasi ikut dicabut", async () => {
    const http = client(nextIp());
    const member = await createAlumni(owner, { status: "verified" });
    const mine = await login(http, member);
    const other = await login(http, member);
    const otherRow = await sessionRowOf(other.refresh_token);
    const gate = await deviceTokenGate(member.userId, otherRow.id);

    const refreshing = http.post("/auth/refresh", { refresh_token: other.refresh_token });
    await untilLockWaiters(1);
    const revoking = http.delete(`/auth/sessions/${otherRow.family_id}`, mine.access_token);
    await untilLockWaiters(2);
    await gate.open();
    const [refreshed, revoked] = await Promise.all([refreshing, revoking]);

    expect(refreshed.statusCode).toBe(200);
    expect(revoked.statusCode, revoked.body).toBe(204);
    const rotated = refreshed.json().refresh_token as string;
    expect((await sessionRowOf(rotated)).revoked_at).not.toBeNull();
    expect((await http.post("/auth/refresh", { refresh_token: rotated })).statusCode).toBe(401);
    // Sesi pemanggil tidak tersentuh.
    expect((await http.get("/auth/sessions", mine.access_token)).statusCode).toBe(200);
    expect(await liveSessions(member.userId)).toBe(1);
  });

  it("AC F13-5: logout saat rotasi keluarga yang sama berjalan → baris hasil rotasi ikut dicabut", async () => {
    const http = client(nextIp());
    const member = await createAlumni(owner, { status: "verified" });
    const session = await login(http, member);
    const gate = await deviceTokenGate(member.userId, (await sessionRowOf(session.refresh_token)).id);

    const refreshing = http.post("/auth/refresh", { refresh_token: session.refresh_token });
    await untilLockWaiters(1);
    const loggingOut = http.post("/auth/logout", {}, session.access_token);
    await untilLockWaiters(2);
    await gate.open();
    const [refreshed, logout] = await Promise.all([refreshing, loggingOut]);

    expect(refreshed.statusCode).toBe(200);
    expect(logout.statusCode).toBe(204);
    const rotated = refreshed.json().refresh_token as string;
    expect((await sessionRowOf(rotated)).revoked_at).not.toBeNull();
    expect((await http.post("/auth/refresh", { refresh_token: rotated })).statusCode).toBe(401);
    expect(await liveSessions(member.userId)).toBe(0);
  });
});

describe("AC F02-4: login dengan sandi lama yang sedang berjalan saat sandi diganti", () => {
  it("AC F02-4: reset sandi commit saat login sandi lama menunggu → login 401 generik, tidak ada sesi yang bertahan", async () => {
    const http = client(nextIp());
    const member = await createAlumni(owner, { status: "verified" });
    const forgot = await http.post("/auth/password/forgot", { email: member.email });
    expect(forgot.statusCode).toBe(202);
    // Email kode nyata dikirim tanpa ditunggu (non-enumerasi): tunggu sampai terkirim.
    for (let i = 0; i < 200 && !mailer.last(member.email); i++) await sleep(5);
    const grant = await http.post("/auth/password/forgot/verify", {
      challenge_id: forgot.json().challenge_id,
      code: mailer.last(member.email)!,
    });
    expect(grant.statusCode).toBe(200);

    // Reset berhenti di revokeDeviceTokens sambil memegang users FOR UPDATE (sesi sudah dicabut).
    const gate = await deviceTokenGate(member.userId, null);
    const resetting = http.post("/auth/password/reset", {
      reset_token: grant.json().reset_token,
      new_password: "Baru#Kapdh2026",
    });
    await untilLockWaiters(1);
    // Sandi lama masih tersimpan (reset belum commit): bcrypt login lolos, lalu UPDATE bersyaratnya menunggu.
    const loggingIn = http.post("/auth/login", { email: member.email, password: member.password });
    await untilLockWaiters(2);
    await gate.open();
    const [reset, login] = await Promise.all([resetting, loggingIn]);

    expect(reset.statusCode).toBe(204);
    expect(login.statusCode).toBe(401);
    expect(login.json()).toMatchObject({ code: "UNAUTHENTICATED", message: "Email atau password salah." });
    expect(await liveSessions(member.userId)).toBe(0);
    limits.clear();
    expect(
      (await http.post("/auth/login", { email: member.email, password: "Baru#Kapdh2026" })).json().next,
    ).toBe("home");
  });

  it("AC F02-4: ganti sandi commit saat login sandi lama menunggu → login 401, hanya sesi pengganti yang hidup", async () => {
    const http = client(nextIp());
    const member = await createAlumni(owner, { status: "verified" });
    const mine = await login(http, member);
    const other = await login(http, member);
    // Ganti sandi berhenti di revokeDeviceTokens (token perangkat lain) sambil memegang users FOR UPDATE.
    const gate = await deviceTokenGate(member.userId, (await sessionRowOf(other.refresh_token)).id);
    const changing = http.post(
      "/auth/password/change",
      { current_password: member.password, new_password: "Ganti#Kapdh2026" },
      mine.access_token,
    );
    await untilLockWaiters(1);
    const loggingIn = http.post("/auth/login", { email: member.email, password: member.password });
    await untilLockWaiters(2);
    await gate.open();
    const [change, loginRes] = await Promise.all([changing, loggingIn]);

    expect(change.statusCode).toBe(204);
    expect(loginRes.statusCode).toBe(401);
    expect(loginRes.json()).toMatchObject({ code: "UNAUTHENTICATED", message: "Email atau password salah." });
    // Hanya keluarga sesi yang mengganti sandi yang tetap hidup.
    expect(await liveSessions(member.userId)).toBe(1);
    expect((await http.get("/auth/sessions", mine.access_token)).statusCode).toBe(200);
  });
});
