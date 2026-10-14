/**
 * AC F16-2 lewat API pada PostgreSQL 17 nyata (PRD 9.2 "last Super Admin concurrent demotion"): dua Super Admin
 * saling menurunkan/menonaktifkan/memulihkan pada request bersamaan. Penjaga transaksi admins_last_super_admin_chk
 * (advisory lock + hitungan Super Admin yang dapat login) memastikan minimal satu tersisa; pihak yang kalah menerima
 * 409 VALIDATION_ERROR dengan `current`, tanpa 500, tanpa deadlock, dan tanpa audit dari transaksi yang batal
 * (AC F17-1). Juga dua undangan bersamaan untuk alumni yang sama (kontrak C7 adminInviteAdmin, AC F16-1) dan job
 * ekspor audit ganda (AC F17-4). API berjalan dengan login role kapdh_app (grant production).
 */
import "reflect-metadata";
import { admins, auditLogs, createDb, files, sessions } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, inArray } from "drizzle-orm";
import { decodeJwt } from "jose";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { ADVISORY_LOCK_NAMESPACES } from "../../src/core/db/locks.js";
import type { Db } from "../../src/core/db/types.js";
import { TokenService } from "../../src/core/identity/token.service.js";
import { MemoryRateLimitStore } from "../../src/core/rate-limit/store.js";
import { AuditExportJob } from "../../src/modules/admin/audit-export.job.js";
import { createWorkerContext } from "../../src/worker.js";
import { createAdmin, createAlumni, type EnrolledAdminFixture, signInAdmin } from "../support/factories.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, createPgTestDatabase, type PgTestDatabase, sleep } from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
const clock = new TestClock();
const storage = new MemoryDriver();
let owner: { db: Db; clock: TestClock };

beforeAll(async () => {
  tdb = await createPgTestDatabase("admin_governance", 8);
  api = connectAs(tdb, "kapdh_app", 12);
  owner = { db: tdb.db as unknown as Db, clock };
  app = await createApp(
    {
      env: testEnv,
      db: api.db as unknown as Db,
      mailer: new MemoryMailer(),
      clock,
      push: new FakePush(),
      storage,
      redis: null,
    },
    { logger: false, rateLimitStore: new MemoryRateLimitStore() },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});

interface Actor {
  admin: EnrolledAdminFixture;
  token: string;
  familyId: string;
}

async function superAdmin(): Promise<Actor> {
  const admin = await createAdmin(owner, { role: "super_admin" });
  const session = await signInAdmin({ app, clock }, admin);
  const [row] = await tdb.db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.id, String(decodeJwt(session.accessToken).sid)));
  return { admin, token: session.accessToken, familyId: row!.familyId };
}

async function headers(actor: Actor, targetAdminId: string): Promise<Record<string, string>> {
  const [row] = await tdb.db
    .select({ version: admins.version })
    .from(admins)
    .where(eq(admins.id, targetAdminId));
  const reauth = await app
    .get(TokenService)
    .signReauth({ userId: actor.admin.userId, familyId: actor.familyId, level: 2 });
  return {
    authorization: `Bearer ${actor.token}`,
    "x-reauth-token": reauth.token,
    "if-match": String(row!.version),
    "idempotency-key": uuidv7(),
  };
}

type Move = "demote" | "disable" | "recover";

async function request(actor: Actor, target: Actor, move: Move) {
  const h = await headers(actor, target.admin.adminId);
  const base = `/api/v1/admin/admins/${target.admin.adminId}`;
  switch (move) {
    case "demote":
      return {
        h,
        run: () =>
          app.inject({ method: "PATCH", url: base, headers: h, payload: { role: "admin", permissions: [] } }),
      };
    case "disable":
      return {
        h,
        run: () =>
          app.inject({
            method: "PATCH",
            url: base,
            headers: h,
            payload: { status: "disabled", reason: "Uji balapan" },
          }),
      };
    case "recover":
      return {
        h,
        run: () =>
          app.inject({
            method: "POST",
            url: `${base}/recovery`,
            headers: h,
            payload: { reason: "Uji balapan pemulihan" },
          }),
      };
  }
}

