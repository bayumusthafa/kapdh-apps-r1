import { admins, auditLogs, mfaTotp, users } from "@kapdh/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret, newTotpSecret, totp } from "../src/auth/crypto.js";
import type { Db } from "../src/infra/db.js";
import type { MemoryMailer } from "../src/infra/mailer.js";
import { createTestApp, type TestClock, testEnv } from "./support/test-app.js";

let app: NestFastifyApplication;
let db: Db;
let mailer: MemoryMailer;
let clock: TestClock;

beforeAll(async () => {
  ({ app, db, mailer, clock } = await createTestApp());
});
afterAll(async () => {
  await app.close();
});

const PASSWORD = "Kapdh#2026";
let emailSeq = 0;
const newEmail = () => `alumni${++emailSeq}@contoh.id`;

function registerBody(email: string, overrides: Record<string, unknown> = {}) {
  return {
    full_name: "Ahmad Islam",
    gender: "male",
    email,
    password: PASSWORD,
    cohort: 29,
    class_in: 1,
    class_out: 6,
    accept_policy_version: "2026-10",
    ...overrides,
  };
}

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload: payload as object, headers });
const get = (url: string, token: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: "GET",
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });

async function registerAndVerify(email = newEmail()) {
  const reg = await post("/auth/register", registerBody(email));
  const code = mailer.last(email)!;
  const ver = await post("/auth/otp/verify", { challenge_id: reg.json().challenge_id, code });
  return { email, session: ver.json().session as { access_token: string; refresh_token: string } };
}

