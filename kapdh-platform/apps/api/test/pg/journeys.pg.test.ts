/**
 * Perjalanan ujung-ke-ujung (Phase D, lensa D7) lewat API HTTP nyata di atas PostgreSQL 17 dengan login role production:
 * API sebagai kapdh_app, prosesor job worker (createWorkerContext, WORKER_MODULES) sebagai kapdh_worker yang dijalankan
 * inline lewat JobRunner (`drainOutbox` / `runScheduled`). Setiap langkah memanggil endpoint seperti klien sungguhan
 * (Flutter, web admin, situs publik) dan memvalidasi respons terhadap kontrak (`expectOperation`).
 *
 * Fixture yang tidak memiliki endpoint publik (admin aktif dengan TOTP, metode bayar, anggota awal di direktori) ditulis
 * pemilik database lewat factories; seluruh perubahan keadaan yang diuji terjadi lewat HTTP atau job worker.
 *
 * Langkah yang terbukti rusak saat audit ditandai `expectDefect("<id>", ...)`: blok itu menegaskan perilaku yang
 * BENAR menurut PRD/kontrak dan diharapkan GAGAL selama cacat belum diperbaiki. Begitu cacat diperbaiki, uji gagal
 * dengan pesan yang meminta penanda dilepas sehingga langkah kembali menjadi asersi biasa.
 */
import "reflect-metadata";
import type { WorkerEnv } from "@kapdh/config";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { totp } from "../../src/core/identity/crypto.js";
import { createRootLogger } from "../../src/core/logging/logger.js";
import { MemoryRateLimitStore } from "../../src/core/rate-limit/store.js";
import { SettingsService } from "../../src/core/settings/settings.service.js";
import { createWorkerContext, type WorkerContext } from "../../src/worker.js";
import { TestSocket } from "../chat/support.js";
import { expectOperation, type HttpMethod, type InjectResponse } from "../support/contract.js";
import {
  type AdminFixture,
  createAdmin,
  type CreateAdminOptions,
  createAlumni,
  type CreateAlumniOptions,
  createPaymentMethod,
} from "../support/factories.js";
import { multipartBody, testJpeg, testPdf } from "../support/files.js";
import { FakePush, type TestApp, TestClock, testEnv } from "../support/test-app.js";
import {
  connectAs,
  createPgTestDatabase,
  PG_CONSENT_VERSION,
  type PgTestDatabase,
  publishLegalVersions,
  type Sql,
} from "./support.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Header yang selalu dikirim aplikasi Flutter (ARCHITECTURE §8.3). */
const APP = { "x-app-platform": "android", "x-app-version": "1.0.0" };

let tdb: PgTestDatabase;
let sql: Sql;
let apiConn: ReturnType<typeof connectAs>;
let workerConn: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
let worker: WorkerContext;
let baseUrl: string;
// Selasa 13 Oktober 2026 09.00 WIB (hari kerja).
const clock = new TestClock(new Date("2026-10-13T02:00:00Z"));
const mailer = new MemoryMailer();
const push = new FakePush();
const storage = new MemoryDriver();
const limits = new MemoryRateLimitStore();
/** Fixture ditulis pemilik database (superuser); API dan worker memakai role production. */
let fx: { app: NestFastifyApplication; db: Db; clock: TestClock };

function workerEnv(): WorkerEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: testEnv.DATABASE_URL,
    REDIS_URL: undefined,
    LOG_LEVEL: "silent",
    PUBLIC_WEB_URL: testEnv.PUBLIC_WEB_URL,
    API_PUBLIC_URL: testEnv.API_PUBLIC_URL,
    ADMIN_ORIGIN: testEnv.ADMIN_ORIGIN,
    SMTP_URL: undefined,
    MAIL_FROM: testEnv.MAIL_FROM,
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_ROOT: "/tmp",
    S3_ENDPOINT: undefined,
    S3_REGION: undefined,
    S3_BUCKET: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_FORCE_PATH_STYLE: false,
    FILE_URL_SECRET: testEnv.FILE_URL_SECRET,
    FCM_PROJECT_ID: undefined,
    FCM_SERVICE_ACCOUNT_JSON: undefined,
    WORKER_CONCURRENCY: 2,
  };
}

beforeAll(async () => {
  tdb = await createPgTestDatabase("journeys", 6);
  sql = tdb.sql;
  // Registrasi terbuka setelah versi legal terbit (F-01); ditulis sebelum aplikasi membaca pengaturan.
  await publishLegalVersions(sql);
  apiConn = connectAs(tdb, "kapdh_app", 12);
  workerConn = connectAs(tdb, "kapdh_worker", 6);
  app = await createApp(
    { env: testEnv, db: apiConn.db as unknown as Db, mailer, clock, push, storage, redis: null },
    { logger: false, rateLimitStore: limits },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  // Socket.IO butuh server HTTP sungguhan (journey e).
  await app.listen(0, "127.0.0.1");
  baseUrl = await app.getUrl();
  worker = await createWorkerContext(
    {
      env: workerEnv(),
      db: workerConn.db as unknown as Db,
      mailer,
      clock,
      push,
      storage,
      redis: null,
    },
    { logger: createRootLogger({ level: "silent", service: "kapdh-worker" }) },
  );
  fx = { app, db: tdb.db as unknown as Db, clock };
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await app?.close();
  await workerConn?.sql.end({ timeout: 5 });
  await apiConn?.sql.end({ timeout: 5 });
  await tdb?.drop();
});

beforeEach(() => {
  limits.clear();
});

// ------------------------------------------------------------------------------------------------ helper HTTP

interface CallOptions {
  token?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  idem?: boolean;
}

/** Satu panggilan klien; `op` = template path kontrak untuk expectOperation (bawaan path itu sendiri). */
async function call(
  method: HttpMethod,
  path: string,
  body?: unknown,
  options: CallOptions = {},
): Promise<InjectResponse> {
  const res = await app.inject({
    method: method.toUpperCase() as "GET",
    url: `/api/v1${path}`,
    ...(body === undefined ? {} : { payload: body as object }),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.idem ? { "idempotency-key": uuidv7() } : {}),
      ...options.headers,
    },
    ...(options.query ? { query: options.query } : {}),
  });
  return res as unknown as InjectResponse;
}

/** Ringkasan request/response untuk pesan asersi (bukti temuan). */
function show(method: string, path: string, res: InjectResponse, body?: unknown): string {
  return `${method.toUpperCase()} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`} -> ${res.statusCode} ${res.body.slice(0, 800)}`;
}

/**
 * Panggil, wajib status `status`, validasi kontrak terhadap template `op`. Mengembalikan body JSON.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function step(
  method: HttpMethod,
  path: string,
  op: string,
  status: number | number[],
  body?: unknown,
  options: CallOptions = {},
): Promise<{ res: InjectResponse; json: Json }> {
  const res = await call(method, path, body, options);
  const expected = Array.isArray(status) ? status : [status];
  expect(expected, show(method, path, res, body)).toContain(res.statusCode);
  const json = expectOperation(method, op, res) as Json;
  collectNonIsoTimestamps(`${method.toUpperCase()} ${op}`, json);
  return { res, json };
}

/**
 * Timestamp JSON wajib ISO 8601 UTC dari Date#toISOString (ARCHITECTURE §2.6); nilai mentah PostgreSQL
 * (`2026-10-13 09:00:00+07`) lolos format date-time Ajv tetapi bergantung zona waktu sesi database.
 */
const nonIsoTimestamps = new Map<string, string>();
function collectNonIsoTimestamps(where: string, value: unknown, path = "$"): void {
  if (typeof value === "string") {
    if (
      /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(value) &&
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(value)
    )
      nonIsoTimestamps.set(`${where} ${path}`, value);
  } else if (Array.isArray(value))
    value.forEach((item, i) => collectNonIsoTimestamps(where, item, `${path}[${i}]`));
  else if (value && typeof value === "object")
    for (const [key, inner] of Object.entries(value)) collectNonIsoTimestamps(where, inner, `${path}.${key}`);
}

/**
 * Penanda cacat yang terbukti saat audit: `assertion` menegaskan perilaku yang benar dan saat ini gagal. Bila asersi
 * lulus (cacat diperbaiki), uji gagal agar penanda dilepas.
 */
async function expectDefect(id: string, assertion: () => unknown | Promise<unknown>): Promise<void> {
  let fixed = false;
  try {
    await assertion();
    fixed = true;
  } catch {
    // Cacat masih ada (asersi perilaku benar gagal) sesuai temuan audit.
  }
  expect(fixed, `${id} tampaknya sudah diperbaiki: lepaskan expectDefect dan jadikan asersi biasa`).toBe(
    false,
  );
}

async function uploadMultipart(
  token: string,
  purpose: string,
  file: { data: Buffer; filename: string; contentType: string },
): Promise<{ res: InjectResponse; json: Json }> {
  const body = multipartBody([
    { name: "purpose", value: purpose },
    { name: "file", ...file },
  ]);
  const res = (await app.inject({
    method: "POST",
    url: "/api/v1/files",
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${token}` },
  })) as unknown as InjectResponse;
  expect(res.statusCode, show("post", "/files (multipart)", res)).toBe(201);
  return { res, json: expectOperation("post", "/files", res) as Json };
}

/** URL berkas bertanda tangan (API_PUBLIC_URL/api/v1/files/content/...) dibuka tanpa Authorization. */
async function openSignedUrl(url: string): Promise<InjectResponse> {
  expect(url.startsWith(testEnv.API_PUBLIC_URL), url).toBe(true);
  return (await app.inject({
    method: "GET",
    url: url.slice(testEnv.API_PUBLIC_URL.length),
  })) as unknown as InjectResponse;
}

const drain = () => worker.jobs.drainOutbox();
const runJob = (name: string) => worker.jobs.runScheduled(name);

// -------------------------------------------------------------------------------------------- aktor (via HTTP)

let emailSeq = 0;
const freshEmail = (prefix: string) => `${prefix}-${++emailSeq}-${uuidv7().slice(-8)}@contoh.test`;

interface MemberSession {
  userId: string;
  email: string;
  password: string;
  token: string;
  refreshToken: string;
}

/** Login alumni lewat POST /auth/login (kontrak login). */
async function loginAlumni(
  email: string,
  password: string,
): Promise<{ token: string; refreshToken: string }> {
  const { json } = await step("post", "/auth/login", "/auth/login", 200, { email, password });
  expect(json.next, JSON.stringify(json)).toBe("home");
  return { token: json.session.access_token, refreshToken: json.session.refresh_token };
}

/** Anggota fixture (keadaan keanggotaan awal) yang masuk lewat HTTP. */
async function memberFixture(options: CreateAlumniOptions = {}): Promise<MemberSession> {
  const fixture = await createAlumni(fx, options);
  const session = await loginAlumni(fixture.email, fixture.password);
  return { userId: fixture.userId, email: fixture.email, password: fixture.password, ...session };
}

interface AdminSession {
  fixture: AdminFixture;
  token: string;
  lastStep: number;
}

/** Langkah TOTP berikutnya yang belum dipakai (server menolak replay langkah yang sama). */
function nextTotp(secret: string, lastStep: number): { code: string; step: number } {
  let stepNow = Math.floor(clock.now().getTime() / 30_000);
  if (stepNow <= lastStep) {
    clock.advance((lastStep - stepNow + 1) * 30_000);
    stepNow = Math.floor(clock.now().getTime() / 30_000);
  }
  return { code: totp(secret, clock.now()), step: stepNow };
}

/** Login admin dua tahap lewat HTTP: sandi (/admin/auth/login) lalu TOTP (/admin/auth/mfa). */
async function loginAdmin(fixture: AdminFixture, lastStep = -1): Promise<AdminSession> {
  const login = await step("post", "/admin/auth/login", "/admin/auth/login", 200, {
    email: fixture.email,
    password: fixture.password,
  });
  const { code, step: usedStep } = nextTotp(fixture.totpSecret!, lastStep);
  const mfa = await step("post", "/admin/auth/mfa", "/admin/auth/mfa", 200, {
    mfa_token: login.json.mfa_token,
    totp_code: code,
  });
  return { fixture, token: mfa.json.access_token, lastStep: usedStep };
}

async function adminFixture(options: CreateAdminOptions & { status?: "active" }): Promise<AdminSession> {
  const fixture = await createAdmin(fx, { displayName: "Pengurus Perjalanan", ...options });
  return loginAdmin(fixture);
}

/** POST /auth/reauth admin (sandi + TOTP langkah baru) → header X-Reauth-Token. */
async function adminReauth(admin: AdminSession): Promise<Record<string, string>> {
  const { code, step: usedStep } = nextTotp(admin.fixture.totpSecret!, admin.lastStep);
  const { json } = await step(
    "post",
    "/auth/reauth",
    "/auth/reauth",
    200,
    { password: admin.fixture.password, totp_code: code },
    { token: admin.token },
  );
  admin.lastStep = usedStep;
  return { "x-reauth-token": json.reauth_token };
}

/** POST /auth/reauth alumni (sandi) → header X-Reauth-Token. */
async function memberReauth(member: { token: string; password: string }): Promise<Record<string, string>> {
  const { json } = await step(
    "post",
    "/auth/reauth",
    "/auth/reauth",
    200,
    { password: member.password },
    { token: member.token },
  );
  return { "x-reauth-token": json.reauth_token };
}

let paymentMethodId: string;
async function bankMethod(): Promise<string> {
  if (!paymentMethodId) paymentMethodId = (await createPaymentMethod(fx)).id;
  return paymentMethodId;
}

/** Token KTA dari QR kartu: `${PUBLIC_WEB_URL}/kta/<nomor>#t=<token>`. */
function ktaFromQr(url: string): { memberNumber: string; token: string } {
  const match = /\/kta\/([^#]+)#t=(.+)$/.exec(url);
  expect(match, `format QR KTA: ${url}`).not.toBeNull();
  return { memberNumber: decodeURIComponent(match![1]!), token: decodeURIComponent(match![2]!) };
}

// ================================================================================================ journeys

describe("D7 (a): registrasi → OTP → iuran → bukti → keputusan admin → KTA aktif → notifikasi", () => {
  it("F-01, F-03, F-04, F-05, F-06, F-13: alur aktivasi anggota baru dari nol", async () => {
    const email = freshEmail("daftar");
    const password = "Kapdh#2026";
    // 1. Data diri (F-01): Idempotency-Key + ulangan jaringan putus (AC F01-4).
    const registerBody = {
      full_name: "Siti Perjalanan",
      gender: "female",
      email,
      password,
      cohort: 25,
      class_in: 1,
      class_out: 6,
      accept_policy_version: PG_CONSENT_VERSION,
    };
    const idemKey = uuidv7();
    const reg = await step("post", "/auth/register", "/auth/register", 201, registerBody, {
      headers: { "idempotency-key": idemKey },
    });
    const replay = await step("post", "/auth/register", "/auth/register", 201, registerBody, {
      headers: { "idempotency-key": idemKey },
    });
    expect(replay.json.challenge_id).toBe(reg.json.challenge_id);
    const [accounts] = await sql<
      { n: number }[]
    >`select count(*)::int as n from app.users where email = ${email}`;
    expect(accounts!.n).toBe(1);
    // Kode tidak pernah dikirim ke klien (AC F01-1).
    expect(reg.res.body).not.toContain(mailer.last(email)!);

    // 2. OTP (AC F01-2).
    const verified = await step("post", "/auth/otp/verify", "/auth/otp/verify", 200, {
      challenge_id: reg.json.challenge_id,
      code: mailer.last(email)!,
      device_name: "Pixel Uji",
    });
    const member: MemberSession = {
      userId: "",
      email,
      password,
      token: verified.json.session.access_token,
      refreshToken: verified.json.session.refresh_token,
    };
    const me = await step("get", "/me", "/me", 200, undefined, { token: member.token });
    member.userId = me.json.user_id;
    expect(me.json.effective_status).toBe("unverified");
    expect(me.json.member_number).toMatch(/^25\.01\.02\.[1-9][0-9]*$/);

    // KTA Tidak Aktif dengan ajakan bayar, tanpa QR (AC F05-1).
    const cardBefore = await step("get", "/me/card", "/me/card", 200, undefined, { token: member.token });
    expect(cardBefore.json.status_label).toBe("inactive");
    expect(cardBefore.json.qr).toBeNull();

    // 3. Biaya KTA (D4): 50.000 + 10.000.
    const fees = await step("get", "/me/fees", "/me/fees", 200, undefined, {
      token: member.token,
      headers: APP,
    });
    expect(fees.json.registration).toMatchObject({ total: "60000.00", eligible: true });
    expect(fees.json.registration.lines.map((l: Json) => l.amount)).toEqual(["50000.00", "10000.00"]);

    // 4. Instruksi pembayaran (AC F03-1).
    const methodId = await bankMethod();
    const methods = await step("get", "/payment-methods", "/payment-methods", 200, undefined, {
      token: member.token,
    });
    expect(methods.json.items.map((m: Json) => m.id)).toContain(methodId);
    const created = await step(
      "post",
      "/me/payments",
      "/me/payments",
      201,
      { type: "registration", payment_method_id: methodId },
      { token: member.token, idem: true, headers: APP },
    );
    const paymentId = created.json.id as string;
    expect(created.json).toMatchObject({ type: "registration", status: "pending", amount: "60000.00" });

    // 5. Unggah bukti (multipart nyata, JPEG dengan EXIF pribadi) lalu kirim bukti (AC F03-2).
    const proof = await uploadMultipart(member.token, "payment_proof", {
      data: await testJpeg({ withPrivateExif: true, width: 320, height: 200 }),
      filename: "bukti-transfer.jpg",
      contentType: "image/jpeg",
    });
    const submitted = await step(
      "put",
      `/me/payments/${paymentId}/proof`,
      "/me/payments/{paymentId}/proof",
      200,
      { file_id: proof.json.id, expected_proof_version: 0, transfer_note: "Transfer dari BSI" },
      { token: member.token, idem: true },
    );
    expect(submitted.json).toMatchObject({ proof_version: 1, stage: "awaiting_review" });

    // Perangkat push terdaftar (F-13).
    await step(
      "put",
      "/devices",
      "/devices",
      204,
      { platform: "android", token: `fcm-${member.userId}`, app_version: "1.0.0" },
      { token: member.token },
    );

    // 6. Admin pembayaran masuk (sandi + TOTP) dan membuka antrean.
    const admin = await adminFixture({ permissions: ["payments.read", "payments.decide"] });
    const queue = await step("get", "/admin/payments", "/admin/payments", 200, undefined, {
      token: admin.token,
      query: { stage: "awaiting_review", type: "registration" },
    });
    expect(queue.json.items.map((p: Json) => p.id)).toContain(paymentId);
    const detail = await step(
      "get",
      `/admin/payments/${paymentId}`,
      "/admin/payments/{paymentId}",
      200,
      undefined,
      { token: admin.token },
    );
    expect(detail.json.proof).toMatchObject({ file_id: proof.json.id, version: 1 });
    expect(detail.json.actions.can_decide).toBe(true);
    // Bukti dibuka lewat URL bertanda tangan; EXIF pribadi sudah dibuang (N-10).
    const access = await step(
      "get",
      `/files/${proof.json.id}/access`,
      "/files/{fileId}/access",
      200,
      undefined,
      { token: admin.token },
    );
    const content = await openSignedUrl(access.json.url);
    expect(content.statusCode, show("get", "signed url", content)).toBe(200);
    expect(String(content.headers["content-type"])).toMatch(/^image\/jpeg/);
    expect((content as unknown as { rawPayload: Buffer }).rawPayload.includes("Data pribadi uji")).toBe(
      false,
    );

    // 7. Approve (AC F04-1); aplikasi anggota tersambung realtime (badge notifikasi, ARCHITECTURE §4.9).
    const memberSocket = await connectSocket(member);
    const decision = await step(
      "post",
      `/admin/payments/${paymentId}/decision`,
      "/admin/payments/{paymentId}/decision",
      200,
      {
        decision: "approve",
        expected_proof_version: 1,
        expected_version: detail.json.version,
        funds_verified: true,
      },
      { token: admin.token, idem: true },
    );
    expect(decision.json).toMatchObject({ id: paymentId, status: "paid", stage: "paid" });
    try {
      const realtime = await memberSocket.waitFor("notification.created");
      expect(realtime.payload).toMatchObject({
        category: "payment",
        deep_link: `kapdh://app/payments/${paymentId}`,
        unread_count: expect.any(Number),
      });
    } finally {
      memberSocket.close();
    }

    // 8. Anggota aktif dan KTA Aktif dengan QR (AC F05-1).
    const meAfter = await step("get", "/me", "/me", 200, undefined, { token: member.token });
    expect(meAfter.json.effective_status).toBe("verified");
    const card = await step("get", "/me/card", "/me/card", 200, undefined, { token: member.token });
    expect(card.json.status_label).toBe("active");
    expect(card.json.qr).not.toBeNull();
    const kta = ktaFromQr(card.json.qr.url);
    expect(kta.memberNumber).toBe(card.json.member_number);
    expect(card.json.qr.url.startsWith(`${testEnv.PUBLIC_WEB_URL}/kta/`)).toBe(true);

    // 9. Verifikasi publik (AC F06-1): tanpa autentikasi.
    const verify = await step("post", "/public/kta/verify", "/public/kta/verify", 200, {
      member_number: kta.memberNumber,
      token: kta.token,
    });
    expect(verify.json.result).toBe("active");
    expect(JSON.stringify(verify.json)).not.toContain(email);

    // 10. Inbox: tepat satu notifikasi keputusan (AC F13-1) dengan deep link.
    const inbox = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: member.token,
    });
    const paymentNotices = inbox.json.items.filter(
      (n: Json) => n.category === "payment" && n.deep_link === `kapdh://app/payments/${paymentId}`,
    );
    expect(paymentNotices, JSON.stringify(inbox.json.items)).toHaveLength(1);
    const unread = await step(
      "get",
      "/notifications/unread-count",
      "/notifications/unread-count",
      200,
      undefined,
      {
        token: member.token,
      },
    );
    expect(unread.json.unread_count).toBeGreaterThanOrEqual(1);

    // 11. Worker: outbox notification.created → email + push terkirim, sekali (AC F13-1).
    const before = mailer.messagesTo(email).length;
    const drained = await drain();
    expect(drained.dead, JSON.stringify(drained)).toBe(0);
    const mails = mailer.messagesTo(email).slice(before);
    expect(
      mails.length,
      JSON.stringify(mailer.messagesTo(email).map((m) => m.subject)),
    ).toBeGreaterThanOrEqual(1);
    expect(mails.map((m) => `${m.subject}\n${m.text}`).join("\n")).not.toContain(proof.json.id);
    expect(push.to(`fcm-${member.userId}`).length).toBeGreaterThanOrEqual(1);
    const deliveries = await sql<{ channel: string; status: string }[]>`
      select d.channel, d.status from app.notification_deliveries d
      join app.notifications n on n.id = d.notification_id
      where n.user_id = ${member.userId} and n.data->>'payment_id' = ${paymentId}`;
    expect(deliveries.map((d) => `${d.channel}:${d.status}`).sort()).toEqual(["email:sent", "push:sent"]);
    // Ulangan worker tidak menggandakan apa pun.
    await drain();
    await runJob("notifications.retry");
    expect(mailer.messagesTo(email).length).toBe(before + mails.length);

    // 12. Tandai dibaca.
    await step(
      "post",
      "/notifications/read",
      "/notifications/read",
      200,
      { ids: [paymentNotices[0].id] },
      { token: member.token },
    );
  });
});

/** Instruksi iuran + unggah bukti + kirim bukti lewat HTTP; mengembalikan payment yang menunggu review. */
async function submitDues(
  member: { token: string },
  type: "registration" | "renewal",
  file: { data: Buffer; filename: string; contentType: string },
): Promise<{ id: string; fileId: string }> {
  const created = await step(
    "post",
    "/me/payments",
    "/me/payments",
    201,
    { type, payment_method_id: await bankMethod() },
    { token: member.token, idem: true, headers: APP },
  );
  const proof = await uploadMultipart(member.token, "payment_proof", file);
  await step(
    "put",
    `/me/payments/${created.json.id}/proof`,
    "/me/payments/{paymentId}/proof",
    200,
    { file_id: proof.json.id, expected_proof_version: 0 },
    { token: member.token, idem: true, headers: APP },
  );
  return { id: created.json.id, fileId: proof.json.id };
}

/** Admin membaca detail lalu memutus versi bukti terbaru (seperti layar antrean web admin). */
async function decide(
  admin: AdminSession,
  paymentId: string,
  decision: "approve" | "reject",
  reason?: string,
): Promise<Json> {
  const detail = await step(
    "get",
    `/admin/payments/${paymentId}`,
    "/admin/payments/{paymentId}",
    200,
    undefined,
    { token: admin.token },
  );
  const body = {
    decision,
    expected_proof_version: detail.json.proof_version,
    expected_version: detail.json.version,
    ...(decision === "approve" ? { funds_verified: true } : { reason }),
  };
  const { json } = await step(
    "post",
    `/admin/payments/${paymentId}/decision`,
    "/admin/payments/{paymentId}/decision",
    200,
    body,
    { token: admin.token, idem: true },
  );
  return json;
}

