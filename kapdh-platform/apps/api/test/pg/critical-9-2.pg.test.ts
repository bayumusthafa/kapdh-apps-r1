/**
 * PRD 9.2 "Skenario kritis yang wajib lulus" pada PostgreSQL 17 nyata (audit D4, ARCHITECTURE §9.2). Berkas ini
 * melengkapi skenario yang belum dibuktikan berkas jalur PG lain; skenario yang sudah terbukti dirujuk:
 *
 *   1. kursi terakhir ............................ events-module.pg (AC F09-1), events-inventory.pg
 *   2. reservasi ganda satu anggota .............. events-module.pg, events-inventory.pg
 *   3. dua pengurus menyetujui bukti yang sama ... payments-module.pg (iuran) + DI SINI (tiket)
 *   4. bukti diganti saat keputusan .............. payments-module.pg (AC F04-4)
 *   5. worker mati setelah commit payment ........ DI SINI (kartu benar, outbox → inbox/push/email tepat sekali)
 *   6. JWT/socket dicabut ........................ DI SINI (logout semua, suspend, pencabutan izin) + auth-races.pg
 *   7. IDOR ...................................... DI SINI (bukti bayar, gambar chat, profil privat, audit)
 *   8. job dijalankan ulang ...................... DI SINI (reservations.expire, events.reminders, events.lifecycle,
 *                                                  event.cancelled, semua job terjadwal) + membership.pg (pengingat
 *                                                  renewal), kernels.pg (renewal diterapkan ulang 8x), content.pg
 *   9. akun dihapus lalu backup dipulihkan ....... DI SINI (ledger diterapkan ulang, total keuangan cocok)
 *                                                  + account-deletion.pg (CLI ledger-reapply)
 *  10. gerbang go-live konfigurasi produksi ...... DI SINI (golive:check menolak lalu meloloskan) + golive-gate.pg
 *                                                  (satu uji per kondisi) + release-job.pg (urutan job rilis)
 *  11. dua Super Admin diturunkan bersamaan ...... last-super-admin.pg, admin-governance.pg
 *
 * Diakhiri invarian global atas seluruh data berkas ini: penghitung kursi = jumlah tiket per status, nominal payment =
 * jumlah baris snapshot (ARCHITECTURE §2.5). API berjalan sebagai login role kapdh_app (mendengarkan port nyata untuk
 * Socket.IO), dua worker sebagai kapdh_worker dengan pool masing-masing (grant production).
 */
