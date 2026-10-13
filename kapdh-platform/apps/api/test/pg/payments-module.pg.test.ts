/**
 * Modul payments pada PostgreSQL 17 nyata (PRD 9.2, ARCHITECTURE §9.2; AC F04-3, F04-4, F04-5, F03-1, PRD 3.3):
 * API berjalan sebagai role kapdh_app dengan pool sungguhan sehingga request HTTP benar-benar bersamaan. Setiap skenario
 * memaksa persaingan kunci secara deterministik: transaksi penahan memegang baris yang dikunci jalur produksi lebih dulu,
 * request dilepas setelah probe melihat jumlah penunggu kunci yang diharapkan.
 */
import "reflect-metadata";
import { createDb } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import {
  createAdmin,
  createAlumni,
  createPaymentMethod,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, createPgTestDatabase, type PgTestDatabase, sleep, type Sql } from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
let clock: TestClock;
let sql: Sql;
let probe: Sql;
let fx: { db: Db; clock: TestClock; app: NestFastifyApplication };

beforeAll(async () => {
  tdb = await createPgTestDatabase("payments_module", 6);
  sql = tdb.sql;
  api = connectAs(tdb, "kapdh_app", 16);
  clock = new TestClock();
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
  fx = { db: tdb.db as unknown as Db, clock, app };
  probe = createDb(tdb.url, { max: 1, applicationName: "kapdh-pg-probe" }).sql;
});
afterAll(async () => {
  await app?.close();
  await probe?.end({ timeout: 5 });
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});

const http = () => httpClient(app);

/** Menunggu sampai minimal `n` backend database ini menunggu kunci (bukti persaingan sungguhan). */
async function waitForLockWaiters(n: number, timeoutMs = 15_000): Promise<boolean> {
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

/**
 * Menahan kunci `lockSql` pada transaksi tersendiri, menjalankan `fire` (request bersamaan), menunggu `waiters`
 * penunggu, lalu commit. Mengembalikan hasil request dan apakah penantian benar-benar teramati.
 */
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

async function member(status: "unverified" | "expiring" = "unverified") {
  const fixture = await createAlumni(fx, { status });
  const session = await signInAlumni(fx, fixture);
  return { userId: fixture.userId, token: session.accessToken };
}

async function admin() {
  const fixture = await createAdmin(fx, { permissions: ["payments.read", "payments.decide"] });
  return { adminId: fixture.adminId, token: (await signInAdmin(fx, fixture)).accessToken };
}

async function proofFor(token: string): Promise<string> {
  return (await uploadTestFile(fx, token, "payment_proof")).id;
}

/** Instruksi registration berbukti versi 1 lewat API. */
async function reviewable(owner: { token: string }) {
  const methodId = (await createPaymentMethod(fx)).id;
  const created = await http().post(
    "/me/payments",
    { type: "registration", payment_method_id: methodId },
    { token: owner.token },
  );
  expect(created.statusCode, created.body).toBe(201);
  const proofed = await http().put(
    `/me/payments/${created.json().id}/proof`,
    { file_id: await proofFor(owner.token), expected_proof_version: 0 },
    { token: owner.token },
  );
  expect(proofed.statusCode, proofed.body).toBe(200);
  return { id: proofed.json().id as string, version: proofed.json().version as string };
}

const approve = (payment: { version: string }) => ({
  decision: "approve",
  expected_proof_version: 1,
  expected_version: payment.version,
  funds_verified: true,
});

async function count(query: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await query;
  return row!.n;
}

describe("AC F04-3 / PRD 9.2: dua pengurus menyetujui payment yang sama bersamaan (PostgreSQL 17)", () => {
  it("hanya satu keputusan berlaku; yang lain 409 PAYMENT_STATE_CONFLICT dengan status terbaru; satu periode keanggotaan", async () => {
    const owner = await member();
    const payment = await reviewable(owner);
    const [first, second] = [await admin(), await admin()];
    const { results, observed } = await underLock(
      (tx) => tx`select id from app.users where id = ${owner.userId} for update`,
      2,
      () =>
        [first, second].map((who) =>
          http().post(`/admin/payments/${payment.id}/decision`, approve(payment), { token: who.token }),
        ),
    );
    expect(observed, "kedua keputusan benar-benar menunggu kunci").toBe(true);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409)!.json();
    expect(loser).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
      current: { id: payment.id, status: "paid" },
    });
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.membership_events where payment_id = ${payment.id}`),
    ).toBe(1);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.payment_events where payment_id = ${payment.id} and kind = 'approved'`),
    ).toBe(1);
    const [alumni] = await sql<{ expires_at: Date | string }[]>`
      select expires_at from app.alumni where user_id = ${owner.userId}`;
    expect(alumni!.expires_at).not.toBeNull();
  });
});

