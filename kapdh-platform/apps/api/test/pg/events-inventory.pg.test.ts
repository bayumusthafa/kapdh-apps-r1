import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  barrier,
  createPgTestDatabase,
  id,
  insertEvent,
  insertUser,
  type PgTestDatabase,
  pgError,
  type Sql,
  withLockWaitGate,
} from "./support.js";

let tdb: PgTestDatabase;
let sql: Sql;

beforeAll(async () => {
  tdb = await createPgTestDatabase("events_inventory", 16);
  sql = tdb.sql;
});
afterAll(async () => {
  await tdb.drop();
});

async function insertTicket(
  tx: Sql,
  eventId: string,
  userId: string | null,
  status: "awaiting_payment" | "paid" | "cancelled" | "expired" = "awaiting_payment",
): Promise<string> {
  const ticketId = id();
  const cancelled = status === "cancelled";
  await tx`
    insert into app.tickets (id, event_id, user_id, status, total_snapshot, hold_expires_at, qr_code,
                             cancelled_at, cancelled_by)
    values (${ticketId}, ${eventId}, ${userId}, ${status}, '50000.00', now() + interval '24 hours',
            ${status === "paid" ? randomBytes(16).toString("hex") : null},
            case when ${cancelled} then now() end, ${cancelled ? "self" : null})`;
  return ticketId;
}

describe("PRD 6.4: satu tiket aktif per anggota per event (partial unique, PostgreSQL 17)", () => {
  it("dua reservasi bersamaan oleh anggota yang sama: tepat satu tiket aktif (PRD 9.2)", async () => {
    const eventId = await insertEvent(sql);
    const userId = await insertUser(sql);
    const ready = barrier(2);
    const { result: results, lockWaitObserved } = await withLockWaitGate(tdb, (hold) =>
      Promise.allSettled(
        [0, 1].map(() =>
          sql.begin(async (tx) => {
            await tx`select 1`;
            await ready();
            await insertTicket(tx as unknown as Sql, eventId, userId);
            await hold();
          }),
        ),
      ),
    );
    // Insert kedua menunggu keputusan transaksi pertama pada indeks unik parsial.
    expect(lockWaitObserved).toBe(true);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(pgError(rejected[0]!.reason)).toMatchObject({
      code: "23505",
      constraint: "tickets_user_id_event_id_active_key",
    });
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.tickets where event_id = ${eventId} and user_id = ${userId}`;
    expect(row!.n).toBe(1);
  });

  it("tiket cancelled/expired boleh dibuat ulang; tiket paid tetap memblokir tiket kedua", async () => {
    const eventId = await insertEvent(sql);
    const userId = await insertUser(sql);
    await insertTicket(sql, eventId, userId, "cancelled");
    await insertTicket(sql, eventId, userId, "expired");
    await insertTicket(sql, eventId, userId, "paid");
    const err = await insertTicket(sql, eventId, userId, "awaiting_payment").catch((e: unknown) => e);
    expect(pgError(err).constraint).toBe("tickets_user_id_event_id_active_key");
  });

  it("tiket milik akun terhapus (user_id null) tidak menghalangi pengguna lain dan event yang sama", async () => {
    const eventId = await insertEvent(sql);
    await insertTicket(sql, eventId, null, "paid");
    await insertTicket(sql, eventId, null, "paid");
    const other = await insertUser(sql);
    await insertTicket(sql, eventId, other, "awaiting_payment");
  });

  it("event yang memiliki tiket tidak dapat dihapus (FK RESTRICT, PRD 4.4)", async () => {
    const eventId = await insertEvent(sql);
    await insertTicket(sql, eventId, await insertUser(sql));
    const err = await sql`delete from app.events where id = ${eventId}`.catch((e: unknown) => e);
    expect(pgError(err).code).toBe("23503");
  });
});

describe("AC F09-1: CHECK 0 <= held + paid <= seats_total di bawah pembaruan counter bersamaan", () => {
  it("12 hold bersamaan pada event 5 kursi: tepat 5 berhasil, sisanya ditolak CHECK", async () => {
    const eventId = await insertEvent(sql, { seatsTotal: 5 });
    const contenders = 12;
    const ready = barrier(contenders);
    const { result: results, lockWaitObserved } = await withLockWaitGate(tdb, (hold) =>
      Promise.allSettled(
        Array.from({ length: contenders }, () =>
          sql.begin(async (tx) => {
            await tx`select 1`;
            await ready();
            await tx`update app.events set held_quantity = held_quantity + 1 where id = ${eventId}`;
            await hold();
          }),
        ),
      ),
    );
    expect(lockWaitObserved).toBe(true);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.length - rejected.length).toBe(5);
    for (const r of rejected) {
      expect(pgError(r.reason)).toMatchObject({ code: "23514", constraint: "events_capacity_chk" });
    }
    const [event] = await sql<{ held: number; paid: number; total: number }[]>`
      select held_quantity as held, paid_quantity as paid, seats_total as total from app.events where id = ${eventId}`;
    expect(event).toEqual({ held: 5, paid: 0, total: 5 });
  });

  it("hold menjadi paid dan hold baru bersamaan tidak pernah melampaui kuota", async () => {
    const eventId = await insertEvent(sql, { seatsTotal: 3 });
    await sql`update app.events set held_quantity = 3 where id = ${eventId}`;
    const ready = barrier(6);
    const moves = Array.from({ length: 3 }, () =>
      sql.begin(async (tx) => {
        await ready();
        await tx`update app.events set held_quantity = held_quantity - 1, paid_quantity = paid_quantity + 1
                 where id = ${eventId}`;
      }),
    );
    const newHolds = Array.from({ length: 3 }, () =>
      sql.begin(async (tx) => {
        await ready();
        await tx`update app.events set held_quantity = held_quantity + 1 where id = ${eventId}`;
      }),
    );
    const results = await Promise.allSettled([...moves, ...newHolds]);
    expect(results.slice(0, 3).every((r) => r.status === "fulfilled")).toBe(true);
    expect(results.slice(3).every((r) => r.status === "rejected")).toBe(true);
    const [event] = await sql<{ held: number; paid: number }[]>`
      select held_quantity as held, paid_quantity as paid from app.events where id = ${eventId}`;
    expect(event).toEqual({ held: 0, paid: 3 });
  });

  it("menurunkan kuota di bawah held + paid ditolak (AC F15-2)", async () => {
    const eventId = await insertEvent(sql, { seatsTotal: 10 });
    await sql`update app.events set held_quantity = 4, paid_quantity = 3 where id = ${eventId}`;
    const err = await sql`update app.events set seats_total = 6 where id = ${eventId}`.catch(
      (e: unknown) => e,
    );
    expect(pgError(err).constraint).toBe("events_capacity_chk");
    const negative = await sql`update app.events set held_quantity = -1 where id = ${eventId}`.catch(
      (e: unknown) => e,
    );
    expect(pgError(negative).constraint).toBe("events_held_quantity_chk");
  });
});
