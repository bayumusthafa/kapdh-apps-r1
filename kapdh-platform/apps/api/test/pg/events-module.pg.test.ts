/**
 * Modul events pada PostgreSQL 17 nyata (PRD 9.2, ARCHITECTURE §9.2; AC F09-1, F09-2, F09-5, PRD 6.4): API berjalan
 * sebagai role kapdh_app dengan pool sungguhan sehingga request HTTP benar-benar bersamaan. Persaingan dipaksa
 * deterministik: transaksi penahan memegang baris yang dikunci jalur produksi lebih dulu, lalu dilepas setelah probe
 * melihat jumlah penunggu kunci yang diharapkan.
 */
import "reflect-metadata";
import type { Permission } from "@kapdh/contracts";
import { createDb } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { JobRunner } from "../../src/core/jobs/job-runner.js";
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
  tdb = await createPgTestDatabase("events_module", 6);
  sql = tdb.sql;
  api = connectAs(tdb, "kapdh_app", 24);
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

async function member() {
  const fixture = await createAlumni(fx, { status: "verified" });
  const session = await signInAlumni(fx, fixture);
  return { ...fixture, token: session.accessToken };
}

async function admin(permissions: Permission[]) {
  const fixture = await createAdmin(fx, { permissions });
  return { adminId: fixture.adminId, token: (await signInAdmin(fx, fixture)).accessToken };
}

/** Event open relatif terhadap jam aplikasi (TestClock), bukan jam database. */
async function insertEvent(options: { seats?: number; price?: string; startsInMs?: number } = {}): Promise<string> {
  const id = uuidv7();
  const now = clock.now().getTime();
  const startsAt = new Date(now + (options.startsInMs ?? 10 * DAY));
  await sql`
    insert into app.events (id, title, starts_at, ends_at, registration_opens_at, registration_closes_at, price,
                            seats_total, status, created_at, updated_at)
    values (${id}, 'Event PG Uji', ${startsAt.toISOString()}, ${new Date(startsAt.getTime() + 4 * HOUR).toISOString()},
            ${new Date(now - DAY).toISOString()}, ${new Date(startsAt.getTime() - 30 * 60_000).toISOString()},
            ${options.price ?? "75000.00"}, ${options.seats ?? 10}, 'open', now(), now())`;
  return id;
}

async function count(query: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await query;
  return row!.n;
}

describe("AC F09-1 / PRD 9.2: kursi terakhir diperebutkan banyak anggota (PostgreSQL 17)", () => {
  it("12 anggota bersamaan pada event 3 kursi: tepat 3 tiket, sisanya 409 EVENT_SOLD_OUT; held tidak melebihi kuota", async () => {
    const eventId = await insertEvent({ seats: 3 });
    const methodId = (await createPaymentMethod(fx)).id;
    const members = await Promise.all(Array.from({ length: 12 }, () => member()));
    const { results, observed } = await underLock(
      (tx) => tx`select id from app.events where id = ${eventId} for update`,
      6,
      () =>
        members.map((m) =>
          http().post(
            `/events/${eventId}/reservations`,
            { expected_price: "75000.00", payment_method_id: methodId },
            { token: m.token },
          ),
        ),
    );
    expect(observed, "reservasi benar-benar menunggu kunci baris event").toBe(true);
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 409).map((r) => r.json().code)).toEqual(
      Array.from({ length: 9 }, () => "EVENT_SOLD_OUT"),
    );
    const [event] = await sql<{ held_quantity: number; paid_quantity: number }[]>`
      select held_quantity, paid_quantity from app.events where id = ${eventId}`;
    expect(event).toEqual({ held_quantity: 3, paid_quantity: 0 });
    expect(await count(sql<{ n: number }[]>`select count(*)::int as n from app.tickets where event_id = ${eventId}`)).toBe(3);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.payments p join app.tickets t on t.id = p.ticket_id
        where t.event_id = ${eventId}`),
    ).toBe(3);
  });
});

describe("PRD 9.2: satu anggota mengirim reservasi ganda bersamaan (PostgreSQL 17)", () => {
  it("4 request dengan Idempotency-Key berbeda: tepat satu tiket aktif; sisanya 409 VERSION_CONFLICT menunjuk tiket itu", async () => {
    const eventId = await insertEvent({ seats: 10, price: "0.00" });
    const owner = await member();
    const { results, observed } = await underLock(
      (tx) => tx`select id from app.events where id = ${eventId} for update`,
      2,
      () =>
        Array.from({ length: 4 }, () =>
          http().post(
            `/events/${eventId}/reservations`,
            { expected_price: "0.00" },
            { token: owner.token, headers: { "idempotency-key": uuidv7() } },
          ),
        ),
    );
    expect(observed).toBe(true);
    const created = results.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(1);
    const ticketId = created[0]!.json().id as string;
    for (const loser of results.filter((r) => r.statusCode !== 201))
      expect(loser.json()).toMatchObject({
        code: "VERSION_CONFLICT",
        current: { reservation_blocked_reason: "has_active_ticket", my_ticket: { id: ticketId } },
      });
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.tickets where event_id = ${eventId} and user_id = ${owner.userId}`),
    ).toBe(1);
    const [event] = await sql<{ paid_quantity: number }[]>`select paid_quantity from app.events where id = ${eventId}`;
    expect(event!.paid_quantity).toBe(1);
  });
});

