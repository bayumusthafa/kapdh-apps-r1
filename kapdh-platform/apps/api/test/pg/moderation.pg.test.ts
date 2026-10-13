/**
 * Moderasi (F-12) di bawah konkurensi nyata PostgreSQL 17 (ARCHITECTURE §9.2; PRD 9.2 "double approval" untuk keputusan
 * moderasi). API berjalan dengan login role kapdh_app (grant production); fixture dibuat dengan koneksi pemilik.
 *
 * - Keputusan ganda: beberapa pengurus memutus laporan yang sama dengan If-Match yang sama → tepat satu keputusan
 *   (satu suspend, satu membership_event, satu audit); sisanya 409 VERSION_CONFLICT dengan detail terbaru.
 * - Banding paralel oleh pemohon yang sama → satu banding aktif (kunci users → alumni pemohon).
 * - Laporan paralel atas target yang sama → satu laporan aktif (kunci baris users pelapor).
 * - Unsuspend dari menu anggota (MembershipKernel) bersamaan dengan keputusan banding unsuspend → satu pencabutan,
 *   banding ditutup sekali, tanpa deadlock (urutan kunci users → alumni → reports yang sama).
 */
import "reflect-metadata";
import { auditLogs, membershipEvents, reports } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import type { Db } from "../../src/core/db/types.js";
import { MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, createPgTestDatabase, type PgTestDatabase, withLockWaitGate } from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
let kernel: MembershipKernel;
const clock = new TestClock();
let owner: { db: Db; clock: TestClock };