/** Super Admin yang dapat login: admins super_admin + active dan akun users active (PRD 3.14). */
async function usableSuperAdmins(): Promise<string[]> {
  const rows = await tdb.sql<{ id: string }[]>`
    select a.id from app.admins a join app.users u on u.id = a.user_id
    where a.role = 'super_admin' and a.status = 'active' and u.status = 'active'`;
  return rows.map((r) => r.id);
}

/** Menyisakan hanya `keep` sebagai Super Admin aktif (demosi langsung yang sah karena mereka tetap ada). */
async function onlyKeep(keep: string[]): Promise<void> {
  const others = (await usableSuperAdmins()).filter((id) => !keep.includes(id));
  if (others.length > 0) await tdb.db.update(admins).set({ role: "admin" }).where(inArray(admins.id, others));
}

/** Kunci advisory penjaga Super Admin terakhir (migrasi 0002, ARCHITECTURE §9.2). */
const SUPER_ADMIN_GUARD_LOCK = 4711000518;

/**
 * Bukti konkurensi deterministik: uji memegang kunci advisory penjaga, menembakkan request, menunggu sampai `waiters`
 * transaksi API benar-benar menunggu kunci (keduanya sudah lolos AuthGuard; yang pertama menunggu kunci penjaga di dalam
 * trigger, yang lain menunggu kunci penjaga atau baris target yang sama), lalu melepasnya sehingga keduanya bersaing pada
 * penjaga transaksi yang sama.
 */