describe("AC F09-2: job kedaluwarsa bersaing dengan kiriman bukti sesudah batas (PostgreSQL 17)", () => {
  it("hold dilepas tepat sekali (held -1 sekali, payment dibatalkan sekali); bukti ditolak RESERVATION_EXPIRED", async () => {
    const eventId = await insertEvent({ seats: 2 });
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
    clock.advance(24 * HOUR + 1000);
    const token = (await signInAlumni(fx, owner)).accessToken;
    const runner = app.get(JobRunner);
    const { results, observed } = await underLock(
      (tx) => tx`select id from app.events where id = ${eventId} for update`,
      2,
      () => [
        runner.runScheduled("reservations.expire").then(() => null),
        http().put(
          `/me/payments/${ticket.payment.id}/proof`,
          { file_id: proof.id, expected_proof_version: 0 },
          { token },
        ),
      ],
    );
    expect(observed, "job dan kiriman bukti menunggu kunci event").toBe(true);
    const submitted = results[1]!;
    expect(submitted!.json()).toMatchObject({ code: "RESERVATION_EXPIRED" });
    const [event] = await sql<{ held_quantity: number }[]>`select held_quantity from app.events where id = ${eventId}`;
    expect(event!.held_quantity).toBe(0);
    const [row] = await sql<{ status: string }[]>`select status from app.tickets where id = ${ticket.id}`;
    expect(row!.status).toBe("expired");
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.audit_logs where entity_id = ${ticket.id} and action = 'ticket.expired'`),
    ).toBe(1);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.payment_events where payment_id = ${ticket.payment.id} and kind = 'cancelled'`),
    ).toBe(1);
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.payment_events where payment_id = ${ticket.payment.id} and kind = 'proof_submitted'`),
    ).toBe(0);
    clock.advance(-(24 * HOUR + 1000));
  });
});

describe("AC F09-5 / PRD 4.5: dua petugas memindai QR yang sama bersamaan (PostgreSQL 17)", () => {
  it("tepat satu check-in tercatat; pemindaian lain 409 TICKET_ALREADY_CHECKED_IN dengan waktu dan petugas pertama", async () => {
    const eventId = await insertEvent({ price: "0.00", startsInMs: HOUR });
    const owner = await member();
    const reserved = await http().post(`/events/${eventId}/reservations`, { expected_price: "0.00" }, { token: owner.token });
    expect(reserved.statusCode, reserved.body).toBe(201);
    const ticket = reserved.json();
    const officers = [await admin(["events.checkin"]), await admin(["events.checkin"])];
    const { results, observed } = await underLock(
      (tx) => tx`select id from app.tickets where id = ${ticket.id} for update`,
      2,
      () =>
        officers.map((o) =>
          http().post("/admin/checkin", { event_id: eventId, qr_code: ticket.qr_code }, { token: o.token }),
        ),
    );
    expect(observed, "kedua UPDATE bersyarat menunggu kunci tiket").toBe(true);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.statusCode === 200)!.json();
    const loser = results.find((r) => r.statusCode === 409)!.json();
    expect(loser).toMatchObject({
      code: "TICKET_ALREADY_CHECKED_IN",
      current: {
        rejection_reason: "already_checked_in",
        ticket: { checked_in_at: winner.checked_in_at, checked_in_by: { admin_id: winner.checked_in_by.admin_id } },
      },
    });
    expect(
      await count(sql<{ n: number }[]>`
        select count(*)::int as n from app.audit_logs where entity_id = ${ticket.id} and action = 'ticket.checked_in'`),
    ).toBe(1);
  });
});

describe("PRD 6.4: urutan kunci event → tiket → payment (PostgreSQL 17)", () => {
  it("pembatalan event dan persetujuan payment tiket bersamaan selesai tanpa deadlock; akhir: tiket cancelled, payment paid, satu refund penuh", async () => {
    const eventId = await insertEvent({ seats: 5 });
    const owner = await member();
    const methodId = (await createPaymentMethod(fx)).id;
    const reserved = await http().post(
      `/events/${eventId}/reservations`,
      { expected_price: "75000.00", payment_method_id: methodId },
      { token: owner.token },
    );
    const ticket = reserved.json();
    const proof = await uploadTestFile(fx, owner.token, "payment_proof");
    const proofed = await http().put(
      `/me/payments/${ticket.payment.id}/proof`,
      { file_id: proof.id, expected_proof_version: 0 },
      { token: owner.token },
    );
    expect(proofed.statusCode, proofed.body).toBe(200);
    const treasurer = await admin(["payments.read", "payments.decide"]);
    const manager = await admin(["events.manage"]);
    const { results, observed } = await underLock(
      (tx) => tx`select id from app.events where id = ${eventId} for update`,
      2,
      () => [
        http().post(
          `/admin/payments/${ticket.payment.id}/decision`,
          { decision: "approve", expected_proof_version: 1, expected_version: proofed.json().version, funds_verified: true },
          { token: treasurer.token },
        ),
        http().post(`/admin/events/${eventId}/cancel`, { reason: "Bencana alam" }, {
          token: manager.token,
          headers: { "if-match": "1" },
        }),
      ],
    );
    expect(observed).toBe(true);
    for (const res of results) expect(res.statusCode, res.body).toBe(200);
    const [row] = await sql<{ status: string }[]>`select status from app.tickets where id = ${ticket.id}`;
    expect(row!.status).toBe("cancelled");
    const [payment] = await sql<{ status: string }[]>`select status from app.payments where id = ${ticket.payment.id}`;
    expect(payment!.status).toBe("paid");
    const refunds = await sql<{ amount: string; status: string }[]>`
      select amount::text as amount, status from app.payment_adjustments where payment_id = ${ticket.payment.id}`;
    expect(refunds).toEqual([{ amount: "75000.00", status: "pending" }]);
    const [event] = await sql<{ held_quantity: number; paid_quantity: number }[]>`
      select held_quantity, paid_quantity from app.events where id = ${eventId}`;
    expect(event).toEqual({ held_quantity: 0, paid_quantity: 0 });
  });
});
