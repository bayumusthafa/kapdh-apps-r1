/**
 * Audit LENS D5 (privasi dan penghapusan akun; F-14, D2, N-09, N-14, N-15, R1/R2): uji ujung ke ujung pada PostgreSQL 17
 * dengan role production (API sebagai kapdh_app, job sebagai kapdh_worker, anonimisasi audit lewat SET LOCAL ROLE
 * kapdh_audit_purge).
 *
 * Berbeda dengan test/account (fixture ditulis langsung ke tabel), anggota "Budi" di sini dibentuk HANYA lewat alur API
 * nyata sehingga isi baris (audit, notifikasi, outbox, bukti laporan, snapshot payment, kunci idempotensi, log) adalah
 * yang benar-benar ditulis kode production: registrasi + OTP, profil lengkap + avatar + profesi/keahlian, dua sesi
 * perangkat + token push, iuran berbukti (versi bukti diganti) disetujui bendahara, refund dengan rekening tujuan dan
 * refund selesai berbukti, tiket (paid, menunggu review, hold, dibatalkan sendiri, paid + check-in event yang sudah
 * selesai), chat direct + grup (teks, gambar, reaksi, avatar grup), laporan oleh dan tentang Budi (diputus warn), like,
 * blokir, preferensi notifikasi, tautan identitas pengurus. Lalu:
 *   1. backup (klon database + salinan storage) diambil SEBELUM permintaan penghapusan;
 *   2. penghapusan diminta lewat aplikasi (disclosure -> reauth -> konfirmasi), efek seketika diperiksa (AC F14-1);
 *   3. job dijalankan worker lewat outbox, lalu SETIAP tabel diperiksa (AC F14-3..F14-5, D2) termasuk pemindaian semua
 *      tabel skema app terhadap teks pribadi Budi, storage, KTA publik, direktori, member_seq tidak dipakai ulang;
 *   4. log API/worker dan payload push diperiksa (N-14, PRD 3.13);
 *   5. backup dipulihkan ke database baru, ledger eksternal diterapkan ulang (AC F14-6) dan pemeriksaan yang sama
 *      diulang pada database dan storage pulihan.
 * Celah yang ditemukan audit didokumentasikan sebagai `it.fails` dengan id temuan (D5-xx): uji itu LULUS selama celah
 * masih ada dan GAGAL begitu diperbaiki (ubah menjadi `it` saat memperbaiki). `D5_REVEAL_GAPS=1` menjalankannya sebagai
 * `it` biasa untuk melihat kegagalan sebenarnya:
 *   D5-01 (DIPERBAIKI, kini `it`) inbox anggota lain memuat nama anggota yang dihapus (notifikasi chat direct);
 *   D5-02 (DIPERBAIKI, kini `it`) respons idempotensi pengurus (check-in) memuat nama/nomor anggota sampai 24 jam;
 *   D5-03 (DIPERBAIKI, kini `it`) bukti refund yang diunggah SETELAH penghapusan tidak pernah dihapus;
 *   D5-04 (DIPERBAIKI, kini `it`) notifikasi yang dibuat selama jendela deletion_pending setelah langkah notifications;
 *   D5-05 (DIPERBAIKI, kini `it`) N anggota yang dihapus setelah titik backup dialokasikan ulang setelah restore + ledger.
 */
import "reflect-metadata";
import type { Permission } from "@kapdh/contracts";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import type { WorkerEnv } from "@kapdh/config";
import {
  accountDeletions,
  admins,
  alumni,
  alumniProfessions,
  alumniSkills,
  auditLogs,
  blocks,
  createDb,
  deviceTokens,
  events,
  files,
  idempotencyKeys,
  masterProfessions,
  masterSkills,
  membershipEvents,
  messageReactions,
  messages,
  notificationDeliveries,
  notifications,
  outboxEvents,
  paymentAdjustments,
  paymentEvents,
  payments,
  postLikes,
  posts,
  reports,
  roomMembers,
  rooms,
  sessions,
  tickets,
  users,
} from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { decodeJwt } from "jose";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import type { Db } from "../../src/core/db/types.js";
import { TokenService } from "../../src/core/identity/token.service.js";
import { createRootLogger } from "../../src/core/logging/logger.js";
import { readLedgerDirectory } from "../../src/modules/account/deletion-ledger.js";
import { DeletionLedgerService } from "../../src/modules/account/deletion-ledger.service.js";
import { AccountDeletionProcessor } from "../../src/modules/account/deletion-processor.js";
import { FORFEIT_REASON } from "../../src/modules/account/deletion-policy.js";
import {
  DELETION_STEPS,
  deletedEmailFor,
  remainingPersonalData,
} from "../../src/modules/account/deletion-steps.js";
import { createWorkerContext, type WorkerContext } from "../../src/worker.js";
import { exportLedger, personalDataHits, restoreStorage, snapshotStorage } from "../account/support.js";
import {
  createAdmin,
  createAlumni,
  createPaymentMethod,
  DEFAULT_PASSWORD,
  type EnrolledAdminFixture,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, PG_CONSENT_VERSION, type PgTestDatabase, publishLegalVersions } from "./support.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
type Json = ReturnType<typeof JSON.parse>;
type InjectResponse = Awaited<ReturnType<NestFastifyApplication["inject"]>>;

// ------------------------------------------------------------------------------------------- cluster dan database

function lane() {
  const config = inject("kapdhPg");
  if (!config)
    throw new Error("Jalur PG belum disiapkan; jalankan lewat `pnpm --filter @kapdh/api test:pg`.");
  return config;
}
const baseUrl = () => {
  const c = lane();
  return `postgres://${c.user}:${c.password}@${c.host}:${c.port}`;
};