describe("D7 (b): iuran ditolak lalu bukti diperbaiki pada payment yang sama", () => {
  it("AC F04-2, F03-3, F04-4, F03-4: tolak beralasan → perbaiki bukti (PDF) → versi lama ditolak → approve versi baru", async () => {
    const member = await memberFixture({ status: "unverified", fullName: "Budi Ditolak" });
    const payment = await submitDues(member, "registration", {
      data: await testJpeg({ width: 200, height: 120 }),
      filename: "bukti-buram.jpg",
      contentType: "image/jpeg",
    });
    const admin = await adminFixture({ permissions: ["payments.read", "payments.decide"] });
    const detail = await step(
      "get",
      `/admin/payments/${payment.id}`,
      "/admin/payments/{paymentId}",
      200,
      undefined,
      { token: admin.token },
    );
    // AC F04-2: alasan kosong/hanya spasi ditolak.
    for (const reason of [undefined, "   "]) {
      const res = await call(
        "post",
        `/admin/payments/${payment.id}/decision`,
        {
          decision: "reject",
          expected_proof_version: 1,
          expected_version: detail.json.version,
          ...(reason === undefined ? {} : { reason }),
        },
        { token: admin.token },
      );
      expect(res.statusCode, show("post", "decision", res)).toBe(400);
      expect(expectOperation("post", "/admin/payments/{paymentId}/decision", res)).toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    const rejectReason = "Nominal pada bukti tidak terbaca";
    const rejected = await decide(admin, payment.id, "reject", rejectReason);
    expect(rejected).toMatchObject({
      status: "rejected",
      stage: "needs_fix",
      rejection_reason: rejectReason,
    });

    // Pemilik melihat alasan (AC F04-2) dan diminta memperbaiki bukti.
    const mine = await step("get", `/me/payments/${payment.id}`, "/me/payments/{paymentId}", 200, undefined, {
      token: member.token,
    });
    expect(mine.json).toMatchObject({
      status: "rejected",
      stage: "needs_fix",
      rejection_reason: rejectReason,
    });
    const me = await step("get", "/me", "/me", 200, undefined, { token: member.token });
    expect(me.json.effective_status).toBe("unverified");
    expect(me.json.registration_payment).toMatchObject({ id: payment.id, rejection_reason: rejectReason });
    const inbox = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: member.token,
    });
    expect(
      inbox.json.items.filter((n: Json) => n.deep_link === `kapdh://app/payments/${payment.id}`),
    ).toHaveLength(1);

    // AC F03-3: bukti baru (PDF) → payment yang SAMA kembali pending dengan versi 2.
    const pdf = await uploadMultipart(member.token, "payment_proof", {
      data: testPdf({ compressedContent: true }),
      filename: "bukti-bank.pdf",
      contentType: "application/pdf",
    });
    const resubmitted = await step(
      "put",
      `/me/payments/${payment.id}/proof`,
      "/me/payments/{paymentId}/proof",
      200,
      { file_id: pdf.json.id, expected_proof_version: 1, transfer_note: "Bukti dari mobile banking" },
      { token: member.token, idem: true, headers: APP },
    );
    expect(resubmitted.json).toMatchObject({
      id: payment.id,
      status: "pending",
      stage: "awaiting_review",
      proof_version: 2,
    });
    const [count] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.payments where user_id = ${member.userId}`;
    expect(count!.n).toBe(1);
    // Histori menyimpan alasan lama.
    expect(
      resubmitted.json.events.some((e: Json) => e.kind === "rejected" && e.reason === rejectReason),
      JSON.stringify(resubmitted.json.events),
    ).toBe(true);

    // AC F04-4: keputusan atas versi lama (layar admin basi) ditolak dengan versi terbaru.
    const stale = await call(
      "post",
      `/admin/payments/${payment.id}/decision`,
      {
        decision: "approve",
        expected_proof_version: 1,
        expected_version: detail.json.version,
        funds_verified: true,
      },
      { token: admin.token },
    );
    expect(stale.statusCode, show("post", "decision (basi)", stale)).toBe(409);
    expect(expectOperation("post", "/admin/payments/{paymentId}/decision", stale)).toMatchObject({
      code: "PROOF_VERSION_CONFLICT",
      current: { proof_version: 2 },
    });
    // Admin membuka bukti PDF terbaru lalu menyetujui.
    const access = await step(
      "get",
      `/files/${pdf.json.id}/access`,
      "/files/{fileId}/access",
      200,
      undefined,
      {
        token: admin.token,
      },
    );
    const content = await openSignedUrl(access.json.url);
    expect(content.statusCode).toBe(200);
    expect(String(content.headers["content-type"])).toMatch(/^application\/pdf/);
    const approved = await decide(admin, payment.id, "approve");
    expect(approved).toMatchObject({ status: "paid", proof_version: 2, rejection_count: 1 });

    // AC F03-4: bukti tidak dapat diganti setelah paid; tidak ada aktivasi ganda.
    const late = await uploadMultipart(member.token, "payment_proof", {
      data: await testJpeg(),
      filename: "telat.jpg",
      contentType: "image/jpeg",
    });
    const replaced = await call(
      "put",
      `/me/payments/${payment.id}/proof`,
      { file_id: late.json.id, expected_proof_version: 2 },
      { token: member.token, headers: APP },
    );
    expect(replaced.statusCode, show("put", "proof setelah paid", replaced)).toBe(409);
    expect(expectOperation("put", "/me/payments/{paymentId}/proof", replaced)).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
    });
    const meAfter = await step("get", "/me", "/me", 200, undefined, { token: member.token });
    expect(meAfter.json.effective_status).toBe("verified");
    const [periods] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.membership_events where user_id = ${member.userId}`;
    expect(periods!.n).toBe(1);
    // Dua keputusan → dua notifikasi (tolak v1, setujui v2), masing-masing satu email.
    await drain();
    const decisions = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: member.token,
    });
    expect(
      decisions.json.items.filter((n: Json) => n.deep_link === `kapdh://app/payments/${payment.id}`),
    ).toHaveLength(2);
    expect(mailer.messagesTo(member.email)).toHaveLength(2);
  });
});

describe("D7 (c): perpanjangan menjelang habis", () => {
  it("AC F07-5, F07-1, F05-5: pengingat 30 hari sekali per periode → renewal → masa baru dari expires_at lama, nomor tetap", async () => {
    const member = await memberFixture({ status: "expiring", fullName: "Citra Perpanjang" });
    const [before] = await sql<{ expires_at: Date; member_number: string }[]>`
      select expires_at, member_number from app.alumni where user_id = ${member.userId}`;
    const me = await step("get", "/me", "/me", 200, undefined, { token: member.token });
    expect(me.json).toMatchObject({ effective_status: "expiring", renewal_eligible: true });
    const card = await step("get", "/me/card", "/me/card", 200, undefined, { token: member.token });
    expect(card.json.status_label).toBe("expiring");
    const oldQr = ktaFromQr(card.json.qr.url);
    // AC F06-1: expiring tetap Aktif dengan tanggal habis.
    const verifyExpiring = await step("post", "/public/kta/verify", "/public/kta/verify", 200, {
      member_number: oldQr.memberNumber,
      token: oldQr.token,
    });
    expect(verifyExpiring.json).toMatchObject({ result: "active", expiring: true });
    // Token QR dibatasi expiry keanggotaan (PRD 3.5).
    expect(new Date(card.json.qr.token_expires_at).getTime()).toBeLessThanOrEqual(
      new Date(before!.expires_at).getTime(),
    );

    // Pengingat 30 hari: job diulang tetap satu notifikasi per periode (AC F07-5).
    await runJob("membership.expiry-reminders");
    await runJob("membership.expiry-reminders");
    clock.advance(HOUR);
    await runJob("membership.expiry-reminders");
    member.token = (await loginAlumni(member.email, member.password)).token;
    const inbox = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: member.token,
      query: { category: "membership" },
    });
    expect(inbox.json.items, JSON.stringify(inbox.json.items)).toHaveLength(1);
    await drain();
    expect(mailer.messagesTo(member.email)).toHaveLength(1);

    // Renewal: hanya biaya perpanjangan (D4).
    const fees = await step("get", "/me/fees", "/me/fees", 200, undefined, {
      token: member.token,
      headers: APP,
    });
    expect(fees.json.renewal).toMatchObject({ total: "10000.00", eligible: true });
    const payment = await submitDues(member, "renewal", {
      data: testPdf(),
      filename: "perpanjang.pdf",
      contentType: "application/pdf",
    });
    const admin = await adminFixture({ permissions: ["payments.read", "payments.decide"] });
    const approved = await decide(admin, payment.id, "approve");
    expect(approved.status).toBe("paid");

    // AC F07-1: masa baru dimulai dari expires_at lama (sisa masa aktif tidak hilang); nomor tetap (AC F05-5).
    const [after] = await sql<{ expires_at: Date; member_number: string }[]>`
      select expires_at, member_number from app.alumni where user_id = ${member.userId}`;
    expect(after!.member_number).toBe(before!.member_number);
    const expectedExpiry = new Date(before!.expires_at);
    expectedExpiry.setUTCFullYear(expectedExpiry.getUTCFullYear() + 1);
    expect(new Date(after!.expires_at).toISOString()).toBe(expectedExpiry.toISOString());
    const meAfter = await step("get", "/me", "/me", 200, undefined, { token: member.token });
    expect(meAfter.json).toMatchObject({
      effective_status: "verified",
      member_number: before!.member_number,
    });
    expect(meAfter.json.expires_at).toBe(expectedExpiry.toISOString());
    const cardAfter = await step("get", "/me/card", "/me/card", 200, undefined, { token: member.token });
    expect(cardAfter.json).toMatchObject({ status_label: "active", member_number: before!.member_number });
    // Token QR lama tetap tunduk status server terbaru (AC F05-5).
    const verifyOld = await step("post", "/public/kta/verify", "/public/kta/verify", 200, {
      member_number: oldQr.memberNumber,
      token: oldQr.token,
    });
    expect(verifyOld.json).toMatchObject({ result: "active", expiring: false });

    // Periode baru mendapat pengingatnya sendiri ketika jendela 30 hari periode baru tiba.
    const resumeAt = clock.now();
    clock.set(new Date(expectedExpiry.getTime() - 20 * DAY));
    await runJob("membership.expiry-reminders");
    const relog = await loginAlumni(member.email, member.password);
    const inbox2 = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: relog.token,
      query: { category: "membership" },
    });
    clock.set(resumeAt);
    expect(inbox2.json.items.length).toBeGreaterThanOrEqual(2);
  });

  it("AC F07-2: anggota expired memperpanjang → masa baru dari approved_at; renewal sebelum jendela ditolak", async () => {
    const expired = await memberFixture({ status: "expired", fullName: "Dedi Kedaluwarsa" });
    const me = await step("get", "/me", "/me", 200, undefined, { token: expired.token });
    expect(me.json.effective_status).toBe("expired");
    // Fitur aktif ditolak (PRD 2.2).
    const dir = await call("get", "/directory", undefined, { token: expired.token });
    expect(dir.statusCode, show("get", "/directory", dir)).toBe(403);
    expect(expectOperation("get", "/directory", dir)).toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
    const payment = await submitDues(expired, "renewal", {
      data: await testJpeg(),
      filename: "renew.jpg",
      contentType: "image/jpeg",
    });
    clock.advance(2 * HOUR);
    const admin = await adminFixture({ permissions: ["payments.read", "payments.decide"] });
    const approvedAt = clock.now();
    await decide(admin, payment.id, "approve");
    const [row] = await sql<{ starts_at: Date; expires_at: Date }[]>`
      select starts_at, expires_at from app.alumni where user_id = ${expired.userId}`;
    const expected = new Date(approvedAt);
    expected.setUTCFullYear(expected.getUTCFullYear() + 1);
    expect(new Date(row!.expires_at).toISOString()).toBe(expected.toISOString());
    const relog = await loginAlumni(expired.email, expired.password);
    const meAfter = await step("get", "/me", "/me", 200, undefined, { token: relog.token });
    expect(meAfter.json.effective_status).toBe("verified");

    // Anggota verified (>30 hari) belum boleh renewal (AC F07-5 jendela).
    const early = await call(
      "post",
      "/me/payments",
      { type: "renewal", payment_method_id: await bankMethod() },
      { token: relog.token, headers: APP },
    );
    expect(early.statusCode, show("post", "/me/payments renewal awal", early)).toBe(400);
    expectOperation("post", "/me/payments", early);
  });
});

// ------------------------------------------------------------------------------------------------- events

/** Admin membuat event lewat POST /admin/events lalu menerbitkannya (draft → open, If-Match). */
async function createOpenEvent(
  admin: AdminSession,
  options: { title: string; price: string; seats: number; startsInMs: number },
): Promise<Json> {
  const now = clock.now();
  const startsAt = new Date(now.getTime() + options.startsInMs);
  const body = {
    title: options.title,
    location_name: "Aula Pesantren",
    timezone: "Asia/Jakarta",
    starts_at: startsAt.toISOString(),
    ends_at: new Date(startsAt.getTime() + 4 * HOUR).toISOString(),
    registration_opens_at: new Date(now.getTime() - HOUR).toISOString(),
    registration_closes_at: new Date(startsAt.getTime() - DAY).toISOString(),
    price: options.price,
    seats_total: options.seats,
  };
  const created = await step("post", "/admin/events", "/admin/events", 201, body, {
    token: admin.token,
    idem: true,
  });
  expect(created.json.status).toBe("draft");
  const opened = await step(
    "post",
    `/admin/events/${created.json.id}/status`,
    "/admin/events/{eventId}/status",
    200,
    { status: "open" },
    { token: admin.token, idem: true, headers: { "if-match": created.json.version } },
  );
  expect(opened.json.status).toBe("open");
  return opened.json;
}

/** Anggota memesan event berbayar lalu mengirim bukti untuk payment tiketnya. */
async function reserveWithProof(
  member: MemberSession,
  event: Json,
): Promise<{ ticket: Json; paymentId: string }> {
  const reserved = await step(
    "post",
    `/events/${event.id}/reservations`,
    "/events/{eventId}/reservations",
    201,
    { expected_price: event.price, payment_method_id: await bankMethod() },
    { token: member.token, idem: true, headers: APP },
  );
  expect(reserved.json).toMatchObject({ status: "awaiting_payment", total: event.price });
  expect(reserved.json.payment).toMatchObject({ status: "pending", amount: event.price, proof_version: 0 });
  const proof = await uploadMultipart(member.token, "payment_proof", {
    data: await testJpeg(),
    filename: "tiket.jpg",
    contentType: "image/jpeg",
  });
  await step(
    "put",
    `/me/payments/${reserved.json.payment.id}/proof`,
    "/me/payments/{paymentId}/proof",
    200,
    { file_id: proof.json.id, expected_proof_version: 0 },
    { token: member.token, idem: true, headers: APP },
  );
  const ticket = await step(
    "get",
    `/me/tickets/${reserved.json.id}`,
    "/me/tickets/{ticketId}",
    200,
    undefined,
    {
      token: member.token,
    },
  );
  expect(ticket.json.status).toBe("awaiting_review");
  return { ticket: ticket.json, paymentId: reserved.json.payment.id };
}

