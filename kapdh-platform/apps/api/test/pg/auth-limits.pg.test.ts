/**
 * Batas kegagalan login dan TOTP di bawah konkurensi nyata PostgreSQL 17 (PRD 2.5 / D1, AC F02-2; ARCHITECTURE §2
 * butir 11). Jatah kegagalan dicadangkan ATOMIK sebelum bcrypt/TOTP dinilai (PasswordVerifier,
 * RateLimitService.reserve), sehingga N permintaan paralel di atas batas menilai TEPAT `limit` percobaan; sisanya 429
 * tanpa pernah menyentuh sandi atau kode. Pola lama (peek → nilai → hit) meloloskan semuanya.
 * API berjalan dengan login role kapdh_app (grant production).
 */
import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { totp } from "../../src/core/identity/crypto.js";
import { MemoryRateLimitStore } from "../../src/core/rate-limit/store.js";
import { createAdmin, createAlumni } from "../support/factories.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, createPgTestDatabase, type PgTestDatabase } from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
const clock = new TestClock();
const limits = new MemoryRateLimitStore();
let owner: { db: Db; clock: TestClock };

beforeAll(async () => {
  tdb = await createPgTestDatabase("auth_limits", 8);
  api = connectAs(tdb, "kapdh_app", 12);
  owner = { db: tdb.db as unknown as Db, clock };
  app = await createApp(
    {
      env: testEnv,
      db: api.db as unknown as Db,
      mailer: new MemoryMailer(),
      clock,
      push: new FakePush(),
      redis: null,
    },
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

const post = (url: string, payload: object, remoteAddress = "198.51.100.10") =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload, remoteAddress });

function tally(statuses: { statusCode: number; json(): { code?: string } }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const res of statuses) {
    const key = `${res.statusCode}:${res.json().code ?? "ok"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("PRD 2.5 / D1: kegagalan login paralel dibatasi tepat 10 per email", () => {
  it("40 POST /auth/login paralel dengan sandi salah: 10 dinilai (401), 30 ditolak 429", async () => {
    limits.clear();
    const member = await createAlumni(owner, { status: "verified" });
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        post("/auth/login", { email: member.email, password: `Salah#2026-${i}` }),
      ),
    );
    expect(tally(responses)).toEqual({ "401:UNAUTHENTICATED": 10, "429:RATE_LIMITED": 30 });
    // Sandi benar pun ditolak selama cooldown (tidak ada tebakan ke-11).
    expect((await post("/auth/login", { email: member.email, password: member.password })).statusCode).toBe(
      429,
    );
  });

  it("40 POST /admin/auth/login paralel dengan sandi salah: 10 dinilai (401), 30 ditolak 429", async () => {
    limits.clear();
    const admin = await createAdmin(owner, { role: "super_admin" });
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        post("/admin/auth/login", { email: admin.email, password: `Salah#2026-${i}` }, "198.51.100.11"),
      ),
    );
    expect(tally(responses)).toEqual({ "401:UNAUTHENTICATED": 10, "429:RATE_LIMITED": 30 });
  });
});

describe("AC F02-2 (kontrak adminVerifyMfa): tebakan TOTP paralel dibatasi tepat 5 per admin", () => {
  it("40 POST /admin/auth/mfa paralel dengan kode salah berbeda: 5 dinilai (400), 35 ditolak 429", async () => {
    limits.clear();
    const admin = await createAdmin(owner, { role: "super_admin" });
    const login = await post(
      "/admin/auth/login",
      { email: admin.email, password: admin.password },
      "198.51.100.12",
    );
    expect(login.statusCode).toBe(200);
    const mfaToken = login.json().mfa_token as string;
    const valid = totp(admin.totpSecret, clock.now());
    // Kode salah yang pasti tidak cocok dengan langkah -1, 0, +1 (toleransi jam RFC 6238).
    const accepted = new Set(
      [-30_000, 0, 30_000].map((offset) => totp(admin.totpSecret, new Date(clock.now().getTime() + offset))),
    );
    const wrongCodes: string[] = [];
    for (let n = Number(valid) + 1; wrongCodes.length < 40; n++) {
      const code = String(n % 1_000_000).padStart(6, "0");
      if (!accepted.has(code)) wrongCodes.push(code);
    }
    const responses = await Promise.all(
      wrongCodes.map((code) =>
        post("/admin/auth/mfa", { mfa_token: mfaToken, totp_code: code }, "198.51.100.12"),
      ),
    );
    expect(tally(responses)).toEqual({ "400:VALIDATION_ERROR": 5, "429:RATE_LIMITED": 35 });
    // Kode benar pun ditolak sampai jendela 15 menit berlalu (tidak ada tebakan ke-6).
    const correct = await post("/admin/auth/mfa", { mfa_token: mfaToken, totp_code: valid }, "198.51.100.12");
    expect(correct.statusCode).toBe(429);
  });
});
