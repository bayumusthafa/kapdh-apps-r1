/**
 * Penghapusan akun (F-14) pada PostgreSQL 17 nyata dengan login role production (infra/db/roles.sql):
 * - API sebagai kapdh_app, job sebagai kapdh_worker. Anonimisasi audit dan histori payment yang append-only hanya
 *   lolos lewat `SET LOCAL ROLE kapdh_audit_purge` di dalam transaksi langkah audit (kapdh_worker anggota INHERIT
 *   FALSE, SET TRUE); tanpa SET ROLE worker tetap ditolak (AC F14-4, F-17, D2).
 * - Dua worker mengeksekusi permintaan yang sama bersamaan: klaim bersyarat membuat tepat satu yang berjalan, kursi
 *   dan pembatalan tidak dihitung ulang (AC F14-2).
 * - Dua perangkat meminta penghapusan bersamaan: satu permintaan terbuka (baris users terkunci,
 *   account_deletions_user_id_open_key; AC F14-1).
 * Jalur PGlite (superuser) memakai role kapdh_audit_purge buatan uji dengan grant yang sama (test/account/support.ts).
 */
import "reflect-metadata";
import type { WorkerEnv } from "@kapdh/config";
import { accountDeletions, auditLogs, paymentEvents } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import type { Db } from "../../src/core/db/types.js";
import { createRootLogger } from "../../src/core/logging/logger.js";
import { AccountDeletionProcessor } from "../../src/modules/account/deletion-processor.js";
import { createWorkerContext, type WorkerContext } from "../../src/worker.js";
import { expectFullyDeleted } from "../account/expect-deleted.js";
import { createRichMember, reauthHeader, requestDeletionViaApp } from "../account/support.js";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, createPgTestDatabase, type PgTestDatabase, pgError } from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
const workers: { conn: ReturnType<typeof connectAs>; ctx: WorkerContext }[] = [];
let app: NestFastifyApplication;
const clock = new TestClock();
const storage = new MemoryDriver();
const mailer = new MemoryMailer();
let fixtures: { app: NestFastifyApplication; db: Db; clock: TestClock; storage: MemoryDriver };

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
  tdb = await createPgTestDatabase("account_deletion", 6);
  api = connectAs(tdb, "kapdh_app", 8);
  app = await createApp(
    { env: testEnv, db: api.db as unknown as Db, mailer, clock, push: new FakePush(), storage, redis: null },
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  // Dua proses worker terpisah (pool kapdh_worker masing-masing), seperti dua replika apps/worker.
  for (let i = 0; i < 2; i++) {
    const conn = connectAs(tdb, "kapdh_worker", 4);
    const ctx = await createWorkerContext(
      {
        env: workerEnv(),
        db: conn.db as unknown as Db,
        mailer,
        clock,
        push: new FakePush(),
        storage,
        redis: null,
      },
      { logger: createRootLogger({ level: "silent", service: "kapdh-worker" }) },
    );
    workers.push({ conn, ctx });
  }
  // Fixture ditulis pemilik database (superuser); API dan job memakai role production.
  fixtures = { app, db: tdb.db as unknown as Db, clock, storage };
});
afterAll(async () => {
  for (const worker of workers) {
    await worker.ctx.close();
    await worker.conn.sql.end({ timeout: 5 });
  }
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});

const runOn = (index: number, deletionId: string) =>
  runAsSystem(() => workers[index]!.ctx.app.get(AccountDeletionProcessor).run(deletionId), {
    jobId: `account.deletion:${uuidv7()}`,
  });

describe("F-14 pada PostgreSQL 17 dengan role production", () => {
  it("AC F14-3, AC F14-4: job sebagai kapdh_worker menghapus/menganonimkan setiap tabel; audit lewat SET LOCAL ROLE kapdh_audit_purge; tanpa SET ROLE tetap append-only", async () => {
    const rich = await createRichMember(fixtures);
    const { id, requestNumber } = await requestDeletionViaApp(fixtures, rich.session);
    const result = await runOn(0, id);
    const [state] = await tdb.db.select().from(accountDeletions).where(eq(accountDeletions.id, id));
    expect(result, `last_error: ${state?.lastError}`).toEqual({ outcome: "completed", requestNumber });
    await expectFullyDeleted(fixtures, rich, requestNumber);

    // Peran sesi kembali ke kapdh_worker sesudah transaksi langkah audit (SET LOCAL).
    const [who] = await workers[0]!.conn.sql<{ role: string }[]>`select current_user as role`;
    expect(who!.role).toBe("kapdh_worker");
    // Tanpa SET ROLE, worker tidak dapat mengubah audit maupun histori payment (grant + trigger append-only).
    const error = await workers[0]!.conn
      .sql`update app.audit_logs set reason = null where id = ${rich.auditIds.adminOnPayment}`.then(
      () => null,
      (e: unknown) => pgError(e),
    );
    expect(error?.code).toBe("42501");
    const eventError = await workers[0]!.conn
      .sql`update app.payment_events set reason = null where payment_id = ${rich.payments.registration}`.then(
      () => null,
      (e: unknown) => pgError(e),
    );
    expect(eventError?.code).toBe("42501");
    // Aplikasi API (kapdh_app) bahkan tidak dapat berpindah ke role purge.
    const setRole = await api.sql
      .begin(async (tx) => tx`set local role kapdh_audit_purge`)
      .then(
        () => null,
        (e: unknown) => pgError(e),
      );
    expect(setRole?.code).toBe("42501");

    const [memberAudit] = await tdb.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.id, rich.auditIds.memberActor));
    expect(memberAudit).toMatchObject({ actorUserId: null, reason: null });
    const events = await tdb.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.actorUserId, rich.member.userId));
    expect(events).toEqual([]);
  });

  it("AC F14-2: dua worker menjalankan permintaan yang sama bersamaan → tepat satu klaim; kursi, pembatalan dan pesan sistem tidak dihitung ulang", async () => {
    const rich = await createRichMember(fixtures);
    const { id, requestNumber } = await requestDeletionViaApp(fixtures, rich.session);
    const results = await Promise.all([runOn(0, id), runOn(1, id)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["completed", "skipped"]);
    const [row] = await tdb.db.select().from(accountDeletions).where(eq(accountDeletions.id, id));
    expect(row).toMatchObject({ status: "completed", attempts: 1 });
    await expectFullyDeleted(fixtures, rich, requestNumber);
  });

  it("AC F14-1: dua perangkat meminta penghapusan bersamaan → satu permintaan terbuka; setiap respons 202 membawa nomor yang sama", async () => {
    const member = await createAlumni(fixtures, { status: "verified" });
    const sessions = [await signInAlumni(fixtures, member), await signInAlumni(fixtures, member)];
    const client = httpClient(app);
    const disclosure = await client.get("/me/deletion/disclosure", { token: sessions[0]!.accessToken });
    const body = { confirm: true, acknowledged_disclosure_version: disclosure.json().version };
    const headers = await Promise.all(sessions.map((s) => reauthHeader(fixtures, s.accessToken)));
    const responses = await Promise.all(
      sessions.map((s, i) =>
        client.post("/me/deletion", body, { token: s.accessToken, headers: headers[i] }),
      ),
    );
    for (const res of responses) expect([202, 401], res.body).toContain(res.statusCode);
    const accepted = responses.filter((r) => r.statusCode === 202).map((r) => r.json().request_number);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    expect(new Set(accepted).size).toBe(1);
    const rows = await tdb.db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.userId, member.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestNumber).toBe(accepted[0]);
  });
});