describe("D7 (d): event berbayar, check-in, event gratis, pembatalan event", () => {
  it("F-09, AC F09-5, F09-6: buat event → pesan → bukti → approve → tiket QR → check-in → scan kedua ditolak", async () => {
    const admin = await adminFixture({
      permissions: ["events.manage", "events.checkin", "payments.read", "payments.decide"],
    });
    const event = await createOpenEvent(admin, {
      title: "Reuni Akbar Perjalanan",
      price: "75000.00",
      seats: 2,
      startsInMs: 5 * DAY,
    });
    const member = await memberFixture({ status: "verified", fullName: "Eka Peserta" });
    const list = await step("get", "/events", "/events", 200, undefined, {
      token: member.token,
      query: { period: "upcoming" },
    });
    expect(list.json.items.map((e: Json) => e.id)).toContain(event.id);
    const detail = await step("get", `/events/${event.id}`, "/events/{eventId}", 200, undefined, {
      token: member.token,
    });
    expect(detail.json.seats_available).toBe(2);

    const { ticket, paymentId } = await reserveWithProof(member, event);
    // Kursi ditahan selama review (PRD 3.9).
    const held = await step("get", `/admin/events/${event.id}`, "/admin/events/{eventId}", 200, undefined, {
      token: admin.token,
    });
    expect(held.json).toMatchObject({ held_quantity: 1, paid_quantity: 0, seats_available: 1 });
    const approved = await decide(admin, paymentId, "approve");
    expect(approved).toMatchObject({ status: "paid", type: "ticket" });
    const paid = await step("get", `/me/tickets/${ticket.id}`, "/me/tickets/{ticketId}", 200, undefined, {
      token: member.token,
    });
    expect(paid.json.status).toBe("paid");
    expect(paid.json.qr_code).toEqual(expect.any(String));
    const qr = paid.json.qr_code as string;
    const counted = await step(
      "get",
      `/admin/events/${event.id}`,
      "/admin/events/{eventId}",
      200,
      undefined,
      {
        token: admin.token,
      },
    );
    expect(counted.json).toMatchObject({ held_quantity: 0, paid_quantity: 1, seats_available: 1 });
    // Notifikasi keputusan pembayaran tiket.
    await drain();
    const inbox = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: member.token,
    });
    expect(inbox.json.items.some((n: Json) => n.deep_link === `kapdh://app/payments/${paymentId}`)).toBe(
      true,
    );

    // AC F09-6: di luar jendela check-in → ditolak dengan alasan.
    const early = await call(
      "post",
      "/admin/checkin",
      { event_id: event.id, qr_code: qr },
      { token: admin.token },
    );
    expect(early.statusCode, show("post", "/admin/checkin (terlalu awal)", early)).toBe(409);
    expect(expectOperation("post", "/admin/checkin", early)).toMatchObject({
      code: "VALIDATION_ERROR",
      current: { rejection_reason: "too_early" },
    });

    // Jendela check-in: 2 jam sebelum mulai (D5). Sesi lama sudah kedaluwarsa → masuk ulang.
    clock.set(new Date(new Date(event.starts_at).getTime() - HOUR));
    const scanner = await loginAdmin(admin.fixture, admin.lastStep);
    const checkin = await step(
      "post",
      "/admin/checkin",
      "/admin/checkin",
      200,
      { event_id: event.id, qr_code: qr },
      { token: scanner.token, idem: true },
    );
    expect(checkin.json).toMatchObject({ event_checked_in_count: 1, event_paid_count: 1 });
    expect(JSON.stringify(checkin.json.ticket)).toContain(ticket.id);
    // AC F09-5: scan kedua → Sudah check-in, hitungan tidak bertambah.
    const second = await call(
      "post",
      "/admin/checkin",
      { event_id: event.id, qr_code: qr },
      { token: scanner.token, idem: true },
    );
    expect(second.statusCode, show("post", "/admin/checkin (kedua)", second)).toBe(409);
    expect(expectOperation("post", "/admin/checkin", second)).toMatchObject({
      code: "TICKET_ALREADY_CHECKED_IN",
      current: {
        rejection_reason: "already_checked_in",
        ticket: { checked_in_at: checkin.json.checked_in_at },
      },
    });
    expect(JSON.stringify((second.json() as Json).current.ticket.checked_in_by)).toContain(
      admin.fixture.adminId,
    );
    const [row] = await sql<{ checked_in_at: Date | null; checked_in_by_admin_id: string | null }[]>`
      select checked_in_at, checked_in_by_admin_id from app.tickets where id = ${ticket.id}`;
    expect(row!.checked_in_at).not.toBeNull();
    expect(row!.checked_in_by_admin_id).toBe(admin.fixture.adminId);
    const memberView = await loginAlumni(member.email, member.password);
    const after = await step("get", `/me/tickets/${ticket.id}`, "/me/tickets/{ticketId}", 200, undefined, {
      token: memberView.token,
    });
    expect(after.json.checked_in_at).not.toBeNull();
    // QR palsu → tidak ditemukan.
    const forged = await call(
      "post",
      "/admin/checkin",
      { event_id: event.id, qr_code: "0".repeat(32) },
      { token: scanner.token },
    );
    expect(forged.statusCode, show("post", "/admin/checkin (palsu)", forged)).toBe(404);
    expect(expectOperation("post", "/admin/checkin", forged)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("AC F09-3: event gratis → tiket langsung paid dengan QR tanpa payment; batal melepas kursi", async () => {
    const admin = await adminFixture({ permissions: ["events.manage", "events.checkin"] });
    const event = await createOpenEvent(admin, {
      title: "Kajian Gratis Perjalanan",
      price: "0.00",
      seats: 5,
      startsInMs: 7 * DAY,
    });
    const member = await memberFixture({ status: "verified", fullName: "Fajar Gratis" });
    const reserved = await step(
      "post",
      `/events/${event.id}/reservations`,
      "/events/{eventId}/reservations",
      201,
      { expected_price: "0.00" },
      { token: member.token, idem: true, headers: APP },
    );
    expect(reserved.json).toMatchObject({ status: "paid", total: "0.00", payment: null });
    expect(reserved.json.qr_code).toEqual(expect.any(String));
    const [payments] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.payments where ticket_id = ${reserved.json.id}`;
    expect(payments!.n).toBe(0);
    // Pesan ulang → satu tiket aktif per anggota per event.
    const again = await call(
      "post",
      `/events/${event.id}/reservations`,
      { expected_price: "0.00" },
      { token: member.token, headers: APP },
    );
    expect(again.statusCode, show("post", "reservations (ulang)", again)).toBe(409);
    expectOperation("post", "/events/{eventId}/reservations", again);
    // Batal mandiri: kursi dilepas tanpa refund (D6 event gratis).
    const cancel = await step(
      "post",
      `/me/tickets/${reserved.json.id}/cancel`,
      "/me/tickets/{ticketId}/cancel",
      200,
      { expected_refund_eligible: false },
      { token: member.token, idem: true, headers: { ...APP, "if-match": reserved.json.version } },
    );
    expect(cancel.json.status).toBe("cancelled");
    const adminView = await step(
      "get",
      `/admin/events/${event.id}`,
      "/admin/events/{eventId}",
      200,
      undefined,
      {
        token: admin.token,
      },
    );
    expect(adminView.json).toMatchObject({ paid_quantity: 0, seats_available: 5 });
  });

  it("AC F09-7, D6: event berbayar dibatalkan → tiket batal, refund penuh pending, bukti yang menunggu tetap diputus", async () => {
    const admin = await adminFixture({
      permissions: ["events.manage", "payments.read", "payments.decide"],
    });
    const event = await createOpenEvent(admin, {
      title: "Seminar Batal Perjalanan",
      price: "50000.00",
      seats: 10,
      startsInMs: 10 * DAY,
    });
    const paidMember = await memberFixture({ status: "verified", fullName: "Gita Lunas" });
    const reviewMember = await memberFixture({ status: "verified", fullName: "Hadi Review" });
    const holdMember = await memberFixture({ status: "verified", fullName: "Indah Hold" });
    const paid = await reserveWithProof(paidMember, event);
    await decide(admin, paid.paymentId, "approve");
    const review = await reserveWithProof(reviewMember, event);
    const hold = await step(
      "post",
      `/events/${event.id}/reservations`,
      "/events/{eventId}/reservations",
      201,
      { expected_price: event.price, payment_method_id: await bankMethod() },
      { token: holdMember.token, idem: true, headers: APP },
    );
    await drain();

    const current = await step(
      "get",
      `/admin/events/${event.id}`,
      "/admin/events/{eventId}",
      200,
      undefined,
      {
        token: admin.token,
      },
    );
    expect(current.json).toMatchObject({ paid_quantity: 1, held_quantity: 2 });
    expect(current.json.allowed_actions).toContain("cancel");
    const cancelled = await step(
      "post",
      `/admin/events/${event.id}/cancel`,
      "/admin/events/{eventId}/cancel",
      200,
      { reason: "Pembicara berhalangan hadir" },
      { token: admin.token, idem: true, headers: { "if-match": current.json.version } },
    );
    expect(cancelled.json.event.status).toBe("cancelled");
    expect(cancelled.json).toMatchObject({
      refunds_created: 1,
      refund_total: "50000.00",
      payments_in_review: 1,
    });

    // Outbox event.cancelled diproses worker: peserta diberi tahu (AC F09-7).
    const drained = await drain();
    expect(drained.dead).toBe(0);
    for (const who of [paidMember, reviewMember, holdMember]) {
      const inbox = await step("get", "/notifications", "/notifications", 200, undefined, {
        token: who.token,
        query: { category: "event" },
      });
      expect(
        inbox.json.items.length,
        `${who.email}: ${JSON.stringify(inbox.json.items)}`,
      ).toBeGreaterThanOrEqual(1);
      // Email kategori event (bawaan aktif) terkirim oleh worker.
      expect(
        mailer
          .messagesTo(who.email)
          .some((m) => `${m.subject}\n${m.text}`.includes("Seminar Batal Perjalanan")),
        JSON.stringify(mailer.messagesTo(who.email).map((m) => m.subject)),
      ).toBe(true);
    }
    // Tiket paid batal dengan refund pending; QR tidak berlaku.
    const paidTicket = await step(
      "get",
      `/me/tickets/${paid.ticket.id}`,
      "/me/tickets/{ticketId}",
      200,
      undefined,
      { token: paidMember.token },
    );
    expect(paidTicket.json).toMatchObject({ status: "cancelled", cancelled_by: "system", qr_code: null });
    expect(paidTicket.json.refunds).toHaveLength(1);
    expect(paidTicket.json.refunds[0]).toMatchObject({ status: "pending", amount: "50000.00" });
    const holdTicket = await step(
      "get",
      `/me/tickets/${hold.json.id}`,
      "/me/tickets/{ticketId}",
      200,
      undefined,
      {
        token: holdMember.token,
      },
    );
    expect(holdTicket.json).toMatchObject({ status: "cancelled", cancelled_by: "admin" });

    // Bendahara melihat refund pending (D6, 7 hari kerja).
    const refunds = await step(
      "get",
      "/admin/payment-adjustments",
      "/admin/payment-adjustments",
      200,
      undefined,
      {
        token: admin.token,
        query: { status: "pending", kind: "refund", payment_id: paid.paymentId },
      },
    );
    expect(refunds.json.items).toHaveLength(1);
    expect(refunds.json.items[0]).toMatchObject({ amount: "50000.00", has_refund_destination: false });
    // Anggota mengisi rekening tujuan refund.
    const mine = await step(
      "get",
      `/me/payments/${paid.paymentId}`,
      "/me/payments/{paymentId}",
      200,
      undefined,
      { token: paidMember.token },
    );
    const adjustment = mine.json.adjustments[0];
    expect(adjustment).toMatchObject({ kind: "refund", status: "pending", destination_required: true });
    await step(
      "put",
      `/me/payments/${paid.paymentId}/adjustments/${adjustment.id}/refund-destination`,
      "/me/payments/{paymentId}/adjustments/{adjustmentId}/refund-destination",
      200,
      { provider: "Bank Uji", account_number: "1234567890", account_holder: "Gita Lunas" },
      { token: paidMember.token, headers: { ...APP, "if-match": adjustment.version } },
    );

    // Bendahara mentransfer lalu menandai refund selesai dengan bukti (D6); rekening tujuan dihapus (D2).
    const adjDetail = await step(
      "get",
      `/admin/payment-adjustments/${adjustment.id}`,
      "/admin/payment-adjustments/{adjustmentId}",
      200,
      undefined,
      { token: admin.token },
    );
    expect(adjDetail.json.refund_destination).toMatchObject({ account_number: "1234567890" });
    const evidence = await uploadMultipart(admin.token, "adjustment_evidence", {
      data: await testJpeg(),
      filename: "bukti-refund.jpg",
      contentType: "image/jpeg",
    });
    const completed = await step(
      "post",
      `/admin/payment-adjustments/${adjustment.id}/complete`,
      "/admin/payment-adjustments/{adjustmentId}/complete",
      200,
      { evidence_file_id: evidence.json.id },
      { token: admin.token, idem: true, headers: { "if-match": adjDetail.json.version } },
    );
    expect(completed.json).toMatchObject({ status: "completed", refund_destination: null });
    const [stored] = await sql<{ refund_destination: unknown }[]>`
      select refund_destination from app.payment_adjustments where id = ${adjustment.id}`;
    expect(stored!.refund_destination).toBeNull();
    const refundedTicket = await step(
      "get",
      `/me/tickets/${paid.ticket.id}`,
      "/me/tickets/{ticketId}",
      200,
      undefined,
      { token: paidMember.token },
    );
    expect(refundedTicket.json.refunds[0]).toMatchObject({ status: "completed" });

    // Bukti yang sedang direview tetap diputus admin; approve setelah batal → refund otomatis (D6).
    const reviewDetail = await step(
      "get",
      `/admin/payments/${review.paymentId}`,
      "/admin/payments/{paymentId}",
      200,
      undefined,
      { token: admin.token },
    );
    expect(reviewDetail.json).toMatchObject({ event_cancelled: true, refund_on_approve: true });
    const lateApprove = await decide(admin, review.paymentId, "approve");
    expect(lateApprove.status).toBe("paid");
    expect(lateApprove.adjustments).toHaveLength(1);
    const reviewTicket = await step(
      "get",
      `/me/tickets/${review.ticket.id}`,
      "/me/tickets/{ticketId}",
      200,
      undefined,
      { token: reviewMember.token },
    );
    expect(reviewTicket.json.status).toBe("cancelled");
    expect(reviewTicket.json.qr_code).toBeNull();
  });
});

// --------------------------------------------------------------------------------------------------- chat

const sendText = (from: MemberSession, roomId: string, body: string, clientMessageId = uuidv7()) =>
  call(
    "post",
    `/chat/rooms/${roomId}/messages`,
    { client_message_id: clientMessageId, kind: "text", body },
    { token: from.token, headers: APP },
  );

async function connectSocket(member: MemberSession): Promise<TestSocket> {
  return TestSocket.connect(baseUrl, member.token, { app } as unknown as TestApp);
}

describe("D7 (e): chat langsung dan grup dengan undangan, kirim pesan, sinkron ulang Socket.IO", () => {
  it("F-11, AC F11-1..F11-4: direct kanonik → grup undangan → realtime → putus → reconnect sinkron after tanpa duplikasi", async () => {
    const ani = await memberFixture({ status: "verified", fullName: "Ani Chat" });
    const bayu = await memberFixture({ status: "verified", fullName: "Bayu Chat" });
    const cici = await memberFixture({ status: "verified", fullName: "Cici Chat" });
    const sockets: TestSocket[] = [];
    try {
      // AC F11-1: direct dari kedua sisi → satu room kanonik.
      const fromAni = await step(
        "post",
        "/chat/direct",
        "/chat/direct",
        [200, 201],
        { user_id: bayu.userId },
        {
          token: ani.token,
          headers: APP,
        },
      );
      const fromBayu = await step(
        "post",
        "/chat/direct",
        "/chat/direct",
        200,
        { user_id: ani.userId },
        {
          token: bayu.token,
          headers: APP,
        },
      );
      expect(fromBayu.json.id).toBe(fromAni.json.id);
      const directId = fromAni.json.id as string;

      await step(
        "put",
        "/devices",
        "/devices",
        204,
        { platform: "android", token: `fcm-chat-${bayu.userId}`, app_version: "1.0.0" },
        { token: bayu.token },
      );
      const bayuSocket = await connectSocket(bayu);
      sockets.push(bayuSocket);
      // AC F11-2: ack sesudah commit; client_message_id diulang → pesan yang sama.
      const clientId = uuidv7();
      const first = await sendText(ani, directId, "Assalamualaikum, apa kabar?", clientId);
      expect(first.statusCode, show("post", "messages", first)).toBe(201);
      const firstMsg = expectOperation("post", "/chat/rooms/{roomId}/messages", first) as Json;
      const retry = await sendText(ani, directId, "Assalamualaikum, apa kabar?", clientId);
      expect(retry.statusCode, show("post", "messages (ulang)", retry)).toBe(200);
      expect((expectOperation("post", "/chat/rooms/{roomId}/messages", retry) as Json).id).toBe(firstMsg.id);
      const live = await bayuSocket.waitFor("message.created", (e) => e.entity_id === firstMsg.id);
      expect(live.payload.room_id).toBe(directId);
      const directHistory = await step(
        "get",
        `/chat/rooms/${directId}/messages`,
        "/chat/rooms/{roomId}/messages",
        200,
        undefined,
        { token: bayu.token },
      );
      expect(directHistory.json.items.map((m: Json) => m.id)).toEqual([firstMsg.id]);
      // Status terbaca, typing dan presence sampai ke lawan bicara (PRD 3.11).
      const aniSocket = await connectSocket(ani);
      sockets.push(aniSocket);
      await step(
        "put",
        `/chat/rooms/${directId}/read`,
        "/chat/rooms/{roomId}/read",
        200,
        { message_id: firstMsg.id },
        { token: bayu.token, headers: APP },
      );
      const readEvent = await aniSocket.waitFor("read.updated", (e) => e.payload.user_id === bayu.userId);
      expect(readEvent.payload).toMatchObject({ room_id: directId, last_read_message_id: firstMsg.id });
      bayuSocket.emit("typing", { room_id: directId });
      const typing = await aniSocket.waitFor("typing", (e) => e.payload.user_id === bayu.userId);
      expect(typing.payload.room_id).toBe(directId);
      bayuSocket.emit("presence.ping");
      const presence = await aniSocket.waitFor("presence", (e) => e.payload.user_id === bayu.userId);
      expect(presence.payload.status).toBe("online");
      const aniRoom = await step("get", `/chat/rooms/${directId}`, "/chat/rooms/{roomId}", 200, undefined, {
        token: ani.token,
      });
      expect(aniRoom.json.peer_last_read_message_id).toBe(firstMsg.id);

      // Grup: hanya undangan yang diterima yang menjadi anggota (PRD 3.11).
      const group = await step(
        "post",
        "/chat/rooms",
        "/chat/rooms",
        201,
        { name: "Angkatan 25 Perjalanan", invitee_user_ids: [bayu.userId, cici.userId] },
        { token: ani.token, idem: true, headers: APP },
      );
      const groupId = group.json.room.id as string;
      const preHistory = await sendText(ani, groupId, "Pesan sebelum Cici bergabung");
      expect(preHistory.statusCode).toBe(201);
      // AC F11-4: undangan belum diterima → riwayat ditolak.
      const peek = await call("get", `/chat/rooms/${groupId}/messages`, undefined, { token: cici.token });
      expect([403, 404], show("get", "messages (belum anggota)", peek)).toContain(peek.statusCode);
      expectOperation("get", "/chat/rooms/{roomId}/messages", peek);
      const invites = await step("get", "/chat/invitations", "/chat/invitations", 200, undefined, {
        token: cici.token,
      });
      expect(JSON.stringify(invites.json.items)).toContain(groupId);
      for (const who of [bayu, cici])
        await step(
          "post",
          `/chat/invitations/${groupId}/accept`,
          "/chat/invitations/{roomId}/accept",
          200,
          undefined,
          { token: who.token, idem: true, headers: APP },
        );
      // Anggota baru hanya melihat pesan sejak bergabung (default v3.5).
      const ciciHistory = await step(
        "get",
        `/chat/rooms/${groupId}/messages`,
        "/chat/rooms/{roomId}/messages",
        200,
        undefined,
        { token: cici.token },
      );
      expect(ciciHistory.json.items.map((m: Json) => m.body)).not.toContain("Pesan sebelum Cici bergabung");

      // Realtime grup ke socket Bayu yang sudah tersambung sebelum menerima undangan.
      const hello = await sendText(ani, groupId, "Selamat datang di grup");
      const helloMsg = expectOperation("post", "/chat/rooms/{roomId}/messages", hello) as Json;
      await bayuSocket.waitFor("message.created", (e) => e.entity_id === helloMsg.id);
      const bayuView = await step(
        "get",
        `/chat/rooms/${groupId}/messages`,
        "/chat/rooms/{roomId}/messages",
        200,
        undefined,
        { token: bayu.token },
      );
      const anchor = bayuView.json.items.at(-1).id as string;
      expect(anchor).toBe(helloMsg.id);

      // AC F11-3: koneksi putus sesudah commit → reconnect sinkron `after` jangkar tanpa kehilangan/duplikasi.
      bayuSocket.close();
      const missed: string[] = [];
      for (const text of ["Rapat jam 8", "Bawa laptop"]) {
        const res = await sendText(cici, groupId, text);
        expect(res.statusCode, show("post", "messages", res)).toBe(201);
        missed.push((res.json() as Json).id);
      }
      const reconnected = await connectSocket(bayu);
      sockets.push(reconnected);
      const synced: string[] = [];
      let after = anchor;
      for (;;) {
        const page = await step(
          "get",
          `/chat/rooms/${groupId}/messages`,
          "/chat/rooms/{roomId}/messages",
          200,
          undefined,
          { token: bayu.token, query: { after } },
        );
        synced.push(...page.json.items.map((m: Json) => m.id));
        if (!page.json.next_cursor || page.json.items.length === 0) break;
        after = page.json.items.at(-1).id;
      }
      expect(synced).toEqual(missed);
      // Socket baru tetap menerima pesan grup berikutnya.
      const next = await sendText(ani, groupId, "Sampai jumpa");
      const nextMsg = expectOperation("post", "/chat/rooms/{roomId}/messages", next) as Json;
      await reconnected.waitFor("message.created", (e) => e.entity_id === nextMsg.id);

      // Penanda baca monoton (PRD 3.11).
      const read = await step(
        "put",
        `/chat/rooms/${groupId}/read`,
        "/chat/rooms/{roomId}/read",
        200,
        { message_id: nextMsg.id },
        { token: bayu.token, headers: APP },
      );
      const backwards = await step(
        "put",
        `/chat/rooms/${groupId}/read`,
        "/chat/rooms/{roomId}/read",
        200,
        { message_id: anchor },
        { token: bayu.token, headers: APP },
      );
      expect(JSON.stringify(backwards.json)).toContain(nextMsg.id);
      expect(read.json).toEqual(backwards.json);
      const rooms = await step("get", "/chat/rooms", "/chat/rooms", 200, undefined, { token: bayu.token });
      const groupRow = rooms.json.items.find((r: Json) => r.id === groupId);
      expect(groupRow.unread_count).toBe(0);

      // Push chat ke perangkat Bayu (worker) tidak memuat isi pesan (§4.7).
      await drain();
      const pushes = push.to(`fcm-chat-${bayu.userId}`);
      expect(pushes.length).toBeGreaterThanOrEqual(1);
      const payloads = JSON.stringify(pushes);
      for (const text of [
        "Assalamualaikum",
        "Selamat datang di grup",
        "Rapat jam 8",
        "Bawa laptop",
        "Sampai jumpa",
      ])
        expect(payloads).not.toContain(text);
    } finally {
      for (const s of sockets) s.close();
    }
  });
});

// --------------------------------------------------------------------------------------------- moderasi

describe("D7 (f): laporan → suspend admin → anggota terbatas → banding → cabut suspend", () => {
  it("F-12, AC F12-2..F12-5: laporan pengguna diputus suspend; portal pembatasan; banding; unsuspend dari menu anggota menutup banding", async () => {
    const reporter = await memberFixture({ status: "verified", fullName: "Rina Pelapor", city: "Garut" });
    const target = await memberFixture({ status: "verified", fullName: "Toni Terlapor", city: "Garut" });
    const targetCard = await step("get", "/me/card", "/me/card", 200, undefined, { token: target.token });
    const targetQr = ktaFromQr(targetCard.json.qr.url);
    const targetSocket = await connectSocket(target);
    try {
      // AC F12-2: laporan terdaftar dan dapat dipantau pelapor.
      const report = await step(
        "post",
        "/reports",
        "/reports",
        201,
        { target_type: "user", target_user_id: target.userId, category: "harassment" },
        { token: reporter.token, idem: true, headers: APP },
      );
      const mine = await step("get", `/reports/${report.json.id}`, "/reports/{reportId}", 200, undefined, {
        token: reporter.token,
      });
      expect(mine.json.status).toBe("open");
      // Terlapor tidak dapat membuka laporan itu.
      const leak = await call("get", `/reports/${report.json.id}`, undefined, { token: target.token });
      expect(leak.statusCode, show("get", "/reports/{id} oleh terlapor", leak)).toBe(404);

      const moderator = await adminFixture({
        permissions: ["moderation.read", "moderation.resolve", "members.read"],
      });
      const queue = await step("get", "/admin/reports", "/admin/reports", 200, undefined, {
        token: moderator.token,
      });
      expect(queue.json.items.map((r: Json) => r.id)).toContain(report.json.id);
      const detail = await step(
        "get",
        `/admin/reports/${report.json.id}`,
        "/admin/reports/{reportId}",
        200,
        undefined,
        { token: moderator.token },
      );
      const claimed = await step(
        "post",
        `/admin/reports/${report.json.id}/claim`,
        "/admin/reports/{reportId}/claim",
        200,
        undefined,
        { token: moderator.token, idem: true, headers: { "if-match": detail.json.version } },
      );
      const suspendMessage = "Akun Anda dibatasi karena melanggar ketentuan komunitas.";
      const resolved = await step(
        "post",
        `/admin/reports/${report.json.id}/resolve`,
        "/admin/reports/{reportId}/resolve",
        200,
        {
          action: "suspend",
          note: "Pelecehan berulang terhadap anggota",
          member_message: suspendMessage,
          confirm: true,
        },
        { token: moderator.token, idem: true, headers: { "if-match": claimed.json.version } },
      );
      expect(resolved.json.status).toBe("resolved");

      // AC F12-4: sesi umum dicabut, socket diputus.
      const revoked = await call("get", "/me", undefined, { token: target.token });
      expect(revoked.statusCode, show("get", "/me (sesi lama)", revoked)).toBe(401);
      await targetSocket.waitFor("session.revoked");
      // Portal pembatasan: login tetap memberi sesi terbatas.
      const restricted = await loginAlumni(target.email, target.password);
      const me = await step("get", "/me", "/me", 200, undefined, { token: restricted.token });
      expect(me.json).toMatchObject({ effective_status: "suspended", suspension_message: suspendMessage });
      expect(JSON.stringify(me.json)).not.toContain("Pelecehan berulang");
      for (const [method, path, op, body] of [
        ["get", "/directory", "/directory", undefined],
        ["post", "/chat/direct", "/chat/direct", { user_id: reporter.userId }],
        ["get", "/events", "/events", undefined],
        ["post", "/me/payments", "/me/payments", { type: "renewal", payment_method_id: await bankMethod() }],
      ] as const) {
        const res = await call(method, path, body, { token: restricted.token, headers: APP });
        expect(res.statusCode, show(method, path, res)).toBe(403);
        expect(expectOperation(method, op, res)).toMatchObject({ code: "ACCOUNT_SUSPENDED" });
      }
      const card = await step("get", "/me/card", "/me/card", 200, undefined, { token: restricted.token });
      expect(card.json).toMatchObject({ status_label: "suspended", qr: null });
      // Direktori menyembunyikan profil; verifikasi KTA Tidak aktif (AC F12-4).
      const search = await step("get", "/directory", "/directory", 200, undefined, {
        token: reporter.token,
        query: { q: "Toni Terlapor" },
      });
      expect(search.json.items.map((m: Json) => m.user_id)).not.toContain(target.userId);
      const profile = await call("get", `/directory/${target.userId}`, undefined, { token: reporter.token });
      expect(profile.statusCode, show("get", "/directory/{userId}", profile)).toBe(404);
      const verify = await step("post", "/public/kta/verify", "/public/kta/verify", 200, {
        member_number: targetQr.memberNumber,
        token: targetQr.token,
      });
      expect(verify.json.result).toBe("inactive");
      expect(JSON.stringify(verify.json)).not.toMatch(/Pelecehan|dibatasi karena/);

      // Banding dari portal pembatasan (PRD 3.12).
      const appealBody = { description: "Saya keberatan, pesan saya disalahpahami oleh pelapor." };
      const appeal = await step("post", "/appeals", "/appeals", 201, appealBody, {
        token: restricted.token,
        idem: true,
        headers: APP,
      });
      expect(appeal.json).toMatchObject({ category: "appeal", status: "open" });
      const again = await step("post", "/appeals", "/appeals", 200, appealBody, {
        token: restricted.token,
        idem: true,
        headers: APP,
      });
      expect(again.json.id).toBe(appeal.json.id);
      const appeals = await step("get", "/admin/reports", "/admin/reports", 200, undefined, {
        token: moderator.token,
        query: { category: "appeal" },
      });
      expect(appeals.json.items.map((r: Json) => r.id)).toContain(appeal.json.id);

      // Unsuspend dari menu anggota admin menutup banding sebagai dikabulkan (admin-members.yaml).
      const member = await step(
        "get",
        `/admin/members/${target.userId}`,
        "/admin/members/{userId}",
        200,
        undefined,
        { token: moderator.token },
      );
      const unsuspended = await step(
        "post",
        `/admin/members/${target.userId}/unsuspend`,
        "/admin/members/{userId}/unsuspend",
        200,
        {
          reason: "Banding diterima setelah peninjauan ulang",
          member_message: "Pembatasan dicabut.",
          confirm: true,
        },
        { token: moderator.token, idem: true, headers: { "if-match": member.json.version } },
      );
      expect(unsuspended.json.effective_status).toBe("verified");
      // AC F12-5: dihitung ulang dari expires_at.
      const meAfter = await step("get", "/me", "/me", 200, undefined, { token: restricted.token });
      expect(meAfter.json).toMatchObject({ effective_status: "verified", suspension_message: null });
      const appealView = await step(
        "get",
        `/reports/${appeal.json.id}`,
        "/reports/{reportId}",
        200,
        undefined,
        {
          token: restricted.token,
        },
      );
      expect(appealView.json).toMatchObject({ status: "resolved", outcome: "action_taken" });
      await drain();
      const notices = await step("get", "/notifications", "/notifications", 200, undefined, {
        token: restricted.token,
        query: { category: "account" },
      });
      expect(notices.json.items.length).toBeGreaterThanOrEqual(2);
      // Pelapor diberi tahu laporannya selesai ditinjau tanpa rincian tindakan (AC F12-2).
      const reporterNotices = await step("get", "/notifications", "/notifications", 200, undefined, {
        token: reporter.token,
        query: { category: "account" },
      });
      expect(reporterNotices.json.items.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(reporterNotices.json.items)).not.toMatch(/suspend|dibatasi/i);
      // Kembali tampil di direktori dan KTA aktif lagi.
      const back = await step("get", "/directory", "/directory", 200, undefined, {
        token: reporter.token,
        query: { q: "Toni Terlapor" },
      });
      expect(back.json.items.map((m: Json) => m.user_id)).toContain(target.userId);
      const verifyBack = await step("post", "/public/kta/verify", "/public/kta/verify", 200, {
        member_number: targetQr.memberNumber,
        token: targetQr.token,
      });
      expect(verifyBack.json.result).toBe("active");
    } finally {
      targetSocket.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ direktori

async function updateProfile(member: MemberSession, patch: Record<string, unknown>): Promise<Json> {
  const me = await step("get", "/me", "/me", 200, undefined, { token: member.token });
  const { json } = await step("patch", "/me/profile", "/me/profile", 200, patch, {
    token: member.token,
    headers: { ...APP, "if-match": me.json.version },
  });
  return json;
}

describe("D7 (g): pencarian direktori dengan privasi", () => {
  it("F-10, AC F10-1..F10-3: hanya verified/expiring yang tampil; kontak tersembunyi tidak ikut payload; paging tanpa duplikasi", async () => {
    const city = `Kota${uuidv7().replace(/-/g, "").slice(-8)}`;
    const viewer = await memberFixture({ status: "verified", fullName: "Vina Pencari", city: "Bogor" });
    const privateMember = await memberFixture({ status: "verified", fullName: "Paris Privat", city });
    const openMember = await memberFixture({ status: "expiring", fullName: "Opik Terbuka", city });
    const hidden = await memberFixture({ status: "verified", fullName: "Hana Tersembunyi", city });
    const unverified = await memberFixture({ status: "unverified", fullName: "Umar Belum", city });
    await memberFixture({ status: "expired", fullName: "Eko Habis", city });
    await createAlumni(fx, { status: "suspended", fullName: "Sari Dibatasi", city });

    const privateProfile = await updateProfile(privateMember, {
      phone: "+6281234500001",
      social_instagram: "@paris.privat",
      privacy: { show_phone: false, show_email: false, show_social: false },
    });
    expect(privateProfile.profile.privacy).toMatchObject({ show_in_directory: true, show_phone: false });
    await updateProfile(openMember, {
      phone: "+6281234500002",
      social_instagram: "@opik.terbuka",
      privacy: { show_phone: true, show_email: true, show_social: true },
    });
    await updateProfile(hidden, { privacy: { show_in_directory: false } });

    // AC F10-1: hasil dan total mengikuti filter dan status terkini.
    const all = await step("get", "/directory", "/directory", 200, undefined, {
      token: viewer.token,
      query: { city },
    });
    expect(all.json.items.map((m: Json) => m.user_id).sort()).toEqual(
      [privateMember.userId, openMember.userId].sort(),
    );
    expect(all.json.total).toBe(2);
    // Paging limit 1 tanpa duplikasi, total tetap.
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await step("get", "/directory", "/directory", 200, undefined, {
        token: viewer.token,
        query: { city, limit: "1", ...(cursor ? { cursor } : {}) },
      });
      expect(page.json.total).toBe(2);
      paged.push(...page.json.items.map((m: Json) => m.user_id));
      cursor = page.json.next_cursor ?? undefined;
    } while (cursor);
    expect(paged).toHaveLength(2);
    expect(new Set(paged).size).toBe(2);
    // Pencarian nama.
    const byName = await step("get", "/directory", "/directory", 200, undefined, {
      token: viewer.token,
      query: { q: "Paris Privat" },
    });
    expect(byName.json.items.map((m: Json) => m.user_id)).toContain(privateMember.userId);

    // AC F10-2: kontak tersembunyi tidak ada di payload (bukan sekadar disamarkan UI).
    const priv = await step(
      "get",
      `/directory/${privateMember.userId}`,
      "/directory/{userId}",
      200,
      undefined,
      { token: viewer.token },
    );
    expect(priv.res.body).not.toContain("6281234500001");
    expect(priv.res.body).not.toContain(privateMember.email);
    expect(priv.res.body).not.toContain("paris.privat");
    expect(priv.json.phone ?? null).toBeNull();
    expect(priv.json.email ?? null).toBeNull();
    const open = await step("get", `/directory/${openMember.userId}`, "/directory/{userId}", 200, undefined, {
      token: viewer.token,
    });
    expect(open.json).toMatchObject({ phone: "+6281234500002", email: openMember.email });
    // "@" di depan dibuang server (SocialHandle, me.yaml).
    expect(open.json.social.instagram).toBe("opik.terbuka");
    // Profil yang tidak boleh tampil → 404 (tidak membocorkan alasan).
    for (const other of [hidden, unverified]) {
      const res = await call("get", `/directory/${other.userId}`, undefined, { token: viewer.token });
      expect(res.statusCode, show("get", "/directory/{userId}", res)).toBe(404);
      expectOperation("get", "/directory/{userId}", res);
    }
    // AC F10-3: unverified dan publik ditolak.
    const denied = await call("get", "/directory", undefined, { token: unverified.token, query: { city } });
    expect(denied.statusCode, show("get", "/directory (unverified)", denied)).toBe(403);
    expect(expectOperation("get", "/directory", denied)).toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
    const anonymous = await call("get", "/directory", undefined, { query: { city } });
    expect(anonymous.statusCode).toBe(401);
    expectOperation("get", "/directory", anonymous);
    // Pengurus berizin tetap melihat data administratif (PRD 3.10).
    const admin = await adminFixture({ permissions: ["members.read"] });
    const adminView = await step(
      "get",
      `/admin/members/${privateMember.userId}`,
      "/admin/members/{userId}",
      200,
      undefined,
      { token: admin.token },
    );
    expect(adminView.res.body).toContain("6281234500001");
  });
});

// ------------------------------------------------------------------------------------------- admin & izin

describe("D7 (h): undangan admin → terima → daftar TOTP → perubahan izin berlaku seketika", () => {
  it("F-16, AC F16-1, F16-3, F02-2: Super Admin mengundang alumni → email undangan worker → aktivasi → izin dicabut/ditambah tanpa login ulang", async () => {
    const superAdmin = await adminFixture({ role: "super_admin", displayName: "Super Admin Perjalanan" });
    const candidate = await memberFixture({ status: "verified", fullName: "Wawan Calon Pengurus" });
    const candidates = await step(
      "get",
      "/admin/admins/candidates",
      "/admin/admins/candidates",
      200,
      undefined,
      {
        token: superAdmin.token,
        query: { q: "Wawan Calon" },
      },
    );
    const listed = candidates.json.items.find((c: Json) => c.user_id === candidate.userId);
    expect(listed, JSON.stringify(candidates.json.items)).toMatchObject({ eligible: true });

    // Tanpa reautentikasi ditolak (PRD 2.3).
    const adminEmail = freshEmail("pengurus");
    const inviteBody = {
      alumni_user_id: candidate.userId,
      email: adminEmail,
      display_name: "Wawan Bendahara",
      role: "admin",
      permissions: ["payments.read"],
    };
    const noReauth = await call("post", "/admin/admins", inviteBody, { token: superAdmin.token });
    expect(noReauth.statusCode, show("post", "/admin/admins", noReauth)).toBe(403);
    expect(expectOperation("post", "/admin/admins", noReauth)).toMatchObject({ code: "REAUTH_REQUIRED" });
    const invited = await step("post", "/admin/admins", "/admin/admins", 201, inviteBody, {
      token: superAdmin.token,
      idem: true,
      headers: await adminReauth(superAdmin),
    });
    const adminId = invited.json.admin.id as string;
    expect(invited.json.admin).toMatchObject({
      status: "invited",
      permissions: ["payments.read"],
      mfa_enrolled: false,
    });

    // Worker mengirim email undangan; token di fragmen #t= (ARCHITECTURE §7).
    await drain();
    const mail = mailer.lastMessage(adminEmail);
    expect(mail, "email undangan admin").toBeDefined();
    const link = /(https?:\/\/[^\s"<>]+\/invite#t=[A-Za-z0-9_%-]+)/.exec(
      `${mail!.text}\n${mail!.html ?? ""}`,
    );
    expect(link, mail!.text).not.toBeNull();
    expect(link![1]!.startsWith(`${testEnv.ADMIN_ORIGIN}/invite#t=`)).toBe(true);
    const inviteToken = decodeURIComponent(link![1]!.split("#t=")[1]!);

    // Aktivasi: preview → terima (ganti sandi awal) → daftar TOTP → konfirmasi.
    const preview = await step(
      "post",
      "/admin/auth/invitations/preview",
      "/admin/auth/invitations/preview",
      200,
      { invite_token: inviteToken },
    );
    expect(preview.json).toMatchObject({ role: "admin", permissions: ["payments.read"] });
    const newPassword = "Bendahara#2026";
    const accepted = await step(
      "post",
      "/admin/auth/invitations/accept",
      "/admin/auth/invitations/accept",
      200,
      { invite_token: inviteToken, password: newPassword },
    );
    expect(accepted.json.totp_enrollment_required).toBe(true);
    // Sesi tahap sandi tidak dapat memakai API admin (AC F02-2).
    const premature = await call("get", "/admin/me", undefined, { token: accepted.json.mfa_token });
    expect([401, 403], show("get", "/admin/me (mfa_token)", premature)).toContain(premature.statusCode);
    expect(["UNAUTHENTICATED", "MFA_REQUIRED"]).toContain(
      (expectOperation("get", "/admin/me", premature) as Json).code,
    );
    const enroll = await step("post", "/admin/auth/totp/enroll", "/admin/auth/totp/enroll", 200, {
      mfa_token: accepted.json.mfa_token,
    });
    const secret = enroll.json.secret as string;
    const confirmStep = nextTotp(secret, -1);
    const confirmed = await step("post", "/admin/auth/totp/confirm", "/admin/auth/totp/confirm", 200, {
      mfa_token: accepted.json.mfa_token,
      totp_code: confirmStep.code,
    });
    expect(confirmed.json.backup_codes).toHaveLength(10);
    const treasurer = confirmed.json.session.access_token as string;
    // Token undangan sekali pakai.
    const reused = await call("post", "/admin/auth/invitations/accept", {
      invite_token: inviteToken,
      password: newPassword,
    });
    expect(reused.statusCode, show("post", "accept (ulang)", reused)).toBe(410);

    const me = await step("get", "/admin/me", "/admin/me", 200, undefined, { token: treasurer });
    expect(me.json.permissions).toEqual(["payments.read"]);
    // Pemberitahuan keamanan aktivasi dikirim worker ke email admin (admin.security_notice kind activated).
    const mailsBefore = mailer.messagesTo(adminEmail).length;
    await drain();
    expect(mailer.messagesTo(adminEmail).length).toBeGreaterThan(mailsBefore);
    await step("get", "/admin/payments", "/admin/payments", 200, undefined, { token: treasurer });
    const noEvents = await call("get", "/admin/events", undefined, { token: treasurer });
    expect(noEvents.statusCode, show("get", "/admin/events", noEvents)).toBe(403);
    expectOperation("get", "/admin/events", noEvents);
    // Akun admin terpisah: sesi alumni tidak memberi akses admin.
    const alumniAsAdmin = await call("get", "/admin/payments", undefined, { token: candidate.token });
    expect([401, 403], show("get", "/admin/payments (token alumni)", alumniAsAdmin)).toContain(
      alumniAsAdmin.statusCode,
    );
    expectOperation("get", "/admin/payments", alumniAsAdmin);

    // AC F16-3: izin diubah Super Admin berlaku pada token yang sama tanpa login ulang.
    const current = await step("get", `/admin/admins/${adminId}`, "/admin/admins/{adminId}", 200, undefined, {
      token: superAdmin.token,
    });
    expect(current.json).toMatchObject({ status: "active", mfa_enrolled: true });
    const updated = await step(
      "patch",
      `/admin/admins/${adminId}`,
      "/admin/admins/{adminId}",
      200,
      { permissions: ["events.manage"], reason: "Pindah ke seksi acara" },
      {
        token: superAdmin.token,
        headers: { ...(await adminReauth(superAdmin)), "if-match": current.json.version },
      },
    );
    expect(updated.json.permissions).toEqual(["events.manage"]);
    await step("get", "/admin/events", "/admin/events", 200, undefined, { token: treasurer });
    const revokedPayments = await call("get", "/admin/payments", undefined, { token: treasurer });
    expect(revokedPayments.statusCode, show("get", "/admin/payments (izin dicabut)", revokedPayments)).toBe(
      403,
    );
    expectOperation("get", "/admin/payments", revokedPayments);

    // Dinonaktifkan → token yang masih berlaku ditolak.
    const latest = await step("get", `/admin/admins/${adminId}`, "/admin/admins/{adminId}", 200, undefined, {
      token: superAdmin.token,
    });
    await step(
      "patch",
      `/admin/admins/${adminId}`,
      "/admin/admins/{adminId}",
      200,
      { status: "disabled", reason: "Masa bakti selesai" },
      {
        token: superAdmin.token,
        headers: { ...(await adminReauth(superAdmin)), "if-match": latest.json.version },
      },
    );
    const disabled = await call("get", "/admin/me", undefined, { token: treasurer });
    expect(disabled.statusCode, show("get", "/admin/me (nonaktif)", disabled)).toBe(401);

    // Jejak audit invite/aktivasi/izin (AC F16-1).
    const [audits] = await sql<{ actions: string[] }[]>`
      select array_agg(action order by created_at) as actions from app.audit_logs
      where entity_id = ${adminId}`;
    expect(audits!.actions.length, JSON.stringify(audits!.actions)).toBeGreaterThanOrEqual(3);
  });
});

// ------------------------------------------------------------------------------------------------ audit

/** Parser CSV RFC 4180 minimal (sel berkutip, kutip ganda di dalam sel, baris CRLF). */
function parseCsv(text: string): string[][] {
  const rowsOut: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rowsOut.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rowsOut.push(row);
  }
  return rowsOut;
}

