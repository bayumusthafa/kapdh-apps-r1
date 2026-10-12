import { accountDeletions, users } from "@kapdh/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { totp } from "../../src/modules/auth/crypto.js";
import {
  accessMismatches,
  ajv,
  expectOperation,
  expectSchema,
  type InjectResponse,
  registeredRoutes,
  routesMissingFromContract,
} from "../support/contract.js";
import {
  createAdmin,
  createAlumni,
  publishLegalVersions,
  TEST_CONSENT_VERSION,
} from "../support/factories.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestClock } from "../support/test-app.js";

/**
 * Respons nyata API harus cocok dengan kontrak packages/contracts (PRD 7.2: kontrak lebih dulu; N-13). Validasi
 * memakai test/support/contract.ts (expectOperation) yang juga dipakai tes setiap modul (ARCHITECTURE §9.1).
 */

let app: NestFastifyApplication;
let db: Db;
let mailer: MemoryMailer;
let clock: TestClock;

beforeAll(async () => {
  const t = await createTestApp();
  ({ app, db, mailer, clock } = t);
  await publishLegalVersions(t);
});
afterAll(async () => {
  await app.close();
});

const PASSWORD = "Kapdh#2026";
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload: payload as object, headers });
const get = (url: string, token?: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("kontrak dan rute terdaftar (ARCHITECTURE §6)", () => {
  it("setiap rute Fastify yang terdaftar ada di kontrak", () => {
    const fastify = app.getHttpAdapter().getInstance();
    const routes = registeredRoutes(fastify.printRoutes({ commonPrefix: false }));
    // Pengaman parser: rute yang pasti ada harus terbaca dan benar-benar terdaftar.
    expect(routes).toContainEqual({ method: "POST", url: "/api/v1/auth/register" });
    expect(routes).toContainEqual({ method: "GET", url: "/api/v1/health" });
    for (const r of routes) {
      if (r.url !== "*")
        expect(fastify.hasRoute({ method: r.method as "GET", url: r.url }), r.url).toBe(true);
    }

    // HEAD otomatis untuk setiap GET dan OPTIONS * untuk preflight CORS bukan operasi API.
    expect(
      routesMissingFromContract(routes),
      "rute tanpa operasi kontrak; tambahkan ke openapi/domains/<domain>.yaml",
    ).toEqual([]);
  });

  it("dekorator akses server cocok dengan x-kapdh-access kontrak bila dideklarasikan (ARCHITECTURE §4.3)", () => {
    expect(accessMismatches(routeAccessList(app))).toEqual([]);
  });

  it("pembanding x-kapdh-access mendeteksi setiap perbedaan deklarasi", () => {
    const meta = {
      isPublic: false,
      audience: "mobile",
      memberAccess: "active",
      permissions: [],
      permissionsAny: [],
      role: null,
      reauth: false,
    };
    const route = { name: "Uji.handler", method: "post", path: "/uji/{id}", meta, idempotent: false };
    const paths = {
      "/uji/{itemId}": {
        post: {
          "x-kapdh-access": {
            audience: "admin",
            permissions: ["payments.read"],
            permissions_any: ["members.read", "master.manage"],
            role: "super_admin",
            reauth: true,
            idempotent: true,
          },
        },
      },
      "/tanpa-anotasi": { post: {} },
    };
    // audience, member_access, permissions, permissions_any, role, reauth, idempotent.
    expect(accessMismatches([route], paths)).toHaveLength(7);
    const adminRoute = {
      ...route,
      meta: {
        ...meta,
        audience: "admin",
        memberAccess: null,
        permissionsAny: ["master.manage", "members.read"],
      },
    };
    expect(
      accessMismatches([adminRoute], {
        "/uji/{x}": {
          post: {
            "x-kapdh-access": { audience: "admin", permissions_any: ["members.read", "master.manage"] },
          },
        },
      }),
    ).toEqual([]);
    const same = { audience: "mobile", member_access: "active" };
    expect(accessMismatches([route], { "/uji/{x}": { post: { "x-kapdh-access": same } } })).toEqual([]);
    expect(accessMismatches([{ ...route, path: "/tanpa-anotasi" }], paths)).toEqual([]);
  });

  it("rute yang belum ada di kontrak terdeteksi", () => {
    expect(
      routesMissingFromContract([
        { method: "GET", url: "/api/v1/me" },
        { method: "POST", url: "/api/v1/belum-ada/:id" },
        { method: "GET", url: "/di-luar" },
        { method: "HEAD", url: "/api/v1/me" },
      ]),
    ).toEqual(["POST /api/v1/belum-ada/:id", "GET /di-luar (di luar /api/v1)"]);
  });

  it("expectOperation menolak status 2xx yang tidak dideklarasikan", () => {
    const fake: InjectResponse = { statusCode: 202, headers: {}, body: "{}", json: () => ({}) };
    expect(() => expectOperation("get", "/me", fake)).toThrow(/status 2xx tidak dideklarasikan/);
  });

  it("validator menolak bentuk yang menyimpang dari kontrak", () => {
    const validate = ajv.getSchema("kapdh#/components/schemas/LoginResponse")!;
    expect(validate({ next: "dashboard" })).toBe(false);
    expect(ajv.getSchema("kapdh#/components/schemas/OtpChallenge")!({ challenge_id: "bukan-uuid" })).toBe(
      false,
    );
    const fake: InjectResponse = {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: "{}",
      json: () => ({ min_app_version: { android: "1.0.0" } }),
    };
    expect(() => expectOperation("get", "/public/config", fake)).toThrow();
  });
});

describe("kesesuaian kontrak OpenAPI endpoint publik", () => {
  it("GET /health dan GET /public/config", async () => {
    expectOperation("get", "/health", await get("/health"));
    expectOperation("get", "/public/config", await get("/public/config"));
  });
});

describe("kesesuaian kontrak OpenAPI irisan Auth", () => {
  it("alur alumni: register, verify, login, refresh, me, logout", async () => {
    const email = "kontrak@contoh.id";
    const body = {
      full_name: "Ahmad Islam",
      gender: "male",
      email,
      password: PASSWORD,
      cohort: 29,
      class_in: 1,
      class_out: 6,
      accept_policy_version: TEST_CONSENT_VERSION,
    };
    const reg = await post("/auth/register", body);
    expect(reg.statusCode).toBe(201);
    expectOperation("post", "/auth/register", reg);
    expectSchema("OtpChallenge", reg.json());

    const resendTooSoon = await post("/auth/otp/resend", { challenge_id: reg.json().challenge_id });
    expect(resendTooSoon.statusCode).toBe(429);
    expectOperation("post", "/auth/otp/resend", resendTooSoon);

    const bad = await post("/auth/otp/verify", {
      challenge_id: reg.json().challenge_id,
      code: mailer.last(email) === "000000" ? "111111" : "000000",
    });
    expect(bad.statusCode).toBe(400);
    expectOperation("post", "/auth/otp/verify", bad);

    const ver = await post("/auth/otp/verify", {
      challenge_id: reg.json().challenge_id,
      code: mailer.last(email)!,
    });
    expect(ver.statusCode).toBe(200);
    expectOperation("post", "/auth/otp/verify", ver);
    expectSchema("OtpVerifyResponse", ver.json());

    const login = await post("/auth/login", { email, password: PASSWORD });
    expect(login.statusCode).toBe(200);
    expectOperation("post", "/auth/login", login);
    expectSchema("LoginResponse", login.json());

    const wrong = await post("/auth/login", { email, password: "Salah#2026" });
    expect(wrong.statusCode).toBe(401);
    expectOperation("post", "/auth/login", wrong);

    const ref = await post("/auth/refresh", { refresh_token: login.json().session.refresh_token });
    expect(ref.statusCode).toBe(200);
    expectOperation("post", "/auth/refresh", ref);
    expectSchema("TokenPair", ref.json());

    const me = await get("/me", ref.json().access_token);
    expect(me.statusCode).toBe(200);
    expectOperation("get", "/me", me);
    expectSchema("Me", me.json());

    const anonymous = await get("/me");
    expect(anonymous.statusCode).toBe(401);
    expectOperation("get", "/me", anonymous);

    const invalid = await post("/auth/register", { ...body, email: "x" });
    expect(invalid.statusCode).toBe(400);
    expectOperation("post", "/auth/register", invalid);

    // F-01: versi persetujuan usang → 409 VERSION_CONFLICT dengan LegalConsentVersions terkini.
    const stale = await post("/auth/register", {
      ...body,
      email: "kontrak-usang@contoh.id",
      accept_policy_version: "privacy:1;terms:9",
    });
    expect(stale.statusCode).toBe(409);
    expectOperation("post", "/auth/register", stale);
    expect(stale.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { policy_version: TEST_CONSENT_VERSION },
    });
    expectSchema("LegalConsentVersions", stale.json().current);

    const logout = await post("/auth/logout", {}, { authorization: `Bearer ${ref.json().access_token}` });
    expect(logout.statusCode).toBe(204);
    expectOperation("post", "/auth/logout", logout);
  });

  it("login akun pending_otp mengembalikan next verify_otp dengan challenge", async () => {
    const email = "kontrak2@contoh.id";
    await post("/auth/register", {
      full_name: "Siti",
      gender: "female",
      email,
      password: PASSWORD,
      cohort: 20,
      class_in: 1,
      class_out: 3,
      accept_policy_version: TEST_CONSENT_VERSION,
    });
    clock.advance(61_000);
    const login = await post("/auth/login", { email, password: PASSWORD });
    expect(login.json().next).toBe("verify_otp");
    expectOperation("post", "/auth/login", login);
    expectSchema("LoginResponse", login.json());
  });

  it("login akun deletion_pending dan disabled: next tanpa sesi sesuai kontrak (PRD 2.2, F-14)", async () => {
    const pending = await createAlumni({ db, clock }, { status: "verified", password: PASSWORD });
    const now = clock.now();
    await db.update(users).set({ status: "deletion_pending" }).where(eq(users.id, pending.userId));
    await db.insert(accountDeletions).values({
      id: uuidv7(),
      requestNumber: "DEL-2026-UJI1",
      userId: pending.userId,
      source: "app",
      requestedAt: now,
      deadlineAt: new Date(now.getTime() + 7 * 24 * 3600_000),
      createdAt: now,
      updatedAt: now,
    });
    const deletion = await post("/auth/login", { email: pending.email, password: PASSWORD });
    expect(deletion.statusCode).toBe(200);
    expectOperation("post", "/auth/login", deletion);
    expect(deletion.json()).toMatchObject({
      next: "deletion_pending",
      deletion: { request_number: "DEL-2026-UJI1", status: "pending", source: "app", completed_at: null },
    });
    expect(deletion.json().session).toBeUndefined();

    const disabled = await createAlumni({ db, clock }, { status: "verified", password: PASSWORD });
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, disabled.userId));
    const off = await post("/auth/login", { email: disabled.email, password: PASSWORD });
    expect(off.statusCode).toBe(200);
    expectOperation("post", "/auth/login", off);
    expect(off.json()).toEqual({ next: "account_disabled" });
  });

  it("alur admin: login, mfa, me", async () => {
    const admin = await createAdmin({ db, clock }, { role: "super_admin", password: PASSWORD });

    const login = await post("/admin/auth/login", { email: admin.email, password: PASSWORD });
    expect(login.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/login", login);
    expect(login.json().totp_enrollment_required).toBe(false);
    // Kode salah = galat formulir 400 dengan field_errors dan sisa percobaan (kontrak adminVerifyMfa).
    const wrongCode = await post("/admin/auth/mfa", {
      mfa_token: login.json().mfa_token,
      totp_code: totp(admin.totpSecret, new Date(clock.now().getTime() + 10 * 60_000)),
    });
    expect(wrongCode.statusCode).toBe(400);
    expectOperation("post", "/admin/auth/mfa", wrongCode);
    expect(wrongCode.json().field_errors.totp_code[0]).toContain("Sisa percobaan 4");
    const badToken = await post("/admin/auth/mfa", { mfa_token: "bukan.token.mfa", totp_code: "123456" });
    expect(badToken.statusCode).toBe(401);
    expectOperation("post", "/admin/auth/mfa", badToken);
    const mfa = await post("/admin/auth/mfa", {
      mfa_token: login.json().mfa_token,
      totp_code: totp(admin.totpSecret, clock.now()),
    });
    expect(mfa.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/mfa", mfa);
    expectSchema("AdminSession", mfa.json());
    expect(String(mfa.headers["set-cookie"])).toContain("Path=/api/v1/auth");

    const me = await get("/admin/me", mfa.json().access_token);
    expect(me.statusCode).toBe(200);
    expectOperation("get", "/admin/me", me);
    expectSchema("AdminProfile", me.json());
    // Field yang wajib dikirim server walau skema masih opsional (deskripsi AdminProfile).
    expect(me.json()).toMatchObject({
      email: admin.email,
      has_linked_alumni: false,
      backup_codes_remaining: expect.any(Number),
      previous_login_at: null,
    });

    const forbidden = await get("/admin/me", login.json().mfa_token);
    expect(forbidden.statusCode).toBe(403);
    expectOperation("get", "/admin/me", forbidden);
  });
});