/** Database baru hasil klon `template` (template lain selain kapdh_template = "backup" titik waktu). */
async function cloneDatabase(template: string, label: string): Promise<string> {
  const name = `kapdh_t_${label}_${randomBytes(4).toString("hex")}`;
  const admin = createDb(`${baseUrl()}/postgres`, { max: 1 }).sql;
  try {
    await admin.unsafe(`create database "${name}" template "${template}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  return name;
}

async function dropDatabase(name: string): Promise<void> {
  const admin = createDb(`${baseUrl()}/postgres`, { max: 1 }).sql;
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

// ------------------------------------------------------------------------------------------------ runtime

/** Log JSON seluruh proses (API + worker) untuk pemeriksaan N-14. */
const logs: string[] = [];
const logSink = { write: (line: string) => void logs.push(line) };

const clock = new TestClock();
const mailer = new MemoryMailer();
const push = new FakePush();

interface Runtime {
  dbName: string;
  /** Pemilik database (superuser): fixture referensi dan pemeriksaan. */
  owner: ReturnType<typeof createDb>;
  api: ReturnType<typeof connectAs>;
  worker: ReturnType<typeof connectAs>;
  app: NestFastifyApplication;
  ctx: WorkerContext;
  storage: MemoryDriver;
  /** Bentuk fixture yang dipakai factories (db pemilik + aplikasi). */
  fx: { app: NestFastifyApplication; db: Db; clock: TestClock; storage: MemoryDriver };
  close(): Promise<void>;
}

function workerEnv(): WorkerEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: testEnv.DATABASE_URL,
    REDIS_URL: undefined,
    LOG_LEVEL: "debug",
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

async function openRuntime(dbName: string, storage: MemoryDriver): Promise<Runtime> {
  const owner = createDb(`${baseUrl()}/${dbName}`, { max: 4, applicationName: "kapdh-pg-test-d5-owner" });
  const database = { name: dbName } as PgTestDatabase;
  const api = connectAs(database, "kapdh_app", 6);
  const worker = connectAs(database, "kapdh_worker", 4);
  const app = await createApp(
    {
      env: { ...testEnv, LOG_LEVEL: "debug" },
      db: api.db as unknown as Db,
      mailer,
      clock,
      push,
      storage,
      redis: null,
    },
    { logger: true, logDestination: logSink },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const ctx = await createWorkerContext(
    { env: workerEnv(), db: worker.db as unknown as Db, mailer, clock, push, storage, redis: null },
    { logger: createRootLogger({ level: "debug", service: "kapdh-worker", destination: logSink }) },
  );
  return {
    dbName,
    owner,
    api,
    worker,
    app,
    ctx,
    storage,
    fx: { app, db: owner.db as unknown as Db, clock, storage },
    async close() {
      await ctx.close();
      await app.close();
      await worker.sql.end({ timeout: 5 });
      await api.sql.end({ timeout: 5 });
      await owner.sql.end({ timeout: 5 });
    },
  };
}

let rt: Runtime;
const created: string[] = [];
const ledgerDirs: string[] = [];
const http = () => httpClient(rt.app);

function expectStatus(res: InjectResponse, ...statuses: number[]): Json {
  expect(statuses, `${res.statusCode} ${res.body.slice(0, 400)}`).toContain(res.statusCode);
  return res.body ? res.json() : null;
}

/** Token X-Reauth-Token keluarga sesi (POST /auth/reauth milik modul auth) untuk akses token ini. */
async function reauthHeader(accessToken: string): Promise<Record<string, string>> {
  const claims = decodeJwt(accessToken);
  const [session] = await rt.owner.db
    .select({ familyId: sessions.familyId, userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.id, String(claims.sid)));
  const { token } = await rt.app
    .get(TokenService)
    .signReauth({ userId: session!.userId, familyId: session!.familyId, level: 1 });
  return { "x-reauth-token": token };
}

// ------------------------------------------------------------------------------------------------ data Budi

const NAME = "Budi Penghapus Santoso";
const PHONE = "081277776666";
const PHONE_IN_CHAT = "081299998888";
const BIO = "Bio rahasia Budi Penghapus";
const INSTAGRAM = "budi.penghapus.ig";
const INSTITUTION = "Universitas Rahasia Budi";
const DEVICE = "Pixel Budi Penghapus";
const TRANSFER_NOTE = "Transfer BCA a.n. Budi Penghapus Santoso";
const REFUND_ACCOUNT = "5550001112";
const DM_TEXT = `Halo Ahmad, ini Budi, nomor saya ${PHONE_IN_CHAT}`;
const IMAGE_CAPTION = "Foto keluarga Budi Penghapus";
const GROUP_TEXT = "Salam dari Budi Penghapus untuk angkatan 22";
const REPORT_TEXT = "Saya Budi Penghapus melaporkan gangguan";
const CANCEL_TEXT = "Budi Penghapus sedang sakit";
const WARN_TEXT = "Budi Penghapus, mohon jaga sikap di grup";

interface Member {
  userId: string;
  email: string;
  token: string;
}
interface AdminSession {
  fixture: EnrolledAdminFixture;
  token: string;
}

interface State {
  budi: Member & {
    password: string;
    refreshTokens: string[];
    accessTokens: string[];
    memberNumber: string;
    memberSeq: number;
    cardToken: string;
    fcmTokens: string[];
  };
  ahmad: Member;
  citra: Member;
  treasurer: AdminSession;
  moderator: AdminSession;
  gate: AdminSession;
  linkedAdminId: string;
  methodId: string;
  files: Record<
    | "avatar"
    | "proofV1"
    | "proofV2"
    | "proofTicketPaid"
    | "proofTicketReview"
    | "chatImage"
    | "groupAvatar"
    | "refundEvidence",
    string
  >;
  objectKeys: string[];
  payments: Record<"registration" | "ticketPaid" | "ticketReview" | "ticketHold" | "ticketCancelled", string>;
  tickets: Record<"paid" | "review" | "hold" | "cancelled" | "live", string>;
  events: Record<"paid" | "review" | "hold" | "cancelled" | "live", string>;
  adjustments: { pendingRefund: string; completedRefund: string };
  rooms: { direct: string; group: string };
  messages: Record<"budiText" | "budiImage" | "budiGroup" | "ahmadReply" | "citraGroup", string>;
  reports: Record<"byBudi" | "aboutBudiMessage" | "aboutBudiUser", string>;
  post: { id: string; slug: string };
  requestNumber: string;
  deletionId: string;
  backupDb: string;
  backupStorage: Map<string, Buffer>;
  ledgerDir: string;
}
const S = {} as State;

/** Teks pribadi Budi yang tidak boleh tersisa di tabel mana pun setelah penghapusan (D2, PRD 6.5). */
function personalTerms(): string[] {
  return [
    S.budi.email,
    NAME,
    PHONE,
    PHONE_IN_CHAT,
    BIO,
    INSTAGRAM,
    INSTITUTION,
    DEVICE,
    TRANSFER_NOTE,
    REFUND_ACCOUNT,
    "Halo Ahmad, ini Budi",
    IMAGE_CAPTION,
    GROUP_TEXT,
    REPORT_TEXT,
    CANCEL_TEXT,
    WARN_TEXT,
    S.budi.memberNumber,
  ];
}

async function signInMember(fixture: { email: string; password: string; userId: string }): Promise<Member> {
  const session = await signInAlumni(rt.fx, fixture);
  return { userId: fixture.userId, email: fixture.email, token: session.accessToken };
}

async function adminSession(permissions: Permission[], displayName: string): Promise<AdminSession> {
  const fixture = await createAdmin(rt.fx, { permissions, displayName });
  const session = await signInAdmin(rt.fx, fixture);
  return { fixture, token: session.accessToken };
}

async function relogin(admin: AdminSession): Promise<void> {
  admin.token = (await signInAdmin(rt.fx, admin.fixture)).accessToken;
}

async function loginBudi(deviceName?: string): Promise<{ access: string; refresh: string }> {
  const res = await http().post("/auth/login", {
    email: S.budi.email,
    password: S.budi.password,
    ...(deviceName ? { device_name: deviceName } : {}),
  });
  const body = expectStatus(res, 200);
  expect(body.next).toBe("home");
  return { access: body.session.access_token, refresh: body.session.refresh_token };
}

async function insertEvent(options: {
  title: string;
  price: string;
  startsInMs: number;
  durationMs?: number;
}): Promise<{ id: string; price: string }> {
  const now = clock.now();
  const startsAt = new Date(now.getTime() + options.startsInMs);
  const id = uuidv7();
  await rt.owner.db.insert(events).values({
    id,
    title: options.title,
    timezone: "Asia/Jakarta",
    startsAt,
    endsAt: new Date(startsAt.getTime() + (options.durationMs ?? 4 * HOUR)),
    registrationOpensAt: new Date(now.getTime() - DAY),
    registrationClosesAt: new Date(startsAt.getTime() - 30 * 60_000),
    price: options.price,
    seatsTotal: 20,
    status: "open",
    createdAt: now,
    updatedAt: now,
  });
  return { id, price: options.price };
}

async function reserve(event: { id: string; price: string }): Promise<Json> {
  const free = Number(event.price) === 0;
  return expectStatus(
    await http().post(
      `/events/${event.id}/reservations`,
      { expected_price: event.price, ...(free ? {} : { payment_method_id: S.methodId }) },
      { token: S.budi.token },
    ),
    201,
  );
}

async function submitProof(
  paymentId: string,
  expected: number,
  note?: string,
): Promise<{ fileId: string; body: Json }> {
  const proof = await uploadTestFile({ app: rt.app }, S.budi.token, "payment_proof");
  const body = expectStatus(
    await http().put(
      `/me/payments/${paymentId}/proof`,
      { file_id: proof.id, expected_proof_version: expected, ...(note ? { transfer_note: note } : {}) },
      { token: S.budi.token },
    ),
    200,
  );
  return { fileId: proof.id, body };
}

async function approve(paymentId: string): Promise<void> {
  const detail = expectStatus(
    await http().get(`/admin/payments/${paymentId}`, { token: S.treasurer.token }),
    200,
  );
  expectStatus(
    await http().post(
      `/admin/payments/${paymentId}/decision`,
      {
        decision: "approve",
        expected_proof_version: detail.proof_version,
        expected_version: detail.version,
        funds_verified: true,
      },
      { token: S.treasurer.token },
    ),
    200,
  );
}

async function sendMessage(token: string, roomId: string, payload: Record<string, unknown>): Promise<string> {
  const body = expectStatus(
    await http().post(
      `/chat/rooms/${roomId}/messages`,
      { client_message_id: uuidv7(), ...payload },
      { token },
    ),
    201,
  );
  return body.id as string;
}

async function report(token: string, body: Record<string, unknown>): Promise<string> {
  return expectStatus(await http().post("/reports", body, { token }), 201).id as string;
}

async function drain(): Promise<void> {
  await runAsSystem(() => rt.ctx.jobs.drainOutbox(), { jobId: `outbox:${uuidv7()}` });
}

// ----------------------------------------------------------------------------------------------------- hooks

let liveDb: string;
const liveStorage = new MemoryDriver();

beforeAll(async () => {
  liveDb = await cloneDatabase(lane().template, "d5_live");
  created.push(liveDb);
  const bootstrap = createDb(`${baseUrl()}/${liveDb}`, { max: 1 });
  try {
    await publishLegalVersions(bootstrap.sql);
  } finally {
    await bootstrap.sql.end({ timeout: 5 });
  }
  rt = await openRuntime(liveDb, liveStorage);
}, 180_000);

afterAll(async () => {
  await rt?.close().catch(() => undefined);
  for (const name of created) await dropDatabase(name).catch(() => undefined);
  for (const dir of [S.ledgerDir, ...ledgerDirs]) if (dir) rmSync(dir, { recursive: true, force: true });
}, 180_000);

// ======================================================================================================== uji

describe("LENS D5: penghapusan akun ujung ke ujung lewat alur API nyata (F-14, D2)", () => {
  it("persiapan: anggota dengan data di setiap tabel, dibentuk lewat API nyata; default privasi melindungi kontak (N-15)", async () => {
    const now = clock.now();
    S.methodId = (await createPaymentMethod(rt.fx, { provider: "Bank Uji D5" })).id;
    const professionId = uuidv7();
    const skillIds = [uuidv7(), uuidv7()];
    await rt.owner.db
      .insert(masterProfessions)
      .values({ id: professionId, label: "Profesi D5", createdAt: now, updatedAt: now });
    await rt.owner.db
      .insert(masterSkills)
      .values(skillIds.map((id, i) => ({ id, label: `Keahlian D5 ${i}`, createdAt: now, updatedAt: now })));

    // Pengurus dan rekan.
    S.treasurer = await adminSession(["payments.read", "payments.decide"], "Bendahara D5");
    S.moderator = await adminSession(["moderation.read", "moderation.resolve"], "Moderator D5");
    S.gate = await adminSession(["events.checkin"], "Petugas Gerbang D5");
    const ahmadFixture = await createAlumni(rt.fx, { status: "verified", fullName: "Ahmad Rekan D5" });
    const citraFixture = await createAlumni(rt.fx, { status: "verified", fullName: "Citra Rekan D5" });
    S.ahmad = await signInMember(ahmadFixture);
    S.citra = await signInMember(citraFixture);

    // Registrasi + OTP (F-01): akun baru, nomor anggota dialokasikan sekali.
    const email = `budi.penghapus.${uuidv7().slice(-8)}@contoh.test`;
    const reg = expectStatus(
      await http().post("/auth/register", {
        full_name: NAME,
        gender: "male",
        email,
        password: DEFAULT_PASSWORD,
        cohort: 22,
        class_in: 1,
        class_out: 6,
        accept_policy_version: PG_CONSENT_VERSION,
      }),
      201,
    );
    const verified = expectStatus(
      await http().post("/auth/otp/verify", { challenge_id: reg.challenge_id, code: mailer.last(email)! }),
      200,
    );
    const [user] = await rt.owner.db.select().from(users).where(eq(users.email, email));
    S.budi = {
      userId: user!.id,
      email,
      password: DEFAULT_PASSWORD,
      token: verified.session.access_token,
      accessTokens: [],
      refreshTokens: [],
      memberNumber: "",
      memberSeq: 0,
      cardToken: "",
      fcmTokens: [],
    };
    const linked = await createAdmin(rt.fx, {
      linkedAlumniUserId: S.budi.userId,
      displayName: "Pengurus Tertaut D5",
    });
    S.linkedAdminId = linked.adminId;

    // N-15 / F-10: kontak dan tautan sosial tersembunyi secara bawaan.
    const me0 = expectStatus(await http().get("/me", { token: S.budi.token }), 200);
    expect(me0.profile.privacy).toEqual({
      show_in_directory: true,
      show_phone: false,
      show_email: false,
      show_social: false,
    });
    const [defaults] = await rt.owner.db.select().from(alumni).where(eq(alumni.userId, S.budi.userId));
    expect(defaults).toMatchObject({ showPhone: false, showEmail: false, showSocial: false });
    S.budi.memberNumber = defaults!.memberNumber!;
    S.budi.memberSeq = Number(defaults!.memberSeq);
    expect(S.budi.memberSeq).toBeGreaterThan(0);

    // Profil lengkap + avatar + profesi/keahlian; telepon diizinkan tampil.
    const avatar = await uploadTestFile({ app: rt.app }, S.budi.token, "avatar");
    const profile = expectStatus(
      await http().patch(
        "/me/profile",
        {
          city: "Kota Budi",
          phone: PHONE,
          bio: BIO,
          last_education_institution: INSTITUTION,
          last_education_city: "Kota Kampus Budi",
          social_instagram: INSTAGRAM,
          profession_id: professionId,
          skill_ids: skillIds,
          avatar_file_id: avatar.id,
          privacy: { show_phone: true },
        },
        { token: S.budi.token, headers: { "if-match": me0.version } },
      ),
      200,
    );
    expect(profile.profile.privacy).toMatchObject({ show_phone: true, show_email: false });

    // Iuran pendaftaran: bukti v1 lalu diganti v2 (dengan catatan transfer), disetujui bendahara -> verified.
    const instruction = expectStatus(
      await http().post(
        "/me/payments",
        { type: "registration", payment_method_id: S.methodId },
        { token: S.budi.token },
      ),
      200,
      201,
    );
    const v1 = await submitProof(instruction.id, 0, TRANSFER_NOTE);
    const v2 = await submitProof(instruction.id, 1, TRANSFER_NOTE);
    await approve(instruction.id);
    const meVerified = expectStatus(await http().get("/me", { token: S.budi.token }), 200);
    expect(meVerified.effective_status).toBe("verified");

    // Event langsung (gratis, mulai 1 jam lagi; check-in terbuka): tiket paid lalu check-in petugas berkunci
    // idempotensi. Jam kemudian dimajukan melewati akhir event sehingga tiket ini menjadi riwayat (tidak hangus).
    const live = await insertEvent({
      title: "Temu Alumni Langsung D5",
      price: "0.00",
      startsInMs: HOUR,
      durationMs: HOUR,
    });
    const liveTicket = await reserve(live);
    expect(liveTicket.status).toBe("paid");
    expectStatus(
      await http().post(
        "/admin/checkin",
        { event_id: live.id, qr_code: liveTicket.qr_code },
        { token: S.gate.token, headers: { "idempotency-key": uuidv7() } },
      ),
      200,
    );
    clock.advance(3 * HOUR);

    // Sesi baru di dua perangkat (nama perangkat = data pribadi) setelah jam dimajukan.
    for (const device of [DEVICE, "Tablet Budi"]) {
      const session = await loginBudi(device);
      S.budi.accessTokens.push(session.access);
      S.budi.refreshTokens.push(session.refresh);
    }
    S.budi.token = S.budi.accessTokens[0]!;
    for (const [i, access] of S.budi.accessTokens.entries()) {
      const fcm = `fcm-budi-${i}-${uuidv7()}`;
      S.budi.fcmTokens.push(fcm);
      expectStatus(
        await http().put(
          "/devices",
          { platform: "android", token: fcm, app_version: "1.0.0" },
          { token: access },
        ),
        204,
      );
    }
    for (const admin of [S.treasurer, S.moderator, S.gate]) await relogin(admin);
    S.ahmad = await signInMember(ahmadFixture);
    S.citra = await signInMember(citraFixture);
    expectStatus(
      await http().put(
        "/devices",
        { platform: "android", token: `fcm-ahmad-${uuidv7()}`, app_version: "1.0.0" },
        { token: S.ahmad.token },
      ),
      204,
    );

    // Refund menunggu dengan rekening tujuan dari Budi; refund lain selesai dengan bukti bendahara (D6).
    const pending = expectStatus(
      await http().post(
        `/admin/payments/${instruction.id}/adjustments`,
        { kind: "refund", amount: "10000.00", reason: "Kelebihan bayar iuran" },
        { token: S.treasurer.token },
      ),
      201,
    );
    expectStatus(
      await http().put(
        `/me/payments/${instruction.id}/adjustments/${pending.id}/refund-destination`,
        { provider: "BCA", account_number: REFUND_ACCOUNT, account_holder: NAME },
        { token: S.budi.token, headers: { "if-match": pending.version } },
      ),
      200,
    );
    const done = expectStatus(
      await http().post(
        `/admin/payments/${instruction.id}/adjustments`,
        { kind: "refund", amount: "5000.00", reason: "Selisih pembulatan" },
        { token: S.treasurer.token },
      ),
      201,
    );
    const evidence = await uploadTestFile({ app: rt.app }, S.treasurer.token, "adjustment_evidence");
    expectStatus(
      await http().post(
        `/admin/payment-adjustments/${done.id}/complete`,
        { evidence_file_id: evidence.id },
        { token: S.treasurer.token, headers: { "if-match": done.version } },
      ),
      200,
    );

    // Tiket: paid (event mendatang), menunggu review (berbukti), hold tanpa bukti, dibatalkan sendiri dengan alasan.
    const paidEvent = await insertEvent({ title: "Reuni D5", price: "75000.00", startsInMs: 10 * DAY });
    const reviewEvent = await insertEvent({ title: "Seminar D5", price: "50000.00", startsInMs: 12 * DAY });
    const holdEvent = await insertEvent({ title: "Workshop D5", price: "40000.00", startsInMs: 14 * DAY });
    const cancelEvent = await insertEvent({ title: "Kajian D5", price: "30000.00", startsInMs: 16 * DAY });
    const paidTicket = await reserve(paidEvent);
    const paidProof = await submitProof(paidTicket.payment.id, 0);
    await approve(paidTicket.payment.id);
    const reviewTicket = await reserve(reviewEvent);
    const reviewProof = await submitProof(reviewTicket.payment.id, 0, "Sudah transfer, Budi Penghapus");
    const holdTicket = await reserve(holdEvent);
    const cancelTicket = await reserve(cancelEvent);
    expectStatus(
      await http().post(
        `/me/tickets/${cancelTicket.id}/cancel`,
        { expected_refund_eligible: false, reason: CANCEL_TEXT },
        { token: S.budi.token, headers: { "if-match": cancelTicket.version } },
      ),
      200,
    );

    // Chat: direct (teks dengan nomor telepon, gambar), balasan dan reaksi dua arah; grup dengan avatar dari Budi.
    const direct = expectStatus(
      await http().post("/chat/direct", { user_id: S.ahmad.userId }, { token: S.budi.token }),
      200,
      201,
    );
    const budiText = await sendMessage(S.budi.token, direct.id, { kind: "text", body: DM_TEXT });
    const chatImage = await uploadTestFile({ app: rt.app }, S.budi.token, "chat_image");
    const budiImage = await sendMessage(S.budi.token, direct.id, {
      kind: "image",
      image_file_id: chatImage.id,
      body: IMAGE_CAPTION,
    });
    const ahmadReply = await sendMessage(S.ahmad.token, direct.id, {
      kind: "text",
      body: "Balasan dari Ahmad",
      reply_to_id: budiText,
    });
    const react = (token: string, roomId: string, messageId: string, emoji: string) =>
      http().put(
        `/chat/rooms/${roomId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
        {},
        { token },
      );
    expectStatus(await react(S.ahmad.token, direct.id, budiText, "👍"), 200);
    expectStatus(await react(S.budi.token, direct.id, ahmadReply, "❤️"), 200);
    const groupAvatar = await uploadTestFile({ app: rt.app }, S.budi.token, "chat_image");
    const group = expectStatus(
      await http().post(
        "/chat/rooms",
        {
          name: "Alumni Angkatan 22 D5",
          avatar_file_id: groupAvatar.id,
          invitee_user_ids: [S.ahmad.userId, S.citra.userId],
        },
        { token: S.budi.token },
      ),
      201,
    );
    for (const m of [S.ahmad, S.citra])
      expectStatus(
        await http().post(`/chat/invitations/${group.room.id}/accept`, {}, { token: m.token }),
        200,
      );
    const budiGroup = await sendMessage(S.budi.token, group.room.id, { kind: "text", body: GROUP_TEXT });
    const citraGroup = await sendMessage(S.citra.token, group.room.id, { kind: "text", body: "Pesan Citra" });

    // Laporan: oleh Budi, tentang pesan Budi, tentang profil Budi (diputus warn dengan pesan untuk Budi).
    const byBudi = await report(S.budi.token, {
      target_type: "user",
      target_user_id: S.ahmad.userId,
      category: "harassment",
      description: REPORT_TEXT,
    });
    const aboutBudiMessage = await report(S.ahmad.token, {
      target_type: "message",
      message_id: budiText,
      category: "spam",
      description: "Pesan spam di chat",
    });
    const aboutBudiUser = await report(S.citra.token, {
      target_type: "user",
      target_user_id: S.budi.userId,
      category: "harassment",
      description: "Profil mengganggu",
    });
    const reportDetail = expectStatus(
      await http().get(`/admin/reports/${aboutBudiUser}`, { token: S.moderator.token }),
      200,
    );
    expectStatus(
      await http().post(
        `/admin/reports/${aboutBudiUser}/resolve`,
        { action: "warn", note: "Pelanggaran ringan pertama", member_message: WARN_TEXT },
        { token: S.moderator.token, headers: { "if-match": reportDetail.version } },
      ),
      200,
    );

    // Like berita, blokir, preferensi notifikasi.
    const postId = uuidv7();
    const slug = `berita-d5-${postId.slice(-8)}`;
    await rt.owner.db.insert(posts).values({
      id: postId,
      slug,
      title: "Berita D5",
      bodyHtml: "<p>Isi</p>",
      status: "published",
      publishedAt: clock.now(),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    expectStatus(await http().put(`/posts/${slug}/like`, {}, { token: S.budi.token }), 200);
    expectStatus(await http().put(`/posts/${slug}/like`, {}, { token: S.ahmad.token }), 200);
    expectStatus(await http().put(`/blocks/${S.citra.userId}`, {}, { token: S.budi.token }), 200, 201, 204);
    expectStatus(
      await http().put(
        "/notifications/preferences",
        {
          push: { payment: true, membership: true, event: true, news: false, chat: true },
          email: { payment: true, membership: true, event: false },
        },
        { token: S.budi.token },
      ),
      200,
    );

    // KTA aktif: verifikasi publik hanya identitas minimum (F-06, D3).
    const card = expectStatus(await http().get("/me/card", { token: S.budi.token }), 200);
    S.budi.cardToken = new URL(card.qr.url).hash.replace(/^#t=/, "");
    const verify = expectStatus(
      await http().post("/public/kta/verify", {
        member_number: S.budi.memberNumber,
        token: S.budi.cardToken,
      }),
      200,
    );
    expect(verify.result).toBe("active");
    expect(Object.keys(verify.member).sort()).toEqual(
      ["avatar_url", "cohort_code", "expires_at", "full_name", "member_number"].sort(),
    );
    expect(JSON.stringify(verify)).not.toContain(S.budi.email);
    expect(JSON.stringify(verify)).not.toContain(PHONE);

    // Direktori: telepon tampil (flag aktif), email tidak (flag mati) — AC F10-2.
    const seen = expectStatus(await http().get(`/directory/${S.budi.userId}`, { token: S.ahmad.token }), 200);
    expect(seen.phone).toBe(PHONE);
    expect(seen).not.toHaveProperty("email");
    expect(seen).not.toHaveProperty("social");

    await drain();

    Object.assign(S, {
      files: {
        avatar: avatar.id,
        proofV1: v1.fileId,
        proofV2: v2.fileId,
        proofTicketPaid: paidProof.fileId,
        proofTicketReview: reviewProof.fileId,
        chatImage: chatImage.id,
        groupAvatar: groupAvatar.id,
        refundEvidence: evidence.id,
      },
      payments: {
        registration: instruction.id,
        ticketPaid: paidTicket.payment.id,
        ticketReview: reviewTicket.payment.id,
        ticketHold: holdTicket.payment.id,
        ticketCancelled: cancelTicket.payment.id,
      },
      tickets: {
        paid: paidTicket.id,
        review: reviewTicket.id,
        hold: holdTicket.id,
        cancelled: cancelTicket.id,
        live: liveTicket.id,
      },
      events: {
        paid: paidEvent.id,
        review: reviewEvent.id,
        hold: holdEvent.id,
        cancelled: cancelEvent.id,
        live: live.id,
      },
      adjustments: { pendingRefund: pending.id, completedRefund: done.id },
      rooms: { direct: direct.id, group: group.room.id },
      messages: { budiText, budiImage, budiGroup, ahmadReply, citraGroup },
      reports: { byBudi, aboutBudiMessage, aboutBudiUser },
      post: { id: postId, slug },
    } satisfies Partial<State>);
    S.objectKeys = (
      await rt.owner.db
        .select({ key: files.objectKey })
        .from(files)
        .where(inArray(files.id, Object.values(S.files)))
    ).map((r) => r.key);
    expect(S.objectKeys).toHaveLength(Object.keys(S.files).length);
    for (const key of S.objectKeys) expect(await liveStorage.exists(key), key).toBe(true);

    // Fixture benar-benar memuat data pribadi di tabel-tabel yang akan diperiksa (pemeriksaan negatif bermakna).
    const before = await personalDataHits(rt.fx.db, personalTerms());
    for (const table of [
      "users",
      "alumni",
      "sessions",
      "payments",
      "payment_adjustments",
      "tickets",
      "messages",
      "reports",
      "notifications",
      "audit_logs",
    ])
      expect(before, table).toHaveProperty(table);
  }, 240_000);

  it("backup titik waktu SEBELUM permintaan penghapusan: klon database + salinan storage (PRD 5.5)", async () => {
    await rt.close();
    S.backupDb = await cloneDatabase(liveDb, "d5_backup");
    created.push(S.backupDb);
    S.backupStorage = snapshotStorage(liveStorage);
    rt = await openRuntime(liveDb, liveStorage);
  }, 120_000);

  it("AC F14-1: konfirmasi -> deletion_pending, semua sesi/token push dicabut, KTA tidak aktif, direktori tidak menampilkan", async () => {
    const disclosure = expectStatus(
      await http().get("/me/deletion/disclosure", { token: S.budi.token }),
      200,
    );
    const accepted = expectStatus(
      await http().post(
        "/me/deletion",
        { confirm: true, acknowledged_disclosure_version: disclosure.version },
        { token: S.budi.token, headers: await reauthHeader(S.budi.token) },
      ),
      202,
    );
    S.requestNumber = accepted.request_number;
    const [row] = await rt.owner.db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.requestNumber, S.requestNumber));
    S.deletionId = row!.id;
    expect((await rt.owner.db.select().from(users).where(eq(users.id, S.budi.userId)))[0]!.status).toBe(
      "deletion_pending",
    );
    // Semua sesi dicabut: akses dan refresh di perangkat lain ditolak.
    for (const access of S.budi.accessTokens)
      expect((await http().get("/me", { token: access })).statusCode).toBe(401);
    for (const refresh of S.budi.refreshTokens)
      expect([401, 403]).toContain(
        (await http().post("/auth/refresh", { refresh_token: refresh })).statusCode,
      );
    const liveSessions = await rt.owner.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, S.budi.userId), sql`${sessions.revokedAt} is null`));
    expect(liveSessions).toEqual([]);
    const liveTokens = await rt.owner.db
      .select()
      .from(deviceTokens)
      .where(and(eq(deviceTokens.userId, S.budi.userId), sql`${deviceTokens.revokedAt} is null`));
    expect(liveTokens).toEqual([]);
    // KTA publik: Tidak aktif tanpa identitas (AC F06-2); direktori dan peserta event tidak menampilkan Budi.
    const verify = expectStatus(
      await http().post("/public/kta/verify", {
        member_number: S.budi.memberNumber,
        token: S.budi.cardToken,
      }),
      200,
    );
    expect(verify).toMatchObject({ result: "inactive", member: null });
    expect((await http().get(`/directory/${S.budi.userId}`, { token: S.ahmad.token })).statusCode).toBe(404);
    const participants = expectStatus(
      await http().get(`/events/${S.events.paid}/participants`, { token: S.ahmad.token }),
      200,
    );
    expect(JSON.stringify(participants)).not.toContain(S.budi.userId);
  });

  it("AC F14-3, F14-4, F14-5: job worker (outbox) selesai; setiap tabel hanya menyisakan catatan anonim", async () => {
    const mailBefore = mailer.mail.filter((m) => m.to === S.budi.email).length;
    await drain();
    const [deletion] = await rt.owner.db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.id, S.deletionId));
    expect(deletion, `last_error: ${deletion?.lastError}`).toMatchObject({
      status: "completed",
      lastError: null,
    });
    expect([...deletion!.stepsDone].sort()).toEqual([...DELETION_STEPS].sort());
    // Email permintaan dan email selesai (F-14) ke alamat lama, sebelum alamat dihapus.
    expect(mailer.mail.filter((m) => m.to === S.budi.email).length - mailBefore).toBe(2);
    await expectErased(rt.owner.db as unknown as Db, liveStorage);
  }, 180_000);

  it("AC F06-2: KTA publik setelah penghapusan -> Tidak ditemukan tanpa identitas; login lama ditolak", async () => {
    const verify = expectStatus(
      await http().post("/public/kta/verify", {
        member_number: S.budi.memberNumber,
        token: S.budi.cardToken,
      }),
      200,
    );
    expect(verify).toMatchObject({ result: "not_found", member: null, expiring: false });
    const login = await http().post("/auth/login", { email: S.budi.email, password: S.budi.password });
    expect(login.statusCode).not.toBe(200);
    expect(login.body).not.toContain(S.budi.userId);
  });

  it("PRD 3.5: N anggota yang dihapus tidak pernah dipakai ulang; pendaftar baru mendapat N lebih besar", async () => {
    const seq = await registerNewMember();
    expect(seq).toBeGreaterThan(S.budi.memberSeq);
    const reused = await rt.owner.db
      .select({ id: alumni.userId })
      .from(alumni)
      .where(eq(alumni.memberSeq, S.budi.memberSeq));
    expect(reused).toEqual([]);
  });

  it("N-14: log API dan worker tidak memuat data pribadi Budi, kode OTP, token sesi/reauth/FCM atau token QR", () => {
    expect(logs.length).toBeGreaterThan(50);
    const text = logs.join("\n").toLowerCase();
    const secrets = [
      ...personalTerms(),
      ...S.budi.accessTokens,
      ...S.budi.refreshTokens,
      ...S.budi.fcmTokens,
      S.budi.cardToken,
      ...mailer.sent.map((m) => m.code),
    ];
    const leaked = secrets.filter((s) => s && text.includes(s.toLowerCase()));
    expect(leaked).toEqual([]);
  });

  it("PRD 3.13: payload push tidak memuat isi chat, catatan transfer, rekening, telepon atau email", () => {
    expect(push.sent.length).toBeGreaterThan(0);
    for (const message of push.sent) {
      const payload = JSON.stringify(message);
      for (const term of [
        PHONE,
        PHONE_IN_CHAT,
        "Halo Ahmad",
        GROUP_TEXT,
        TRANSFER_NOTE,
        REFUND_ACCOUNT,
        S.budi.email,
      ])
        expect(payload, term).not.toContain(term);
      expect(Object.keys(message.data).sort()).toEqual(
        expect.arrayContaining(["category", "notification_id"]),
      );
      for (const key of Object.keys(message.data))
        expect(["notification_id", "category", "route", "deep_link"]).toContain(key);
    }
  });

  it("AC F14-6: restore backup sebelum penghapusan -> ledger eksternal diterapkan ulang sebelum layanan dibuka", async () => {
    // Salinan ledger TERBARU (storage live) seperti pada manifest backup; database dan storage dipulihkan dari backup.
    S.ledgerDir = exportLedger(liveStorage);
    const entries = readLedgerDirectory(S.ledgerDir);
    expect(entries.map((e) => [e.request_number, e.state])).toEqual([[S.requestNumber, "completed"]]);
    for (const key of S.objectKeys) expect(entries[0]!.object_keys).toContain(key);
    expect(JSON.stringify(entries)).not.toContain(S.budi.email);

    await rt.close();
    const restoredStorage = await restoreStorage(S.backupStorage);
    rt = await openRuntime(S.backupDb, restoredStorage);
    // Backup memuat Budi utuh (data yang sudah dihapus "muncul kembali").
    const [revived] = await rt.owner.db.select().from(users).where(eq(users.id, S.budi.userId));
    expect(revived).toMatchObject({ status: "active", email: S.budi.email });
    for (const key of S.objectKeys) expect(await restoredStorage.exists(key)).toBe(true);

    const mailBefore = mailer.mail.length;
    const summary = await runAsSystem(() => rt.ctx.app.get(DeletionLedgerService).reapply(entries), {
      jobId: `ledger-reapply:${uuidv7()}`,
    });
    expect(summary).toMatchObject({
      reapplied: [S.requestNumber],
      failed: [],
      absent: [],
      alreadyDeleted: [],
    });
    // Tanpa email ulang ke alamat lama (langkah email entri completed sudah dianggap selesai).
    expect(mailer.mail.length).toBe(mailBefore);
    await expectErased(rt.owner.db as unknown as Db, restoredStorage, { restored: true });
    // Login dengan sandi lama di database pulihan ditolak; N tetap tidak dipakai ulang.
    expect(
      (await http().post("/auth/login", { email: S.budi.email, password: S.budi.password })).statusCode,
    ).not.toBe(200);
    expect(await registerNewMember()).toBeGreaterThan(S.budi.memberSeq);
    // Uji celah berikut berjalan pada database live.
    await rt.close();
    rt = await openRuntime(liveDb, liveStorage);
  }, 240_000);
});