describe("D7 (i): ekspor audit CSV", () => {
  it("F-17, AC F17-2..F17-4: pencarian dan ekspor memakai filter yang sama; formula dinetralkan; tanpa izin ditolak", async () => {
    // Keputusan pembayaran beralasan "formula" menghasilkan audit yang akan diekspor.
    const member = await memberFixture({ status: "unverified", fullName: "Mira Audit" });
    const payment = await submitDues(member, "registration", {
      data: await testJpeg(),
      filename: "audit.jpg",
      contentType: "image/jpeg",
    });
    const treasurer = await adminFixture({ permissions: ["payments.read", "payments.decide"] });
    const formula = '=HYPERLINK("http://contoh.test/x","klik")';
    await decide(treasurer, payment.id, "reject", formula);

    const auditor = await adminFixture({ permissions: ["audit.read", "audit.export"] });
    const search = await step("get", "/admin/audit/entries", "/admin/audit/entries", 200, undefined, {
      token: auditor.token,
      query: { entity_id: payment.id },
    });
    expect(search.json.items.map((e: Json) => e.action)).toContain("payment.rejected");
    const exportJob = await step(
      "post",
      "/admin/audit/exports",
      "/admin/audit/exports",
      202,
      { entity_id: payment.id },
      { token: auditor.token, idem: true },
    );
    expect(exportJob.json).toMatchObject({ status: "processing", filters: { entity_id: payment.id } });

    // Worker memproses topik audit.export.requested.
    const drained = await drain();
    expect(drained.dead).toBe(0);
    const ready = await step(
      "get",
      `/admin/audit/exports/${exportJob.json.id}`,
      "/admin/audit/exports/{exportId}",
      200,
      undefined,
      { token: auditor.token },
    );
    expect(ready.json.status, JSON.stringify(ready.json)).toBe("ready");
    // AC F17-4: hasil ekspor = hasil pencarian dengan filter yang sama.
    expect(ready.json.row_count).toBe(search.json.total);
    const access = await step(
      "get",
      `/admin/audit/exports/${exportJob.json.id}/access`,
      "/admin/audit/exports/{exportId}/access",
      200,
      undefined,
      { token: auditor.token },
    );
    const file = await openSignedUrl(access.json.url);
    expect(file.statusCode, show("get", "unduh CSV", file)).toBe(200);
    expect(String(file.headers["content-type"])).toMatch(/^text\/csv/);
    const csv = parseCsv(file.body.startsWith(String.fromCharCode(0xfeff)) ? file.body.slice(1) : file.body);
    const [header, ...records] = csv.filter((r) => r.length > 1);
    expect(records).toHaveLength(search.json.total);
    // AC F17-3: tidak ada sel yang dapat dieksekusi sebagai formula.
    for (const record of records)
      for (const value of record) expect(/^[=+\-@\t\r]/.test(value), `sel formula: ${value}`).toBe(false);
    expect(file.body).toContain(`'${formula.replaceAll('"', '""')}`);
    expect(header!.join(",").toLowerCase()).not.toMatch(/password|token|secret/);
    expect(file.body).not.toContain(member.email);

    // AC F17-4: filter gabungan (nama aktor, peran, aksi, rentang waktu) memberi jumlah yang sama di pencarian
    // dan ekspor.
    // Aktor = bendahara (bukan auditor, karena permintaan ekspor auditor sendiri juga tercatat di audit).
    const filters = {
      actor_admin_id: treasurer.fixture.adminId,
      effective_role: "admin",
      from: new Date(clock.now().getTime() - 400 * DAY).toISOString(),
      to: new Date(clock.now().getTime() + HOUR).toISOString(),
    };
    const extras: Record<string, string>[] = [{}, { action: "payment.rejected" }, { entity_type: "payment" }];
    for (const extra of extras) {
      const query: Record<string, string> = { ...filters, ...extra };
      const counted = await step("get", "/admin/audit/entries", "/admin/audit/entries", 200, undefined, {
        token: auditor.token,
        query,
      });
      expect(counted.json.total, JSON.stringify(query)).toBeGreaterThan(0);
      const exported = await step("post", "/admin/audit/exports", "/admin/audit/exports", 202, query, {
        token: auditor.token,
        idem: true,
      });
      await drain();
      const result = await step(
        "get",
        `/admin/audit/exports/${exported.json.id}`,
        "/admin/audit/exports/{exportId}",
        200,
        undefined,
        { token: auditor.token },
      );
      expect(result.json.status, JSON.stringify(result.json)).toBe("ready");
      expect(result.json.row_count, JSON.stringify(query)).toBe(counted.json.total);
    }

    // AC F17-2: tanpa audit.export ditolak walaupun id ekspor diketahui.
    const reader = await adminFixture({ permissions: ["audit.read"] });
    for (const [method, path, op] of [
      ["post", "/admin/audit/exports", "/admin/audit/exports"],
      ["get", `/admin/audit/exports/${exportJob.json.id}`, "/admin/audit/exports/{exportId}"],
      ["get", `/admin/audit/exports/${exportJob.json.id}/access`, "/admin/audit/exports/{exportId}/access"],
    ] as const) {
      const res = await call(method, path, method === "post" ? { entity_id: payment.id } : undefined, {
        token: reader.token,
      });
      expect(res.statusCode, show(method, path, res)).toBe(403);
      expectOperation(method, op, res);
    }
    // Kepemilikan: pengurus lain dengan izin lengkap (bukan Super Admin) tidak melihat/mengunduh ekspor ini.
    const ownExports = await step("get", "/admin/audit/exports", "/admin/audit/exports", 200, undefined, {
      token: auditor.token,
    });
    expect(ownExports.json.items.map((e: Json) => e.id)).toContain(exportJob.json.id);
    const otherAuditor = await adminFixture({ permissions: ["audit.read", "audit.export"] });
    const others = await step("get", "/admin/audit/exports", "/admin/audit/exports", 200, undefined, {
      token: otherAuditor.token,
    });
    expect(others.json.items.map((e: Json) => e.id)).not.toContain(exportJob.json.id);
    const foreign = await call("get", `/admin/audit/exports/${exportJob.json.id}/access`, undefined, {
      token: otherAuditor.token,
    });
    expect([403, 404], show("get", "access ekspor orang lain", foreign)).toContain(foreign.statusCode);
    expectOperation("get", "/admin/audit/exports/{exportId}/access", foreign);
    // Permintaan, penyelesaian dan unduhan ekspor tercatat di audit (PRD 3.17).
    const exportAudit = await sql<{ action: string }[]>`
      select action from app.audit_logs where entity_id = ${exportJob.json.id} order by created_at`;
    expect(exportAudit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["audit.export.requested", "audit.export.completed", "audit.export.downloaded"]),
    );
    // N-14: request_id permintaan HTTP menghubungkan audit API dan audit job worker.
    const requestId = String(exportJob.res.headers["x-request-id"]);
    const correlated = await sql<{ action: string; request_id: string }[]>`
      select action, request_id from app.audit_logs
      where entity_id = ${exportJob.json.id} and action in ('audit.export.requested', 'audit.export.completed')`;
    expect(correlated.map((a) => `${a.action}:${a.request_id}`).sort()).toEqual([
      `audit.export.completed:${requestId}`,
      `audit.export.requested:${requestId}`,
    ]);
  });
});

// ------------------------------------------------------------------------------------------ hapus akun

describe("D7 (j): permintaan hapus akun → job worker → login ditolak → status web", () => {
  it("F-14, AC F14-1, F14-3, F06-2: hapus akun dari aplikasi; portal web menampilkan status; data pribadi hilang", async () => {
    const leaver = await memberFixture({ status: "verified", fullName: "Lutfi Pamit" });
    const friend = await memberFixture({ status: "verified", fullName: "Kiki Teman" });
    // Jejak data: avatar, KTA, chat, perangkat.
    const avatar = await uploadMultipart(leaver.token, "avatar", {
      data: await testJpeg({ width: 128, height: 128 }),
      filename: "avatar.jpg",
      contentType: "image/jpeg",
    });
    await updateProfile(leaver, { avatar_file_id: avatar.json.id, phone: "+6281299990000" });
    const card = await step("get", "/me/card", "/me/card", 200, undefined, { token: leaver.token });
    const qr = ktaFromQr(card.json.qr.url);
    const room = await step(
      "post",
      "/chat/direct",
      "/chat/direct",
      [200, 201],
      { user_id: friend.userId },
      {
        token: leaver.token,
        headers: APP,
      },
    );
    const secretText = "Nomor rekening saya 7000999 jangan disebar";
    const sent = await sendText(leaver, room.json.id, secretText);
    expect(sent.statusCode).toBe(201);
    await step(
      "put",
      "/devices",
      "/devices",
      204,
      { platform: "android", token: `fcm-hapus-${leaver.userId}`, app_version: "1.0.0" },
      { token: leaver.token },
    );

    // Pengungkapan lalu permintaan dengan reautentikasi ≤ 10 menit (PRD 3.14).
    const disclosure = await step(
      "get",
      "/me/deletion/disclosure",
      "/me/deletion/disclosure",
      200,
      undefined,
      {
        token: leaver.token,
      },
    );
    const deletionBody = { confirm: true, acknowledged_disclosure_version: disclosure.json.version };
    const noReauth = await call("post", "/me/deletion", deletionBody, { token: leaver.token, headers: APP });
    expect(noReauth.statusCode, show("post", "/me/deletion", noReauth)).toBe(403);
    expect(expectOperation("post", "/me/deletion", noReauth)).toMatchObject({ code: "REAUTH_REQUIRED" });
    const requested = await step("post", "/me/deletion", "/me/deletion", 202, deletionBody, {
      token: leaver.token,
      idem: true,
      headers: { ...APP, ...(await memberReauth(leaver)) },
    });
    expect(requested.json).toMatchObject({ status: "pending", source: "app" });
    const requestNumber = requested.json.request_number as string;

    // AC F14-1: sesi dicabut; login tidak menerbitkan sesi, mengarahkan ke status penghapusan.
    const oldSession = await call("get", "/me", undefined, { token: leaver.token });
    expect(oldSession.statusCode, show("get", "/me (sesi lama)", oldSession)).toBe(401);
    const pendingLogin = await step("post", "/auth/login", "/auth/login", 200, {
      email: leaver.email,
      password: leaver.password,
    });
    expect(pendingLogin.json).toMatchObject({
      next: "deletion_pending",
      deletion: { request_number: requestNumber },
    });
    expect(pendingLogin.json.session).toBeUndefined();

    // Portal web /delete-account: challenge email → verifikasi → status permintaan (tanpa sesi).
    const challenge = await step("post", "/public/deletion/challenge", "/public/deletion/challenge", 202, {
      email: leaver.email,
    });
    const code = mailer.last(leaver.email);
    expect(code, "OTP deletion terkirim").toBeDefined();
    const status = await step("post", "/public/deletion/verify", "/public/deletion/verify", 200, {
      challenge_id: challenge.json.challenge_id,
      code,
    });
    expect(status.json).toMatchObject({
      deletable: false,
      blocked_reason: "deletion_in_progress",
      deletion: { request_number: requestNumber },
      deletion_token: null,
    });

    // Job worker (topik account.deletion.requested) menyelesaikan penghapusan.
    const drained = await drain();
    expect(drained.dead).toBe(0);
    const [row] = await sql<{ status: string; last_error: string | null }[]>`
      select status, last_error from app.account_deletions where request_number = ${requestNumber}`;
    expect(row, "baris account_deletions").toBeDefined();
    expect(row!.status, String(row!.last_error)).toBe("completed");
    // Pemberitahuan selesai dikirim (PRD 3.14).
    const completionMail = [...mailer.mail, ...mailer.messages].filter(
      (m) => (m as { to: string }).to === leaver.email,
    );
    expect(JSON.stringify(completionMail)).toContain(requestNumber);

    // Login ditolak tanpa membocorkan status (kredensial tidak lagi ada).
    const refused = await call("post", "/auth/login", { email: leaver.email, password: leaver.password });
    expect(refused.statusCode, show("post", "/auth/login (terhapus)", refused)).toBe(401);
    expectOperation("post", "/auth/login", refused);

    // AC F06-2: nomor KTA tidak ditemukan setelah penghapusan.
    const verify = await step("post", "/public/kta/verify", "/public/kta/verify", 200, {
      member_number: qr.memberNumber,
      token: qr.token,
    });
    expect(["not_found", "inactive"]).toContain(verify.json.result);
    expect(verify.json.member).toBeNull();
    // AC F14-3: isi chat menjadi placeholder; profil tidak ada di direktori.
    const history = await step(
      "get",
      `/chat/rooms/${room.json.id}/messages`,
      "/chat/rooms/{roomId}/messages",
      200,
      undefined,
      { token: friend.token },
    );
    expect(history.res.body).not.toContain(secretText);
    expect(history.res.body).not.toContain("Lutfi Pamit");
    const profile = await call("get", `/directory/${leaver.userId}`, undefined, { token: friend.token });
    expect(profile.statusCode).toBe(404);
    const [user] = await sql<{ status: string; email: string; password_hash: string | null }[]>`
      select status, email, password_hash from app.users where id = ${leaver.userId}`;
    expect(user!.status).toBe("deleted");
    expect(user!.email).not.toBe(leaver.email);
    const [leftovers] = await sql<{ files: number; devices: number; phone: string | null }[]>`
      select (select count(*)::int from app.files where owner_user_id = ${leaver.userId}) as files,
             (select count(*)::int from app.device_tokens where user_id = ${leaver.userId} and revoked_at is null) as devices,
             (select phone from app.alumni where user_id = ${leaver.userId}) as phone`;
    expect(leftovers).toMatchObject({ files: 0, devices: 0, phone: null });

    // Portal web setelah selesai: email lama tidak lagi dikenali (tanpa OTP baru ke alamat itu).
    const before = mailer.sent.filter((m) => m.to === leaver.email).length;
    const after = await step("post", "/public/deletion/challenge", "/public/deletion/challenge", 202, {
      email: leaver.email,
    });
    expect(after.json.challenge_id).toEqual(expect.any(String));
    expect(mailer.sent.filter((m) => m.to === leaver.email)).toHaveLength(before);
  });
});

// ============================================================================ perluasan journey (cabang penting)