describe("F-01 registrasi dan verifikasi email", () => {
  it("AC F01-1: satu akun pending_otp dibuat dan kode tidak dikirim ke klien", async () => {
    const email = newEmail();
    const res = await post("/auth/register", registerBody(email));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.challenge_id).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(mailer.last(email)!);
    expect(body.attempts_left).toBe(5);
    const rows = await db.select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending_otp");
  });

  it("menolak sandi yang tidak memenuhi aturan dan kelas keluar sebelum kelas masuk", async () => {
    const res = await post(
      "/auth/register",
      registerBody(newEmail(), { password: "kapdh2026", class_in: 5, class_out: 3 }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(Object.keys(res.json().field_errors)).toEqual(expect.arrayContaining(["password", "class_out"]));
  });

  it("menolak angkatan melebihi angkatan terbaru", async () => {
    const res = await post("/auth/register", registerBody(newEmail(), { cohort: 31 }));
    expect(res.statusCode).toBe(400);
  });

  it("AC F01-2: OTP benar mengaktifkan akun, mengalokasikan nomor anggota, dan KTA belum aktif", async () => {
    const { email, session } = await registerAndVerify();
    expect(session.access_token).toBeTruthy();
    expect(session.refresh_token).toBeTruthy();
    const me = await get("/me", session.access_token);
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(email);
    expect(me.json().effective_status).toBe("unverified");
    expect(me.json().member_number).toMatch(/^29\.01\.01\.[1-9]\d*$/);
    expect(me.json().profile).toMatchObject({
      graduation_year: 2025,
      entry_year: 2019,
      exit_year: 2025,
      education_status: "01",
    });
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "account.activated"));
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it("nomor urut berbeda untuk setiap anggota dan tidak pernah sama", async () => {
    const a = await registerAndVerify();
    const b = await registerAndVerify();
    const na = (await get("/me", a.session.access_token)).json().member_number as string;
    const nb = (await get("/me", b.session.access_token)).json().member_number as string;
    expect(na.split(".")[3]).not.toBe(nb.split(".")[3]);
  });

  it("AC F01-3: lima kode salah membuat challenge tidak berlaku", async () => {
    const email = newEmail();
    const { challenge_id } = (await post("/auth/register", registerBody(email))).json();
    const right = mailer.last(email)!;
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 4; i++) {
      const r = await post("/auth/otp/verify", { challenge_id, code: wrong });
      expect(r.statusCode).toBe(400);
      expect(r.json().message).toContain(`Sisa percobaan ${5 - i}`);
    }
    expect((await post("/auth/otp/verify", { challenge_id, code: wrong })).statusCode).toBe(410);
    const after = await post("/auth/otp/verify", { challenge_id, code: right });
    expect(after.statusCode).toBe(410);
    expect(after.json().code).toBe("OTP_EXPIRED");
  });

  it("AC F01-3: kode kedaluwarsa setelah 10 menit", async () => {
    const email = newEmail();
    const { challenge_id } = (await post("/auth/register", registerBody(email))).json();
    clock.advance(10 * 60_000 + 1);
    expect((await post("/auth/otp/verify", { challenge_id, code: mailer.last(email)! })).statusCode).toBe(
      410,
    );
  });

  it("AC F01-3: kirim ulang mematuhi cooldown 60 detik dan membatalkan kode lama", async () => {
    const email = newEmail();
    const first = (await post("/auth/register", registerBody(email))).json();
    const oldCode = mailer.last(email)!;
    const early = await post("/auth/otp/resend", { challenge_id: first.challenge_id });
    expect(early.statusCode).toBe(429);
    expect(early.json().retry_after_seconds).toBeGreaterThan(0);
    clock.advance(61_000);
    const second = await post("/auth/otp/resend", { challenge_id: first.challenge_id });
    expect(second.statusCode).toBe(200);
    expect(
      (await post("/auth/otp/verify", { challenge_id: first.challenge_id, code: oldCode })).statusCode,
    ).toBe(410);
    expect(
      (
        await post("/auth/otp/verify", {
          challenge_id: second.json().challenge_id,
          code: mailer.last(email)!,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("AC F01-4: registrasi ulang tidak membuat akun ganda dan challenge lama batal", async () => {
    const email = newEmail();
    const first = (await post("/auth/register", registerBody(email))).json();
    clock.advance(61_000);
    const second = (await post("/auth/register", registerBody(email, { password: "Lain#2026x" }))).json();
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(1);
    expect(second.challenge_id).not.toBe(first.challenge_id);
    // Pemilik challenge pertama tidak bisa mengaktifkan akun dengan sandi yang sudah diganti (pre-account hijacking).
    expect(
      (await post("/auth/otp/verify", { challenge_id: first.challenge_id, code: "123456" })).statusCode,
    ).toBe(410);
  });

  it("email yang sudah aktif ditolak dengan 409", async () => {
    const { email } = await registerAndVerify();
    const res = await post("/auth/register", registerBody(email));
    expect(res.statusCode).toBe(409);
  });
});

describe("F-02 login, refresh, dan sesi", () => {
  it("login akun pending_otp diarahkan ke verifikasi tanpa token", async () => {
    const email = newEmail();
    await post("/auth/register", registerBody(email));
    const res = await post("/auth/login", { email, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().next).toBe("verify_otp");
    expect(res.json().session).toBeUndefined();
  });

  it("AC F02-1: login valid menerbitkan access token 15 menit", async () => {
    const { email } = await registerAndVerify();
    const res = await post("/auth/login", { email: email.toUpperCase(), password: PASSWORD });
    expect(res.json().next).toBe("home");
    const s = res.json().session;
    const ttl = new Date(s.access_expires_at).getTime() - clock.now().getTime();
    // exp JWT dibulatkan ke detik
    expect(ttl).toBeGreaterThan(15 * 60_000 - 1000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    clock.advance(15 * 60_000 + 1000);
    expect((await get("/me", s.access_token)).statusCode).toBe(401);
  });

  it("sandi salah tidak membedakan email terdaftar atau tidak", async () => {
    const { email } = await registerAndVerify();
    const a = await post("/auth/login", { email, password: "Salah#2026" });
    const b = await post("/auth/login", { email: "tidakada@contoh.id", password: "Salah#2026" });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().message).toBe(b.json().message);
  });

  it("10 kegagalan login dalam 15 menit memicu cooldown", async () => {
    const { email } = await registerAndVerify();
    for (let i = 0; i < 10; i++) await post("/auth/login", { email, password: "Salah#2026" });
    const blocked = await post("/auth/login", { email, password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    clock.advance(15 * 60_000 + 1000);
    expect((await post("/auth/login", { email, password: PASSWORD })).statusCode).toBe(200);
  });

  it("AC F02-3: refresh berotasi; refresh token lama dipakai ulang mencabut seluruh keluarga sesi", async () => {
    const { session } = await registerAndVerify();
    const r1 = await post("/auth/refresh", { refresh_token: session.refresh_token });
    expect(r1.statusCode).toBe(200);
    const newPair = r1.json();
    expect(newPair.refresh_token).not.toBe(session.refresh_token);

    const reuse = await post("/auth/refresh", { refresh_token: session.refresh_token });
    expect(reuse.statusCode).toBe(401);
    // Token hasil rotasi ikut dicabut.
    expect((await post("/auth/refresh", { refresh_token: newPair.refresh_token })).statusCode).toBe(401);
    expect((await get("/me", newPair.access_token)).statusCode).toBe(401);
  });

  it("AC F02-6: keluar semua perangkat membuat access token lama ditolak", async () => {
    const { email, session } = await registerAndVerify();
    const other = (await post("/auth/login", { email, password: PASSWORD })).json().session;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout-all",
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    expect(res.statusCode).toBe(204);
    expect((await get("/me", session.access_token)).statusCode).toBe(401);
    expect((await get("/me", other.access_token)).statusCode).toBe(401);
    expect((await post("/auth/refresh", { refresh_token: other.refresh_token })).statusCode).toBe(401);
  });

  it("logout mencabut sesi saat ini", async () => {
    const { session } = await registerAndVerify();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    expect((await get("/me", session.access_token)).statusCode).toBe(401);
  });
});

describe("F-02 admin dengan TOTP", () => {
  const adminEmail = "admin@kapdh.test";
  let secret: string;

  beforeAll(async () => {
    secret = newTotpSecret();
    const userId = uuidv7();
    await db.insert(users).values({
      id: userId,
      email: adminEmail,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      status: "active",
      kind: "admin",
    });
    await db
      .insert(admins)
      .values({ id: uuidv7(), userId, displayName: "Bayu Musthafa", role: "super_admin" });
    await db.insert(mfaTotp).values({
      userId,
      secretEncrypted: encryptSecret(secret, testEnv.TOTP_ENC_KEY),
      verifiedAt: new Date(),
    });
  });

  async function adminSession() {
    const login = (await post("/admin/auth/login", { email: adminEmail, password: PASSWORD })).json();
    const res = await post("/admin/auth/mfa", {
      mfa_token: login.mfa_token,
      totp_code: totp(secret, clock.now()),
    });
    return { body: res.json(), cookie: String(res.headers["set-cookie"] ?? "") };
  }

  it("AC F02-2: token tahap sandi tidak bisa memanggil API admin", async () => {
    const login = await post("/admin/auth/login", { email: adminEmail, password: PASSWORD });
    expect(login.statusCode).toBe(200);
    const res = await get("/admin/me", login.json().mfa_token);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("MFA_REQUIRED");
  });

  it("akun admin tidak bisa masuk lewat login alumni, dan sebaliknya", async () => {
    expect((await post("/auth/login", { email: adminEmail, password: PASSWORD })).statusCode).toBe(401);
    const { email } = await registerAndVerify();
    expect((await post("/admin/auth/login", { email, password: PASSWORD })).statusCode).toBe(401);
  });

  it("TOTP benar menerbitkan sesi admin, cookie HttpOnly, dan izin efektif", async () => {
    const { body, cookie } = await adminSession();
    expect(body.idle_timeout_seconds).toBe(1800);
    expect(cookie).toContain("kapdh_admin_rt=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const me = await get("/admin/me", body.access_token);
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe("super_admin");
    expect(me.json().permissions).toContain("payments.decide");
  });

  it("TOTP salah ditolak", async () => {
    const login = (await post("/admin/auth/login", { email: adminEmail, password: PASSWORD })).json();
    const wrong = totp(secret, new Date(clock.now().getTime() + 10 * 60_000));
    expect((await post("/admin/auth/mfa", { mfa_token: login.mfa_token, totp_code: wrong })).statusCode).toBe(
      401,
    );
  });

  it("token admin tidak bisa memanggil endpoint anggota", async () => {
    const { body } = await adminSession();
    expect((await get("/me", body.access_token)).statusCode).toBe(403);
  });

  it("AC F02-5: sesi admin berakhir setelah idle 30 menit; polling latar tidak memperpanjang", async () => {
    const { body } = await adminSession();
    clock.advance(20 * 60_000);
    // Permintaan latar tidak dihitung aktivitas.
    expect((await get("/admin/me", body.access_token, { "x-background-request": "1" })).statusCode).toBe(401);
    // Access token 15 menit sudah habis pada titik ini; uji idle memakai token baru.
    const fresh = await adminSession();
    clock.advance(10 * 60_000);
    expect(
      (await get("/admin/me", fresh.body.access_token, { "x-background-request": "1" })).statusCode,
    ).toBe(200);
    clock.advance(4 * 60_000);
    expect(
      (await get("/admin/me", fresh.body.access_token, { "x-background-request": "1" })).statusCode,
    ).toBe(200);
    clock.advance(17 * 60_000);
    const res = await get("/admin/me", fresh.body.access_token);
    expect(res.statusCode).toBe(401);
  });

  it("refresh admin lewat cookie wajib Origin web admin", async () => {
    const { cookie } = await adminSession();
    const token = /kapdh_admin_rt=([^;]+)/.exec(cookie)![1]!;
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { kapdh_admin_rt: token },
      headers: { origin: "https://evil.example" },
    });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { kapdh_admin_rt: token },
      headers: { origin: testEnv.ADMIN_ORIGIN },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().refresh_token).toBeUndefined();
    expect(String(ok.headers["set-cookie"])).toContain("kapdh_admin_rt=");
  });
});