import "reflect-metadata";
import type { WorkerEnv } from "@kapdh/config";
import type { Permission } from "@kapdh/contracts";
import { appSettings, createDb } from "@kapdh/database";
import { seedDev } from "@kapdh/database/seeds/dev";
import { seedReference } from "@kapdh/database/seeds/reference";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { rmSync } from "node:fs";
import { decodeJwt } from "jose";
import { io, type Socket } from "socket.io-client";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { GOLIVE_EXIT, runGoLiveCheckCommand } from "../../src/cli/golive-check-command.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import type { Db } from "../../src/core/db/types.js";
import { TokenService } from "../../src/core/identity/token.service.js";
import { JobRunner } from "../../src/core/jobs/job-runner.js";
import { createRootLogger } from "../../src/core/logging/logger.js";
import { readLedgerDirectory } from "../../src/modules/account/deletion-ledger.js";
import { DeletionLedgerService } from "../../src/modules/account/deletion-ledger.service.js";
import { AccountDeletionProcessor } from "../../src/modules/account/deletion-processor.js";
import { EventsJobsService } from "../../src/modules/events/events-jobs.service.js";
import { NotificationDeliveryService } from "../../src/modules/notifications/delivery.service.js";
import { createWorkerContext, type WorkerContext } from "../../src/worker.js";
import { expectFullyDeleted } from "../account/expect-deleted.js";
import {
  createRichMember,
  exportLedger,
  requestDeletionViaApp,
  restoreStorage,
  snapshotStorage,
} from "../account/support.js";
import {
  type AlumniFixtureStatus,
  createAdmin,
  createAlumni,
  createPaymentMethod,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { approveProductionConfig } from "../support/golive.js";
import { httpClient } from "../support/http.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, createPgTestDatabase, type PgTestDatabase, sleep, type Sql } from "./support.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

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

interface TestWorker {
  conn: ReturnType<typeof connectAs>;
  ctx: WorkerContext;
  push: FakePush;
  mailer: MemoryMailer;
  jobs: JobRunner;
}

let tdb: PgTestDatabase;
let sql: Sql;
let probe: Sql;
let apiConn: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
let baseUrl: string;
const clock = new TestClock();
const storage = new MemoryDriver();
const apiPush = new FakePush();
const apiMailer = new MemoryMailer();
const workers: TestWorker[] = [];
const sockets: Socket[] = [];
let fx: { app: NestFastifyApplication; db: Db; clock: TestClock; storage: MemoryDriver };

async function startWorker(db: Db, workerStorage: MemoryDriver, workerClock: TestClock) {
  const push = new FakePush();
  const mailer = new MemoryMailer();
  const ctx = await createWorkerContext(
    { env: workerEnv(), db, mailer, clock: workerClock, push, storage: workerStorage, redis: null },
    { logger: createRootLogger({ level: "silent", service: "kapdh-worker" }) },
  );
  return { ctx, push, mailer, jobs: ctx.app.get(JobRunner) };
}

beforeAll(async () => {
  tdb = await createPgTestDatabase("critical_9_2", 8);
  sql = tdb.sql;
  apiConn = connectAs(tdb, "kapdh_app", 24);
  app = await createApp(
    {
      env: testEnv,
      db: apiConn.db as unknown as Db,
      mailer: apiMailer,
      clock,
      push: apiPush,
      storage,
      redis: null,
    },
    { logger: false },
  );
  await app.init();
  // Port nyata: Socket.IO namespace /realtime untuk skenario pencabutan socket (AC F02-6).
  await app.listen(0, "127.0.0.1");
  baseUrl = await app.getUrl();
  fx = { app, db: tdb.db as unknown as Db, clock, storage };
  probe = createDb(tdb.url, { max: 1, applicationName: "kapdh-pg-probe-critical" }).sql;
  // Dua replika apps/worker: pool kapdh_worker, push dan mailer masing-masing.
  for (let i = 0; i < 2; i++) {
    const conn = connectAs(tdb, "kapdh_worker", 6);
    workers.push({ conn, ...(await startWorker(conn.db as unknown as Db, storage, clock)) });
  }
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  for (const worker of workers) {
    await worker.ctx.close();
    await worker.conn.sql.end({ timeout: 5 });
  }
  await app?.close();
  await probe?.end({ timeout: 5 });
  await apiConn?.sql.end({ timeout: 5 });
  await tdb.drop();
});

const http = () => httpClient(app);

/** Menunggu sampai minimal `n` backend database ini menunggu kunci (bukti persaingan sungguhan). */
async function waitForLockWaiters(n: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await probe<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`;
    if ((row?.n ?? 0) >= n) return true;
    await sleep(10);
  }
  return false;
}

/** Menahan kunci `lock`, menembakkan `fire`, menunggu `waiters` penunggu kunci, lalu commit. */
async function underLock<T>(
  lock: (tx: Sql) => Promise<unknown>,
  waiters: number,
  fire: () => Promise<T>[],
): Promise<{ results: T[]; observed: boolean }> {
  let pending: Promise<T>[] = [];
  let observed = false;
  await sql.begin(async (tx) => {
    await lock(tx as unknown as Sql);
    pending = fire();
    observed = await waitForLockWaiters(waiters);
  });
  return { results: await Promise.all(pending), observed };
}

async function count(query: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await query;
  return row!.n;
}

async function member(status: AlumniFixtureStatus = "verified") {
  const fixture = await createAlumni(fx, { status });
  const session = await signInAlumni(fx, fixture);
  return { ...fixture, token: session.accessToken, refreshToken: session.refreshToken };
}

async function admin(permissions: Permission[]) {
  const fixture = await createAdmin(fx, { permissions });
  const session = await signInAdmin(fx, fixture);
  return { adminId: fixture.adminId, userId: fixture.userId, token: session.accessToken };
}

/** Event open relatif terhadap jam aplikasi (TestClock), bukan jam database. */
async function insertEvent(
  options: { seats?: number; price?: string; startsInMs?: number } = {},
): Promise<string> {
  const id = uuidv7();
  const now = clock.now().getTime();
  const startsAt = new Date(now + (options.startsInMs ?? 10 * DAY));
  await sql`
    insert into app.events (id, title, starts_at, ends_at, registration_opens_at, registration_closes_at, price,
                            seats_total, status, created_at, updated_at)
    values (${id}, 'Event Kritis PG', ${startsAt.toISOString()},
            ${new Date(startsAt.getTime() + 4 * HOUR).toISOString()}, ${new Date(now - DAY).toISOString()},
            ${new Date(startsAt.getTime() - 30 * 60_000).toISOString()}, ${options.price ?? "75000.00"},
            ${options.seats ?? 10}, 'open', now(), now())`;
  return id;
}

/** Instruksi registration berbukti versi 1 lewat API (F-03, F-04). */
async function reviewableRegistration(owner: { token: string }) {
  const methodId = (await createPaymentMethod(fx)).id;
  const created = await http().post(
    "/me/payments",
    { type: "registration", payment_method_id: methodId },
    { token: owner.token },
  );
  expect(created.statusCode, created.body).toBe(201);
  const proof = await uploadTestFile(fx, owner.token, "payment_proof");
  const proofed = await http().put(
    `/me/payments/${created.json().id}/proof`,
    { file_id: proof.id, expected_proof_version: 0 },
    { token: owner.token },
  );
  expect(proofed.statusCode, proofed.body).toBe(200);
  return {
    id: proofed.json().id as string,
    version: proofed.json().version as string,
    proofFileId: proof.id,
  };
}

const approve = (payment: { version: string }) => ({
  decision: "approve",
  expected_proof_version: 1,
  expected_version: payment.version,
  funds_verified: true,
});

async function familyOf(accessToken: string): Promise<string> {
  const [row] = await sql<{ family_id: string }[]>`
    select family_id from app.sessions where id = ${String(decodeJwt(accessToken).sid)}`;
  return row!.family_id;
}

/** URL isi berkas bertanda tangan → path request inject (tanpa host). */
function contentPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

interface ConnectError extends Error {
  data?: { code: string };
}

function connect(token: string): Promise<Socket> {
  const socket = io(`${baseUrl}/realtime`, {
    transports: ["websocket"],
    auth: { token },
    reconnection: false,
    forceNew: true,
    timeout: 5000,
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error: ConnectError) => reject(error));
  });
}

function disconnected(socket: Socket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.disconnected) return resolve();
    const timer = setTimeout(() => reject(new Error("socket tidak diputus")), timeoutMs);
    socket.once("disconnect", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ------------------------------------------------------------------------------------------- skenario 3 (tiket)

describe("PRD 9.2 #3 / AC F04-3: dua pengurus menyetujui bukti TIKET yang sama bersamaan (PostgreSQL 17)", () => {
  it("satu keputusan berlaku, yang lain 409 PAYMENT_STATE_CONFLICT; satu tiket paid, held→paid tepat sekali, satu audit ticket.paid", async () => {
    const eventId = await insertEvent({ seats: 2, price: "75000.00" });
    const owner = await member();
    const methodId = (await createPaymentMethod(fx)).id;
    const reserved = await http().post(
      `/events/${eventId}/reservations`,
      { expected_price: "75000.00", payment_method_id: methodId },
      { token: owner.token },
    );
    expect(reserved.statusCode, reserved.body).toBe(201);
    const ticket = reserved.json();
    const proof = await uploadTestFile(fx, owner.token, "payment_proof");
    const proofed = await http().put(
      `/me/payments/${ticket.payment.id}/proof`,
      { file_id: proof.id, expected_proof_version: 0 },
      { token: owner.token },
    );
    expect(proofed.statusCode, proofed.body).toBe(200);
    const deciders = [
      await admin(["payments.read", "payments.decide"]),
      await admin(["payments.read", "payments.decide"]),
    ];
    const body = approve({ version: proofed.json().version as string });
    // lockRelated mengunci event lebih dulu (urutan kunci global PRD 6.4): kedua keputusan antre di baris event.
    const { results, observed } = await underLock(
      (tx) => tx`select id from app.events where id = ${eventId} for update`,
      2,
      () =>
        deciders.map((d) =>
          http().post(`/admin/payments/${ticket.payment.id}/decision`, body, { token: d.token }),
        ),
    );
    expect(observed, "kedua keputusan benar-benar menunggu kunci baris event").toBe(true);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json()).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
      current: { id: ticket.payment.id, status: "paid" },
    });
    const [row] = await sql<{ status: string; qr_code: string | null }[]>`
      select status, qr_code from app.tickets where id = ${ticket.id}`;
    expect(row!.status).toBe("paid");
    expect(row!.qr_code).toMatch(/^[0-9a-f]{32}$/);
    const [event] = await sql<{ held_quantity: number; paid_quantity: number }[]>`
      select held_quantity, paid_quantity from app.events where id = ${eventId}`;
    expect(event).toEqual({ held_quantity: 0, paid_quantity: 1 });
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.payment_events
        where payment_id = ${ticket.payment.id} and kind = 'approved'`),
    ).toBe(1);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.audit_logs where entity_id = ${ticket.id} and action = 'ticket.paid'`),
    ).toBe(1);
  });

  it("lintas F-14: job penghapusan akun (kapdh_worker) dan persetujuan bukti tiket pemiliknya bersaing di kunci event → tanpa deadlock/500; kursi dilepas tepat sekali", async () => {
    const eventId = await insertEvent({ seats: 3, price: "75000.00" });
    const owner = await member();
    const methodId = (await createPaymentMethod(fx)).id;
    const reserved = await http().post(
      `/events/${eventId}/reservations`,
      { expected_price: "75000.00", payment_method_id: methodId },
      { token: owner.token },
    );
    expect(reserved.statusCode, reserved.body).toBe(201);
    const ticket = reserved.json();
    const proof = await uploadTestFile(fx, owner.token, "payment_proof");
    const proofed = await http().put(
      `/me/payments/${ticket.payment.id}/proof`,
      { file_id: proof.id, expected_proof_version: 0 },
      { token: owner.token },
    );
    expect(proofed.statusCode, proofed.body).toBe(200);
    const decider = await admin(["payments.read", "payments.decide"]);
    const { id: deletionId } = await requestDeletionViaApp(fx, {
      accessToken: owner.token,
      refreshToken: owner.refreshToken,
    });
    const { results, observed } = await underLock<unknown>(
      (tx) => tx`select id from app.events where id = ${eventId} for update`,
      2,
      () => [
        runAsSystem(() => workers[0]!.ctx.app.get(AccountDeletionProcessor).run(deletionId), {
          jobId: `account.deletion:${uuidv7()}`,
        }),
        http().post(
          `/admin/payments/${ticket.payment.id}/decision`,
          approve({ version: proofed.json().version as string }),
          { token: decider.token },
        ),
      ],
    );
    expect(observed, "job penghapusan dan keputusan menunggu kunci event yang sama").toBe(true);
    const [deletion, decision] = results as unknown as [
      { outcome: string },
      { statusCode: number; body: string },
    ];
    expect(deletion.outcome).toBe("completed");
    expect(decision.statusCode, decision.body).toBe(200);
    const [row] = await sql<{ status: string; user_id: string | null }[]>`
      select status, user_id from app.tickets where id = ${ticket.id}`;
    expect(row).toEqual({ status: "cancelled", user_id: null });
    const [payment] = await sql<{ status: string; user_id: string | null; amount: string }[]>`
      select status, user_id, amount::text as amount from app.payments where id = ${ticket.payment.id}`;
    expect(payment).toEqual({ status: "paid", user_id: null, amount: "75000.00" });
    const [event] = await sql<{ held_quantity: number; paid_quantity: number }[]>`
      select held_quantity, paid_quantity from app.events where id = ${eventId}`;
    expect(event).toEqual({ held_quantity: 0, paid_quantity: 0 });
  });
});

// ------------------------------------------------------------------------------------------------ skenario 5

describe("PRD 9.2 #5 / AC F04-1, PRD 5.1: worker mati setelah commit payment (PostgreSQL 17)", () => {
  it("kartu dan periode benar sejak commit; event outbox milik worker yang mati diklaim ulang setelah lease habis; inbox, push dan email tepat sekali", async () => {
    const owner = await member("unverified");
    const deviceToken = `pg-kritis-${uuidv7()}`;
    const registered = await http().put(
      "/devices",
      { platform: "android", token: deviceToken },
      { token: owner.token },
    );
    expect(registered.statusCode, registered.body).toBe(204);
    const payment = await reviewableRegistration(owner);
    const decider = await admin(["payments.read", "payments.decide"]);
    const decided = await http().post(`/admin/payments/${payment.id}/decision`, approve(payment), {
      token: decider.token,
    });
    expect(decided.statusCode, decided.body).toBe(200);

    // Sebelum worker mana pun berjalan, hasil keputusan sudah final: periode dan KTA benar (AC F04-1, F05-1).
    const [period] = await sql<{ expires_at: Date; member_number: string }[]>`
      select expires_at, member_number from app.alumni where user_id = ${owner.userId}`;
    expect(period!.expires_at).not.toBeNull();
    const card = await http().get("/me/card", { token: owner.token });
    expect(card.statusCode, card.body).toBe(200);
    expect(card.json().member_number).toBe(period!.member_number);
    expect(new Date(card.json().expires_at as string).getTime()).toBe(new Date(period!.expires_at).getTime());

    const [notification] = await sql<{ id: string }[]>`
      select id from app.notifications where user_id = ${owner.userId} and data->>'payment_id' = ${payment.id}`;
    const dedupKey = `notification.created:${notification!.id}`;
    const [pending] = await sql<{ status: string; attempts: number }[]>`
      select status, attempts from app.outbox_events where dedup_key = ${dedupKey}`;
    expect(pending).toEqual({ status: "pending", attempts: 0 });

    const pushes = () =>
      [apiPush, ...workers.map((w) => w.push)]
        .flatMap((p) => p.to(deviceToken))
        .filter((m) => m.data.notification_id === notification!.id);
    const mails = async () => {
      const ids = new Set(
        (
          await sql<{ id: string }[]>`
            select id from app.notification_deliveries
            where notification_id = ${notification!.id} and channel = 'email'`
        ).map((r) => r.id),
      );
      return [apiMailer, ...workers.map((w) => w.mailer)]
        .flatMap((m) => m.messages)
        .filter((m) => m.dedupKey !== undefined && ids.has(m.dedupKey));
    };

    // Worker A mengklaim lalu mati SESUDAH efek kanal terjadi dan SEBELUM hasil dicatat (crash paling buruk).
    const [dying, survivor] = workers as [TestWorker, TestWorker];
    const claims = await dying.jobs.claimOutbox({ limit: 1000, lockMs: 60_000 });
    const mine = claims.find((c) => c.dedupKey === dedupKey);
    expect(mine, "event outbox payment diklaim worker A").toBeDefined();
    for (const other of claims) if (other !== mine) await dying.jobs.releaseOutboxClaim(other);
    await runAsSystem(() => dying.ctx.app.get(NotificationDeliveryService).deliver(notification!.id));
    expect(pushes()).toHaveLength(1);
    expect(await mails()).toHaveLength(1);

    // Selama lease worker A berlaku, worker B tidak dapat mengklaim event yang sama (SKIP LOCKED + locked_until).
    const peek = await survivor.jobs.claimOutbox({ limit: 1000 });
    for (const claim of peek) await survivor.jobs.releaseOutboxClaim(claim);
    expect(peek.some((c) => c.dedupKey === dedupKey)).toBe(false);

    // Lease habis: worker B mengklaim ulang dan memproses; handler idempoten tidak mengirim ulang.
    clock.advance(61_000);
    await survivor.jobs.drainOutbox();
    const [done] = await sql<{ status: string; attempts: number }[]>`
      select status, attempts from app.outbox_events where dedup_key = ${dedupKey}`;
    expect(done).toEqual({ status: "dispatched", attempts: 2 });
    expect(pushes()).toHaveLength(1);
    expect(await mails()).toHaveLength(1);
    const deliveries = await sql<{ channel: string; status: string; attempt: number }[]>`
      select channel::text as channel, status::text as status, attempt from app.notification_deliveries
      where notification_id = ${notification!.id} order by channel::text`;
    expect(deliveries.map((d) => ({ ...d }))).toEqual([
      { channel: "email", status: "sent", attempt: 1 },
      { channel: "push", status: "sent", attempt: 1 },
    ]);

    // Worker A "hidup kembali" dengan klaim lamanya: pemrosesan ditolak (fencing), tidak ada efek baru.
    expect(await dying.jobs.processOutboxClaim(mine!)).toBe("lost");
    expect(pushes()).toHaveLength(1);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.notifications
        where user_id = ${owner.userId} and data->>'payment_id' = ${payment.id}`),
    ).toBe(1);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.membership_events where payment_id = ${payment.id}`),
    ).toBe(1);
    const [after] = await sql<{ expires_at: Date }[]>`
      select expires_at from app.alumni where user_id = ${owner.userId}`;
    expect(new Date(after!.expires_at).getTime()).toBe(new Date(period!.expires_at).getTime());
  });
});

// ------------------------------------------------------------------------------------------------ skenario 6

describe("PRD 9.2 #6 / AC F02-6, F12-3, F16-3: JWT dan socket yang sudah dicabut (PostgreSQL 17)", () => {
  it("logout semua: socket perangkat lain diputus; access/refresh token lama dan handshake socket baru ditolak 401 UNAUTHENTICATED", async () => {
    const owner = await createAlumni(fx, { status: "verified" });
    const peer = await createAlumni(fx, { status: "verified" });
    const phone = await signInAlumni(fx, owner);
    const tablet = await signInAlumni(fx, owner);
    const socket = await connect(phone.accessToken);
    const gone = disconnected(socket);
    const res = await http().post("/auth/logout-all", {}, { token: tablet.accessToken });
    expect(res.statusCode, res.body).toBe(204);
    await gone;
    const attempts = await Promise.all(
      [phone, tablet].flatMap((s) => [
        http().get("/me", { token: s.accessToken }),
        http().get("/directory", { token: s.accessToken }),
        http().post("/chat/direct", { user_id: peer.userId }, { token: s.accessToken }),
        http().post("/auth/refresh", { refresh_token: s.refreshToken }),
      ]),
    );
    for (const attempt of attempts) {
      expect(attempt.statusCode, attempt.body).toBe(401);
      expect(attempt.json().code).toBe("UNAUTHENTICATED");
    }
    await expect(connect(phone.accessToken)).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.room_members rm join app.rooms r on r.id = rm.room_id
        where r.kind = 'direct' and rm.user_id = ${owner.userId}`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.sessions where user_id = ${owner.userId} and revoked_at is null`),
    ).toBe(0);
  });

  it("suspend: socket diputus dan seluruh sesi dicabut (token lama 401); sesi baru hanya portal terbatas: tindakan anggota aktif 403 ACCOUNT_SUSPENDED", async () => {
    const owner = await member();
    const peer = await createAlumni(fx, { status: "verified" });
    const socket = await connect(owner.token);
    const gone = disconnected(socket);
    const moderator = await admin(["members.read", "moderation.read", "moderation.resolve"]);
    const [row] = await sql<{ version: number }[]>`
      select version from app.alumni where user_id = ${owner.userId}`;
    const suspended = await http().post(
      `/admin/members/${owner.userId}/suspend`,
      {
        reason: "Pelanggaran ketentuan komunitas (uji PG)",
        member_message: "Akun dibatasi sementara.",
        confirm: true,
      },
      { token: moderator.token, headers: { "if-match": String(row!.version), "idempotency-key": uuidv7() } },
    );
    expect(suspended.statusCode, suspended.body).toBe(200);
    await gone;
    // MembershipKernel.suspend mencabut semua sesi (lebih ketat dari sekadar menolak tingkat akses).
    const stale = await Promise.all([
      http().get("/me", { token: owner.token }),
      http().post("/chat/direct", { user_id: peer.userId }, { token: owner.token }),
      http().post("/auth/refresh", { refresh_token: owner.refreshToken }),
    ]);
    for (const res of stale) expect(res.statusCode, res.body).toBe(401);
    const fresh = (await signInAlumni(fx, owner)).accessToken;
    const denied = await Promise.all([
      http().post("/chat/direct", { user_id: peer.userId }, { token: fresh }),
      http().get("/directory", { token: fresh }),
    ]);
    for (const res of denied) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().code).toBe("ACCOUNT_SUSPENDED");
    }
    expect((await http().get("/me", { token: fresh })).statusCode).toBe(200);
  });

  it("pencabutan izin: token admin lama langsung 403 FORBIDDEN; URL bukti bertanda tangan yang sudah terbit mati (404)", async () => {
    const owner = await member("unverified");
    const payment = await reviewableRegistration(owner);
    const treasurer = await admin(["payments.read", "payments.decide"]);
    const superAdmin = await createAdmin(fx, { role: "super_admin" });
    const superSession = await signInAdmin(fx, superAdmin);

    expect((await http().get(`/admin/payments/${payment.id}`, { token: treasurer.token })).statusCode).toBe(
      200,
    );
    const access = await http().get(`/files/${payment.proofFileId}/access`, { token: treasurer.token });
    expect(access.statusCode, access.body).toBe(200);
    const signed = contentPath(access.json().url as string);
    expect((await app.inject({ method: "GET", url: signed })).statusCode).toBe(200);

    const [target] = await sql<{ version: number }[]>`
      select version from app.admins where id = ${treasurer.adminId}`;
    const reauth = await app.get(TokenService).signReauth({
      userId: superAdmin.userId,
      familyId: await familyOf(superSession.accessToken),
      level: 2,
    });
    const revoked = await http().patch(
      `/admin/admins/${treasurer.adminId}`,
      { permissions: ["events.checkin"] },
      {
        token: superSession.accessToken,
        headers: { "x-reauth-token": reauth.token, "if-match": String(target!.version) },
      },
    );
    expect(revoked.statusCode, revoked.body).toBe(200);

    const after = await Promise.all([
      http().get(`/admin/payments/${payment.id}`, { token: treasurer.token }),
      http().post(`/admin/payments/${payment.id}/decision`, approve(payment), { token: treasurer.token }),
    ]);
    for (const res of after) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().code).toBe("FORBIDDEN");
    }
    expect((await app.inject({ method: "GET", url: signed })).statusCode).toBe(404);
    expect(
      (await http().get(`/files/${payment.proofFileId}/access`, { token: treasurer.token })).statusCode,
    ).toBe(404);
    const [state] = await sql<{ status: string }[]>`select status from app.payments where id = ${payment.id}`;
    expect(state!.status).toBe("pending");
  });
});

// ------------------------------------------------------------------------------------------------ skenario 7

describe("PRD 9.2 #7 / N-09: mengganti object ID tidak memaparkan data pihak lain (PostgreSQL 17)", () => {
  it("bukti bayar: anggota lain dan pengurus tanpa payments.read ditolak tanpa membedakan alasan; pemilik dan payments.read dapat membuka", async () => {
    const owner = await member("unverified");
    const intruder = await member("unverified");
    const payment = await reviewableRegistration(owner);
    const otherProof = await uploadTestFile(fx, intruder.token, "payment_proof");

    const asIntruder = await Promise.all([
      http().get(`/me/payments/${payment.id}`, { token: intruder.token }),
      http().get(`/files/${payment.proofFileId}/access`, { token: intruder.token }),
      http().put(
        `/me/payments/${payment.id}/proof`,
        { file_id: otherProof.id, expected_proof_version: 1 },
        { token: intruder.token },
      ),
      http().post(
        `/me/payments/${payment.id}/cancel`,
        { reason: "Coba batalkan" },
        { token: intruder.token, headers: { "if-match": payment.version } },
      ),
      // Jalur berkas publik tanpa autentikasi tidak pernah melayani berkas privat (PRD 5.4).
      http().get(`/files/public/${payment.proofFileId}`),
    ]);
    for (const res of asIntruder) expect(res.statusCode, res.body).toBe(404);

    const eventsManager = await admin(["events.manage"]);
    expect(
      (await http().get(`/admin/payments/${payment.id}`, { token: eventsManager.token })).statusCode,
    ).toBe(403);
    expect(
      (await http().get(`/files/${payment.proofFileId}/access`, { token: eventsManager.token })).statusCode,
    ).toBe(404);

    expect((await http().get(`/me/payments/${payment.id}`, { token: owner.token })).statusCode).toBe(200);
    expect(
      (await http().get(`/files/${payment.proofFileId}/access`, { token: owner.token })).statusCode,
    ).toBe(200);
    const reader = await admin(["payments.read"]);
    expect(
      (await http().get(`/files/${payment.proofFileId}/access`, { token: reader.token })).statusCode,
    ).toBe(200);
    const [row] = await sql<{ proof_version: number; status: string }[]>`
      select proof_version, status from app.payments where id = ${payment.id}`;
    expect(row).toEqual({ proof_version: 1, status: "pending" });
  });

  it("gambar chat: bukan anggota room 404 untuk berkas, room dan riwayat; URL bertanda tangan pengirim mati setelah ia logout", async () => {
    const sender = await member();
    const recipient = await member();
    const outsider = await member();
    const opened = await http().post("/chat/direct", { user_id: recipient.userId }, { token: sender.token });
    expect(opened.statusCode, opened.body).toBe(201);
    const roomId = opened.json().id as string;
    const image = await uploadTestFile(fx, sender.token, "chat_image");
    const sent = await http().post(
      `/chat/rooms/${roomId}/messages`,
      { client_message_id: uuidv7(), kind: "image", image_file_id: image.id },
      { token: sender.token },
    );
    expect(sent.statusCode, sent.body).toBe(201);

    const asOutsider = await Promise.all([
      http().get(`/files/${image.id}/access`, { token: outsider.token }),
      http().get(`/chat/rooms/${roomId}`, { token: outsider.token }),
      http().get(`/chat/rooms/${roomId}/messages`, { token: outsider.token }),
      http().get(`/files/public/${image.id}`),
    ]);
    for (const res of asOutsider) expect(res.statusCode, res.body).toBe(404);

    expect((await http().get(`/files/${image.id}/access`, { token: recipient.token })).statusCode).toBe(200);
    const own = await http().get(`/files/${image.id}/access`, { token: sender.token });
    expect(own.statusCode, own.body).toBe(200);
    const signed = contentPath(own.json().url as string);
    expect((await app.inject({ method: "GET", url: signed })).statusCode).toBe(200);
    expect((await http().post("/auth/logout", {}, { token: sender.token })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: signed })).statusCode).toBe(404);
  });

  it("profil privat: anggota yang tidak tampil di direktori 404; kontak yang disembunyikan tidak ada di payload", async () => {
    const viewer = await member();
    const hidden = await createAlumni(fx, { status: "verified", showInDirectory: false });
    const shy = await createAlumni(fx, { status: "verified" });
    await sql`
      update app.alumni set phone = '081299988877', show_phone = false, show_email = false, show_social = false,
                            social_instagram = 'rahasia.pg'
      where user_id = ${shy.userId}`;

    expect((await http().get(`/directory/${hidden.userId}`, { token: viewer.token })).statusCode).toBe(404);
    const profile = await http().get(`/directory/${shy.userId}`, { token: viewer.token });
    expect(profile.statusCode, profile.body).toBe(200);
    const body = profile.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("phone");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("social");
    expect(profile.body).not.toContain("081299988877");
    expect(profile.body).not.toContain(shy.email);
    expect(profile.body).not.toContain("rahasia.pg");
  });

  it("audit: admin tanpa audit.read 403 untuk daftar dan entri; token anggota ditolak; audit.read dapat membaca", async () => {
    const [entry] = await sql<
      { id: string }[]
    >`select id from app.audit_logs order by created_at desc limit 1`;
    const stranger = await admin(["payments.read"]);
    for (const path of ["/admin/audit/entries", `/admin/audit/entries/${entry!.id}`]) {
      const res = await http().get(path, { token: stranger.token });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().code).toBe("FORBIDDEN");
    }
    const alumni = await member();
    const asMember = await http().get(`/admin/audit/entries/${entry!.id}`, { token: alumni.token });
    expect([401, 403], asMember.body).toContain(asMember.statusCode);
    const auditor = await admin(["audit.read"]);
    expect((await http().get(`/admin/audit/entries/${entry!.id}`, { token: auditor.token })).statusCode).toBe(
      200,
    );
  });
});

// ------------------------------------------------------------------------------------------------ skenario 8

describe("PRD 9.2 #8 / AC F09-2, F13-6, PRD 5.1: job dijalankan ulang tidak menggandakan efek (PostgreSQL 17)", () => {
  it("reservations.expire: 4 eksekusi bersamaan pada 2 worker + ulangan → setiap hold dilepas, dibatalkan, diaudit dan diberitahukan tepat sekali", async () => {
    const eventA = await insertEvent({ seats: 5 });
    const eventB = await insertEvent({ seats: 5 });
    const methodId = (await createPaymentMethod(fx)).id;
    const reserve = async (eventId: string) => {
      const holder = await member();
      const res = await http().post(
        `/events/${eventId}/reservations`,
        { expected_price: "75000.00", payment_method_id: methodId },
        { token: holder.token },
      );
      expect(res.statusCode, res.body).toBe(201);
      return {
        userId: holder.userId,
        ticketId: res.json().id as string,
        paymentId: res.json().payment.id as string,
      };
    };
    const lapsed = [await reserve(eventA), await reserve(eventA), await reserve(eventB)];
    clock.advance(13 * HOUR);
    const active = await reserve(eventA);
    clock.advance(12 * HOUR); // hold pertama 25 jam (lewat), hold terakhir 12 jam (masih berlaku)

    const { observed } = await underLock(
      (tx) => tx`select id from app.events where id = ${eventA} for update`,
      2,
      () =>
        workers.flatMap((w) => [
          w.jobs.runScheduled("reservations.expire"),
          w.jobs.runScheduled("reservations.expire"),
        ]),
    );
    expect(observed, "eksekusi job benar-benar bersaing pada kunci event").toBe(true);
    await workers[0]!.jobs.runScheduled("reservations.expire");

    for (const hold of lapsed) {
      const [ticket] = await sql<
        { status: string }[]
      >`select status from app.tickets where id = ${hold.ticketId}`;
      expect(ticket!.status).toBe("expired");
      expect(
        await count(sql<{ n: number }[]>`
          select count(*)::int as n from app.payment_events where payment_id = ${hold.paymentId} and kind = 'cancelled'`),
      ).toBe(1);
      expect(
        await count(sql<{ n: number }[]>`
          select count(*)::int as n from app.audit_logs where entity_id = ${hold.ticketId} and action = 'ticket.expired'`),
      ).toBe(1);
      expect(
        await count(sql<{ n: number }[]>`
          select count(*)::int as n from app.notifications
          where dedup_key = ${`u:${hold.userId}:ticket.expired:${hold.ticketId}`}`),
      ).toBe(1);
    }
    const [stillHeld] = await sql<
      { status: string }[]
    >`select status from app.tickets where id = ${active.ticketId}`;
    expect(stillHeld!.status).toBe("awaiting_payment");
    const seats = await sql<{ id: string; held_quantity: number }[]>`
      select id, held_quantity from app.events where id in (${eventA}, ${eventB})`;
    expect(Object.fromEntries(seats.map((s) => [s.id, s.held_quantity]))).toEqual({
      [eventA]: 1,
      [eventB]: 0,
    });
  });

  it("events.reminders: 4 eksekusi bersamaan + ulangan → satu pengingat H-3 dan satu outbox per pemegang tiket", async () => {
    const eventId = await insertEvent({ price: "0.00", startsInMs: 2 * DAY });
    const holders: string[] = [];
    for (let i = 0; i < 3; i++) {
      const holder = await member();
      const res = await http().post(
        `/events/${eventId}/reservations`,
        { expected_price: "0.00" },
        { token: holder.token },
      );
      expect(res.statusCode, res.body).toBe(201);
      holders.push(holder.userId);
    }
    const { observed } = await underLock(
      (tx) => tx`select id from app.events where id = ${eventId} for update`,
      2,
      () =>
        workers.flatMap((w) => [
          w.jobs.runScheduled("events.reminders"),
          w.jobs.runScheduled("events.reminders"),
        ]),
    );
    expect(observed).toBe(true);
    await workers[1]!.jobs.runScheduled("events.reminders");
    for (const userId of holders) {
      const rows = await sql<{ id: string }[]>`
        select id from app.notifications
        where user_id = ${userId} and dedup_key like ${`u:${userId}:event.reminder.h3:${eventId}:%`}`;
      expect(rows).toHaveLength(1);
      expect(
        await count(sql<{ n: number }[]>`
          select count(*)::int as n from app.outbox_events
          where dedup_key = ${`notification.created:${rows[0]!.id}`}`),
      ).toBe(1);
    }
  });

  it("events.lifecycle: 4 eksekusi bersamaan + ulangan → satu transisi dan satu audit per event", async () => {
    const now = clock.now().getTime();
    const closing = uuidv7();
    const ending = uuidv7();
    const at = (ms: number) => new Date(now + ms).toISOString();
    await sql`
      insert into app.events (id, title, starts_at, ends_at, registration_opens_at, registration_closes_at, price,
                              seats_total, status, created_at, updated_at)
      values (${closing}, 'Pendaftaran Tutup PG', ${at(DAY)}, ${at(DAY + 4 * HOUR)}, ${at(-2 * DAY)}, ${at(-HOUR)},
              '0.00', 10, 'open', now(), now()),
             (${ending}, 'Acara Selesai PG', ${at(-5 * HOUR)}, ${at(-HOUR)}, ${at(-3 * DAY)}, ${at(-6 * HOUR)},
              '0.00', 10, 'open', now(), now())`;
    const { observed } = await underLock(
      (tx) => tx`select id from app.events where id = ${closing} for update`,
      2,
      () =>
        workers.flatMap((w) => [
          w.jobs.runScheduled("events.lifecycle"),
          w.jobs.runScheduled("events.lifecycle"),
        ]),
    );
    expect(observed).toBe(true);
    await workers[0]!.jobs.runScheduled("events.lifecycle");
    const rows = await sql<{ id: string; status: string; version: number }[]>`
      select id, status, version from app.events where id in (${closing}, ${ending})`;
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.status, r.version]]))).toEqual({
      [closing]: ["closed", 2],
      [ending]: ["done", 2],
    });
    for (const id of [closing, ending])
      expect(
        await count(sql<{ n: number }[]>`
          select count(*)::int as n from app.audit_logs where entity_id = ${id} and action = 'event.status_changed'`),
      ).toBe(1);
  });

  it("event.cancelled: fanout diulang (dua worker drain outbox + panggilan langsung bersamaan) → satu notifikasi per pemegang tiket", async () => {
    const eventId = await insertEvent({ price: "0.00", startsInMs: 5 * DAY });
    const holders: string[] = [];
    for (let i = 0; i < 2; i++) {
      const holder = await member();
      const res = await http().post(
        `/events/${eventId}/reservations`,
        { expected_price: "0.00" },
        { token: holder.token },
      );
      expect(res.statusCode, res.body).toBe(201);
      holders.push(holder.userId);
    }
    const manager = await admin(["events.manage"]);
    const cancelled = await http().post(
      `/admin/events/${eventId}/cancel`,
      { reason: "Uji fanout ulang" },
      { token: manager.token, headers: { "if-match": "1" } },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const fanout = (w: TestWorker) =>
      runAsSystem(() => w.ctx.app.get(EventsJobsService).fanoutCancellation(eventId));
    const settled = await Promise.allSettled([
      workers[0]!.jobs.drainOutbox(),
      workers[1]!.jobs.drainOutbox(),
      fanout(workers[0]!),
      fanout(workers[1]!),
    ]);
    expect(settled.filter((s) => s.status === "rejected")).toEqual([]);
    await fanout(workers[0]!);
    for (const userId of holders) {
      const rows = await sql<{ id: string }[]>`
        select id from app.notifications where dedup_key = ${`u:${userId}:event.cancelled:${eventId}`}`;
      expect(rows).toHaveLength(1);
      expect(
        await count(sql<{ n: number }[]>`
          select count(*)::int as n from app.outbox_events
          where dedup_key = ${`notification.created:${rows[0]!.id}`}`),
      ).toBe(1);
    }
    const [event] = await sql<{ held_quantity: number; paid_quantity: number }[]>`
      select held_quantity, paid_quantity from app.events where id = ${eventId}`;
    expect(event).toEqual({ held_quantity: 0, paid_quantity: 0 });
  });

  it("semua job terjadwal: 2 eksekusi bersamaan per worker pada 2 worker lalu ulangan → tanpa galat, deadlock, atau 500", async () => {
    const names = workers[0]!.ctx.registry.scheduledJobs().map((job) => job.name);
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
    for (const name of names) {
      const settled = await Promise.allSettled(
        workers.flatMap((w) => [w.jobs.runScheduled(name), w.jobs.runScheduled(name)]),
      );
      const failures = settled
        .filter((s): s is PromiseRejectedResult => s.status === "rejected")
        .map((s) => String((s.reason as Error)?.message ?? s.reason));
      expect(failures, `job ${name}`).toEqual([]);
      await workers[1]!.jobs.runScheduled(name);
    }
  });
});

// ------------------------------------------------------------------------------------------------ skenario 9

/** Ringkasan keuangan dan inventori yang wajib sama antara database sumber dan database pulihan (D2, PRD 9.2). */
async function financeSnapshot(s: Sql) {
  const plain = <T extends object>(rows: readonly T[]) => rows.map((row) => ({ ...row }));
  return {
    payments: plain(
      await s<{ type: string; status: string; n: number; total: string }[]>`
        select type::text, status::text, count(*)::int as n, coalesce(sum(amount), 0)::text as total
        from app.payments group by 1, 2 order by 1, 2`,
    ),
    paid: plain(
      await s<{ n: number; total: string }[]>`
        select count(*)::int as n, coalesce(sum(amount), 0)::text as total from app.payments where status = 'paid'`,
    ),
    adjustments: plain(
      await s<{ kind: string; status: string; n: number; total: string }[]>`
        select kind::text, status::text, count(*)::int as n, coalesce(sum(amount), 0)::text as total
        from app.payment_adjustments group by 1, 2 order by 1, 2`,
    ),
    paymentEvents: plain(
      await s<{ kind: string; n: number }[]>`
        select kind::text, count(*)::int as n from app.payment_events group by 1 order by 1`,
    ),
    seats: plain(
      await s<{ id: string; held_quantity: number; paid_quantity: number }[]>`
        select id, held_quantity, paid_quantity from app.events order by id`,
    ),
    tickets: plain(
      await s<{ status: string; n: number }[]>`
        select status::text, count(*)::int as n from app.tickets group by 1 order by 1`,
    ),
  };
}

/** Penghitung kursi yang tidak sama dengan jumlah tiket per status (PRD 4.4, AC F09-1). */
async function seatMismatches(s: Sql) {
  return s<{ id: string }[]>`
    select e.id from app.events e
    left join app.tickets t on t.event_id = e.id
    group by e.id, e.status, e.held_quantity, e.paid_quantity
    having (e.status = 'cancelled' and (e.held_quantity <> 0 or e.paid_quantity <> 0))
        or (e.status <> 'cancelled' and (
              e.held_quantity <> count(t.id) filter (where t.status in ('awaiting_payment', 'awaiting_review'))
           or e.paid_quantity <> count(t.id) filter (where t.status = 'paid')))`;
}

/** posts.like_count yang tidak sama dengan jumlah baris post_likes (AC F08-3). */
async function likeMismatches(s: Sql) {
  return s<{ id: string }[]>`
    select p.id from app.posts p
    where p.like_count <> (select count(*) from app.post_likes l where l.post_id = p.id)`;
}

describe("PRD 9.2 #9 / AC F14-6, D2: akun dihapus lalu backup dipulihkan (PostgreSQL 17)", () => {
  it("ledger diterapkan ulang ke database pulihan: data terhapus tidak aktif kembali; total keuangan, penyesuaian, histori payment dan penghitung kursi sama dengan database sumber", async () => {
    const lane = inject("kapdhPg");
    const base = `postgres://${lane.user}:${lane.password}@${lane.host}:${lane.port}`;
    const rclock = new TestClock();
    const sourceStorage = new MemoryDriver();
    const seed = await createPgTestDatabase("restore_seed", 4);
    const names = { live: `${seed.name}_live`, backup: `${seed.name}_bkp` };
    const closers: (() => Promise<unknown>)[] = [];
    const open = (name: string) => {
      const handle = { name } as PgTestDatabase;
      const owner = createDb(`${base}/${name}`, { max: 4, applicationName: "kapdh-pg-test-restore" });
      const apiRole = connectAs(handle, "kapdh_app", 8);
      const workerRole = connectAs(handle, "kapdh_worker", 4);
      closers.push(
        () => owner.sql.end({ timeout: 5 }),
        () => apiRole.sql.end({ timeout: 5 }),
        () => workerRole.sql.end({ timeout: 5 }),
      );
      return { owner, apiRole, workerRole };
    };
    const apiFor = async (db: Db, appStorage: MemoryDriver) => {
      const instance = await createApp(
        {
          env: testEnv,
          db,
          mailer: new MemoryMailer(),
          clock: rclock,
          push: new FakePush(),
          storage: appStorage,
          redis: null,
        },
        { logger: false },
      );
      await instance.init();
      await instance.getHttpAdapter().getInstance().ready();
      closers.unshift(() => instance.close());
      return instance;
    };
    try {
      // 1. Data anggota lengkap (iuran lunas, refund, tiket aktif/lunas/ditinjau) lewat API sebagai kapdh_app.
      const seedApi = connectAs(seed, "kapdh_app", 8);
      const seedApp = await createApp(
        {
          env: testEnv,
          db: seedApi.db as unknown as Db,
          mailer: new MemoryMailer(),
          clock: rclock,
          push: new FakePush(),
          storage: sourceStorage,
          redis: null,
        },
        { logger: false },
      );
      await seedApp.init();
      await seedApp.getHttpAdapter().getInstance().ready();
      const rich = await createRichMember({
        app: seedApp,
        db: seed.db as unknown as Db,
        clock: rclock,
        storage: sourceStorage,
      });
      const before = await financeSnapshot(seed.sql);
      await seedApp.close();
      await seedApi.sql.end({ timeout: 5 });
      await seed.sql.end({ timeout: 5 });

      // 2. Backup harian SEBELUM permintaan penghapusan: salinan database (template) dan salinan storage berkas.
      const admin = createDb(`${base}/postgres`, { max: 1 }).sql;
      try {
        await admin.unsafe(`create database "${names.live}" template "${seed.name}"`);
        await admin.unsafe(`create database "${names.backup}" template "${seed.name}"`);
      } finally {
        await admin.end({ timeout: 5 });
      }
      const fileBackup = snapshotStorage(sourceStorage);

      // 3. Produksi berjalan: anggota menghapus akun, job (kapdh_worker) menyelesaikan penghapusan.
      const live = open(names.live);
      const liveApp = await apiFor(live.apiRole.db as unknown as Db, sourceStorage);
      const liveWorker = await startWorker(live.workerRole.db as unknown as Db, sourceStorage, rclock);
      closers.unshift(() => liveWorker.ctx.close());
      const { id, requestNumber } = await requestDeletionViaApp(
        { app: liveApp, db: live.owner.db as unknown as Db },
        rich.session,
      );
      const result = await runAsSystem(() => liveWorker.ctx.app.get(AccountDeletionProcessor).run(id), {
        jobId: `account.deletion:${uuidv7()}`,
      });
      expect(result).toMatchObject({ outcome: "completed", requestNumber });
      await expectFullyDeleted(
        { db: live.owner.db as unknown as Db, storage: sourceStorage },
        rich,
        requestNumber,
      );
      const liveAfter = await financeSnapshot(live.owner.sql);

      // 4. Bencana: database dan berkas dipulihkan dari backup; ledger terbaru dari salinan di luar backup.
      const ledgerDir = exportLedger(sourceStorage);
      const entries = readLedgerDirectory(ledgerDir);
      rmSync(ledgerDir, { recursive: true, force: true });
      expect(entries.map((e) => [e.request_number, e.state])).toEqual([[requestNumber, "completed"]]);
      const restoredStorage = await restoreStorage(fileBackup);
      const restored = open(names.backup);
      const [resurrected] = await restored.owner.sql<{ status: string }[]>`
        select status from app.users where id = ${rich.member.userId}`;
      expect(resurrected!.status, "backup memuat akun sebelum dihapus").toBe("active");
      const restoredWorker = await startWorker(
        restored.workerRole.db as unknown as Db,
        restoredStorage,
        rclock,
      );
      closers.unshift(() => restoredWorker.ctx.close());
      const summary = await runAsSystem(
        () => restoredWorker.ctx.app.get(DeletionLedgerService).reapply(entries),
        {
          jobId: `ledger-reapply:${uuidv7()}`,
        },
      );
      expect(summary).toMatchObject({
        reapplied: [requestNumber],
        failed: [],
        absent: [],
        alreadyDeleted: [],
      });
      await expectFullyDeleted(
        { db: restored.owner.db as unknown as Db, storage: restoredStorage },
        rich,
        requestNumber,
      );

      // 5. Total keuangan cocok: database pulihan = database sumber sesudah penghapusan; uang masuk tidak berubah.
      const restoredAfter = await financeSnapshot(restored.owner.sql);
      expect(restoredAfter).toEqual(liveAfter);
      expect(restoredAfter.paid).toEqual(before.paid);
      expect(await seatMismatches(live.owner.sql)).toEqual([]);
      expect(await seatMismatches(restored.owner.sql)).toEqual([]);
      expect(await likeMismatches(live.owner.sql)).toEqual([]);
      expect(await likeMismatches(restored.owner.sql)).toEqual([]);

      // Penerapan ulang kedua idempoten: tidak ada perubahan keuangan lagi.
      const again = await runAsSystem(() =>
        restoredWorker.ctx.app.get(DeletionLedgerService).reapply(entries),
      );
      expect(again).toMatchObject({ reapplied: [], alreadyDeleted: [requestNumber], failed: [] });
      expect(await financeSnapshot(restored.owner.sql)).toEqual(liveAfter);
    } finally {
      for (const close of closers) await close().catch(() => undefined);
      const cleanup = createDb(`${base}/postgres`, { max: 1 }).sql;
      try {
        for (const name of [names.live, names.backup])
          await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
      await seed.drop();
    }
  }, 240_000);
});