describe("D7 (d+): hold kedaluwarsa, bukti ditolak, pesan ulang, tiket anggota suspended/expired saat check-in", () => {
  it("AC F09-1, F09-2, F09-4: kursi terakhir → hold lewat batas (job) → bukti telat ditolak → tolak bukti → pesan ulang tiket baru", async () => {
    const admin = await adminFixture({ permissions: ["events.manage", "payments.read", "payments.decide"] });
    const event = await createOpenEvent(admin, {
      title: "Workshop Satu Kursi",
      price: "25000.00",
      seats: 1,
      startsInMs: 6 * DAY,
    });
    const first = await memberFixture({ status: "verified", fullName: "Nana Hold" });
    const second = await memberFixture({ status: "verified", fullName: "Odi Antre" });
    const hold = await step(
      "post",
      `/events/${event.id}/reservations`,
      "/events/{eventId}/reservations",
      201,
      { expected_price: event.price, payment_method_id: await bankMethod() },
      { token: first.token, idem: true, headers: APP },
    );
    // D5: hold 24 jam (registrasi masih lama ditutup).
    expect(new Date(hold.json.hold_expires_at).getTime() - clock.now().getTime()).toBe(24 * HOUR);
    const soldOut = await call(
      "post",
      `/events/${event.id}/reservations`,
      { expected_price: event.price, payment_method_id: await bankMethod() },
      { token: second.token, headers: APP },
    );
    expect(soldOut.statusCode, show("post", "reservations (habis)", soldOut)).toBe(409);
    expect(expectOperation("post", "/events/{eventId}/reservations", soldOut)).toMatchObject({
      code: "EVENT_SOLD_OUT",
    });
    // Bukti diunggah sebelum hold habis, tetapi dikirim sesudahnya.
    const lateProof = await uploadMultipart(first.token, "payment_proof", {
      data: await testJpeg(),
      filename: "telat.jpg",
      contentType: "image/jpeg",
    });
    clock.advance(24 * HOUR + 60_000);
    await runJob("reservations.expire");
    const firstToken = (await loginAlumni(first.email, first.password)).token;
    const late = await call(
      "put",
      `/me/payments/${hold.json.payment.id}/proof`,
      { file_id: lateProof.json.id, expected_proof_version: 0 },
      { token: firstToken, headers: APP },
    );
    expect(late.statusCode, show("put", "proof (hold habis)", late)).toBe(409);
    expect((expectOperation("put", "/me/payments/{paymentId}/proof", late) as Json).code).toMatch(
      /RESERVATION_EXPIRED|PAYMENT_STATE_CONFLICT/,
    );
    const expiredTicket = await step(
      "get",
      `/me/tickets/${hold.json.id}`,
      "/me/tickets/{ticketId}",
      200,
      undefined,
      { token: firstToken },
    );
    expect(expiredTicket.json).toMatchObject({ status: "expired", payment_status: "cancelled" });

    // Kursi kembali → anggota kedua memesan; bukti ditolak → kursi dilepas (AC F09-4).
    const secondToken = (await loginAlumni(second.email, second.password)).token;
    second.token = secondToken;
    const reserved = await reserveWithProof(second, event);
    const freshAdmin = await loginAdmin(admin.fixture, admin.lastStep);
    const rejected = await decide(freshAdmin, reserved.paymentId, "reject", "Nama pengirim tidak sesuai");
    expect(rejected.status).toBe("rejected");
    const cancelledTicket = await step(
      "get",
      `/me/tickets/${reserved.ticket.id}`,
      "/me/tickets/{ticketId}",
      200,
      undefined,
      { token: secondToken },
    );
    expect(cancelledTicket.json).toMatchObject({ status: "cancelled", payment_status: "rejected" });
    // Bukti baru tidak menghidupkan tiket yang dibatalkan (pembayaran tiket ditolak = final).
    const revive = await uploadMultipart(secondToken, "payment_proof", {
      data: await testJpeg(),
      filename: "lagi.jpg",
      contentType: "image/jpeg",
    });
    const reviveRes = await call(
      "put",
      `/me/payments/${reserved.paymentId}/proof`,
      { file_id: revive.json.id, expected_proof_version: 1 },
      { token: secondToken, headers: APP },
    );
    expect(reviveRes.statusCode, show("put", "proof tiket ditolak", reviveRes)).toBe(409);
    expectOperation("put", "/me/payments/{paymentId}/proof", reviveRes);
    // Pendaftaran ulang → tiket dan payment baru.
    const again = await step(
      "post",
      `/events/${event.id}/reservations`,
      "/events/{eventId}/reservations",
      201,
      { expected_price: event.price, payment_method_id: await bankMethod() },
      { token: secondToken, idem: true, headers: APP },
    );
    expect(again.json.id).not.toBe(reserved.ticket.id);
    expect(again.json.payment.id).not.toBe(reserved.paymentId);
    const counts = await step("get", `/admin/events/${event.id}`, "/admin/events/{eventId}", 200, undefined, {
      token: freshAdmin.token,
    });
    expect(counts.json).toMatchObject({ held_quantity: 1, paid_quantity: 0, seats_available: 0 });
  });

  it("PRD 2.2, D6, AC F13-6: tiket anggota expired tetap berlaku saat check-in, tiket anggota suspended tidak; pengingat H-3/H-1 sekali", async () => {
    const admin = await adminFixture({
      permissions: [
        "events.manage",
        "events.checkin",
        "members.read",
        "moderation.read",
        "moderation.resolve",
      ],
    });
    const event = await createOpenEvent(admin, {
      title: "Malam Keakraban Gratis",
      price: "0.00",
      seats: 10,
      startsInMs: 12 * DAY,
    });
    // Anggota expiring (habis 10 hari lagi) memesan sekarang; saat acara ia sudah expired.
    const lapsing = await memberFixture({ status: "expiring", fullName: "Putri Lewat Masa" });
    const suspended = await memberFixture({ status: "verified", fullName: "Qori Dibatasi" });
    const tickets: Record<string, Json> = {};
    for (const who of [lapsing, suspended]) {
      const res = await step(
        "post",
        `/events/${event.id}/reservations`,
        "/events/{eventId}/reservations",
        201,
        { expected_price: "0.00" },
        { token: who.token, idem: true, headers: APP },
      );
      expect(res.json.status).toBe("paid");
      tickets[who.userId] = res.json;
    }
    // Suspend lewat menu anggota admin.
    const member = await step(
      "get",
      `/admin/members/${suspended.userId}`,
      "/admin/members/{userId}",
      200,
      undefined,
      { token: admin.token },
    );
    await step(
      "post",
      `/admin/members/${suspended.userId}/suspend`,
      "/admin/members/{userId}/suspend",
      200,
      { reason: "Penipuan di grup", member_message: "Akun Anda dibatasi.", confirm: true },
      { token: admin.token, idem: true, headers: { "if-match": member.json.version } },
    );

    // Pengingat H-3 lalu H-1: satu per tiket per jenis walau job diulang (AC F13-6).
    const startsAt = new Date(event.starts_at).getTime();
    clock.set(new Date(startsAt - 3 * DAY + 10 * 60_000));
    await runJob("events.reminders");
    await runJob("events.reminders");
    clock.set(new Date(startsAt - DAY + 10 * 60_000));
    await runJob("events.reminders");
    await runJob("events.reminders");
    const lapsingToken = (await loginAlumni(lapsing.email, lapsing.password)).token;
    const reminders = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: lapsingToken,
      query: { category: "event" },
    });
    expect(reminders.json.items, JSON.stringify(reminders.json.items)).toHaveLength(2);

    // Saat acara: anggota expired (PRD 2.2) tetap dapat melihat tiket dan check-in.
    clock.set(new Date(startsAt - HOUR));
    const lapsingNow = (await loginAlumni(lapsing.email, lapsing.password)).token;
    const me = await step("get", "/me", "/me", 200, undefined, { token: lapsingNow });
    expect(me.json.effective_status).toBe("expired");
    const ticketView = await step(
      "get",
      `/me/tickets/${tickets[lapsing.userId].id}`,
      "/me/tickets/{ticketId}",
      200,
      undefined,
      { token: lapsingNow },
    );
    expect(ticketView.json.qr_code).toEqual(expect.any(String));
    const scanner = await loginAdmin(admin.fixture, admin.lastStep);
    await step(
      "post",
      "/admin/checkin",
      "/admin/checkin",
      200,
      { event_id: event.id, qr_code: tickets[lapsing.userId].qr_code },
      { token: scanner.token, idem: true },
    );
    // Anggota suspended: tiket tidak berlaku (PRD 2.2, D6).
    const refused = await call(
      "post",
      "/admin/checkin",
      { event_id: event.id, qr_code: tickets[suspended.userId].qr_code },
      { token: scanner.token },
    );
    expect(refused.statusCode, show("post", "/admin/checkin (anggota suspended)", refused)).toBe(409);
    expect(expectOperation("post", "/admin/checkin", refused)).toMatchObject({
      code: "VALIDATION_ERROR",
      current: { rejection_reason: "holder_ineligible" },
    });
    expect(refused.body).not.toMatch(/Penipuan|dibatasi/);
    const [row] = await sql<{ checked_in_at: string | null }[]>`
      select checked_in_at from app.tickets where id = ${tickets[suspended.userId].id}`;
    expect(row!.checked_in_at).toBeNull();
  });
});

describe("D7 (d++): batal mandiri tiket berbayar (H-3) dan hold yang dibatasi penutupan pendaftaran (D5, D6)", () => {
  it("PRD 3.9 D6, D5: batal sebelum H-3 → refund penuh; sesudah H-3 → tanpa refund; hold = min(24 jam, registration_closes_at)", async () => {
    const admin = await adminFixture({ permissions: ["events.manage", "payments.read", "payments.decide"] });
    const event = await createOpenEvent(admin, {
      title: "Pelatihan Batal Mandiri",
      price: "40000.00",
      seats: 5,
      startsInMs: 6 * DAY,
    });
    const early = await memberFixture({ status: "verified", fullName: "Qiqi Batal Awal" });
    const late = await memberFixture({ status: "verified", fullName: "Rara Batal Telat" });
    const earlyTicket = await reserveWithProof(early, event);
    const lateTicket = await reserveWithProof(late, event);
    await decide(admin, earlyTicket.paymentId, "approve");
    await decide(admin, lateTicket.paymentId, "approve");

    // H-5: refund penuh.
    const before = await step(
      "get",
      `/me/tickets/${earlyTicket.ticket.id}`,
      "/me/tickets/{ticketId}",
      200,
      undefined,
      { token: early.token },
    );
    expect(before.json).toMatchObject({ status: "paid", can_cancel: true, refund_eligible: true });
    const cancelled = await step(
      "post",
      `/me/tickets/${earlyTicket.ticket.id}/cancel`,
      "/me/tickets/{ticketId}/cancel",
      200,
      { expected_refund_eligible: true, reason: "Berhalangan" },
      { token: early.token, idem: true, headers: { ...APP, "if-match": before.json.version } },
    );
    expect(cancelled.json).toMatchObject({ status: "cancelled", cancelled_by: "self" });
    expect(cancelled.json.refunds).toHaveLength(1);
    expect(cancelled.json.refunds[0]).toMatchObject({ status: "pending", amount: "40000.00" });

    // Sesudah H-3: batal tetap boleh tanpa refund; tampilan basi (refund_eligible true) ditolak 409.
    const startsAt = new Date(event.starts_at).getTime();
    const stale = await step(
      "get",
      `/me/tickets/${lateTicket.ticket.id}`,
      "/me/tickets/{ticketId}",
      200,
      undefined,
      {
        token: late.token,
      },
    );
    expect(stale.json.refund_eligible).toBe(true);
    clock.set(new Date(startsAt - 2 * DAY));
    const lateToken = (await loginAlumni(late.email, late.password)).token;
    const mismatch = await call(
      "post",
      `/me/tickets/${lateTicket.ticket.id}/cancel`,
      { expected_refund_eligible: true },
      { token: lateToken, headers: { ...APP, "if-match": stale.json.version } },
    );
    expect(mismatch.statusCode, show("post", "cancel (tampilan basi)", mismatch)).toBe(409);
    expect(expectOperation("post", "/me/tickets/{ticketId}/cancel", mismatch)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { refund_eligible: false },
    });
    const noRefund = await step(
      "post",
      `/me/tickets/${lateTicket.ticket.id}/cancel`,
      "/me/tickets/{ticketId}/cancel",
      200,
      { expected_refund_eligible: false },
      {
        token: lateToken,
        idem: true,
        headers: { ...APP, "if-match": (mismatch.json() as Json).current.version },
      },
    );
    expect(noRefund.json).toMatchObject({ status: "cancelled", refunds: [] });

    // Hold dibatasi registration_closes_at (D5): event yang pendaftarannya tutup 5 jam lagi.
    const admin2 = await loginAdmin(admin.fixture, admin.lastStep);
    const now = clock.now();
    const soonStart = new Date(now.getTime() + DAY + 5 * HOUR);
    const soon = await step(
      "post",
      "/admin/events",
      "/admin/events",
      201,
      {
        title: "Kopdar Mendadak",
        starts_at: soonStart.toISOString(),
        ends_at: new Date(soonStart.getTime() + 2 * HOUR).toISOString(),
        registration_opens_at: new Date(now.getTime() - HOUR).toISOString(),
        registration_closes_at: new Date(now.getTime() + 5 * HOUR).toISOString(),
        price: "15000.00",
        seats_total: 3,
      },
      { token: admin2.token, idem: true },
    );
    await step(
      "post",
      `/admin/events/${soon.json.id}/status`,
      "/admin/events/{eventId}/status",
      200,
      { status: "open" },
      { token: admin2.token, idem: true, headers: { "if-match": soon.json.version } },
    );
    const holder = await memberFixture({ status: "verified", fullName: "Sasa Hold Pendek" });
    const hold = await step(
      "post",
      `/events/${soon.json.id}/reservations`,
      "/events/{eventId}/reservations",
      201,
      { expected_price: "15000.00", payment_method_id: await bankMethod() },
      { token: holder.token, idem: true, headers: APP },
    );
    expect(hold.json.hold_expires_at).toBe(new Date(now.getTime() + 5 * HOUR).toISOString());
    // Setelah pendaftaran ditutup (job lifecycle), pemesanan baru ditolak.
    clock.advance(6 * HOUR);
    await runJob("events.lifecycle");
    await runJob("reservations.expire");
    const another = await memberFixture({ status: "verified", fullName: "Tata Terlambat Daftar" });
    const closed = await call(
      "post",
      `/events/${soon.json.id}/reservations`,
      { expected_price: "15000.00", payment_method_id: await bankMethod() },
      { token: another.token, headers: APP },
    );
    expect([400, 409], show("post", "reservations (ditutup)", closed)).toContain(closed.statusCode);
    expectOperation("post", "/events/{eventId}/reservations", closed);
    const holderToken = (await loginAlumni(holder.email, holder.password)).token;
    const lapsed = await step(
      "get",
      `/me/tickets/${hold.json.id}`,
      "/me/tickets/{ticketId}",
      200,
      undefined,
      {
        token: holderToken,
      },
    );
    expect(lapsed.json.status).toBe("expired");
  });
});

describe("D7 (e+): blokir dua arah pada chat langsung dan undangan grup", () => {
  it("AC F12-1: blokir dari satu pihak menolak kirim direct dari kedua pihak dan undangan grup; riwayat tetap", async () => {
    const blocker = await memberFixture({ status: "verified", fullName: "Rudi Pemblokir" });
    const blocked = await memberFixture({ status: "verified", fullName: "Susi Diblokir" });
    const room = await step(
      "post",
      "/chat/direct",
      "/chat/direct",
      [200, 201],
      { user_id: blocked.userId },
      {
        token: blocker.token,
        headers: APP,
      },
    );
    expect((await sendText(blocked, room.json.id, "Halo sebelum blokir")).statusCode).toBe(201);
    await step("put", `/blocks/${blocked.userId}`, "/blocks/{userId}", 200, undefined, {
      token: blocker.token,
      headers: APP,
    });
    for (const [from, label] of [
      [blocked, "terblokir"],
      [blocker, "pemblokir"],
    ] as const) {
      const res = await sendText(from, room.json.id, `Pesan dari ${label}`);
      expect(res.statusCode, show("post", `messages (${label})`, res)).toBe(403);
      expectOperation("post", "/chat/rooms/{roomId}/messages", res);
    }
    const history = await step(
      "get",
      `/chat/rooms/${room.json.id}/messages`,
      "/chat/rooms/{roomId}/messages",
      200,
      undefined,
      { token: blocker.token },
    );
    expect(history.json.items.map((m: Json) => m.body)).toContain("Halo sebelum blokir");
    // Undangan grup dari pihak terblokir ke pemblokir ditolak.
    const group = await call(
      "post",
      "/chat/rooms",
      { name: "Grup Terblokir", invitee_user_ids: [blocker.userId] },
      { token: blocked.token, headers: APP },
    );
    // Kontrak createChatGroup: calon yang terblokir dilewati (invitations.skipped), grup tetap dibuat.
    expect(group.statusCode, show("post", "/chat/rooms (undang pemblokir)", group)).toBe(201);
    const created = expectOperation("post", "/chat/rooms", group) as Json;
    expect(created.invitations.invited_user_ids).not.toContain(blocker.userId);
    expect(created.invitations.skipped.map((s: Json) => s.user_id)).toContain(blocker.userId);
    const invites = await step("get", "/chat/invitations", "/chat/invitations", 200, undefined, {
      token: blocker.token,
    });
    expect(JSON.stringify(invites.json.items)).not.toContain(created.room.id);
  });
});

describe("D7 (e2): reaksi, balasan, hapus pesan dan mute pada grup (F-11)", () => {
  it("PRD 3.11: reaksi & hapus tersiar realtime; balasan merujuk pesan asal; room di-mute tetap menulis inbox tanpa push", async () => {
    const host = await memberFixture({ status: "verified", fullName: "Dewa Tuan Rumah" });
    const guest = await memberFixture({ status: "verified", fullName: "Elsa Tamu" });
    const fcm = `fcm-mute-${guest.userId}`;
    await step(
      "put",
      "/devices",
      "/devices",
      204,
      { platform: "android", token: fcm, app_version: "1.0.0" },
      {
        token: guest.token,
      },
    );
    const group = await step(
      "post",
      "/chat/rooms",
      "/chat/rooms",
      201,
      { name: "Grup Reaksi", invitee_user_ids: [guest.userId] },
      { token: host.token, idem: true, headers: APP },
    );
    const groupId = group.json.room.id as string;
    await step(
      "post",
      `/chat/invitations/${groupId}/accept`,
      "/chat/invitations/{roomId}/accept",
      200,
      undefined,
      {
        token: guest.token,
        idem: true,
        headers: APP,
      },
    );
    const hostSocket = await connectSocket(host);
    try {
      const first = expectOperation(
        "post",
        "/chat/rooms/{roomId}/messages",
        await sendText(host, groupId, "Siapa ikut futsal?"),
      ) as Json;
      const reply = await call(
        "post",
        `/chat/rooms/${groupId}/messages`,
        { client_message_id: uuidv7(), kind: "text", body: "Saya ikut", reply_to_id: first.id },
        { token: guest.token, headers: APP },
      );
      expect(reply.statusCode, show("post", "messages (balasan)", reply)).toBe(201);
      const replyMsg = expectOperation("post", "/chat/rooms/{roomId}/messages", reply) as Json;
      expect(JSON.stringify(replyMsg.reply_to)).toContain(first.id);
      const reacted = await step(
        "put",
        `/chat/rooms/${groupId}/messages/${first.id}/reactions/${encodeURIComponent("👍")}`,
        "/chat/rooms/{roomId}/messages/{messageId}/reactions/{emoji}",
        200,
        undefined,
        { token: guest.token, headers: APP },
      );
      expect(reacted.json.reactions).toEqual([{ emoji: "👍", count: 1, reacted_by_me: true }]);
      await hostSocket.waitFor("reaction.updated", (e) => e.entity_id === first.id);
      const removed = await step(
        "delete",
        `/chat/rooms/${groupId}/messages/${replyMsg.id}`,
        "/chat/rooms/{roomId}/messages/{messageId}",
        200,
        undefined,
        { token: guest.token, headers: APP },
      );
      expect(removed.json).toMatchObject({ body: null, deleted_at: expect.any(String) });
      await hostSocket.waitFor("message.deleted", (e) => e.entity_id === replyMsg.id);
      // Pengirim lain tidak dapat menghapus pesan orang lain.
      const foreign = await call("delete", `/chat/rooms/${groupId}/messages/${first.id}`, undefined, {
        token: guest.token,
        headers: APP,
      });
      expect(foreign.statusCode).toBe(403);
    } finally {
      hostSocket.close();
    }
    // Mute: episode belum dibaca baru tetap masuk inbox, tanpa push (kontrak setChatRoomMute).
    await drain();
    const pushesBefore = push.to(fcm).length;
    const muted = await call(
      "put",
      `/chat/rooms/${groupId}/mute`,
      { muted: true },
      { token: guest.token, headers: APP },
    );
    expect(muted.statusCode, show("put", "mute", muted)).toBe(204);
    const history = await step(
      "get",
      `/chat/rooms/${groupId}/messages`,
      "/chat/rooms/{roomId}/messages",
      200,
      undefined,
      { token: guest.token },
    );
    await step(
      "put",
      `/chat/rooms/${groupId}/read`,
      "/chat/rooms/{roomId}/read",
      200,
      { message_id: history.json.items.at(-1).id },
      { token: guest.token, headers: APP },
    );
    await sendText(host, groupId, "Lapangan jam 7 malam");
    await drain();
    expect(push.to(fcm)).toHaveLength(pushesBefore);
    const inbox = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: guest.token,
      query: { category: "chat" },
    });
    expect(
      inbox.json.items.filter((n: Json) => n.deep_link === `kapdh://app/chat/${groupId}`).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("D7 (e3): langganan room Socket.IO mengikuti status keanggotaan (AC F11-6, events/README.md)", () => {
  it("AC F11-6: socket anggota expired tidak menerima pesan grup; setelah renewal disetujui socket yang sama dimasukkan ulang ke room", async () => {
    const owner = await memberFixture({ status: "verified", fullName: "Vino Pemilik Grup" });
    const lapsing = await memberFixture({ status: "expiring", fullName: "Wati Hampir Habis" });
    const group = await step(
      "post",
      "/chat/rooms",
      "/chat/rooms",
      201,
      { name: "Grup Perpanjang", invitee_user_ids: [lapsing.userId] },
      { token: owner.token, idem: true, headers: APP },
    );
    const groupId = group.json.room.id as string;
    await step(
      "post",
      `/chat/invitations/${groupId}/accept`,
      "/chat/invitations/{roomId}/accept",
      200,
      undefined,
      {
        token: lapsing.token,
        idem: true,
        headers: APP,
      },
    );
    // Masa keanggotaan habis.
    const [row] = await sql<{ expires_at: string }[]>`
      select expires_at from app.alumni where user_id = ${lapsing.userId}`;
    clock.set(new Date(new Date(row!.expires_at).getTime() + HOUR));
    const ownerToken = (await loginAlumni(owner.email, owner.password)).token;
    const expiredSession = await loginAlumni(lapsing.email, lapsing.password);
    const socket = await connectSocket({ ...lapsing, token: expiredSession.token });
    try {
      const before = await sendText({ ...owner, token: ownerToken }, groupId, "Pesan saat Wati expired");
      const beforeMsg = expectOperation("post", "/chat/rooms/{roomId}/messages", before) as Json;
      await socket.none("message.created", (e) => e.entity_id === beforeMsg.id, 400);
      const denied = await call("get", `/chat/rooms/${groupId}/messages`, undefined, {
        token: expiredSession.token,
      });
      expect(denied.statusCode).toBe(403);

      // Renewal disetujui → socket yang masih tersambung dimasukkan ulang ke room (butir 5).
      const payment = await submitDues({ token: expiredSession.token }, "renewal", {
        data: await testJpeg(),
        filename: "wati.jpg",
        contentType: "image/jpeg",
      });
      const admin = await adminFixture({ permissions: ["payments.read", "payments.decide"] });
      await decide(admin, payment.id, "approve");
      const after = await sendText({ ...owner, token: ownerToken }, groupId, "Selamat datang kembali Wati");
      const afterMsg = expectOperation("post", "/chat/rooms/{roomId}/messages", after) as Json;
      await socket.waitFor("message.created", (e) => e.entity_id === afterMsg.id);
    } finally {
      socket.close();
    }
  });

  it("AC F12-5: socket sesi terbatas anggota suspended dimasukkan ulang ke room setelah unsuspend", async () => {
    const owner = await memberFixture({ status: "verified", fullName: "Xavi Pemilik Grup" });
    const member = await memberFixture({ status: "verified", fullName: "Yuni Dibatasi Sementara" });
    const group = await step(
      "post",
      "/chat/rooms",
      "/chat/rooms",
      201,
      { name: "Grup Pulih", invitee_user_ids: [member.userId] },
      { token: owner.token, idem: true, headers: APP },
    );
    const groupId = group.json.room.id as string;
    await step(
      "post",
      `/chat/invitations/${groupId}/accept`,
      "/chat/invitations/{roomId}/accept",
      200,
      undefined,
      {
        token: member.token,
        idem: true,
        headers: APP,
      },
    );
    const moderator = await adminFixture({
      permissions: ["members.read", "moderation.read", "moderation.resolve"],
    });
    const detail = await step(
      "get",
      `/admin/members/${member.userId}`,
      "/admin/members/{userId}",
      200,
      undefined,
      {
        token: moderator.token,
      },
    );
    const suspended = await step(
      "post",
      `/admin/members/${member.userId}/suspend`,
      "/admin/members/{userId}/suspend",
      200,
      { reason: "Uji langganan socket", member_message: "Akun dibatasi sementara.", confirm: true },
      { token: moderator.token, idem: true, headers: { "if-match": detail.json.version } },
    );
    const restricted = await loginAlumni(member.email, member.password);
    const socket = await connectSocket({ ...member, token: restricted.token });
    try {
      const during = await sendText(owner, groupId, "Pesan selama dibatasi");
      const duringMsg = expectOperation("post", "/chat/rooms/{roomId}/messages", during) as Json;
      await socket.none("message.created", (e) => e.entity_id === duringMsg.id, 400);
      await step(
        "post",
        `/admin/members/${member.userId}/unsuspend`,
        "/admin/members/{userId}/unsuspend",
        200,
        { reason: "Selesai ditinjau", confirm: true },
        { token: moderator.token, idem: true, headers: { "if-match": suspended.json.version } },
      );
      const after = await sendText(owner, groupId, "Selamat bergabung lagi");
      const afterMsg = expectOperation("post", "/chat/rooms/{roomId}/messages", after) as Json;
      await socket.waitFor("message.created", (e) => e.entity_id === afterMsg.id);
    } finally {
      socket.close();
    }
  });
});

describe("D7 (idem): ulangan jaringan dengan Idempotency-Key yang sama di sepanjang perjalanan (PRD 4.3)", () => {
  it("PRD 4.3, AC F03-4, F09-1: reservasi, instruksi iuran, kirim bukti dan keputusan yang diulang memutar hasil pertama", async () => {
    const admin = await adminFixture({ permissions: ["events.manage", "payments.read", "payments.decide"] });
    const event = await createOpenEvent(admin, {
      title: "Event Ulang Jaringan",
      price: "30000.00",
      seats: 4,
      startsInMs: 8 * DAY,
    });
    const member = await memberFixture({ status: "expiring", fullName: "Zul Sinyal Lemah" });
    const replayed = async (method: HttpMethod, path: string, op: string, body: unknown, status: number) => {
      const key = uuidv7();
      const first = await step(method, path, op, status, body, {
        token: member.token,
        headers: { ...APP, "idempotency-key": key },
      });
      const second = await call(method, path, body, {
        token: member.token,
        headers: { ...APP, "idempotency-key": key },
      });
      expect(second.statusCode, show(method, `${path} (ulang)`, second, body)).toBe(status);
      expect(second.headers["idempotent-replayed"], show(method, `${path} (ulang)`, second, body)).toBe(
        "true",
      );
      expect(expectOperation(method, op, second)).toEqual(first.json);
      return first.json;
    };
    const ticket = await replayed(
      "post",
      `/events/${event.id}/reservations`,
      "/events/{eventId}/reservations",
      { expected_price: "30000.00", payment_method_id: await bankMethod() },
      201,
    );
    const dues = await replayed(
      "post",
      "/me/payments",
      "/me/payments",
      { type: "renewal", payment_method_id: await bankMethod() },
      201,
    );
    const proof = await uploadMultipart(member.token, "payment_proof", {
      data: await testJpeg(),
      filename: "ulang.jpg",
      contentType: "image/jpeg",
    });
    await replayed(
      "put",
      `/me/payments/${dues.id}/proof`,
      "/me/payments/{paymentId}/proof",
      { file_id: proof.json.id, expected_proof_version: 0 },
      200,
    );
    const ticketProof = await uploadMultipart(member.token, "payment_proof", {
      data: await testJpeg(),
      filename: "ulang-tiket.jpg",
      contentType: "image/jpeg",
    });
    await replayed(
      "put",
      `/me/payments/${ticket.payment.id}/proof`,
      "/me/payments/{paymentId}/proof",
      { file_id: ticketProof.json.id, expected_proof_version: 0 },
      200,
    );
    const [counts] = await sql<{ tickets: number; payments: number }[]>`
      select (select count(*)::int from app.tickets where user_id = ${member.userId}) as tickets,
             (select count(*)::int from app.payments where user_id = ${member.userId}) as payments`;
    expect(counts).toEqual({ tickets: 1, payments: 2 });
  });
});

describe("D7 (k): preferensi notifikasi dan logout perangkat (F-13)", () => {
  it("AC F13-2, F13-5: email kategori dimatikan → inbox tetap, tanpa email; logout → token perangkat tidak menerima push", async () => {
    const member = await memberFixture({ status: "unverified", fullName: "Tari Preferensi" });
    const fcm = `fcm-pref-${member.userId}`;
    await step(
      "put",
      "/devices",
      "/devices",
      204,
      { platform: "ios", token: fcm, app_version: "1.0.0" },
      {
        token: member.token,
      },
    );
    const prefs = await step(
      "put",
      "/notifications/preferences",
      "/notifications/preferences",
      200,
      {
        push: { payment: true, membership: true, event: true, news: true, chat: true },
        email: { payment: false, membership: true, event: true },
      },
      { token: member.token, headers: APP },
    );
    expect(prefs.json.email.payment).toBe(false);
    expect(prefs.json.mandatory_categories).toEqual(expect.arrayContaining(["security", "account"]));
    const payment = await submitDues(member, "registration", {
      data: await testJpeg(),
      filename: "pref.jpg",
      contentType: "image/jpeg",
    });
    const admin = await adminFixture({ permissions: ["payments.read", "payments.decide"] });
    await decide(admin, payment.id, "approve");
    await drain();
    expect(mailer.messagesTo(member.email)).toHaveLength(0);
    expect(push.to(fcm)).toHaveLength(1);
    const inbox = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: member.token,
    });
    expect(inbox.json.items.some((n: Json) => n.deep_link === `kapdh://app/payments/${payment.id}`)).toBe(
      true,
    );

    // Logout → token perangkat dicabut; notifikasi berikutnya tidak dikirim ke perangkat itu (AC F13-5).
    const logout = await call("post", "/auth/logout", undefined, { token: member.token });
    expect(logout.statusCode, show("post", "/auth/logout", logout)).toBe(204);
    expectOperation("post", "/auth/logout", logout);
    const renewalAdmin = await adminFixture({
      permissions: ["members.read", "moderation.read", "moderation.resolve"],
    });
    const detail = await step(
      "get",
      `/admin/members/${member.userId}`,
      "/admin/members/{userId}",
      200,
      undefined,
      { token: renewalAdmin.token },
    );
    await step(
      "post",
      `/admin/members/${member.userId}/suspend`,
      "/admin/members/{userId}/suspend",
      200,
      { reason: "Uji pencabutan token", member_message: "Akun dibatasi sementara.", confirm: true },
      { token: renewalAdmin.token, idem: true, headers: { "if-match": detail.json.version } },
    );
    await drain();
    expect(push.to(fcm)).toHaveLength(1);
  });
});

describe("D7 (k2): kelas galat FCM pada pengiriman worker (F-13)", () => {
  it("AC F13-4: UNAVAILABLE dicoba ulang tanpa menonaktifkan token; UNREGISTERED menonaktifkan token sehingga notifikasi berikutnya tidak dikirim", async () => {
    const member = await memberFixture({ status: "expiring", fullName: "Anton Token Usang" });
    const fcm = `fcm-usang-${member.userId}`;
    await step(
      "put",
      "/devices",
      "/devices",
      204,
      { platform: "android", token: fcm, app_version: "1.0.0" },
      {
        token: member.token,
      },
    );
    await drain();
    await runJob("notifications.retry");
    const admin = await adminFixture({ permissions: ["payments.read", "payments.decide"] });
    const payment = await submitDues(member, "renewal", {
      data: await testJpeg(),
      filename: "fcm.jpg",
      contentType: "image/jpeg",
    });
    push.failNext(fcm, { ok: false, errorClass: "unavailable", retryable: true, deactivateToken: false });
    await decide(admin, payment.id, "approve");
    await drain();
    const [device] = await sql<{ revoked_at: string | null }[]>`
      select revoked_at from app.device_tokens where token = ${fcm}`;
    expect(device!.revoked_at).toBeNull();
    clock.advance(30 * 60_000);
    await runJob("notifications.retry");
    expect(push.to(fcm)).toHaveLength(2);
    const [sentRow] = await sql<{ status: string; attempt: number }[]>`
      select d.status, d.attempt from app.notification_deliveries d
      join app.device_tokens t on t.id = d.device_token_id where t.token = ${fcm}`;
    expect(sentRow).toMatchObject({ status: "sent", attempt: 2 });

    // UNREGISTERED: token dinonaktifkan; notifikasi berikutnya (expiry reminder tidak relevan) → suspend notice.
    const moderator = await adminFixture({
      permissions: ["members.read", "moderation.read", "moderation.resolve"],
    });
    const memberToken = (await loginAlumni(member.email, member.password)).token;
    await step(
      "put",
      "/devices",
      "/devices",
      204,
      { platform: "android", token: fcm, app_version: "1.0.0" },
      {
        token: memberToken,
      },
    );
    const card = await step("get", "/me/card", "/me/card", 200, undefined, { token: memberToken });
    expect(card.json.status_label).toBe("active");
    push.failNext(fcm, { ok: false, errorClass: "unregistered", retryable: false, deactivateToken: true });
    const detail = await step(
      "get",
      `/admin/members/${member.userId}`,
      "/admin/members/{userId}",
      200,
      undefined,
      {
        token: moderator.token,
      },
    );
    const suspended = await step(
      "post",
      `/admin/members/${member.userId}/suspend`,
      "/admin/members/{userId}/suspend",
      200,
      { reason: "Uji token FCM", member_message: "Akun dibatasi sementara.", confirm: true },
      { token: moderator.token, idem: true, headers: { "if-match": detail.json.version } },
    );
    await drain();
    const [revoked] = await sql<{ revoked_at: string | null }[]>`
      select revoked_at from app.device_tokens where token = ${fcm} order by created_at desc limit 1`;
    expect(revoked!.revoked_at).not.toBeNull();
    const pushesBefore = push.to(fcm).length;
    await step(
      "post",
      `/admin/members/${member.userId}/unsuspend`,
      "/admin/members/{userId}/unsuspend",
      200,
      { reason: "Selesai", confirm: true },
      { token: moderator.token, idem: true, headers: { "if-match": suspended.json.version } },
    );
    await drain();
    expect(push.to(fcm)).toHaveLength(pushesBefore);
  });
});

describe("D7 (l): Super Admin memulai pemulihan sandi alumni (F-16)", () => {
  it("AC F16-4, F02-4: sesi target dicabut, notifikasi keamanan, OTP hanya lewat email terverifikasi, sandi baru berlaku", async () => {
    const superAdmin = await adminFixture({ role: "super_admin", displayName: "Super Admin Pemulihan" });
    const member = await memberFixture({ status: "verified", fullName: "Umi Lupa Sandi" });
    const otpBefore = mailer.sent.filter((m) => m.to === member.email).length;
    const initiated = await step(
      "post",
      `/admin/members/${member.userId}/password-reset`,
      "/admin/members/{userId}/password-reset",
      202,
      { reason: "Permintaan via telepon setelah verifikasi identitas", confirm: true },
      { token: superAdmin.token, idem: true, headers: await adminReauth(superAdmin) },
    );
    expect(initiated.json.sessions_revoked).toBeGreaterThanOrEqual(1);
    expect(initiated.res.body).not.toMatch(/challenge_id|"code"/);
    const old = await call("get", "/me", undefined, { token: member.token });
    expect(old.statusCode).toBe(401);
    const otps = mailer.sent.filter((m) => m.to === member.email);
    expect(otps.length).toBe(otpBefore + 1);
    const otp = otps.at(-1)!;
    expect(otp.purpose).toBe("password_reset");
    const link = /kapdh:\/\/app\/forgot\/otp\?challenge_id=([0-9a-f-]{36})/.exec(otp.text);
    expect(link, otp.text).not.toBeNull();
    const grant = await step("post", "/auth/password/forgot/verify", "/auth/password/forgot/verify", 200, {
      challenge_id: link![1],
      code: otp.code,
    });
    const newPassword = "SandiBaru#2026";
    await step("post", "/auth/password/reset", "/auth/password/reset", 204, {
      reset_token: grant.json.reset_token,
      new_password: newPassword,
    });
    const oldLogin = await call("post", "/auth/login", { email: member.email, password: member.password });
    expect(oldLogin.statusCode).toBe(401);
    const fresh = await loginAlumni(member.email, newPassword);
    // Notifikasi keamanan (wajib) tanpa kode.
    await drain();
    const security = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: fresh.token,
      query: { category: "security" },
    });
    expect(security.json.items.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(security.json.items)).not.toContain(otp.code);
  });
});