async function raceOnGuard<T>(
  fire: () => Promise<T>,
  waiters: number,
): Promise<{ result: T; waiting: number }> {
  const holder = createDb(tdb.url, { max: 1, applicationName: "kapdh-pg-test-guard-holder" }).sql;
  try {
    await holder`select pg_advisory_lock(${SUPER_ADMIN_GUARD_LOCK})`;
    const pending = fire();
    let waiting = 0;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [row] = await holder<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`;
      waiting = row?.n ?? 0;
      if (waiting >= waiters) break;
      await sleep(5);
    }
    await holder`select pg_advisory_unlock(${SUPER_ADMIN_GUARD_LOCK})`;
    return { result: await pending, waiting };
  } finally {
    await holder.end({ timeout: 5 });
  }
}

const AUDIT_ACTION: Record<Move, string> = {
  demote: "admin.updated",
  disable: "admin.updated",
  recover: "admin.recovery_initiated",
};

describe("AC F16-2: dua Super Admin terakhir saling menurunkan lewat API secara bersamaan", () => {
  it.each<[Move, Move]>([
    ["demote", "demote"],
    ["disable", "disable"],
    ["demote", "disable"],
    ["recover", "demote"],
    ["disable", "recover"],
  ])(
    "AC F16-2: %s vs %s: tepat satu berhasil, yang lain 409 dengan current, satu Super Admin tersisa",
    async (m1, m2) => {
      for (let round = 0; round < 3; round++) {
        const a = await superAdmin();
        const b = await superAdmin();
        await onlyKeep([a.admin.adminId, b.admin.adminId]);
        expect((await usableSuperAdmins()).sort()).toEqual([a.admin.adminId, b.admin.adminId].sort());

        const first = await request(a, b, m1);
        const second = await request(b, a, m2);
        const { result: responses, waiting } = await raceOnGuard(
          () => Promise.all([first.run(), second.run()]),
          2,
        );
        // Kedua transaksi API menunggu penjaga yang sama secara bersamaan (bukan berurutan).
        expect(waiting).toBe(2);
        const statuses = responses.map((r) => r.statusCode).sort();
        expect(statuses, responses.map((r) => r.body).join("\n")).toEqual([200, 409]);
        const loserIndex = responses.findIndex((r) => r.statusCode === 409);
        const loser = responses[loserIndex]!;
        const body = loser.json() as {
          code: string;
          field_errors: Record<string, string[]>;
          current: { id: string };
        };
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(Object.keys(body.field_errors).some((k) => k === "role" || k === "status")).toBe(true);
        const loserTarget = loserIndex === 0 ? b : a;
        expect(body.current.id).toBe(loserTarget.admin.adminId);

        const remaining = await usableSuperAdmins();
        expect(remaining).toHaveLength(1);
        // Pemenang menulis tepat satu audit; transaksi yang batal tidak meninggalkan audit (AC F17-1).
        const moves = [m1, m2];
        const targets = [b, a];
        for (const [index, target] of targets.entries()) {
          const rows = await tdb.db
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.entityId, target.admin.adminId),
                eq(auditLogs.action, AUDIT_ACTION[moves[index]!]),
              ),
            );
          expect(rows, `audit ${moves[index]} -> ${index}`).toHaveLength(index === loserIndex ? 0 : 1);
        }
        // Target yang kalah tidak berubah (versi sama).
        const [untouched] = await tdb.db
          .select()
          .from(admins)
          .where(eq(admins.id, loserTarget.admin.adminId));
        expect(untouched).toMatchObject({ role: "super_admin", status: "active" });
      }
    },
  );

  it("AC F16-2: hanya satu Super Admin aktif; dua request bersamaan menurunkan/menonaktifkan dirinya sendiri: keduanya 409", async () => {
    const solo = await superAdmin();
    await onlyKeep([solo.admin.adminId]);
    const demote = await request(solo, solo, "demote");
    const disable = await request(solo, solo, "disable");
    const { result: responses, waiting } = await raceOnGuard(
      () => Promise.all([demote.run(), disable.run()]),
      2,
    );
    expect(waiting).toBe(2);
    expect(responses.map((r) => r.statusCode)).toEqual([409, 409]);
    for (const res of responses) expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await usableSuperAdmins()).toEqual([solo.admin.adminId]);
  });
});

describe("AC F16-1 (kontrak C7 adminInviteAdmin): dua undangan bersamaan berebut alumni yang sama", () => {
  it("AC F16-1: tepat satu 201; yang lain 409 VALIDATION_ERROR pada alumni_user_id (bukan email); satu identitas admin tertaut", async () => {
    const root = await superAdmin();
    const member = await createAlumni(owner, { status: "verified", fullName: "Alumni Rebutan" });
    const inviteRequest = async () => {
      const reauth = await app
        .get(TokenService)
        .signReauth({ userId: root.admin.userId, familyId: root.familyId, level: 2 });
      const headers = {
        authorization: `Bearer ${root.token}`,
        "x-reauth-token": reauth.token,
        "idempotency-key": uuidv7(),
      };
      // Email login tidak dikirim: keduanya memakai email alumni sebagai bawaan (alur "Delegasi User jadi Admin").
      return () =>
        app.inject({
          method: "POST",
          url: "/api/v1/admin/admins",
          headers,
          payload: { alumni_user_id: member.userId, role: "admin", permissions: ["audit.read"] },
        });
    };
    const first = await inviteRequest();
    const second = await inviteRequest();

    // Uji memegang kunci baris akun alumni sampai KEDUA transaksi undangan menunggunya, lalu melepasnya, sehingga
    // keduanya benar-benar bersaing (bukan berurutan karena kebetulan).
    const holder = createDb(tdb.url, { max: 1, applicationName: "kapdh-pg-test-alumni-holder" }).sql;
    let waiting = 0;
    let pending!: Promise<Awaited<ReturnType<typeof first>>[]>;
    try {
      await holder.begin(async (tx) => {
        await tx`select id from app.users where id = ${member.userId} for update`;
        pending = Promise.all([first(), second()]);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          // Koneksi lain (snapshot pg_stat_activity di dalam transaksi tidak diperbarui).
          const [row] = await tdb.sql<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`;
          waiting = row?.n ?? 0;
          if (waiting >= 2) break;
          await sleep(5);
        }
      });
    } finally {
      await holder.end({ timeout: 5 });
    }
    const responses = await pending;
    expect(waiting).toBe(2);
    expect(responses.map((r) => r.statusCode).sort(), responses.map((r) => r.body).join("\n")).toEqual([
      201, 409,
    ]);
    const loser = responses.find((r) => r.statusCode === 409)!.json() as {
      code: string;
      field_errors: Record<string, string[]>;
    };
    expect(loser.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(loser.field_errors)).toEqual(["alumni_user_id"]);

    const linked = await tdb.db.select().from(admins).where(eq(admins.linkedAlumniUserId, member.userId));
    expect(linked).toHaveLength(1);
    const logins = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from app.users where kind = 'admin' and email = ${member.email}`;
    expect(logins[0]!.n).toBe(1);
    // Hanya transaksi pemenang yang meninggalkan audit (AC F17-1).
    const invited = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from app.audit_logs
      where action = 'admin.invited' and after ->> 'linked_alumni_user_id' = ${member.userId}`;
    expect(invited[0]!.n).toBe(1);
  });
});

