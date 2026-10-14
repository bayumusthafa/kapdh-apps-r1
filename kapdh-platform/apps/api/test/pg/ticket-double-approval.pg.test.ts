/**
 * Audit traceability D2 (PRD 9.2 skenario 2, AC F04-3, AC F09-1): "Dua admin menyetujui bukti yang sama; hanya satu
 * periode ATAU TIKET aktif tercipta." Jalur iuran sudah dibuktikan di payments-module.pg.test.ts; berkas ini membuktikan
 * jalur tiket pada PostgreSQL 17 nyata (role kapdh_app, pool sungguhan). Persaingan dipaksa deterministik: transaksi
 * penahan memegang baris event (kunci pertama jalur keputusan tiket: event → tiket → payment, PRD 6.4), kedua keputusan
 * dilepas setelah probe melihat keduanya menunggu kunci.
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

const HOUR = 3600_000;
const DAY = 24 * HOUR;

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
let clock: TestClock;
let sql: Sql;
let probe: Sql;
let fx: { db: Db; clock: TestClock; app: NestFastifyApplication };

beforeAll(async () => {
  tdb = await createPgTestDatabase("ticket_double_approval", 6);
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

async function count(query: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await query;
  return row!.n;
}

describe("PRD 9.2 / AC F04-3: dua pengurus menyetujui bukti tiket yang sama bersamaan (PostgreSQL 17)", () => {
  it("PRD 9.2: tepat satu keputusan berlaku; yang lain 409 PAYMENT_STATE_CONFLICT; satu tiket paid, satu QR, kursi paid 1 dan held 0", async () => {
    const eventId = uuidv7();
    const now = clock.now().getTime();
    const startsAt = new Date(now + 10 * DAY);
    await sql`
      insert into app.events (id, title, starts_at, ends_at, registration_opens_at, registration_closes_at, price,
                              seats_total, status, created_at, updated_at)
      values (${eventId}, 'Event PG Persetujuan Ganda', ${startsAt.toISOString()},
              ${new Date(startsAt.getTime() + 4 * HOUR).toISOString()}, ${new Date(now - DAY).toISOString()},
              ${new Date(startsAt.getTime() - 30 * 60_000).toISOString()}, '75000.00', 5, 'open', now(), now())`;
    const fixture = await createAlumni(fx, { status: "verified" });
    const owner = { userId: fixture.userId, token: (await signInAlumni(fx, fixture)).accessToken };
    const methodId = (await createPaymentMethod(fx)).id;
    const reserved = await http().post(
      `/events/${eventId}/reservations`,
      { expected_price: "75000.00", payment_method_id: methodId },
      { token: owner.token },
    );
    expect(reserved.statusCode, reserved.body).toBe(201);
    const ticket = reserved.json() as { id: string; payment: { id: string } };
    const proof = await uploadTestFile(fx, owner.token, "payment_proof");
    const proofed = await http().put(
      `/me/payments/${ticket.payment.id}/proof`,
      { file_id: proof.id, expected_proof_version: 0 },
      { token: owner.token },
    );
    expect(proofed.statusCode, proofed.body).toBe(200);
    const body = {
      decision: "approve",
      expected_proof_version: 1,
      expected_version: proofed.json().version as string,
      funds_verified: true,
    };
    const treasurers = await Promise.all(
      [0, 1].map(async () => {
        const admin = await createAdmin(fx, { permissions: ["payments.read", "payments.decide"] });
        return (await signInAdmin(fx, admin)).accessToken;
      }),
    );

    let pending: Promise<{ statusCode: number; body: string; json(): unknown }>[] = [];
    let observed = false;
    await sql.begin(async (tx) => {
      await tx`select id from app.events where id = ${eventId} for update`;
      pending = treasurers.map((token) =>
        http().post(`/admin/payments/${ticket.payment.id}/decision`, body, { token }),
      );
      observed = await waitForLockWaiters(2);
    });
    const results = await Promise.all(pending);

    expect(observed, "kedua keputusan benar-benar menunggu kunci event").toBe(true);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json()).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
      current: { id: ticket.payment.id, status: "paid" },
    });

    const tickets = await sql<{ status: string; qr_code: string | null }[]>`
      select status, qr_code from app.tickets where event_id = ${eventId}`;
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.status).toBe("paid");
    expect(tickets[0]!.qr_code).toBeTruthy();
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
        select count(*)::int as n from app.audit_logs
        where entity_id = ${ticket.payment.id} and action = 'payment.approved'`),
    ).toBe(1);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.notifications
        where user_id = ${owner.userId} and category = 'payment'`),
    ).toBe(1);
  });
});