describe("D7 (j+): hapus akun admin grup terakhir dengan tiket aktif dan bukti iuran menunggu", () => {
  it("AC F14-5, F14-4, PRD 3.9 D6: grup dialihkan, tiket hangus konsisten dengan penghitung kursi, payment menunggu tetap dapat diputus", async () => {
    const leaver = await memberFixture({ status: "expiring", fullName: "Wulan Admin Grup" });
    const friend = await memberFixture({ status: "verified", fullName: "Xena Anggota Grup" });
    const group = await step(
      "post",
      "/chat/rooms",
      "/chat/rooms",
      201,
      { name: "Grup Pamit", invitee_user_ids: [friend.userId] },
      { token: leaver.token, idem: true, headers: APP },
    );
    const groupId = group.json.room.id as string;
    await step(
      "post",
      `/chat/invitations/${groupId}/accept`,
      "/chat/invitations/{roomId}/accept",
      200,
      undefined,
      {
        token: friend.token,
        idem: true,
        headers: APP,
      },
    );
    const admin = await adminFixture({ permissions: ["events.manage", "payments.read", "payments.decide"] });
    const event = await createOpenEvent(admin, {
      title: "Event Tiket Hangus",
      price: "0.00",
      seats: 3,
      startsInMs: 9 * DAY,
    });
    const ticket = await step(
      "post",
      `/events/${event.id}/reservations`,
      "/events/{eventId}/reservations",
      201,
      { expected_price: "0.00" },
      { token: leaver.token, idem: true, headers: APP },
    );
    // Iuran perpanjangan berbukti yang masih menunggu keputusan (dana mungkin sudah ditransfer).
    const renewal = await submitDues(leaver, "renewal", {
      data: await testJpeg(),
      filename: "renew-pamit.jpg",
      contentType: "image/jpeg",
    });
    const disclosure = await step(
      "get",
      "/me/deletion/disclosure",
      "/me/deletion/disclosure",
      200,
      undefined,
      {
        token: leaver.token,
      },
    );
    expect(disclosure.json.sole_admin_group_count).toBe(1);
    expect(disclosure.json.active_tickets.map((t: Json) => t.ticket_id)).toContain(ticket.json.id);
    const requested = await step(
      "post",
      "/me/deletion",
      "/me/deletion",
      202,
      { confirm: true, acknowledged_disclosure_version: disclosure.json.version },
      { token: leaver.token, idem: true, headers: { ...APP, ...(await memberReauth(leaver)) } },
    );
    await drain();
    const [row] = await sql<{ status: string; last_error: string | null }[]>`
      select status, last_error from app.account_deletions where request_number = ${requested.json.request_number}`;
    expect(row!.status, String(row!.last_error)).toBe("completed");

    // AC F14-5: grup tetap ada dan dialihkan ke anggota aktif.
    const room = await step("get", `/chat/rooms/${groupId}`, "/chat/rooms/{roomId}", 200, undefined, {
      token: friend.token,
    });
    expect(room.json.my_role).toBe("admin");
    // Tiket hangus; penghitung kursi tetap sama dengan isi tabel tiket.
    const [counters] = await sql<
      { paid_quantity: number; held_quantity: number; paid: number; held: number }[]
    >`
      select e.paid_quantity, e.held_quantity,
             (select count(*)::int from app.tickets t where t.event_id = e.id and t.status = 'paid') as paid,
             (select count(*)::int from app.tickets t where t.event_id = e.id
                and t.status in ('awaiting_payment', 'awaiting_review')) as held
      from app.events e where e.id = ${event.id}`;
    expect(counters!.paid_quantity).toBe(counters!.paid);
    expect(counters!.held_quantity).toBe(counters!.held);
    const [t] = await sql<{ status: string; user_id: string | null; qr_code: string | null }[]>`
      select status, user_id, qr_code from app.tickets where id = ${ticket.json.id}`;
    expect(t).toMatchObject({ status: "cancelled", user_id: null });
    const adminTickets = await step(
      "get",
      `/admin/events/${event.id}/tickets`,
      "/admin/events/{eventId}/tickets",
      200,
      undefined,
      { token: admin.token },
    );
    expect(adminTickets.res.body).not.toContain("Wulan Admin Grup");

    // Payment berbukti tidak dibatalkan; tetap diputus pengurus dalam bentuk anonim (PRD 4.4, AC F14-4).
    const pending = await step(
      "get",
      `/admin/payments/${renewal.id}`,
      "/admin/payments/{paymentId}",
      200,
      undefined,
      { token: admin.token },
    );
    expect(pending.json).toMatchObject({ status: "pending", member: null, proof: null });
    expect(disclosure.json.open_payments.map((p: Json) => p.payment_id)).toContain(renewal.id);
    const decided = await decide(admin, renewal.id, "approve");
    expect(decided.status).toBe("paid");
  });
});

describe("D7 (m): penghapusan akun lewat situs web tanpa aplikasi (F-14)", () => {
  it("AC F14-1: challenge email → verifikasi → konfirmasi → job → selesai", async () => {
    const member = await memberFixture({ status: "unverified", fullName: "Vivi Web" });
    const challenge = await step("post", "/public/deletion/challenge", "/public/deletion/challenge", 202, {
      email: member.email,
    });
    const verified = await step("post", "/public/deletion/verify", "/public/deletion/verify", 200, {
      challenge_id: challenge.json.challenge_id,
      code: mailer.last(member.email),
    });
    expect(verified.json).toMatchObject({ deletable: true, blocked_reason: null });
    const confirmed = await step(
      "post",
      "/public/deletion/confirm",
      "/public/deletion/confirm",
      202,
      {
        deletion_token: verified.json.deletion_token,
        confirm: true,
        acknowledged_disclosure_version: verified.json.disclosure.version,
      },
      { idem: true },
    );
    expect(confirmed.json).toMatchObject({ source: "web", status: "pending" });
    const session = await call("get", "/me", undefined, { token: member.token });
    expect(session.statusCode).toBe(401);
    await drain();
    const [row] = await sql<{ status: string }[]>`
      select status from app.account_deletions where request_number = ${confirmed.json.request_number}`;
    expect(row!.status).toBe("completed");
  });
});

describe("D7 (o): koreksi identitas anggota oleh admin menerbitkan ulang KTA (F-05)", () => {
  it("AC F05-6: kelas keluar dikoreksi → prefix nomor dihitung ulang, N tetap, QR lama perlu diperbarui, QR baru aktif, audit lama/baru", async () => {
    const member = await memberFixture({
      status: "verified",
      fullName: "Yusuf Koreksi",
      cohort: 12,
      classIn: 1,
      classOut: 3,
    });
    const before = await step("get", "/me/card", "/me/card", 200, undefined, { token: member.token });
    const oldNumber = before.json.member_number as string;
    expect(oldNumber).toMatch(/^12\.02\.01\.[1-9][0-9]*$/);
    const seq = oldNumber.split(".")[3];
    const oldQr = ktaFromQr(before.json.qr.url);
    const admin = await adminFixture({ permissions: ["members.read", "members.manage"] });
    const detail = await step(
      "get",
      `/admin/members/${member.userId}`,
      "/admin/members/{userId}",
      200,
      undefined,
      {
        token: admin.token,
      },
    );
    // Nomor dari klien diabaikan/ditolak (AC F05-6).
    const injected = await call(
      "patch",
      `/admin/members/${member.userId}`,
      { reason: "Coba kirim nomor", member_number: "12.01.01.1" },
      { token: admin.token, headers: { "if-match": detail.json.version } },
    );
    expect(injected.statusCode, show("patch", "/admin/members (member_number)", injected)).toBe(400);
    expectOperation("patch", "/admin/members/{userId}", injected);
    const corrected = await step(
      "patch",
      `/admin/members/${member.userId}`,
      "/admin/members/{userId}",
      200,
      { reason: "Koreksi data ijazah: tamat Aliyah", class_out: 6 },
      { token: admin.token, headers: { "if-match": detail.json.version } },
    );
    expect(JSON.stringify(corrected.json)).toContain(`12.01.01.${seq}`);
    const after = await step("get", "/me/card", "/me/card", 200, undefined, { token: member.token });
    expect(after.json.member_number).toBe(`12.01.01.${seq}`);
    const newQr = ktaFromQr(after.json.qr.url);
    const verifyNew = await step("post", "/public/kta/verify", "/public/kta/verify", 200, {
      member_number: newQr.memberNumber,
      token: newQr.token,
    });
    expect(verifyNew.json.result).toBe("active");
    // QR lama (nomor lama) tidak lagi Aktif: "perlu diperbarui".
    const verifyOld = await step("post", "/public/kta/verify", "/public/kta/verify", 200, {
      member_number: oldQr.memberNumber,
      token: oldQr.token,
    });
    expect(verifyOld.json.result).not.toBe("active");
    const [audit] = await sql<{ before: Json; after: Json }[]>`
      select before, after from app.audit_logs
      where entity_id = ${member.userId} and before::text like ${`%${oldNumber}%`}
      order by created_at desc limit 1`;
    expect(audit, "audit nomor lama/baru").toBeDefined();
    expect(JSON.stringify(audit!.after)).toContain(`12.01.01.${seq}`);
  });
});

describe("D7 (p): perubahan event setelah ada tiket (F-09, F-15)", () => {
  it("AC F15-2, AC F13-6: kuota tidak dapat di bawah held+paid, event bertiket tidak dapat dihapus; jadwal berubah → pengingat jadwal lama tidak terkirim", async () => {
    const admin = await adminFixture({ permissions: ["events.manage"] });
    const event = await createOpenEvent(admin, {
      title: "Bakti Sosial Bergeser",
      price: "0.00",
      seats: 5,
      startsInMs: 20 * DAY,
    });
    const members = [
      await memberFixture({ status: "verified", fullName: "Zaki Peserta" }),
      await memberFixture({ status: "verified", fullName: "Zahra Peserta" }),
    ];
    for (const m of members)
      await step(
        "post",
        `/events/${event.id}/reservations`,
        "/events/{eventId}/reservations",
        201,
        { expected_price: "0.00" },
        { token: m.token, idem: true, headers: APP },
      );
    const current = await step(
      "get",
      `/admin/events/${event.id}`,
      "/admin/events/{eventId}",
      200,
      undefined,
      {
        token: admin.token,
      },
    );
    expect(current.json).toMatchObject({ paid_quantity: 2, min_seats_total: 2, has_tickets: true });
    const shrink = await call(
      "patch",
      `/admin/events/${event.id}`,
      { seats_total: 1 },
      { token: admin.token, headers: { "if-match": current.json.version } },
    );
    // Kontrak adminUpdateEvent: 409 VALIDATION_ERROR + field_errors.seats_total + current.
    expect(shrink.statusCode, show("patch", "/admin/events (kuota < paid)", shrink)).toBe(409);
    expect(expectOperation("patch", "/admin/events/{eventId}", shrink)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { seats_total: expect.any(Array) },
    });
    const remove = await call("delete", `/admin/events/${event.id}`, undefined, {
      token: admin.token,
      headers: { "if-match": current.json.version },
    });
    expect(remove.statusCode, show("delete", "/admin/events (bertiket)", remove)).toBe(409);
    expect(expectOperation("delete", "/admin/events/{eventId}", remove)).toMatchObject({
      code: "VALIDATION_ERROR",
    });

    // Jadwal digeser 5 hari; pada jam H-3 jadwal LAMA tidak ada pengingat, pada H-3 jadwal baru ada satu.
    const oldStart = new Date(event.starts_at).getTime();
    const newStart = oldStart + 5 * DAY;
    const moved = await step(
      "patch",
      `/admin/events/${event.id}`,
      "/admin/events/{eventId}",
      200,
      {
        starts_at: new Date(newStart).toISOString(),
        ends_at: new Date(newStart + 4 * HOUR).toISOString(),
        registration_closes_at: new Date(newStart - DAY).toISOString(),
      },
      { token: admin.token, headers: { "if-match": current.json.version } },
    );
    expect(moved.json.starts_at).toBe(new Date(newStart).toISOString());
    await drain();
    clock.set(new Date(oldStart - 3 * DAY + 10 * 60_000));
    await runJob("events.reminders");
    const token0 = (await loginAlumni(members[0]!.email, members[0]!.password)).token;
    const stale = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: token0,
      query: { category: "event" },
    });
    const reminderTitles = (items: Json[]) =>
      items.filter((n: Json) => /pengingat|H-3|H-1|besok|3 hari/i.test(`${n.title} ${n.body}`));
    expect(reminderTitles(stale.json.items), JSON.stringify(stale.json.items)).toHaveLength(0);
    clock.set(new Date(newStart - 3 * DAY + 10 * 60_000));
    await runJob("events.reminders");
    const token0b = (await loginAlumni(members[0]!.email, members[0]!.password)).token;
    const fresh = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: token0b,
      query: { category: "event" },
    });
    expect(reminderTitles(fresh.json.items), JSON.stringify(fresh.json.items)).toHaveLength(1);
  });
});

describe("D7 (p2): harga event berubah setelah ada reservasi (PRD 4.4, AC F03-5)", () => {
  it("PRD 4.4: harga baru hanya untuk reservasi baru; reservasi lama memakai snapshot; expected_price lama ditolak", async () => {
    const admin = await adminFixture({ permissions: ["events.manage", "payments.read", "payments.decide"] });
    const event = await createOpenEvent(admin, {
      title: "Event Harga Naik",
      price: "30000.00",
      seats: 5,
      startsInMs: 9 * DAY,
    });
    const early = await memberFixture({ status: "verified", fullName: "Agus Harga Lama" });
    const held = await step(
      "post",
      `/events/${event.id}/reservations`,
      "/events/{eventId}/reservations",
      201,
      { expected_price: "30000.00", payment_method_id: await bankMethod() },
      { token: early.token, idem: true, headers: APP },
    );
    const current = await step(
      "get",
      `/admin/events/${event.id}`,
      "/admin/events/{eventId}",
      200,
      undefined,
      {
        token: admin.token,
      },
    );
    await step(
      "patch",
      `/admin/events/${event.id}`,
      "/admin/events/{eventId}",
      200,
      { price: "45000.00" },
      { token: admin.token, headers: { "if-match": current.json.version } },
    );
    const stale = await call(
      "post",
      `/events/${event.id}/reservations`,
      { expected_price: "30000.00", payment_method_id: await bankMethod() },
      {
        token: (await memberFixture({ status: "verified", fullName: "Budi Harga Basi" })).token,
        headers: APP,
      },
    );
    expect(stale.statusCode, show("post", "reservations (harga basi)", stale)).toBe(409);
    expectOperation("post", "/events/{eventId}/reservations", stale);
    const late = await memberFixture({ status: "verified", fullName: "Cici Harga Baru" });
    const fresh = await step(
      "post",
      `/events/${event.id}/reservations`,
      "/events/{eventId}/reservations",
      201,
      { expected_price: "45000.00", payment_method_id: await bankMethod() },
      { token: late.token, idem: true, headers: APP },
    );
    expect(fresh.json).toMatchObject({ total: "45000.00", payment: { amount: "45000.00" } });
    const old = await step("get", `/me/tickets/${held.json.id}`, "/me/tickets/{ticketId}", 200, undefined, {
      token: early.token,
    });
    expect(old.json).toMatchObject({ total: "30000.00", payment: { amount: "30000.00" } });
    const proof = await uploadMultipart(early.token, "payment_proof", {
      data: await testJpeg(),
      filename: "lama.jpg",
      contentType: "image/jpeg",
    });
    await step(
      "put",
      `/me/payments/${held.json.payment.id}/proof`,
      "/me/payments/{paymentId}/proof",
      200,
      { file_id: proof.json.id, expected_proof_version: 0 },
      { token: early.token, idem: true, headers: APP },
    );
    const approved = await decide(admin, held.json.payment.id, "approve");
    expect(approved.amount).toBe("30000.00");
  });
});

