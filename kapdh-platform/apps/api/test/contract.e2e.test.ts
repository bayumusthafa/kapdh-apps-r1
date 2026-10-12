import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { admins, mfaTotp, users } from "@kapdh/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import bcrypt from "bcryptjs";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { encryptSecret, newTotpSecret, totp } from "../src/auth/crypto.js";
import type { Db } from "../src/infra/db.js";
import type { MemoryMailer } from "../src/infra/mailer.js";
import { createTestApp, type TestClock, testEnv } from "./support/test-app.js";

/**
 * Respons nyata API harus cocok dengan skema di packages/contracts (PRD 7.2: kontrak lebih dulu).
 * Klien web admin dan Flutter memakai tipe yang dibangkitkan dari kontrak yang sama.
 */
const specPath = fileURLToPath(new URL("../../../packages/contracts/openapi/openapi.yaml", import.meta.url));
const spec = parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats CJS: di ESM fungsi bisa berada di `default` atau langsung sebagai modul.
type AddFormats = (a: Ajv2020) => void;
const addFormats = ((addFormatsModule as unknown as { default?: AddFormats }).default ??
  addFormatsModule) as unknown as AddFormats;
addFormats(ajv);
ajv.addSchema({ ...spec, $id: "kapdh" });

function expectSchema(name: string, body: unknown) {
  const validate = ajv.getSchema(`kapdh#/components/schemas/${name}`)!;
  const ok = validate(body);
  expect(ok, `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

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
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload: payload as object, headers });
const get = (url: string, token: string) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

describe("kesesuaian kontrak OpenAPI irisan Auth", () => {
  it("validator menolak bentuk yang menyimpang dari kontrak", () => {
    const validate = ajv.getSchema("kapdh#/components/schemas/LoginResponse")!;
    expect(validate({ next: "dashboard" })).toBe(false);
    expect(ajv.getSchema("kapdh#/components/schemas/OtpChallenge")!({ challenge_id: "bukan-uuid" })).toBe(
      false,
    );
  });

  it("alur alumni: register, verify, login, refresh, me", async () => {
    const email = "kontrak@contoh.id";
    const body = {
      full_name: "Ahmad Islam",
      gender: "male",
      email,
      password: PASSWORD,
      cohort: 29,
      class_in: 1,
      class_out: 6,
      accept_policy_version: "2026-10",
    };
    const reg = await post("/auth/register", body);
    expect(reg.statusCode).toBe(201);
    expectSchema("OtpChallenge", reg.json());

    const resendTooSoon = await post("/auth/otp/resend", { challenge_id: reg.json().challenge_id });
    expect(resendTooSoon.statusCode).toBe(429);
    expectSchema("Error", resendTooSoon.json());

    const bad = await post("/auth/otp/verify", {
      challenge_id: reg.json().challenge_id,
      code: mailer.last(email) === "000000" ? "111111" : "000000",
    });
    expect(bad.statusCode).toBe(400);
    expectSchema("Error", bad.json());

    const ver = await post("/auth/otp/verify", {
      challenge_id: reg.json().challenge_id,
      code: mailer.last(email)!,
    });
    expect(ver.statusCode).toBe(200);
    expectSchema("OtpVerifyResponse", ver.json());

    const login = await post("/auth/login", { email, password: PASSWORD });
    expectSchema("LoginResponse", login.json());

    const ref = await post("/auth/refresh", { refresh_token: login.json().session.refresh_token });
    expect(ref.statusCode).toBe(200);
    expectSchema("TokenPair", ref.json());

    const me = await get("/me", ref.json().access_token);
    expect(me.statusCode).toBe(200);
    expectSchema("Me", me.json());

    const invalid = await post("/auth/register", { ...body, email: "x" });
    expect(invalid.statusCode).toBe(400);
    expectSchema("Error", invalid.json());
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
      accept_policy_version: "2026-10",
    });
    clock.advance(61_000);
    const login = await post("/auth/login", { email, password: PASSWORD });
    expect(login.json().next).toBe("verify_otp");
    expectSchema("LoginResponse", login.json());
  });

  it("alur admin: login, mfa, me", async () => {
    const secret = newTotpSecret();
    const userId = uuidv7();
    await db.insert(users).values({
      id: userId,
      email: "kontrak-admin@kapdh.test",
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

    const login = await post("/admin/auth/login", { email: "kontrak-admin@kapdh.test", password: PASSWORD });
    expect(login.statusCode).toBe(200);
    const mfa = await post("/admin/auth/mfa", {
      mfa_token: login.json().mfa_token,
      totp_code: totp(secret, clock.now()),
    });
    expect(mfa.statusCode).toBe(200);
    expectSchema("AdminSession", mfa.json());
    expect(String(mfa.headers["set-cookie"])).toContain("Path=/api/v1/auth");

    const me = await get("/admin/me", mfa.json().access_token);
    expect(me.statusCode).toBe(200);
    expectSchema("AdminProfile", me.json());

    const forbidden = await get("/admin/me", login.json().mfa_token);
    expect(forbidden.statusCode).toBe(403);
    expectSchema("Error", forbidden.json());
  });
});
