import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
 * Respons nyata API harus cocok dengan kontrak packages/contracts (PRD 7.2: kontrak lebih dulu; N-13).
 * Kontrak dibaca dari bundle dist/openapi.yaml (root.yaml + domains/*.yaml, ARCHITECTURE §6) yang dibangun
 * `pnpm --filter @kapdh/contracts bundle` (turbo menjalankan build dependensi sebelum test).
 */
type HttpMethod = "get" | "put" | "post" | "delete" | "patch";
type JsonObject = Record<string, unknown>;
interface InjectResponse {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json(): unknown;
}

const require = createRequire(import.meta.url);
const specPath = require.resolve("@kapdh/contracts/openapi.yaml");
if (!existsSync(specPath)) {
  throw new Error(
    `${specPath} belum ada; jalankan \`pnpm --filter @kapdh/contracts bundle\` atau \`pnpm build\`.`,
  );
}
const spec = parse(readFileSync(specPath, "utf8")) as JsonObject & { paths: Record<string, JsonObject> };
const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats CJS: di ESM fungsi bisa berada di `default` atau langsung sebagai modul.
type AddFormats = (a: Ajv2020) => void;
const addFormats = ((addFormatsModule as unknown as { default?: AddFormats }).default ??
  addFormatsModule) as unknown as AddFormats;
addFormats(ajv);
ajv.addSchema({ ...spec, $id: "kapdh" });

/** Segmen JSON pointer dalam fragmen URI (RFC 6901 §6). */
const pointerSegment = (s: string) => encodeURIComponent(s.replaceAll("~", "~0").replaceAll("/", "~1"));

function resolvePointer(pointer: string): JsonObject {
  return pointer
    .replace(/^#\//, "")
    .split("/")
    .map((s) => decodeURIComponent(s).replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((node, key) => (node as JsonObject)[key], spec) as JsonObject;
}

function expectSchema(name: string, body: unknown) {
  const validate = ajv.getSchema(`kapdh#/components/schemas/${name}`)!;
  const ok = validate(body);
  expect(ok, `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

/**
 * Memvalidasi respons terhadap operasi kontrak (ARCHITECTURE §6): status harus dideklarasikan (status 2xx yang tidak
 * dideklarasikan selalu gagal; status lain jatuh ke `default`), lalu body divalidasi terhadap skema status itu.
 * Mengembalikan body JSON (atau undefined untuk respons tanpa body, mis. 204).
 */
function expectOperation(method: HttpMethod, path: string, res: InjectResponse): unknown {
  const where = `${method.toUpperCase()} ${path} -> ${res.statusCode}`;
  const item = spec.paths[path];
  expect(item, `path ${path} tidak ada di kontrak`).toBeDefined();
  const operation = item![method] as { responses: Record<string, JsonObject> } | undefined;
  expect(operation, `${method.toUpperCase()} ${path} tidak ada di kontrak`).toBeDefined();

  const status = String(res.statusCode);
  const range = `${status[0]}XX`;
  let key: string;
  if (status in operation!.responses) key = status;
  else if (range in operation!.responses) key = range;
  else {
    expect(
      res.statusCode >= 200 && res.statusCode < 300,
      `${where}: status 2xx tidak dideklarasikan di kontrak`,
    ).toBe(false);
    expect(
      operation!.responses.default,
      `${where}: status tidak dideklarasikan dan tidak ada default`,
    ).toBeDefined();
    key = "default";
  }

  let pointer = `#/paths/${pointerSegment(path)}/${method}/responses/${pointerSegment(key)}`;
  let response = operation!.responses[key]!;
  while (typeof response.$ref === "string") {
    pointer = response.$ref;
    response = resolvePointer(pointer);
  }
  const content = response.content as Record<string, unknown> | undefined;
  if (!content?.["application/json"]) {
    expect(res.body, `${where}: kontrak tidak mendeklarasikan body`).toBe("");
    return undefined;
  }
  expect(String(res.headers["content-type"] ?? ""), `${where}: content-type`).toMatch(/^application\/json/);
  const body = res.json();
  const validate = ajv.getSchema(`kapdh${pointer}/content/application~1json/schema`);
  expect(validate, `${where}: skema respons tidak dapat dikompilasi`).toBeDefined();
  expect(validate!(body), `${where}: ${ajv.errorsText(validate!.errors)}`).toBe(true);
  return body;
}

/** Daftar rute Fastify dari pohon printRoutes({ commonPrefix: false }) (setiap tingkat diindentasi 4 karakter). */
function registeredRoutes(tree: string): { method: string; url: string }[] {
  const routes: { method: string; url: string }[] = [];
  const stack: string[] = [];
  for (const line of tree.split("\n")) {
    const node = /^(.*?)(?:├── |└── )(.*)$/.exec(line);
    if (!node) continue;
    const depth = node[1]!.length / 4;
    const parts = /^(.*?)(?: \(([A-Z, ]+)\))?(?: \{.*\})?$/.exec(node[2]!)!;
    stack.length = depth;
    stack.push(parts[1]!);
    for (const method of parts[2]?.split(", ") ?? []) routes.push({ method, url: stack.join("") });
  }
  return routes;
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

    const normalize = (p: string) => p.replace(/\{[^}]+\}/g, "{}");
    const contract = new Map(Object.entries(spec.paths).map(([p, item]) => [normalize(p), item]));
    const missing: string[] = [];
    for (const { method, url } of routes) {
      // HEAD otomatis untuk setiap GET dan OPTIONS * untuk preflight CORS bukan operasi API.
      if (method === "HEAD" || (method === "OPTIONS" && url === "*")) continue;
      if (!url.startsWith("/api/v1/")) {
        missing.push(`${method} ${url} (di luar /api/v1)`);
        continue;
      }
      const path = normalize(url.slice("/api/v1".length).replace(/:([A-Za-z0-9_]+)/g, "{$1}"));
      if (!contract.get(path)?.[method.toLowerCase()]) missing.push(`${method} ${url}`);
    }
    expect(missing, "rute tanpa operasi kontrak; tambahkan ke openapi/domains/<domain>.yaml").toEqual([]);
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
      accept_policy_version: "2026-10",
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
      accept_policy_version: "2026-10",
    });
    clock.advance(61_000);
    const login = await post("/auth/login", { email, password: PASSWORD });
    expect(login.json().next).toBe("verify_otp");
    expectOperation("post", "/auth/login", login);
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
    expectOperation("post", "/admin/auth/login", login);
    const mfa = await post("/admin/auth/mfa", {
      mfa_token: login.json().mfa_token,
      totp_code: totp(secret, clock.now()),
    });
    expect(mfa.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/mfa", mfa);
    expectSchema("AdminSession", mfa.json());
    expect(String(mfa.headers["set-cookie"])).toContain("Path=/api/v1/auth");

    const me = await get("/admin/me", mfa.json().access_token);
    expect(me.statusCode).toBe(200);
    expectOperation("get", "/admin/me", me);
    expectSchema("AdminProfile", me.json());

    const forbidden = await get("/admin/me", login.json().mfa_token);
    expect(forbidden.statusCode).toBe(403);
    expectOperation("get", "/admin/me", forbidden);
  });
});