describe("D7 (authz): objek milik anggota lain di sepanjang alur iuran (N-09, AC F10-5)", () => {
  it("N-09: bukti, payment, tiket dan berkas milik anggota lain tidak dapat dipakai atau dibaca lewat ID", async () => {
    const alice = await memberFixture({ status: "unverified", fullName: "Alya Pemilik" });
    const bob = await memberFixture({ status: "unverified", fullName: "Bima Pengintip" });
    const alicePayment = await submitDues(alice, "registration", {
      data: await testJpeg(),
      filename: "alya.jpg",
      contentType: "image/jpeg",
    });
    const bobPayment = await step(
      "post",
      "/me/payments",
      "/me/payments",
      201,
      { type: "registration", payment_method_id: await bankMethod() },
      { token: bob.token, idem: true, headers: APP },
    );
    // Bob memakai berkas bukti milik Alya.
    const reuse = await call(
      "put",
      `/me/payments/${bobPayment.json.id}/proof`,
      { file_id: alicePayment.fileId, expected_proof_version: 0 },
      { token: bob.token, headers: APP },
    );
    expect([400, 404, 422], show("put", "proof dengan berkas orang lain", reuse)).toContain(reuse.statusCode);
    expectOperation("put", "/me/payments/{paymentId}/proof", reuse);
    for (const [path, op] of [
      [`/me/payments/${alicePayment.id}`, "/me/payments/{paymentId}"],
      [`/files/${alicePayment.fileId}/access`, "/files/{fileId}/access"],
    ] as const) {
      const res = await call("get", path, undefined, { token: bob.token });
      expect([403, 404], show("get", path, res)).toContain(res.statusCode);
      expectOperation("get", op, res);
    }
    const cancel = await call(
      "post",
      `/me/payments/${alicePayment.id}/cancel`,
      {},
      { token: bob.token, headers: { ...APP, "if-match": "1" } },
    );
    expect([403, 404], show("post", "cancel payment orang lain", cancel)).toContain(cancel.statusCode);
    // Admin hanya payments.read tidak dapat memutus.
    const reader = await adminFixture({ permissions: ["payments.read"] });
    const detail = await step(
      "get",
      `/admin/payments/${alicePayment.id}`,
      "/admin/payments/{paymentId}",
      200,
      undefined,
      { token: reader.token },
    );
    expect(detail.json.actions.can_decide).toBe(false);
    const denied = await call(
      "post",
      `/admin/payments/${alicePayment.id}/decision`,
      {
        decision: "approve",
        expected_proof_version: 1,
        expected_version: detail.json.version,
        funds_verified: true,
      },
      { token: reader.token },
    );
    expect(denied.statusCode).toBe(403);
    const [row] = await sql<
      { status: string }[]
    >`select status from app.payments where id = ${alicePayment.id}`;
    expect(row!.status).toBe("pending");
  });
});

describe("D7 (q): keluar grup oleh admin terakhir (F-11)", () => {
  it("AC F11-5, F11-4: admin terakhir wajib memilih pengganti; setelah keluar riwayat & langganan socket ditolak", async () => {
    const owner = await memberFixture({ status: "verified", fullName: "Abel Admin Grup" });
    const heir = await memberFixture({ status: "verified", fullName: "Bella Penerus" });
    const group = await step(
      "post",
      "/chat/rooms",
      "/chat/rooms",
      201,
      { name: "Grup Estafet", invitee_user_ids: [heir.userId] },
      { token: owner.token, idem: true, headers: APP },
    );
    const groupId = group.json.room.id as string;
    await step(
      "post",
      `/chat/invitations/${groupId}/accept`,
      "/chat/invitations/{roomId}/accept",
      200,
      undefined,
      {
        token: heir.token,
        idem: true,
        headers: APP,
      },
    );
    const ownerSocket = await connectSocket(owner);
    try {
      const blocked = await call(
        "post",
        `/chat/rooms/${groupId}/leave`,
        {},
        { token: owner.token, headers: APP },
      );
      expect([400, 409], show("post", "leave tanpa pengganti", blocked)).toContain(blocked.statusCode);
      expectOperation("post", "/chat/rooms/{roomId}/leave", blocked);
      const left = await call(
        "post",
        `/chat/rooms/${groupId}/leave`,
        { successor_user_id: heir.userId },
        { token: owner.token, headers: APP },
      );
      expect(left.statusCode, show("post", "leave", left)).toBe(204);
      expectOperation("post", "/chat/rooms/{roomId}/leave", left);
      const heirView = await step("get", `/chat/rooms/${groupId}`, "/chat/rooms/{roomId}", 200, undefined, {
        token: heir.token,
      });
      expect(heirView.json.my_role).toBe("admin");
      const history = await call("get", `/chat/rooms/${groupId}/messages`, undefined, { token: owner.token });
      expect([403, 404], show("get", "messages setelah keluar", history)).toContain(history.statusCode);
      // Socket pemilik lama tidak lagi menerima pesan grup.
      const msg = await sendText(heir, groupId, "Terima kasih Abel");
      const sent = expectOperation("post", "/chat/rooms/{roomId}/messages", msg) as Json;
      await ownerSocket.none("message.created", (e) => e.entity_id === sent.id, 400);
    } finally {
      ownerSocket.close();
    }
  });
});

describe("D7 (r): pengaturan admin berlaku ke klien (F-15)", () => {
  it("AC F15-3, AC F03-5, PRD 4.5: biaya baru hanya untuk payment baru; mode pemeliharaan menolak mutasi anggota tetapi verifikasi KTA tetap jalan", async () => {
    const admin = await adminFixture({
      permissions: ["settings.manage", "payments.read", "payments.decide"],
    });
    const oldMember = await memberFixture({ status: "unverified", fullName: "Cahya Harga Lama" });
    const oldPayment = await submitDues(oldMember, "registration", {
      data: await testJpeg(),
      filename: "lama.jpg",
      contentType: "image/jpeg",
    });
    const fees = await step("get", "/admin/settings/fees", "/admin/settings/fees", 200, undefined, {
      token: admin.token,
    });
    const updated = await step(
      "put",
      "/admin/settings/fees",
      "/admin/settings/fees",
      200,
      {
        registration_fee: "55000.00",
        card_fee: "15000.00",
        renewal_fee: "12000.00",
        reason: "Rapat pengurus",
      },
      { token: admin.token, headers: { ...(await adminReauth(admin)), "if-match": fees.json.version } },
    );
    expect(updated.json.registration_total).toBe("70000.00");
    const newMember = await memberFixture({ status: "unverified", fullName: "Dina Harga Baru" });
    const quote = await step("get", "/me/fees", "/me/fees", 200, undefined, {
      token: newMember.token,
      headers: APP,
    });
    expect(quote.json.registration.total).toBe("70000.00");
    const approvedOld = await decide(admin, oldPayment.id, "approve");
    expect(approvedOld.amount).toBe("60000.00");

    // Mode pemeliharaan (PRD 4.5).
    const settings = await step("get", "/admin/settings", "/admin/settings", 200, undefined, {
      token: admin.token,
    });
    const maintenanceOn = await step(
      "put",
      "/admin/settings/maintenance",
      "/admin/settings/maintenance",
      200,
      { active: true, message: "Pemeliharaan server", until: null },
      {
        token: admin.token,
        headers: { ...(await adminReauth(admin)), "if-match": settings.json.maintenance.version },
      },
    );
    try {
      const config = await step("get", "/public/config", "/public/config", 200);
      expect(config.json.maintenance).toMatchObject({ active: true });
      const mutation = await call(
        "post",
        "/me/payments",
        { type: "registration", payment_method_id: await bankMethod() },
        { token: newMember.token, headers: APP },
      );
      expect(mutation.statusCode, show("post", "/me/payments (pemeliharaan)", mutation)).toBe(503);
      expect(expectOperation("post", "/me/payments", mutation)).toMatchObject({ code: "MAINTENANCE" });
      await step("get", "/me", "/me", 200, undefined, { token: newMember.token });
      // Refresh dan verifikasi KTA publik tetap jalan.
      const card = await step("get", "/me/card", "/me/card", 200, undefined, { token: oldMember.token });
      const qr = ktaFromQr(card.json.qr.url);
      await step("post", "/public/kta/verify", "/public/kta/verify", 200, {
        member_number: qr.memberNumber,
        token: qr.token,
      });
      await step(
        "post",
        "/auth/refresh",
        "/auth/refresh",
        200,
        { refresh_token: newMember.refreshToken },
        {
          headers: APP,
        },
      );

      // Pengurus mematikan maintenance dari web admin (/admin/** dikecualikan, request-gate.ts). Endpoint itu
      // mewajibkan X-Reauth-Token; POST /auth/reauth dikecualikan dari maintenance untuk access token admin (D7-01).
      clock.advance(11 * 60_000); // token reauth saat mengaktifkan sudah lewat 10 menit
      const relogged = await loginAdmin(admin.fixture, admin.lastStep);
      admin.token = relogged.token;
      admin.lastStep = relogged.lastStep;
      const stuck = await call(
        "put",
        "/admin/settings/maintenance",
        { active: false, message: null, until: null },
        { token: admin.token, headers: { "if-match": maintenanceOn.json.version } },
      );
      expect(stuck.statusCode, show("put", "/admin/settings/maintenance", stuck)).toBe(403);
      expect(expectOperation("put", "/admin/settings/maintenance", stuck)).toMatchObject({
        code: "REAUTH_REQUIRED",
      });
      // Anggota tidak mendapat pengecualian reautentikasi.
      const memberReauth = await call(
        "post",
        "/auth/reauth",
        { password: newMember.password },
        { token: newMember.token, headers: APP },
      );
      expect(memberReauth.statusCode, show("post", "/auth/reauth (anggota)", memberReauth)).toBe(503);
      expect(expectOperation("post", "/auth/reauth", memberReauth)).toMatchObject({ code: "MAINTENANCE" });
      const reauthStep = nextTotp(admin.fixture.totpSecret!, admin.lastStep);
      const reauthBody = { password: admin.fixture.password, totp_code: reauthStep.code };
      const reauth = await call("post", "/auth/reauth", reauthBody, { token: admin.token });
      admin.lastStep = reauthStep.step;
      expect(reauth.statusCode, show("post", "/auth/reauth (pemeliharaan)", reauth, reauthBody)).toBe(200);
      const reauthToken = (expectOperation("post", "/auth/reauth", reauth) as Json).reauth_token as string;
      // Unggahan kerja pengurus (bukti D13, bukti refund) lewat POST /files tetap diproses.
      const upload = multipartBody([
        { name: "purpose", value: "adjustment_evidence" },
        { name: "file", filename: "refund.jpg", contentType: "image/jpeg", data: await testJpeg() },
      ]);
      const adminUpload = (await app.inject({
        method: "POST",
        url: "/api/v1/files",
        payload: upload.payload,
        headers: { ...upload.headers, authorization: `Bearer ${admin.token}` },
      })) as unknown as InjectResponse;
      expect(adminUpload.statusCode, show("post", "/files (pemeliharaan)", adminUpload)).toBe(201);
      expectOperation("post", "/files", adminUpload);
      // Maintenance dimatikan lewat API dengan reautentikasi baru.
      const off = await step(
        "put",
        "/admin/settings/maintenance",
        "/admin/settings/maintenance",
        200,
        { active: false, message: null, until: null },
        {
          token: admin.token,
          headers: { "x-reauth-token": reauthToken, "if-match": maintenanceOn.json.version },
        },
      );
      expect(off.json).toMatchObject({ active: false });
      const resumed = await step("get", "/public/config", "/public/config", 200);
      expect(resumed.json.maintenance).toMatchObject({ active: false });
    } finally {
      // Jaring pengaman bila langkah di atas gagal sebelum maintenance dimatikan lewat API: perjalanan lain tidak
      // boleh ikut terkena 503.
      const [current] = await sql<{ active: boolean }[]>`
        select (value ->> 'active')::boolean as active from app.app_settings where key = 'maintenance'`;
      if (current?.active) {
        await sql`
          update app.app_settings set value = '{"active": false, "message": null, "until": null}'::jsonb,
                 version = version + 1 where key = 'maintenance'`;
        app.get(SettingsService).invalidate("maintenance");
        worker.app.get(SettingsService).invalidate("maintenance");
      }
    }
  });
});

describe("D7 (s): keluar semua perangkat dan idle admin (F-02)", () => {
  it("AC F02-6, F02-5: logout-all memutus socket & sesi lain; sesi admin idle 30 menit tidak dapat di-refresh", async () => {
    const member = await memberFixture({ status: "verified", fullName: "Elang Banyak Perangkat" });
    const second = await loginAlumni(member.email, member.password);
    const socket = await connectSocket({ ...member, token: second.token });
    try {
      await step("post", "/auth/logout-all", "/auth/logout-all", 204, undefined, { token: member.token });
      await socket.waitFor("session.revoked");
      for (const token of [member.token, second.token]) {
        const res = await call("get", "/me", undefined, { token });
        expect(res.statusCode).toBe(401);
      }
      const refresh = await call(
        "post",
        "/auth/refresh",
        { refresh_token: second.refreshToken },
        { headers: APP },
      );
      expect(refresh.statusCode).toBe(401);
    } finally {
      socket.close();
    }

    // Ganti sandi alumni: sesi lain dicabut + socket diputus, sesi saat ini tetap (AC F02-4).
    const changer = await memberFixture({ status: "verified", fullName: "Fikri Ganti Sandi" });
    const otherDevice = await loginAlumni(changer.email, changer.password);
    const otherSocket = await connectSocket({ ...changer, token: otherDevice.token });
    try {
      await step(
        "post",
        "/auth/password/change",
        "/auth/password/change",
        204,
        { current_password: changer.password, new_password: "SandiAlumniBaru#2026" },
        { token: changer.token, headers: APP },
      );
      await otherSocket.waitFor("session.revoked");
      expect((await call("get", "/me", undefined, { token: otherDevice.token })).statusCode).toBe(401);
      await step("get", "/me", "/me", 200, undefined, { token: changer.token });
      await drain();
      const security = await step("get", "/notifications", "/notifications", 200, undefined, {
        token: changer.token,
        query: { category: "security" },
      });
      expect(security.json.items.length).toBeGreaterThanOrEqual(1);
    } finally {
      otherSocket.close();
    }

    const fixture = await createAdmin(fx, { permissions: ["payments.read"], displayName: "Admin Idle" });
    const login = await step("post", "/admin/auth/login", "/admin/auth/login", 200, {
      email: fixture.email,
      password: fixture.password,
    });
    const { code } = nextTotp(fixture.totpSecret!, -1);
    const mfa = await app.inject({
      method: "POST",
      url: "/api/v1/admin/auth/mfa",
      payload: { mfa_token: login.json.mfa_token, totp_code: code },
    });
    expect(mfa.statusCode, mfa.body).toBe(200);
    const cookie = /kapdh_admin_rt=([^;]+)/.exec(String(mfa.headers["set-cookie"] ?? ""))![1]!;
    // Refresh sebelum idle berhasil.
    clock.advance(10 * 60_000);
    const active = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { kapdh_admin_rt: cookie },
      headers: { origin: testEnv.ADMIN_ORIGIN },
    });
    expect(active.statusCode, active.body).toBe(200);
    const rotated = /kapdh_admin_rt=([^;]+)/.exec(String(active.headers["set-cookie"] ?? ""))?.[1] ?? cookie;
    clock.advance(31 * 60_000);
    const idle = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { kapdh_admin_rt: rotated },
      headers: { origin: testEnv.ADMIN_ORIGIN },
    });
    expect(idle.statusCode, idle.body).toBe(401);
  });
});

describe("D7 (u): email keputusan gagal → worker mengulang → gagal permanen → pengurus mengirim ulang (F-13)", () => {
  it("AC F04-5, F13-1, PRD 3.13: SMTP sementara gagal dijadwalkan ulang tanpa menggandakan inbox; gagal permanen tampil di admin dan dapat dikirim ulang", async () => {
    const member = await memberFixture({ status: "unverified", fullName: "Hesti Email Gagal" });
    const payment = await submitDues(member, "registration", {
      data: await testJpeg(),
      filename: "gagal.jpg",
      contentType: "image/jpeg",
    });
    const admin = await adminFixture({
      permissions: ["payments.read", "payments.decide", "notifications.manage"],
    });
    // Antrean outbox/pengiriman lain dikosongkan agar kegagalan tiruan mengenai email keputusan ini.
    await drain();
    await runJob("notifications.retry");
    await decide(admin, payment.id, "approve");
    // Percobaan 1: 421 (sementara) → dijadwalkan ulang.
    mailer.failNext({ responseCode: 421, message: "421 Try again later" });
    await drain();
    expect(mailer.messagesTo(member.email)).toHaveLength(0);
    const pending = await step(
      "get",
      "/admin/notifications/deliveries",
      "/admin/notifications/deliveries",
      200,
      undefined,
      { token: admin.token, query: { user_id: member.userId, channel: "email" } },
    );
    expect(pending.json.items).toHaveLength(1);
    expect(pending.json.items[0]).toMatchObject({
      status: "pending",
      attempt: 1,
      error_class: "bounce_soft",
    });
    // Worker mengulang setelah backoff.
    clock.advance(30 * 60_000);
    await runJob("notifications.retry");
    expect(mailer.messagesTo(member.email)).toHaveLength(1);
    const inbox = await loginAlumni(member.email, member.password);
    const notices = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: inbox.token,
    });
    expect(
      notices.json.items.filter((n: Json) => n.deep_link === `kapdh://app/payments/${payment.id}`),
    ).toHaveLength(1);

    // Gagal permanen (550) pada notifikasi berikutnya → failed; pengurus mengirim ulang.
    const other = await memberFixture({ status: "unverified", fullName: "Indra Email Ditolak" });
    const otherPayment = await submitDues(other, "registration", {
      data: await testJpeg(),
      filename: "tolak.jpg",
      contentType: "image/jpeg",
    });
    const decider = await loginAdmin(admin.fixture, admin.lastStep);
    await drain();
    await runJob("notifications.retry");
    await decide(decider, otherPayment.id, "reject", "Bukti bukan transfer");
    mailer.failNext({ responseCode: 550, message: "550 Mailbox unavailable" });
    await drain();
    const failed = await step(
      "get",
      "/admin/notifications/deliveries",
      "/admin/notifications/deliveries",
      200,
      undefined,
      { token: decider.token, query: { user_id: other.userId, status: "failed" } },
    );
    expect(failed.json.items).toHaveLength(1);
    expect(failed.json.items[0].retryable).toBe(true);
    const retried = await step(
      "post",
      "/admin/notifications/deliveries/retry",
      "/admin/notifications/deliveries/retry",
      200,
      { delivery_ids: [failed.json.items[0].id] },
      { token: decider.token, idem: true },
    );
    expect(retried.json.requeued).toHaveLength(1);
    await runJob("notifications.retry");
    expect(mailer.messagesTo(other.email)).toHaveLength(1);
    const after = await step(
      "get",
      "/admin/notifications/deliveries",
      "/admin/notifications/deliveries",
      200,
      undefined,
      { token: decider.token, query: { user_id: other.userId, channel: "email" } },
    );
    expect(after.json.items[0].status).toBe("sent");
  });
});

describe("D7 (v): berkas ekspor audit dan unggahan sementara kedaluwarsa oleh job worker", () => {
  it("AC F17-4, N-10: ekspor siap → 24 jam → maintenance.cleanup → expired/404; unggahan tak terpakai dibersihkan files.cleanup-temp", async () => {
    const auditor = await adminFixture({ permissions: ["audit.read", "audit.export"] });
    const created = await step(
      "post",
      "/admin/audit/exports",
      "/admin/audit/exports",
      202,
      { action: "payment.approved" },
      { token: auditor.token, idem: true },
    );
    await drain();
    const ready = await step(
      "get",
      `/admin/audit/exports/${created.json.id}`,
      "/admin/audit/exports/{exportId}",
      200,
      undefined,
      { token: auditor.token },
    );
    expect(ready.json.status).toBe("ready");
    const member = await memberFixture({ status: "unverified", fullName: "Joko Unggah Lupa" });
    const orphan = await uploadMultipart(member.token, "payment_proof", {
      data: await testJpeg(),
      filename: "lupa.jpg",
      contentType: "image/jpeg",
    });

    clock.set(new Date(new Date(ready.json.expires_at).getTime() + HOUR));
    await runJob("maintenance.cleanup");
    await runJob("files.cleanup-temp");
    const relog = await loginAdmin(auditor.fixture, auditor.lastStep);
    const expired = await step(
      "get",
      `/admin/audit/exports/${created.json.id}`,
      "/admin/audit/exports/{exportId}",
      200,
      undefined,
      { token: relog.token },
    );
    expect(expired.json.status).toBe("expired");
    const access = await call("get", `/admin/audit/exports/${created.json.id}/access`, undefined, {
      token: relog.token,
    });
    expect(access.statusCode, show("get", "access ekspor kedaluwarsa", access)).toBe(404);
    expectOperation("get", "/admin/audit/exports/{exportId}/access", access);

    // Unggahan sementara > 24 jam tidak dapat lagi dipakai sebagai bukti.
    const memberToken = (await loginAlumni(member.email, member.password)).token;
    const created2 = await step(
      "post",
      "/me/payments",
      "/me/payments",
      201,
      { type: "registration", payment_method_id: await bankMethod() },
      { token: memberToken, idem: true, headers: APP },
    );
    const stale = await call(
      "put",
      `/me/payments/${created2.json.id}/proof`,
      { file_id: orphan.json.id, expected_proof_version: 0 },
      { token: memberToken, headers: APP },
    );
    expect([400, 404, 422], show("put", "proof berkas dibersihkan", stale)).toContain(stale.statusCode);
    expectOperation("put", "/me/payments/{paymentId}/proof", stale);
    const [file] = await sql<{ status: string }[]>`select status from app.files where id = ${orphan.json.id}`;
    expect(file!.status).toBe("deleted");
  });
});

/** Undangan admin tertaut alumni lewat HTTP + email worker + aktivasi TOTP; mengembalikan sesi admin baru. */
async function inviteAndActivate(
  superAdmin: AdminSession,
  alumniUserId: string,
  permissions: string[],
): Promise<{ adminId: string; token: string }> {
  const adminEmail = freshEmail("pengurus-tertaut");
  const invited = await step(
    "post",
    "/admin/admins",
    "/admin/admins",
    201,
    {
      alumni_user_id: alumniUserId,
      email: adminEmail,
      display_name: "Pengurus Tertaut",
      role: "admin",
      permissions,
    },
    { token: superAdmin.token, idem: true, headers: await adminReauth(superAdmin) },
  );
  await drain();
  const mail = mailer.lastMessage(adminEmail)!;
  const token = decodeURIComponent(
    /\/invite#t=([A-Za-z0-9_%-]+)/.exec(`${mail.text}\n${mail.html ?? ""}`)![1]!,
  );
  const accepted = await step(
    "post",
    "/admin/auth/invitations/accept",
    "/admin/auth/invitations/accept",
    200,
    {
      invite_token: token,
      password: "Tertaut#2026",
    },
  );
  const enroll = await step("post", "/admin/auth/totp/enroll", "/admin/auth/totp/enroll", 200, {
    mfa_token: accepted.json.mfa_token,
  });
  const confirmed = await step("post", "/admin/auth/totp/confirm", "/admin/auth/totp/confirm", 200, {
    mfa_token: accepted.json.mfa_token,
    totp_code: nextTotp(enroll.json.secret, -1).code,
  });
  return { adminId: invited.json.admin.id, token: confirmed.json.session.access_token };
}

describe("D7 (x): konflik kepentingan pengurus tertaut alumni dan verifikasi dana (PRD 2.3, 3.4)", () => {
  it("PRD 2.3, AC F04-1: pengurus hasil undangan tidak dapat memutus iuran akun alumninya; approve tanpa funds_verified ditolak", async () => {
    const superAdmin = await adminFixture({ role: "super_admin", displayName: "Super Admin Konflik" });
    const alumniSelf = await memberFixture({ status: "expiring", fullName: "Kurnia Bendahara Anggota" });
    const linked = await inviteAndActivate(superAdmin, alumniSelf.userId, [
      "payments.read",
      "payments.decide",
    ]);
    const payment = await submitDues(alumniSelf, "renewal", {
      data: await testJpeg(),
      filename: "milik-sendiri.jpg",
      contentType: "image/jpeg",
    });
    const own = await step(
      "get",
      `/admin/payments/${payment.id}`,
      "/admin/payments/{paymentId}",
      200,
      undefined,
      {
        token: linked.token,
      },
    );
    expect(own.json).toMatchObject({ conflict_of_interest: true, actions: { can_decide: false } });
    const selfApprove = await call(
      "post",
      `/admin/payments/${payment.id}/decision`,
      {
        decision: "approve",
        expected_proof_version: 1,
        expected_version: own.json.version,
        funds_verified: true,
      },
      { token: linked.token },
    );
    expect(selfApprove.statusCode, show("post", "decision (konflik)", selfApprove)).toBe(403);
    expect(expectOperation("post", "/admin/payments/{paymentId}/decision", selfApprove)).toMatchObject({
      code: "FORBIDDEN",
    });

    const other = await adminFixture({ permissions: ["payments.read", "payments.decide"] });
    const detail = await step(
      "get",
      `/admin/payments/${payment.id}`,
      "/admin/payments/{paymentId}",
      200,
      undefined,
      {
        token: other.token,
      },
    );
    for (const funds of [undefined, false]) {
      const res = await call(
        "post",
        `/admin/payments/${payment.id}/decision`,
        {
          decision: "approve",
          expected_proof_version: 1,
          expected_version: detail.json.version,
          ...(funds === undefined ? {} : { funds_verified: funds }),
        },
        { token: other.token },
      );
      expect(res.statusCode, show("post", `decision funds_verified=${funds}`, res)).toBe(400);
      expectOperation("post", "/admin/payments/{paymentId}/decision", res);
    }
    const approved = await decide(other, payment.id, "approve");
    expect(approved.status).toBe("paid");

    // Akun alumni pribadi pengurus tetap dapat dihapus terpisah (PRD 3.14); identitas admin tetap berfungsi.
    const disclosure = await step(
      "get",
      "/me/deletion/disclosure",
      "/me/deletion/disclosure",
      200,
      undefined,
      {
        token: alumniSelf.token,
      },
    );
    expect(disclosure.json.linked_admin_identity).toBe(true);
    const requested = await step(
      "post",
      "/me/deletion",
      "/me/deletion",
      202,
      { confirm: true, acknowledged_disclosure_version: disclosure.json.version },
      { token: alumniSelf.token, idem: true, headers: { ...APP, ...(await memberReauth(alumniSelf)) } },
    );
    await drain();
    const [row] = await sql<{ status: string; last_error: string | null }[]>`
      select status, last_error from app.account_deletions where request_number = ${requested.json.request_number}`;
    expect(row!.status, String(row!.last_error)).toBe("completed");
    const adminView = await step(
      "get",
      `/admin/admins/${linked.adminId}`,
      "/admin/admins/{adminId}",
      200,
      undefined,
      {
        token: superAdmin.token,
      },
    );
    expect(adminView.json.status).toBe("active");
    expect(adminView.res.body).not.toContain("Kurnia Bendahara Anggota");
    const stillWorks = await call("get", "/admin/payments", undefined, { token: linked.token });
    expect(stillWorks.statusCode).toBe(200);
  });
});