// ------------------------------------------------------------------------------------- celah yang ditemukan audit

/** D5_REVEAL_GAPS=1 menjalankan uji celah sebagai `it` biasa untuk melihat kegagalan sebenarnya. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- semua celah D5 sudah diperbaiki; dipakai lagi bila ada celah baru
const gap = process.env.D5_REVEAL_GAPS ? it : it.fails;

describe("LENS D5: celah privasi yang ditemukan (it.fails = celah masih ada)", () => {
  // Diperbaiki: notifikasi chat direct tidak lagi memuat nama pengirim (chat.notifications.ts), dan langkah
  // notifications menulis ulang baris format lama di kotak masuk lawan bicara ke teks netral.
  it("D5-01 (D2, AC F14-3): kotak masuk anggota lain tidak lagi memuat nama anggota yang sudah dihapus", async () => {
    const hits = await notificationsMentioning(NAME);
    expect(hits).toEqual([]);
  });

  it("D5-02 (D2): respons idempotensi pengurus yang memuat nama/nomor anggota ikut dihapus bersama akun", async () => {
    // POST /admin/checkin dengan Idempotency-Key menyimpan respons (holder.full_name, member_number) pada scope akun
    // petugas. Diperbaiki: job juga menghapus respons tersimpan aktor lain yang merujuk id akun/inventaris
    // (langkah revoke_access, diulang di langkah credentials).
    const leftovers = await rt.owner.db
      .select({ endpoint: idempotencyKeys.endpoint })
      .from(idempotencyKeys)
      .where(sql`${idempotencyKeys.responseBody}::text like ${`%${NAME}%`}`);
    expect(leftovers).toEqual([]);
    const byId = await rt.owner.db
      .select({ endpoint: idempotencyKeys.endpoint })
      .from(idempotencyKeys)
      .where(sql`${idempotencyKeys.responseBody}::text like ${`%${S.budi.userId}%`}`);
    expect(byId).toEqual([]);
  });

  let lateEvidenceId = "";
  it("D5-03 persiapan: bendahara menyelesaikan refund pending SETELAH akun dihapus, dengan bukti transfer baru", async () => {
    // Refund pending tidak diselesaikan job (PRD 4.4); bendahara menyelesaikannya setelah akun dihapus dengan bukti
    // transfer (adjustment_evidence: memuat rekening dan nama penerima).
    await relogin(S.treasurer);
    const [adjustment] = await rt.owner.db
      .select()
      .from(paymentAdjustments)
      .where(eq(paymentAdjustments.id, S.adjustments.pendingRefund));
    const evidence = await uploadTestFile({ app: rt.app }, S.treasurer.token, "adjustment_evidence");
    expectStatus(
      await http().post(
        `/admin/payment-adjustments/${S.adjustments.pendingRefund}/complete`,
        { evidence_file_id: evidence.id },
        { token: S.treasurer.token, headers: { "if-match": String(adjustment!.version) } },
      ),
      200,
    );
    lateEvidenceId = evidence.id;
    const [payment] = await rt.owner.db
      .select()
      .from(payments)
      .where(eq(payments.id, S.payments.registration));
    expect(payment!.userId).toBeNull();
  });

  it("D5-03 (D2, AC F14-4): bukti refund atas payment anggota yang sudah dihapus tidak tersimpan tanpa batas", async () => {
    // Diperbaiki: penyelesaian refund atas payment yang pemiliknya dihapus memutus rujukan bukti dan menghapus
    // berkasnya setelah commit; audit hanya menyimpan sha256/ukuran.
    const [file] = await rt.owner.db.select().from(files).where(eq(files.id, lateEvidenceId));
    expect({ status: file!.status, stored: await rt.storage.exists(file!.objectKey) }).toEqual({
      status: "deleted",
      stored: false,
    });
    const [adjustment] = await rt.owner.db
      .select()
      .from(paymentAdjustments)
      .where(eq(paymentAdjustments.id, S.adjustments.pendingRefund));
    expect(adjustment).toMatchObject({ status: "completed", evidenceFileId: null, refundDestination: null });
    const [audit] = await rt.owner.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, S.adjustments.pendingRefund),
          eq(auditLogs.action, "payment_adjustment.completed"),
        ),
      );
    expect(audit!.after).toMatchObject({
      evidence_file_id: null,
      evidence_erased: { file_id: lateEvidenceId, sha256: file!.sha256, bytes: file!.bytes },
    });
  });

  let windowUserId = "";
  it("D5-04 persiapan: job gagal di langkah files, bendahara memutus payment anggota selama deletion_pending, retry selesai", async () => {
    // Anggota kedua dengan tiket berbukti menunggu review. Langkah files gagal (storage), lalu bendahara menyetujui
    // payment yang masih atas nama anggota (finance belum berjalan) -> notifikasi baru ke akun deletion_pending.
    const fixture = await createAlumni(rt.fx, { status: "verified", fullName: "Dewi Jendela D5" });
    windowUserId = fixture.userId;
    const token = (await signInAlumni(rt.fx, fixture)).accessToken;
    const event = await insertEvent({ title: "Bazar D5", price: "20000.00", startsInMs: 20 * DAY });
    const ticket = expectStatus(
      await http().post(
        `/events/${event.id}/reservations`,
        { expected_price: event.price, payment_method_id: S.methodId },
        { token },
      ),
      201,
    );
    const proof = await uploadTestFile({ app: rt.app }, token, "payment_proof");
    expectStatus(
      await http().put(
        `/me/payments/${ticket.payment.id}/proof`,
        { file_id: proof.id, expected_proof_version: 0 },
        { token },
      ),
      200,
    );
    const disclosure = expectStatus(await http().get("/me/deletion/disclosure", { token }), 200);
    const accepted = expectStatus(
      await http().post(
        "/me/deletion",
        { confirm: true, acknowledged_disclosure_version: disclosure.version },
        { token, headers: await reauthHeader(token) },
      ),
      202,
    );
    const [row] = await rt.owner.db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.requestNumber, accepted.request_number));
    rt.storage.failNext("delete", 1);
    const processor = rt.ctx.app.get(AccountDeletionProcessor);
    const first = await runAsSystem(() => processor.run(row!.id), { jobId: `account.deletion:${uuidv7()}` });
    expect(first).toMatchObject({ outcome: "failed", step: "files" });
    await relogin(S.treasurer);
    await approve(ticket.payment.id);
    // Perbaikan D5-04: keputusan payment untuk akun deletion_pending tidak menulis inbox (tanpa outbox/email).
    const created = await rt.owner.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.userId));
    expect(created).toEqual([]);
    // Notifikasi yang lolos pemeriksaan status secara bersamaan (disimulasikan langsung) disapu langkah credentials.
    await rt.owner.db.insert(notifications).values({
      id: uuidv7(),
      userId: fixture.userId,
      category: "payment",
      title: "Pembayaran disetujui",
      body: "Notifikasi yang lolos bersamaan selama jendela retry.",
      data: {},
      dedupKey: `u:${fixture.userId}:uji-d5-04:${uuidv7()}`,
      createdAt: clock.now(),
    });
    clock.advance(HOUR);
    const second = await runAsSystem(() => processor.run(row!.id), { jobId: `account.deletion:${uuidv7()}` });
    expect(second).toMatchObject({ outcome: "completed" });
  });

  it("D5-04 (D2, AC F14-2/F14-3): inbox yang dibuat selama jendela deletion_pending ikut dihapus saat retry", async () => {
    // Celah: retry melanjutkan dari steps_done (notifications sudah selesai), sehingga notifikasi baru itu tetap ada
    // pada akun `deleted` (judul/isi keputusan pembayaran) selamanya.
    expect(await remainingPersonalData(rt.owner.db as unknown as Db, windowUserId)).toMatchObject({
      notifications: 0,
    });
  });
  const reuse = { deletedSeq: 0, nextSeq: 0 };
  it("D5-05 persiapan: anggota mendaftar SETELAH backup lalu menghapus akun; backup dipulihkan, ledger diterapkan ulang", async () => {
    await rt.close();
    const backup = await cloneDatabase(liveDb, "d5_backup2");
    created.push(backup);
    const snapshot = snapshotStorage(liveStorage);
    rt = await openRuntime(liveDb, liveStorage);
    const xena = await registerViaApi("Xena Sesudah Backup");
    const disclosure = expectStatus(await http().get("/me/deletion/disclosure", { token: xena.token }), 200);
    const accepted = expectStatus(
      await http().post(
        "/me/deletion",
        { confirm: true, acknowledged_disclosure_version: disclosure.version },
        { token: xena.token, headers: await reauthHeader(xena.token) },
      ),
      202,
    );
    await drain();
    const [row] = await rt.owner.db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.requestNumber, accepted.request_number));
    expect(row!.status).toBe("completed");
    const dir = exportLedger(liveStorage);
    ledgerDirs.push(dir);
    const entries = readLedgerDirectory(dir);

    await rt.close();
    rt = await openRuntime(backup, await restoreStorage(snapshot));
    const summary = await runAsSystem(() => rt.ctx.app.get(DeletionLedgerService).reapply(entries), {
      jobId: `ledger-reapply:${uuidv7()}`,
    });
    expect(summary.failed).toEqual([]);
    expect(summary.absent).toContain(accepted.request_number);
    reuse.deletedSeq = xena.seq;
    reuse.nextSeq = (await registerViaApi("Pendaftar Pasca Pemulihan")).seq;
    await rt.close();
    rt = await openRuntime(liveDb, liveStorage);
  });

  it("D5-05 (PRD 6.4, AC F14-6): setelah restore + ledger, N anggota yang sudah dihapus tidak dialokasikan ulang", () => {
    // Celah: entri ledger tidak memuat N dan penerapan ulang tidak memajukan membership_no_seq, sehingga N milik
    // akun yang dihapus setelah titik backup diberikan lagi kepada pendaftar berikutnya.
    expect(reuse.nextSeq).toBeGreaterThan(reuse.deletedSeq);
  });
});

// ----------------------------------------------------------------------------------------------- pemeriksaan

async function notificationsMentioning(term: string) {
  return rt.owner.db
    .select({ userId: notifications.userId, body: notifications.body })
    .from(notifications)
    .where(sql`${notifications.title} || ' ' || coalesce(${notifications.body}, '') like ${`%${term}%`}`);
}

/** Registrasi + OTP lewat API (F-01); mengembalikan akun, sesi dan N yang dialokasikan. */
async function registerViaApi(fullName: string): Promise<Member & { seq: number }> {
  const email = `pendaftar.${uuidv7().slice(-8)}@contoh.test`;
  const reg = expectStatus(
    await http().post("/auth/register", {
      full_name: fullName,
      gender: "female",
      email,
      password: DEFAULT_PASSWORD,
      cohort: 22,
      class_in: 1,
      class_out: 6,
      accept_policy_version: PG_CONSENT_VERSION,
    }),
    201,
  );
  const verified = expectStatus(
    await http().post("/auth/otp/verify", { challenge_id: reg.challenge_id, code: mailer.last(email)! }),
    200,
  );
  const [row] = await rt.owner.db
    .select({ userId: alumni.userId, seq: alumni.memberSeq })
    .from(alumni)
    .innerJoin(users, eq(users.id, alumni.userId))
    .where(eq(users.email, email));
  return { userId: row!.userId, email, token: verified.session.access_token, seq: Number(row!.seq) };
}