// ----------------------------------------------------------------------------------------------- skenario 10

describe("PRD 9.2 #10 / PRD 8.2 butir 3-4, 9.3: gerbang go-live menolak konfigurasi produksi yang belum disahkan", () => {
  // Gerbang go-live (temuan audit D4, perintah golive:check) menolak sebelum rilis. Perbaikan D4-02 melengkapinya saat
  // berjalan: nominal iuran yang belum tersimpan (versi 0) atau bertotal 0.00 juga ditolak saat instruksi iuran dibuat
  // (fail closed, test/payments/dues-configuration.e2e.test.ts dan invarian D4-02 di bawah).

  /** Perintah golive:check yang sama dengan job rilis (infra/scripts/release-job.sh): kode keluar + laporan teks. */
  async function gate(db: Db): Promise<{ code: number; out: string }> {
    const out: string[] = [];
    const code = await runGoLiveCheckCommand([], {
      db,
      now: new Date(),
      stdout: { write: (t: string) => out.push(t) },
      stderr: { write: (t: string) => out.push(t) },
    });
    return { code, out: out.join("") };
  }

  it("production dengan nominal kosong, fixture dev, atau tanpa Super Admin ber-TOTP → gerbang menolak; konfigurasi tersahkan → lolos", async () => {
    // Database production baru (migrasi + seed referensi, PRD 8.2 butir 2 dan 4), terpisah dari data skenario lain.
    const fresh = await createPgTestDatabase("c92_golive", 4);
    try {
      const db = fresh.db as unknown as Db;
      await seedReference(fresh.db);

      // Tanpa Super Admin ber-TOTP (bootstrap belum diaktifkan): ditolak.
      let result = await gate(db);
      expect(result.code).toBe(GOLIVE_EXIT.refused);
      expect(result.out).toContain("Super Admin aktif ber-TOTP: 0 dari minimal 2");

      // Seluruh konfigurasi disahkan (dua Super Admin ber-TOTP, metode bayar, legal, master, kontak): lolos.
      await approveProductionConfig(db);
      result = await gate(db);
      expect(result.code, result.out).toBe(GOLIVE_EXIT.passed);

      // Nominal kosong (baris fees hilang → API diam-diam memakai bawaan versi 0): ditolak; seed ulang memulihkan.
      await db.delete(appSettings).where(eq(appSettings.key, "fees"));
      result = await gate(db);
      expect(result.code).toBe(GOLIVE_EXIT.refused);
      expect(result.out).toContain("Nominal kosong");
      await seedReference(fresh.db);
      expect((await gate(db)).code).toBe(GOLIVE_EXIT.passed);

      // Fixture dev di database production: ditolak.
      await seedDev(fresh.db);
      result = await gate(db);
      expect(result.code).toBe(GOLIVE_EXIT.refused);
      expect(result.out).toContain("[GAGAL] Tanpa fixture dev atau data sintetis");
    } finally {
      await fresh.drop();
    }
  });
});