describe("AC F04-4 / PRD 9.2: bukti diganti saat pengurus memutus (PostgreSQL 17)", () => {
  it("penggantian bukti mendapat kunci lebih dulu → keputusan atas versi lama ditolak 409 PROOF_VERSION_CONFLICT", async () => {
    const owner = await member();
    const payment = await reviewable(owner);
    const decider = await admin();
    const replacement = await proofFor(owner.token);
    const { results, observed } = await underLock(
      (tx) => tx`select id from app.payments where id = ${payment.id} for update`,
      2,
      () => {
        const replace = http().put(
          `/me/payments/${payment.id}/proof`,
          { file_id: replacement, expected_proof_version: 1 },
          { token: owner.token },
        );
        // Keputusan dikirim setelah penggantian sudah antre di kunci payment (urutan antrean baris = FIFO).
        const decision = waitForLockWaiters(1).then(() =>
          http().post(`/admin/payments/${payment.id}/decision`, approve(payment), { token: decider.token }),
        );
        return [replace, decision];
      },
    );
    expect(observed).toBe(true);
    const [replaced, decided] = results;
    expect(replaced!.statusCode, replaced!.body).toBe(200);
    expect(replaced!.json().proof_version).toBe(2);
    expect(decided!.json()).toMatchObject({
      code: "PROOF_VERSION_CONFLICT",
      current: { proof_version: 2, status: "pending", proof: { file_id: replacement } },
    });
    const [row] = await sql<{ status: string; proof_version: number }[]>`
      select status, proof_version from app.payments where id = ${payment.id}`;
    expect(row).toEqual({ status: "pending", proof_version: 2 });
  });

  it("keputusan mendapat kunci lebih dulu → penggantian bukti ditolak 409 PAYMENT_STATE_CONFLICT; paid tidak berubah", async () => {
    const owner = await member();
    const payment = await reviewable(owner);
    const decider = await admin();
    const replacement = await proofFor(owner.token);
    const { results, observed } = await underLock(
      (tx) => tx`select id from app.payments where id = ${payment.id} for update`,
      2,
      () => {
        const decision = http().post(`/admin/payments/${payment.id}/decision`, approve(payment), {
          token: decider.token,
        });
        const replace = waitForLockWaiters(1).then(() =>
          http().put(
            `/me/payments/${payment.id}/proof`,
            { file_id: replacement, expected_proof_version: 1 },
            { token: owner.token },
          ),
        );
        return [decision, replace];
      },
    );
    expect(observed).toBe(true);
    const [decided, replaced] = results;
    expect(decided!.statusCode, decided!.body).toBe(200);
    expect(replaced!.json()).toMatchObject({ code: "PAYMENT_STATE_CONFLICT", current: { status: "paid" } });
    const [row] = await sql<{ status: string; proof_version: number }[]>`
      select status, proof_version from app.payments where id = ${payment.id}`;
    expect(row).toEqual({ status: "paid", proof_version: 1 });
  });
});

describe("PRD 3.3 / AC F03-1: instruksi iuran bersamaan (PostgreSQL 17)", () => {
  it("permintaan bersamaan anggota yang sama menghasilkan satu payment: satu 201, sisanya 200 dengan id yang sama", async () => {
    const owner = await member();
    const methodId = (await createPaymentMethod(fx)).id;
    const { results, observed } = await underLock(
      (tx) => tx`select id from app.users where id = ${owner.userId} for update`,
      3,
      () =>
        Array.from({ length: 5 }, () =>
          http().post(
            "/me/payments",
            { type: "registration", payment_method_id: methodId },
            { token: owner.token },
          ),
        ),
    );
    expect(observed).toBe(true);
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.payments where user_id = ${owner.userId}`),
    ).toBe(1);
  });
});

describe("AC F04-5 / PRD 9.2: persetujuan idempoten saat diulang bersamaan (PostgreSQL 17)", () => {
  it("Idempotency-Key sama diulang bersamaan: satu eksekusi, ulangan memutar hasil pertama, keanggotaan diperpanjang sekali", async () => {
    const owner = await member("expiring");
    const methodId = (await createPaymentMethod(fx)).id;
    const created = await http().post(
      "/me/payments",
      { type: "renewal", payment_method_id: methodId },
      { token: owner.token },
    );
    const proofed = await http().put(
      `/me/payments/${created.json().id}/proof`,
      { file_id: await proofFor(owner.token), expected_proof_version: 0 },
      { token: owner.token },
    );
    const payment = { id: proofed.json().id as string, version: proofed.json().version as string };
    const [before] = await sql<{ expires_at: Date | string }[]>`
      select expires_at from app.alumni where user_id = ${owner.userId}`;
    const decider = await admin();
    const key = uuidv7();
    const send = () =>
      http().post(`/admin/payments/${payment.id}/decision`, approve(payment), {
        token: decider.token,
        headers: { "idempotency-key": key },
      });
    const concurrent = await Promise.all(Array.from({ length: 4 }, send));
    const executed = concurrent.filter(
      (r) => r.statusCode === 200 && r.headers["idempotent-replayed"] !== "true",
    );
    expect(executed).toHaveLength(1);
    for (const res of concurrent.filter((r) => r !== executed[0]))
      expect(
        res.statusCode === 200 ? res.headers["idempotent-replayed"] : res.json().code,
        res.body,
      ).toBeOneOf(["true", "IDEMPOTENCY_CONFLICT"]);
    const replay = await send();
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(executed[0]!.json());
    const retry = await http().post(`/admin/payments/${payment.id}/decision`, approve(payment), {
      token: decider.token,
    });
    expect(retry.json().code).toBe("PAYMENT_STATE_CONFLICT");
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.membership_events where payment_id = ${payment.id}`),
    ).toBe(1);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.notifications
        where user_id = ${owner.userId} and data->>'payment_id' = ${payment.id}`),
    ).toBe(1);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.audit_logs where entity_id = ${payment.id} and action = 'payment.approved'`),
    ).toBe(1);
    const [after] = await sql<{ expires_at: Date | string }[]>`
      select expires_at from app.alumni where user_id = ${owner.userId}`;
    // Renewal saat expiring: masa baru dimulai dari expires_at lama (AC F07-1), hanya sekali.
    expect(new Date(after!.expires_at).getTime()).toBeGreaterThan(new Date(before!.expires_at).getTime());
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.membership_events where user_id = ${owner.userId}`),
    ).toBe(1);
  });
});