/** N anggota baru hasil registrasi lewat API. */
async function registerNewMember(): Promise<number> {
  return (await registerViaApi("Pendaftar Baru D5")).seq;
}

/**
 * Pemeriksaan per tabel setelah penghapusan (dipakai pada database live dan database pulihan). Celah yang sudah
 * didokumentasikan sudah diperbaiki seluruhnya; tidak ada pengecualian tersisa.
 */
async function expectErased(db: Db, storage: MemoryDriver, options: { restored?: boolean } = {}) {
  const userId = S.budi.userId;
  const count = async (q: Promise<unknown[]>) => (await q).length;

  // users: tombstone tanpa kredensial/email (AC F14-3).
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  expect(user).toMatchObject({
    status: "deleted",
    email: deletedEmailFor(userId),
    passwordHash: "!deleted",
    emailVerifiedAt: null,
    policyVersion: null,
    policyAcceptedAt: null,
    lastLoginAt: null,
  });
  // Profil, kontak, profesi/keahlian.
  expect(await count(db.select().from(alumni).where(eq(alumni.userId, userId)))).toBe(0);
  expect(
    await count(db.select().from(alumniProfessions).where(eq(alumniProfessions.alumniUserId, userId))),
  ).toBe(0);
  expect(await count(db.select().from(alumniSkills).where(eq(alumniSkills.alumniUserId, userId)))).toBe(0);
  // Sesi, OTP, token perangkat, inbox, preferensi, kunci idempotensi milik akun: semua 0.
  const remaining = await remainingPersonalData(db, userId);
  expect(Object.entries(remaining).filter(([, n]) => n > 0)).toEqual([]);
  expect(await count(db.select().from(alumniSkills).where(eq(alumniSkills.alumniUserId, userId)))).toBe(0);
  const orphanDeliveries = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .leftJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .where(sql`${notifications.id} is null`);
  expect(orphanDeliveries).toEqual([]);

  // Berkas (AC F14-3, F14-4): avatar, bukti v1/v2, bukti tiket, gambar chat, avatar grup, bukti refund pengurus.
  const fileRows = await db
    .select()
    .from(files)
    .where(inArray(files.id, Object.values(S.files)));
  expect(fileRows).toHaveLength(Object.keys(S.files).length);
  for (const file of fileRows) {
    expect(file, file.purpose).toMatchObject({ status: "deleted", ownerUserId: null });
    expect(await storage.exists(file.objectKey), file.objectKey).toBe(false);
  }
  // Tidak ada objek storage tanpa baris `ready` (tidak ada objek yatim yang dibiarkan).
  const readyKeys = new Set(
    (await db.select({ key: files.objectKey }).from(files).where(eq(files.status, "ready"))).map(
      (r) => r.key,
    ),
  );
  const orphanObjects = storage.keys().filter((k) => !k.startsWith("ledger/") && !readyKeys.has(k));
  expect(orphanObjects).toEqual([]);

  // Payment anonim: jumlah/tanggal/status/referensi tetap; tanpa pemilik, catatan transfer, bukti (AC F14-4).
  const paymentRows = await db
    .select()
    .from(payments)
    .where(inArray(payments.id, Object.values(S.payments)));
  expect(paymentRows).toHaveLength(5);
  const byPayment = Object.fromEntries(paymentRows.map((p) => [p.id, p]));
  for (const p of paymentRows) {
    expect(p).toMatchObject({ userId: null, transferNote: null, proofFileId: null });
    expect(Number(p.amount)).toBeGreaterThanOrEqual(0);
    expect(p.createdAt).toBeInstanceOf(Date);
  }
  expect(byPayment[S.payments.registration]).toMatchObject({
    status: "paid",
    type: "registration",
    proofVersion: 2,
  });
  expect(byPayment[S.payments.ticketPaid]).toMatchObject({ status: "paid" });
  expect(byPayment[S.payments.ticketReview]).toMatchObject({ status: "pending", proofVersion: 1 });
  expect(byPayment[S.payments.ticketHold]).toMatchObject({
    status: "cancelled",
    cancelReason: FORFEIT_REASON,
  });
  expect(byPayment[S.payments.ticketCancelled]!.status).toBe("cancelled");
  const eventRows = await db
    .select()
    .from(paymentEvents)
    .where(inArray(paymentEvents.paymentId, Object.values(S.payments)));
  expect(eventRows.filter((e) => e.actorUserId === userId)).toEqual([]);
  // Penyesuaian: rekening tujuan dan rujukan bukti hilang; nominal dan status tetap; refund pending tidak diselesaikan job.
  const adjustmentRows = await db
    .select()
    .from(paymentAdjustments)
    .where(inArray(paymentAdjustments.id, Object.values(S.adjustments)));
  const byAdjustment = Object.fromEntries(adjustmentRows.map((a) => [a.id, a]));
  expect(byAdjustment[S.adjustments.pendingRefund]).toMatchObject({
    status: "pending",
    amount: "10000.00",
    refundDestination: null,
  });
  expect(byAdjustment[S.adjustments.completedRefund]).toMatchObject({
    status: "completed",
    amount: "5000.00",
    evidenceFileId: null,
    refundDestination: null,
  });

  // Tiket anonim; tiket aktif event mendatang hangus sekali; tiket event selesai (check-in) tetap beserta petugasnya.
  const ticketRows = await db
    .select()
    .from(tickets)
    .where(inArray(tickets.id, Object.values(S.tickets)));
  const byTicket = Object.fromEntries(ticketRows.map((x) => [x.id, x]));
  for (const ticket of ticketRows) expect(ticket.userId).toBeNull();
  for (const id of [S.tickets.paid, S.tickets.review, S.tickets.hold])
    expect(byTicket[id]).toMatchObject({
      status: "cancelled",
      cancelledBy: "system",
      cancelReason: FORFEIT_REASON,
    });
  expect(byTicket[S.tickets.cancelled]).toMatchObject({
    status: "cancelled",
    cancelledBy: "self",
    cancelReason: null,
  });
  expect(byTicket[S.tickets.live]).toMatchObject({
    status: "paid",
    checkedInByAdminId: S.gate.fixture.adminId,
  });
  expect(byTicket[S.tickets.live]!.checkedInAt).not.toBeNull();
  const eventCounters = await db
    .select({ id: events.id, held: events.heldQuantity, paid: events.paidQuantity })
    .from(events)
    .where(inArray(events.id, Object.values(S.events)));
  const byEvent = Object.fromEntries(eventCounters.map((e) => [e.id, e]));
  for (const id of [S.events.paid, S.events.review, S.events.hold, S.events.cancelled])
    expect(byEvent[id], id).toMatchObject({ held: 0, paid: 0 });
  expect(byEvent[S.events.live]).toMatchObject({ held: 0, paid: 1 });

  // Histori keanggotaan anonim (aktivasi + warn) tanpa nomor dan alasan.
  const memberships = await db
    .select()
    .from(membershipEvents)
    .where(eq(membershipEvents.paymentId, S.payments.registration));
  expect(memberships).toEqual([expect.objectContaining({ userId: null, reason: null, kind: "activation" })]);

  // Chat: pesan Budi menjadi placeholder tanpa pengirim; pesan rekan dan reaksi rekan pada pesan Budi tetap.
  const budiMessages = await db
    .select()
    .from(messages)
    .where(inArray(messages.id, [S.messages.budiText, S.messages.budiImage, S.messages.budiGroup]));
  expect(budiMessages).toHaveLength(3);
  for (const m of budiMessages) {
    expect(m).toMatchObject({ senderId: null, body: null, imageFileId: null });
    expect(m.deletedAt).not.toBeNull();
  }
  const peerMessages = await db
    .select({ body: messages.body, senderId: messages.senderId })
    .from(messages)
    .where(inArray(messages.id, [S.messages.ahmadReply, S.messages.citraGroup]));
  expect(peerMessages.map((m) => m.body).sort()).toEqual(["Balasan dari Ahmad", "Pesan Citra"]);
  expect(await count(db.select().from(messageReactions).where(eq(messageReactions.userId, userId)))).toBe(0);
  expect(
    await count(
      db.select().from(messageReactions).where(eq(messageReactions.messageId, S.messages.budiText)),
    ),
  ).toBe(1);
  // Grup: admin dialihkan ke anggota aktif (AC F14-5); avatar grup unggahan Budi dilepas; pembuat dianonimkan.
  const groupMembers = await db
    .select({ userId: roomMembers.userId, role: roomMembers.role, status: roomMembers.status })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, S.rooms.group));
  expect(groupMembers.find((m) => m.userId === userId)).toBeUndefined();
  expect(groupMembers.filter((m) => m.role === "admin" && m.status === "joined")).toHaveLength(1);
  const [groupRoom] = await db.select().from(rooms).where(eq(rooms.id, S.rooms.group));
  expect(groupRoom).toMatchObject({ createdBy: null, avatarFileId: null, closedAt: null });
  const systemBodies = (
    await db
      .select({ body: messages.body })
      .from(messages)
      .where(and(inArray(messages.roomId, Object.values(S.rooms)), eq(messages.kind, "system")))
  ).map((m) => m.body ?? "");
  for (const body of systemBodies) expect(body).not.toContain("Budi");
  expect(
    await count(
      db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, S.rooms.direct), eq(roomMembers.userId, userId))),
    ),
  ).toBe(0);

  // Laporan anonim (D2): pelapor/terlapor null, teks Budi dihapus, bukti tanpa nama/isi/foto Budi.
  const reportRows = await db
    .select()
    .from(reports)
    .where(inArray(reports.id, Object.values(S.reports)));
  const byReport = Object.fromEntries(reportRows.map((r) => [r.id, r]));
  expect(byReport[S.reports.byBudi]).toMatchObject({
    reporterId: null,
    description: null,
    targetUserId: S.ahmad.userId,
  });
  expect(byReport[S.reports.aboutBudiMessage]).toMatchObject({
    reporterId: S.ahmad.userId,
    targetUserId: null,
  });
  expect(byReport[S.reports.aboutBudiUser]).toMatchObject({
    reporterId: S.citra.userId,
    targetUserId: null,
    memberMessage: null,
    status: "resolved",
    action: "warn",
  });
  for (const r of reportRows) expect(JSON.stringify(r.evidence ?? null)).not.toContain(userId);

  // Like, blokir.
  expect(await count(db.select().from(postLikes).where(eq(postLikes.userId, userId)))).toBe(0);
  expect((await db.select().from(posts).where(eq(posts.id, S.post.id)))[0]!.likeCount).toBe(1);
  expect(
    await count(
      db
        .select()
        .from(blocks)
        .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId))),
    ),
  ).toBe(0);

  // Audit (F-17, D2): tidak ada aktor Budi; tautan identitas pengurus diputus, identitas pengurusnya tetap.
  expect(await count(db.select().from(auditLogs).where(eq(auditLogs.actorUserId, userId)))).toBe(0);
  const [linked] = await db.select().from(admins).where(eq(admins.id, S.linkedAdminId));
  expect(linked).toMatchObject({ linkedAlumniUserId: null });
  // Outbox hanya id (N-14).
  const outbox = await db.select({ payload: outboxEvents.payload }).from(outboxEvents);
  for (const row of outbox) expect(JSON.stringify(row.payload)).not.toContain(S.budi.email);

  // Permintaan selesai; salinan kerja ledger hanya id/object key.
  const [deletion] = await db
    .select()
    .from(accountDeletions)
    .where(eq(accountDeletions.requestNumber, S.requestNumber));
  expect(deletion).toMatchObject({ status: "completed" });
  expect(JSON.stringify(deletion!.ledger)).not.toContain(S.budi.email);
  if (options.restored) expect(deletion!.ledger).toMatchObject({ restored: true });

  // Pemindaian SEMUA tabel skema app: tidak ada teks pribadi Budi tersisa (D2, PRD 6.5), kecuali celah yang
  // Seluruh celah D5-01..D5-05 sudah diperbaiki: tidak ada data pribadi tersisa di tabel mana pun.
  const hits = await personalDataHits(db, personalTerms());
  const knownGaps: Record<string, number> = {};
  const unexpected = Object.fromEntries(
    Object.entries(hits).filter(([table, n]) => n > (knownGaps[table] ?? 0)),
  );
  expect(unexpected).toEqual({});

  // Status akun lain tidak berubah (AC F14-2).
  const others = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(and(inArray(users.id, [S.ahmad.userId, S.citra.userId]), ne(users.status, "active")));
  expect(others).toEqual([]);
  expect(
    await count(
      db
        .select()
        .from(files)
        .where(and(eq(files.purpose, "avatar"), isNotNull(files.ownerUserId), eq(files.ownerUserId, userId))),
    ),
  ).toBe(0);
}