describe("D7 (y): gambar chat, laporan pesan dengan bukti, hapus pesan oleh moderator (F-11, F-12)", () => {
  it("AC F11-4, F12-2, F12-3: gambar hanya untuk anggota room; laporan pesan menyimpan bukti; warn + remove_message mengirim message.deleted", async () => {
    const sender = await memberFixture({ status: "verified", fullName: "Lia Pengirim Gambar" });
    const receiver = await memberFixture({ status: "verified", fullName: "Mamat Penerima" });
    const outsider = await memberFixture({ status: "verified", fullName: "Nunu Orang Luar" });
    const room = await step(
      "post",
      "/chat/direct",
      "/chat/direct",
      [200, 201],
      { user_id: receiver.userId },
      {
        token: sender.token,
        headers: APP,
      },
    );
    const image = await uploadMultipart(sender.token, "chat_image", {
      data: await testJpeg({ width: 300, height: 300, withPrivateExif: true }),
      filename: "foto.jpg",
      contentType: "image/jpeg",
    });
    const sent = await call(
      "post",
      `/chat/rooms/${room.json.id}/messages`,
      { client_message_id: uuidv7(), kind: "image", image_file_id: image.json.id },
      { token: sender.token, headers: APP },
    );
    expect(sent.statusCode, show("post", "messages (gambar)", sent)).toBe(201);
    const imageMsg = expectOperation("post", "/chat/rooms/{roomId}/messages", sent) as Json;
    const offensive = await sendText(sender, room.json.id, "Kamu bodoh sekali, dasar penipu!");
    const offensiveMsg = expectOperation("post", "/chat/rooms/{roomId}/messages", offensive) as Json;
    const view = await step(
      "get",
      `/chat/rooms/${room.json.id}/messages`,
      "/chat/rooms/{roomId}/messages",
      200,
      undefined,
      { token: receiver.token },
    );
    const received = view.json.items.find((m: Json) => m.id === imageMsg.id);
    const imageUrl = received.image?.url as string;
    expect(imageUrl, JSON.stringify(received)).toEqual(expect.any(String));
    const opened = await openSignedUrl(imageUrl);
    expect(opened.statusCode).toBe(200);
    // Bukan anggota room: akses berkas lewat id ditolak (AC F11-4).
    const leak = await call("get", `/files/${image.json.id}/access`, undefined, { token: outsider.token });
    expect([403, 404], show("get", "/files/{id}/access (orang luar)", leak)).toContain(leak.statusCode);

    // Laporan pesan dengan konteks (AC F12-2).
    const report = await step(
      "post",
      "/reports",
      "/reports",
      201,
      {
        target_type: "message",
        message_id: offensiveMsg.id,
        context_message_ids: [imageMsg.id],
        category: "harassment",
      },
      { token: receiver.token, idem: true, headers: APP },
    );
    const moderator = await adminFixture({ permissions: ["moderation.read", "moderation.resolve"] });
    const detail = await step(
      "get",
      `/admin/reports/${report.json.id}`,
      "/admin/reports/{reportId}",
      200,
      undefined,
      { token: moderator.token },
    );
    expect(detail.res.body).toContain("Kamu bodoh sekali");
    const receiverSocket = await connectSocket(receiver);
    try {
      const resolved = await step(
        "post",
        `/admin/reports/${report.json.id}/resolve`,
        "/admin/reports/{reportId}/resolve",
        200,
        {
          action: "warn",
          note: "Bahasa kasar",
          member_message: "Mohon jaga bahasa di komunitas.",
          remove_message: true,
        },
        { token: moderator.token, idem: true, headers: { "if-match": detail.json.version } },
      );
      expect(resolved.json.status).toBe("resolved");
      await receiverSocket.waitFor("message.deleted", (e) => e.entity_id === offensiveMsg.id);
    } finally {
      receiverSocket.close();
    }
    const after = await step(
      "get",
      `/chat/rooms/${room.json.id}/messages`,
      "/chat/rooms/{roomId}/messages",
      200,
      undefined,
      { token: receiver.token },
    );
    expect(after.res.body).not.toContain("Kamu bodoh sekali");
    // Bukti tetap tersimpan untuk moderator (PRD 3.12).
    const evidence = await step(
      "get",
      `/admin/reports/${report.json.id}`,
      "/admin/reports/{reportId}",
      200,
      undefined,
      { token: moderator.token },
    );
    expect(evidence.res.body).toContain("Kamu bodoh sekali");
    // Warn tidak mengubah tanggal keanggotaan; pengirim menerima pesan peringatan (AC F12-3).
    await drain();
    const warned = await step("get", "/notifications", "/notifications", 200, undefined, {
      token: sender.token,
      query: { category: "account" },
    });
    expect(JSON.stringify(warned.json.items)).toContain("Mohon jaga bahasa");
  });
});

describe("D7 (cms): berita terjadwal diterbitkan worker sekali (F-08)", () => {
  it("AC F15-5, F08-1, F08-3: jadwal tiba → content.announce menerbitkan sekali, feed & like konsisten, arsip tidak hidup lagi", async () => {
    const editor = await adminFixture({ permissions: ["content.manage"] });
    const reader = await memberFixture({ status: "verified", fullName: "Umar Pembaca" });
    const post = await step(
      "post",
      "/admin/content/posts",
      "/admin/content/posts",
      201,
      {
        title: "Pengumuman Reuni Akbar 2026",
        slug: `reuni-akbar-${uuidv7().slice(-8)}`,
        excerpt: "Daftar sekarang",
        body_html: "<p>Reuni akbar <strong>KAPDH</strong>.</p><script>alert(1)</script>",
      },
      { token: editor.token, idem: true },
    );
    expect(post.json.body_html ?? "").not.toContain("<script");
    const at = new Date(clock.now().getTime() + 2 * HOUR);
    const scheduled = await step(
      "post",
      `/admin/content/posts/${post.json.id}/publish`,
      "/admin/content/posts/{postId}/publish",
      200,
      { published_at: at.toISOString() },
      { token: editor.token, idem: true, headers: { "if-match": post.json.version } },
    );
    const before = await step("get", "/posts", "/posts", 200, undefined, { token: reader.token });
    expect(before.json.items.map((p: Json) => p.slug)).not.toContain(post.json.slug);
    clock.set(new Date(at.getTime() + 60_000));
    await runJob("content.announce");
    await runJob("content.announce");
    const token = (await loginAlumni(reader.email, reader.password)).token;
    const feed = await step("get", "/posts", "/posts", 200, undefined, { token });
    expect(feed.json.items.map((p: Json) => p.slug)).toContain(post.json.slug);
    await drain();
    const news = await step("get", "/notifications", "/notifications", 200, undefined, {
      token,
      query: { category: "news" },
    });
    expect(news.json.items.filter((n: Json) => JSON.stringify(n).includes(post.json.slug))).toHaveLength(1);
    // Like berulang → satu like (AC F08-3).
    for (let i = 0; i < 3; i++)
      await step("put", `/posts/${post.json.slug}/like`, "/posts/{slug}/like", 200, undefined, {
        token,
        headers: APP,
      });
    const detail = await step("get", `/posts/${post.json.slug}`, "/posts/{slug}", 200, undefined, { token });
    expect(detail.json).toMatchObject({ like_count: 1, liked_by_me: true });
    // Arsip → hilang dari feed; job lama tidak menghidupkannya.
    const editorNow = await loginAdmin(editor.fixture, editor.lastStep);
    const current = await step(
      "get",
      `/admin/content/posts/${post.json.id}`,
      "/admin/content/posts/{postId}",
      200,
      undefined,
      { token: editorNow.token },
    );
    await step(
      "post",
      `/admin/content/posts/${post.json.id}/archive`,
      "/admin/content/posts/{postId}/archive",
      200,
      {},
      { token: editorNow.token, idem: true, headers: { "if-match": current.json.version } },
    );
    await runJob("content.announce");
    const after = await step("get", "/posts", "/posts", 200, undefined, { token });
    expect(after.json.items.map((p: Json) => p.slug)).not.toContain(post.json.slug);
    expect(scheduled.json.published_at).toBe(at.toISOString());
  });
});

describe("D7 (h2): ganti sandi admin saat ada login tahap sandi yang belum selesai (F-02)", () => {
  it("AC F02-4, N-08: mfa_token yang diterbitkan dengan sandi lama tidak boleh menghasilkan sesi setelah sandi diganti", async () => {
    const fixture = await createAdmin(fx, {
      permissions: ["payments.read"],
      displayName: "Admin Ganti Sandi",
    });
    const session = await loginAdmin(fixture);
    // Tahap sandi di perangkat/peramban lain (sandi lama) — belum menyelesaikan TOTP.
    const pending = await step("post", "/admin/auth/login", "/admin/auth/login", 200, {
      email: fixture.email,
      password: fixture.password,
    });
    const newPassword = "SandiAdminBaru#2026";
    await step(
      "post",
      "/admin/auth/password/change",
      "/admin/auth/password/change",
      204,
      { current_password: fixture.password, new_password: newPassword },
      { token: session.token },
    );
    const oldPassword = await call("post", "/admin/auth/login", {
      email: fixture.email,
      password: fixture.password,
    });
    expect(oldPassword.statusCode).toBe(401);
    const { code } = nextTotp(fixture.totpSecret!, session.lastStep);
    const late = await call("post", "/admin/auth/mfa", {
      mfa_token: pending.json.mfa_token,
      totp_code: code,
    });
    // D7-02: mfa_token sandi lama masih menghasilkan sesi admin baru setelah sandi diganti.
    await expectDefect("D7-02", () => {
      expect(late.statusCode, show("post", "/admin/auth/mfa (mfa_token sebelum ganti sandi)", late)).toBe(
        401,
      );
    });
    expect(late.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/mfa", late);
    const me = await call("get", "/admin/me", undefined, { token: (late.json() as Json).access_token });
    expect(me.statusCode).toBe(200);
  });
});

describe("D7 (a2): registrasi dengan salah ketik email, kirim ulang OTP dan login sebelum verifikasi (F-01)", () => {
  it("AC F01-1, F01-3, F01-4: koreksi email → kirim ulang membatalkan kode lama → login pending_otp diarahkan ke OTP → aktif", async () => {
    const typo = freshEmail("salahketik");
    const correct = freshEmail("benar");
    const password = "Kapdh#2026";
    const reg = await step(
      "post",
      "/auth/register",
      "/auth/register",
      201,
      {
        full_name: "Rudi Salah Ketik",
        gender: "male",
        email: typo,
        password,
        cohort: 20,
        class_in: 4,
        class_out: 6,
        accept_policy_version: PG_CONSENT_VERSION,
      },
      { idem: true },
    );
    const corrected = await step("post", "/auth/email-correction", "/auth/email-correction", 200, {
      challenge_id: reg.json.challenge_id,
      password,
      new_email: correct,
    });
    const firstCode = mailer.last(correct);
    expect(firstCode).toBeDefined();
    // Kode untuk email lama tidak lagi berlaku.
    const stale = await call("post", "/auth/otp/verify", {
      challenge_id: reg.json.challenge_id,
      code: mailer.last(typo)!,
    });
    expect([400, 410], show("post", "/auth/otp/verify (email lama)", stale)).toContain(stale.statusCode);
    expectOperation("post", "/auth/otp/verify", stale);
    // Kirim ulang sebelum 60 detik ditolak; sesudahnya kode lama batal (PRD 2.5).
    const early = await call("post", "/auth/otp/resend", { challenge_id: corrected.json.challenge_id });
    expect(early.statusCode, show("post", "/auth/otp/resend (cooldown)", early)).toBe(429);
    expectOperation("post", "/auth/otp/resend", early);
    clock.advance(61_000);
    const resent = await step("post", "/auth/otp/resend", "/auth/otp/resend", 200, {
      challenge_id: corrected.json.challenge_id,
    });
    const secondCode = mailer.last(correct)!;
    if (secondCode !== firstCode) {
      const old = await call("post", "/auth/otp/verify", {
        challenge_id: resent.json.challenge_id,
        code: firstCode,
      });
      expect([400, 410], show("post", "/auth/otp/verify (kode lama)", old)).toContain(old.statusCode);
    }
    // Aplikasi ditutup; login dengan email benar → next verify_otp dengan challenge (tanpa sesi).
    const login = await step("post", "/auth/login", "/auth/login", 200, { email: correct, password });
    expect(login.json.next).toBe("verify_otp");
    expect(login.json.session).toBeUndefined();
    const challengeId = login.json.challenge.challenge_id as string;
    const status = await step("post", "/auth/otp/status", "/auth/otp/status", 200, {
      challenge_id: challengeId,
    });
    expect(status.json.attempts_left).toBeGreaterThan(0);
    const verified = await step("post", "/auth/otp/verify", "/auth/otp/verify", 200, {
      challenge_id: challengeId,
      code: mailer.last(correct)!,
    });
    const me = await step("get", "/me", "/me", 200, undefined, { token: verified.json.session.access_token });
    expect(me.json).toMatchObject({ email: correct, effective_status: "unverified" });
    expect(me.json.member_number).toMatch(/^20\.02\.01\.[1-9][0-9]*$/);
    const [typoAccount] = await sql<
      { n: number }[]
    >`select count(*)::int as n from app.users where email = ${typo}`;
    expect(typoAccount!.n).toBe(0);
  });
});

describe("D7 (a+): rencana cadangan iOS (D13) — instruksi iuran disembunyikan, pengurus mencatat pembayaran", () => {
  it("D13, AC F03-1, F04-1: iOS tidak menerima instruksi iuran; pengurus mencatat iuran bukti luar aplikasi → anggota aktif", async () => {
    const admin = await adminFixture({
      permissions: ["settings.manage", "payments.read", "payments.decide"],
    });
    const settings = await step("get", "/admin/settings", "/admin/settings", 200, undefined, {
      token: admin.token,
    });
    const hidden = await step(
      "put",
      "/admin/settings/payment-instructions",
      "/admin/settings/payment-instructions",
      200,
      { dues_hidden_platforms: ["ios"], reason: "Peninjauan App Store" },
      {
        token: admin.token,
        headers: { ...(await adminReauth(admin)), "if-match": settings.json.payment_instructions.version },
      },
    );
    const IOS = { "x-app-platform": "ios", "x-app-version": "1.0.0" };
    try {
      const member = await memberFixture({ status: "unverified", fullName: "Oki Pengguna iPhone" });
      const fees = await step("get", "/me/fees", "/me/fees", 200, undefined, {
        token: member.token,
        headers: IOS,
      });
      expect(fees.json.instructions_hidden).toBe(true);
      const blocked = await call(
        "post",
        "/me/payments",
        { type: "registration", payment_method_id: await bankMethod() },
        { token: member.token, headers: IOS },
      );
      expect(blocked.statusCode, show("post", "/me/payments (iOS)", blocked)).toBe(403);
      expect(expectOperation("post", "/me/payments", blocked)).toMatchObject({ code: "FORBIDDEN" });
      const methods = await call("get", "/payment-methods", undefined, { token: member.token, headers: IOS });
      expectOperation("get", "/payment-methods", methods);
      // Android tetap melihat instruksi.
      const android = await step("get", "/me/fees", "/me/fees", 200, undefined, {
        token: member.token,
        headers: APP,
      });
      expect(android.json.instructions_hidden).toBe(false);

      // Pengurus mencatat iuran yang ditransfer di luar aplikasi (bukti diunggah pengurus).
      const proof = await uploadMultipart(admin.token, "payment_proof", {
        data: testPdf(),
        filename: "mutasi.pdf",
        contentType: "application/pdf",
      });
      const recorded = await step(
        "post",
        "/admin/payments",
        "/admin/payments",
        201,
        {
          user_id: member.userId,
          type: "registration",
          payment_method_id: await bankMethod(),
          proof_file_id: proof.json.id,
          funds_verified: true,
          reason: "Mutasi BSI 14 Okt, transfer dari rekening anggota",
        },
        { token: admin.token, idem: true },
      );
      expect(recorded.json).toMatchObject({
        status: "paid",
        type: "registration",
        amount: fees.json.registration.total,
      });
      const me = await step("get", "/me", "/me", 200, undefined, { token: member.token, headers: IOS });
      expect(me.json.effective_status).toBe("verified");
      // Bukti pengurus tidak dibuka kepada anggota (kontrak getMyPayment).
      const mine = await step(
        "get",
        `/me/payments/${recorded.json.id}`,
        "/me/payments/{paymentId}",
        200,
        undefined,
        { token: member.token, headers: IOS },
      );
      expect(mine.json).toMatchObject({ status: "paid", instructions_hidden: true });
      const proofAccess = await call("get", `/files/${proof.json.id}/access`, undefined, {
        token: member.token,
      });
      expect([403, 404], show("get", "bukti pengurus oleh anggota", proofAccess)).toContain(
        proofAccess.statusCode,
      );
    } finally {
      await step(
        "put",
        "/admin/settings/payment-instructions",
        "/admin/settings/payment-instructions",
        200,
        { dues_hidden_platforms: [] },
        { token: admin.token, headers: { ...(await adminReauth(admin)), "if-match": hidden.json.version } },
      );
    }
  });
});

describe("D7 (t): layar baca web admin dan aplikasi atas data hasil seluruh perjalanan (kontrak)", () => {
  it("F-15, F-08..F-13: setiap endpoint baca mengembalikan status dan bentuk kontrak pada PostgreSQL 17", async () => {
    const superAdmin = await adminFixture({ role: "super_admin", displayName: "Super Admin Sapu" });
    const pick = async (query: Promise<{ id: string }[]>) => (await query)[0]?.id;
    const memberId = await pick(sql<{ id: string }[]>`
      select a.user_id as id from app.alumni a join app.users u on u.id = a.user_id
      where u.status = 'active' order by a.created_at limit 1`);
    const eventId = await pick(sql<{ id: string }[]>`
      select event_id as id from app.tickets group by event_id order by count(*) desc limit 1`);
    const reportId = await pick(
      sql<{ id: string }[]>`select id from app.reports order by created_at limit 1`,
    );
    const adminId = await pick(sql<{ id: string }[]>`select id from app.admins order by created_at limit 1`);
    const auditId = await pick(
      sql<{ id: string }[]>`select id from app.audit_logs order by created_at desc limit 1`,
    );
    const adjustmentId = await pick(sql<{ id: string }[]>`select id from app.payment_adjustments limit 1`);
    const methodId = await bankMethod();
    const adminReads: [string, string, Record<string, string>?][] = [
      ["/admin/me", "/admin/me"],
      ["/admin/permissions", "/admin/permissions"],
      ["/admin/dashboard", "/admin/dashboard"],
      ["/admin/dashboard/badges", "/admin/dashboard/badges"],
      ["/admin/payments", "/admin/payments", { limit: "100" }],
      ["/admin/payments", "/admin/payments", { stage: "awaiting_review", overdue: "true" }],
      ["/admin/payments/summary", "/admin/payments/summary"],
      ["/admin/payment-adjustments", "/admin/payment-adjustments"],
      [`/admin/payment-adjustments/${adjustmentId}`, "/admin/payment-adjustments/{adjustmentId}"],
      ["/admin/payment-methods", "/admin/payment-methods"],
      [`/admin/payment-methods/${methodId}`, "/admin/payment-methods/{methodId}"],
      ["/admin/members", "/admin/members", { limit: "100" }],
      ["/admin/members", "/admin/members", { effective_status: "suspended" }],
      [`/admin/members/${memberId}`, "/admin/members/{userId}"],
      [`/admin/members/${memberId}/membership-events`, "/admin/members/{userId}/membership-events"],
      ["/admin/events", "/admin/events", { limit: "100" }],
      [`/admin/events/${eventId}`, "/admin/events/{eventId}"],
      [`/admin/events/${eventId}/stats`, "/admin/events/{eventId}/stats"],
      [`/admin/events/${eventId}/tickets`, "/admin/events/{eventId}/tickets"],
      ["/admin/event-categories", "/admin/event-categories"],
      ["/admin/checkin/events", "/admin/checkin/events"],
      ["/admin/reports", "/admin/reports", { limit: "100" }],
      [`/admin/reports/${reportId}`, "/admin/reports/{reportId}"],
      ["/admin/notifications/deliveries", "/admin/notifications/deliveries", { limit: "100" }],
      ["/admin/notifications/outbox", "/admin/notifications/outbox", { limit: "100" }],
      ["/admin/admins", "/admin/admins", { limit: "100" }],
      [`/admin/admins/${adminId}`, "/admin/admins/{adminId}"],
      ["/admin/admins/candidates", "/admin/admins/candidates"],
      ["/admin/audit/entries", "/admin/audit/entries", { limit: "100" }],
      [`/admin/audit/entries/${auditId}`, "/admin/audit/entries/{entryId}"],
      ["/admin/audit/exports", "/admin/audit/exports"],
      ["/admin/settings", "/admin/settings"],
      ["/admin/settings/fees", "/admin/settings/fees"],
      ["/admin/content/posts", "/admin/content/posts"],
      ["/admin/content/banners", "/admin/content/banners"],
      ["/admin/content/pages", "/admin/content/pages"],
      ["/admin/content/post-categories", "/admin/content/post-categories"],
      ["/admin/content/event-categories", "/admin/content/event-categories"],
      ["/admin/masters/professions", "/admin/masters/{kind}"],
      ["/admin/masters/skills", "/admin/masters/{kind}"],
    ];
    const failures: string[] = [];
    for (const [path, op, query] of adminReads) {
      if (path.includes("undefined")) continue;
      try {
        await step("get", path, op, 200, undefined, { token: superAdmin.token, query });
      } catch (error) {
        failures.push((error as Error).message.split("\n")[0]!);
      }
    }
    const member = await memberFixture({ status: "verified", fullName: "Gilang Penjelajah" });
    const memberReads: [string, string][] = [
      ["/me", "/me"],
      ["/me/membership", "/me/membership"],
      ["/me/card", "/me/card"],
      ["/home", "/home"],
      ["/posts", "/posts"],
      ["/categories", "/categories"],
      ["/event-categories", "/event-categories"],
      ["/events", "/events"],
      [`/events/${eventId}`, "/events/{eventId}"],
      [`/events/${eventId}/participants`, "/events/{eventId}/participants"],
      ["/me/tickets", "/me/tickets"],
      ["/me/payments", "/me/payments"],
      ["/reports", "/reports"],
      ["/blocks", "/blocks"],
      ["/notifications/preferences", "/notifications/preferences"],
      ["/auth/sessions", "/auth/sessions"],
      ["/masters/professions", "/masters/{kind}"],
      ["/masters/skills", "/masters/{kind}"],
      ["/chat/rooms", "/chat/rooms"],
      ["/chat/invitations", "/chat/invitations"],
      ["/directory", "/directory"],
      ["/public/config", "/public/config"],
      ["/public/pages", "/public/pages"],
      ["/health", "/health"],
    ];
    for (const [path, op] of memberReads) {
      try {
        await step("get", path, op, 200, undefined, { token: member.token, headers: APP });
      } catch (error) {
        failures.push((error as Error).message.split("\n")[0]!);
      }
    }
    expect(failures).toEqual([]);
  });

  it("ARCHITECTURE §2.6: seluruh timestamp respons perjalanan berformat ISO 8601 UTC", () => {
    expect([...nonIsoTimestamps.entries()].map(([where, value]) => `${where} = ${value}`)).toEqual([]);
  });
});

describe("D7 (n): seluruh job terjadwal worker berjalan sebagai kapdh_worker di atas data perjalanan", () => {
  it("ARCHITECTURE §4.8: setiap job terjadwal yang terdaftar di worker selesai tanpa galat (grant role production)", async () => {
    const names = worker.registry.scheduledJobs().map((job) => job.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "reservations.expire",
        "events.lifecycle",
        "events.reminders",
        "membership.expiry-reminders",
        "content.announce",
        "files.cleanup-temp",
        "maintenance.cleanup",
        "account.deletion",
        "notifications.retry",
        "notifications.device-sweep",
      ]),
    );
    const failures: string[] = [];
    for (const name of names) {
      try {
        await runJob(name);
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    const drained = await drain();
    expect(drained.dead).toBe(0);
    const [dead] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.outbox_events where status in ('dead', 'failed')`;
    expect(dead!.n).toBe(0);
  });
});

// @@END@@