describe("AC F17-4 (kontrak C7 AuditExport): job ekspor ganda bersamaan menulis tepat satu entri terminal dan satu berkas", () => {
  it("AC F17-4: dua eksekusi worker (role kapdh_worker) atas ekspor yang sama: satu completed, satu berhenti tanpa berkas", async () => {
    const requester = await createAdmin(owner, { permissions: ["audit.read", "audit.export"] });
    const session = await signInAdmin({ app, clock }, requester);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/audit/exports",
      headers: { authorization: `Bearer ${session.accessToken}`, "idempotency-key": uuidv7() },
      payload: { entity_type: "admin" },
    });
    expect(created.statusCode, created.body).toBe(202);
    const exportId = created.json().id as string;

    const workerDb = connectAs(tdb, "kapdh_worker", 6);
    const worker = await createWorkerContext({
      env: {
        NODE_ENV: "test",
        DATABASE_URL: tdb.url,
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
      },
      db: workerDb.db as unknown as Db,
      mailer: new MemoryMailer(),
      clock,
      push: new FakePush(),
      storage,
      redis: null,
    });
    const holder = createDb(tdb.url, { max: 1, applicationName: "kapdh-pg-test-export-holder" }).sql;
    try {
      const job = worker.app.get(AuditExportJob);
      const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;
      const run = () =>
        runAsSystem(() =>
          job.handle(
            {
              id: uuidv7(),
              topic: "audit.export.requested",
              dedupKey: `audit.export.requested:${exportId}`,
              attempts: 1,
              requestId: null,
              payload: { export_id: exportId, admin_id: requester.adminId },
            },
            { jobId: "uji", requestId: "uji", logger },
          ),
        );
      // Kunci per ekspor dipegang uji sampai kedua eksekusi menunggunya, lalu dilepas (bukti konkurensi).
      await holder`select pg_advisory_lock(${ADVISORY_LOCK_NAMESPACES.auditExport}::int4, hashtext(${exportId}))`;
      const both = Promise.all([run(), run()]);
      let waiting = 0;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && waiting < 2) {
        const [row] = await holder<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        waiting = row?.n ?? 0;
        if (waiting < 2) await sleep(5);
      }
      await holder`select pg_advisory_unlock(${ADVISORY_LOCK_NAMESPACES.auditExport}::int4, hashtext(${exportId}))`;
      await both;
      expect(waiting).toBe(2);

      const terminal = await tdb.db
        .select({ action: auditLogs.action, after: auditLogs.after })
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, "audit_export"), eq(auditLogs.entityId, exportId)));
      const completed = terminal.filter((r) => r.action === "audit.export.completed");
      expect(completed).toHaveLength(1);
      expect(terminal.filter((r) => r.action === "audit.export.failed")).toHaveLength(0);
      const exportFiles = await tdb.db
        .select()
        .from(files)
        .where(and(eq(files.purpose, "audit_export"), eq(files.ownerUserId, requester.userId)));
      expect(exportFiles).toHaveLength(1);
      expect(exportFiles[0]!.id).toBe((completed[0]!.after as { file_id: string }).file_id);
      // Tidak ada objek storage yatim dari eksekusi yang kalah.
      expect(storage.keys().filter((key) => key.includes("audit_export"))).toEqual([
        exportFiles[0]!.objectKey,
      ]);
    } finally {
      await holder.end({ timeout: 5 });
      await worker.close();
      await workerDb.sql.end({ timeout: 5 });
    }
  });
});