// ------------------------------------------------------------------------------------------- invarian akhir

describe("Invarian data sesudah seluruh skenario berkas ini (PRD 6.4, ARCHITECTURE §2.5)", () => {
  it("penghitung kursi setiap event = jumlah tiket per status; event batal 0/0 (AC F09-1); like_count = jumlah like (AC F08-3)", async () => {
    expect(await seatMismatches(sql)).toEqual([]);
    expect(await likeMismatches(sql)).toEqual([]);
  });

  it("nominal payment = jumlah baris snapshot; payment tiket = total_snapshot tiket; refund aktif tidak melebihi nominal", async () => {
    const lines = await sql<{ id: string }[]>`
      select p.id from app.payments p
      where p.amount <> coalesce(
        (select sum((line->>'amount')::numeric) from jsonb_array_elements(p.lines_snapshot) line), 0)`;
    expect(lines.map((r) => r.id)).toEqual([]);
    const tickets = await sql<{ id: string }[]>`
      select p.id from app.payments p join app.tickets t on t.id = p.ticket_id where p.amount <> t.total_snapshot`;
    expect(tickets.map((r) => r.id)).toEqual([]);
    const refunds = await sql<{ id: string }[]>`
      select p.id from app.payments p join app.payment_adjustments a on a.payment_id = p.id
      where a.kind = 'refund' and a.status <> 'cancelled'
      group by p.id, p.amount having sum(a.amount) > p.amount`;
    expect(refunds.map((r) => r.id)).toEqual([]);
  });

  it("D4-02 (PRD 8.2 butir 4, AC F17-1): setiap payment iuran memakai versi `fees` tersimpan (>= 1), nominal > 0", async () => {
    const [dues] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.payments where type in ('registration', 'renewal')`;
    expect(dues!.n).toBeGreaterThan(0);
    const unbacked = await sql<{ id: string }[]>`
      select p.id from app.payments p
      where p.type in ('registration', 'renewal')
        and (p.settings_version is null or p.settings_version < 1 or p.amount <= 0
             or p.settings_version > coalesce((select s.version from app.app_settings s where s.key = 'fees'), 0))`;
    expect(unbacked.map((r) => r.id)).toEqual([]);
  });
});