beforeAll(async () => {
  tdb = await createPgTestDatabase("moderation", 16);
  api = connectAs(tdb, "kapdh_app", 14);
  owner = { db: tdb.db as unknown as Db, clock };
  app = await createApp(
    {
      env: testEnv,
      db: api.db as unknown as Db,
      mailer: new MemoryMailer(),
      clock,
      push: new FakePush(),
      storage: new MemoryDriver(),
      redis: null,
    },
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  kernel = app.get(MembershipKernel);
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});

const http = () => httpClient(app);

async function member(status: "verified" | "suspended" = "verified") {
  const fixture = await createAlumni(owner, { status });
  return { ...fixture, token: (await signInAlumni({ app }, fixture)).accessToken };
}

async function moderator() {
  const admin = await createAdmin(owner, { permissions: ["moderation.read", "moderation.resolve"] });
  return { ...admin, token: (await signInAdmin({ app, clock }, admin)).accessToken };
}

/** Penahan memegang kunci baris lebih dulu sehingga semua peserta PASTI berebut kunci yang sama. */
async function contended<T>(lockSql: (tx: PgTestDatabase["sql"]) => Promise<unknown>, run: () => Promise<T>) {
  return withLockWaitGate(tdb, async (hold) => {
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const blocker = tdb.sql.begin(async (tx) => {
      await lockSql(tx as unknown as PgTestDatabase["sql"]);
      signalLocked();
      await hold();
    });
    await locked;
    const work = run();
    await blocker;
    return work;
  });
}

describe("Moderasi bersamaan (PostgreSQL 17)", () => {
  it("keputusan ganda: satu suspend menang, lainnya 409 VERSION_CONFLICT dengan detail terbaru", async () => {
    const reporter = await member();
    const target = await member();
    const admins = [await moderator(), await moderator()];
    const created = await http().post(
      "/reports",
      { target_type: "user", target_user_id: target.userId, category: "scam" },
      { token: reporter.token },
    );
    expect(created.statusCode, created.body).toBe(201);
    const reportId = created.json().id as string;

    const { result, lockWaitObserved } = await contended(
      (tx) => tx`select id from app.reports where id = ${reportId} for update`,
      () =>
        Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            http().post(
              `/admin/reports/${reportId}/resolve`,
              {
                action: "suspend",
                note: `Penipuan terbukti (${i}).`,
                member_message: "Akun Anda dibatasi.",
                confirm: true,
              },
              { token: admins[i % 2]!.token, headers: { "if-match": "1" } },
            ),
          ),
        ),
    );
    expect(lockWaitObserved).toBe(true);
    const statuses = result.map((res) => res.statusCode).sort();
    expect(statuses, result.map((r) => r.body).join("\n")).toEqual([200, 409, 409, 409, 409, 409]);
    for (const res of result.filter((r) => r.statusCode === 409))
      expect(res.json()).toMatchObject({
        code: "VERSION_CONFLICT",
        current: { status: "resolved", version: "2" },
      });

    const events = await tdb.db
      .select()
      .from(membershipEvents)
      .where(and(eq(membershipEvents.userId, target.userId), eq(membershipEvents.kind, "suspend")));
    expect(events).toHaveLength(1);
    const resolved = await tdb.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, reportId), eq(auditLogs.action, "moderation.report_resolved")));
    expect(resolved).toHaveLength(1);
  });

  it("banding paralel oleh pemohon yang sama → satu banding aktif", async () => {
    const appellant = await member("suspended");
    const { result, lockWaitObserved } = await contended(
      (tx) => tx`select user_id from app.alumni where user_id = ${appellant.userId} for update`,
      () =>
        // 5 = batas laju banding per 24 jam (APPEAL_RATE); semuanya mencapai transaksi.
        Promise.all(
          Array.from({ length: 5 }, () =>
            http().post(
              "/appeals",
              { description: "Mohon tinjau ulang pembatasan saya." },
              { token: appellant.token },
            ),
          ),
        ),
    );
    expect(lockWaitObserved).toBe(true);
    expect(result.map((res) => res.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(result.map((res) => res.json().id)).size).toBe(1);
    const appeals = await tdb.db
      .select()
      .from(reports)
      .where(and(eq(reports.reporterId, appellant.userId), eq(reports.category, "appeal")));
    expect(appeals).toHaveLength(1);
  });

  it("laporan paralel atas target yang sama → satu laporan aktif", async () => {
    const reporter = await member();
    const target = await member();
    const { result, lockWaitObserved } = await contended(
      (tx) => tx`select id from app.users where id = ${reporter.userId} for update`,
      () =>
        Promise.all(
          Array.from({ length: 6 }, () =>
            http().post(
              "/reports",
              { target_type: "user", target_user_id: target.userId, category: "spam" },
              { token: reporter.token },
            ),
          ),
        ),
    );
    expect(lockWaitObserved).toBe(true);
    expect(result.map((res) => res.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const rows = await tdb.db.select().from(reports).where(eq(reports.reporterId, reporter.userId));
    expect(rows).toHaveLength(1);
  });

  it("unsuspend menu anggota bersamaan dengan keputusan banding: satu pencabutan, banding ditutup sekali, tanpa deadlock", async () => {
    for (let round = 0; round < 3; round++) {
      const appellant = await member("suspended");
      const admin = await moderator();
      const appeal = await http().post(
        "/appeals",
        { description: "Mohon cabut pembatasan saya." },
        { token: appellant.token },
      );
      expect(appeal.statusCode, appeal.body).toBe(201);
      const appealId = appeal.json().id as string;

      const [viaReport, viaMenu] = await Promise.allSettled([
        http().post(
          `/admin/reports/${appealId}/resolve`,
          {
            action: "unsuspend",
            note: "Banding dikabulkan.",
            member_message: "Pembatasan dicabut.",
            confirm: true,
          },
          { token: admin.token, headers: { "if-match": "1" } },
        ),
        runAsSystem(() =>
          withTx(api.db as unknown as Db, (tx) =>
            kernel.unsuspend(tx, appellant.userId, {
              reason: "Dicabut dari menu anggota.",
              actorAdminId: null,
            }),
          ),
        ),
      ]);
      expect(viaReport.status).toBe("fulfilled");
      const reportStatus = viaReport.status === "fulfilled" ? viaReport.value.statusCode : 0;
      const menuOk = viaMenu.status === "fulfilled";
      if (!menuOk) expect((viaMenu as PromiseRejectedResult).reason).toMatchObject({ status: 400 });
      // Tepat satu jalur mencabut suspend: keputusan banding 200 XOR menu anggota berhasil (lainnya 409/400).
      expect([reportStatus === 200, menuOk].filter(Boolean), `putaran ${round}`).toHaveLength(1);
      if (!menuOk) expect(reportStatus).toBe(200);
      else expect(reportStatus).toBe(409);

      const unsuspends = await tdb.db
        .select()
        .from(membershipEvents)
        .where(and(eq(membershipEvents.userId, appellant.userId), eq(membershipEvents.kind, "unsuspend")));
      expect(unsuspends).toHaveLength(1);
      const [row] = await tdb.db.select().from(reports).where(eq(reports.id, appealId));
      expect(row).toMatchObject({ status: "resolved", action: "unsuspend" });
      const closings = await tdb.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, appealId), eq(auditLogs.action, "moderation.report_resolved")));
      expect(closings).toHaveLength(1);
    }
  });
});
