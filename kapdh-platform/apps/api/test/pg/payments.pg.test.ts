import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  barrier,
  createPgTestDatabase,
  id,
  insertEvent,
  insertUser,
  type PgTestDatabase,
  pgError,
  sleep,
  type Sql,
  withLockWaitProbe,
} from "./support.js";

let tdb: PgTestDatabase;
let sql: Sql;

beforeAll(async () => {
  tdb = await createPgTestDatabase("payments");
  sql = tdb.sql;
});
afterAll(async () => {
  await tdb.drop();
});

async function insertPayment(
  tx: Sql,
  userId: string,
  type: "registration" | "renewal" | "ticket",
  opts: { ticketId?: string; status?: "pending" | "paid" } = {},
): Promise<string> {
  const paymentId = id();
  const paid = opts.status === "paid";
  await tx`
    insert into app.payments (id, user_id, type, status, amount, lines_snapshot, method_snapshot, settings_version,
                              ticket_id, proof_version, decided_at)
    values (${paymentId}, ${userId}, ${type}, ${opts.status ?? "pending"}, '60000.00', '[]'::jsonb, '{}'::jsonb,
            ${type === "ticket" ? null : 1}, ${opts.ticketId ?? null}, ${paid ? 1 : 0},
            case when ${paid} then now() end)`;
  return paymentId;
}

async function insertTicket(eventId: string, userId: string): Promise<string> {
  const ticketId = id();
  await sql`
    insert into app.tickets (id, event_id, user_id, status, total_snapshot, hold_expires_at)
    values (${ticketId}, ${eventId}, ${userId}, 'awaiting_payment', '50000.00', now() + interval '24 hours')`;
  return ticketId;
}

/** Menjalankan n transaksi bersamaan dan memastikan minimal satu benar-benar menunggu lock transaksi lain. */
async function concurrently<T>(n: number, run: (tx: Sql, i: number) => Promise<T>) {
  const ready = barrier(n);
  const { result, maxWaiting } = await withLockWaitProbe(
    sql,
    Promise.allSettled(
      Array.from({ length: n }, (_, i) =>
        sql.begin(async (tx) => {
          await tx`select 1`;
          await ready();
          const value = await run(tx as unknown as Sql, i);
          await sleep(150);
          return value;
        }),
      ),
    ),
  );
  expect(maxWaiting).toBeGreaterThanOrEqual(1);
  return result;
}

describe("PRD 3.3/6.4: satu payment nonterminal registration/renewal per pengguna (PostgreSQL 17)", () => {
  it("registrasi ganda bersamaan hanya menghasilkan satu payment pending (PRD 9.2)", async () => {
    const userId = await insertUser(sql);
    const results = await concurrently(2, (tx) => insertPayment(tx, userId, "registration"));
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(pgError(rejected[0]!.reason)).toMatchObject({
      code: "23505",
      constraint: "payments_user_id_type_open_key",
    });
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.payments where user_id = ${userId} and type = 'registration'`;
    expect(row!.n).toBe(1);
  });

  it("registration dan renewal terbuka dapat berdampingan; payment terminal tidak memblokir yang baru", async () => {
    const userId = await insertUser(sql);
    const registration = await insertPayment(sql, userId, "registration");
    await insertPayment(sql, userId, "renewal");
    await sql`update app.payments set status = 'rejected', decided_at = now(), rejection_reason = 'Bukti buram'
              where id = ${registration}`;
    const stillOpen = await insertPayment(sql, userId, "registration").catch((e: unknown) => e);
    expect(pgError(stillOpen).constraint).toBe("payments_user_id_type_open_key");
    await sql`update app.payments set status = 'cancelled', cancelled_at = now() where id = ${registration}`;
    await insertPayment(sql, userId, "registration");
  });

  it("payment tiket unik per tiket, bukan per pengguna/jenis (anggota dapat memesan event berbeda)", async () => {
    const userId = await insertUser(sql);
    const ticketA = await insertTicket(await insertEvent(sql), userId);
    const ticketB = await insertTicket(await insertEvent(sql), userId);
    await insertPayment(sql, userId, "ticket", { ticketId: ticketA });
    await insertPayment(sql, userId, "ticket", { ticketId: ticketB });
    const duplicate = await insertPayment(sql, userId, "ticket", { ticketId: ticketA }).catch(
      (e: unknown) => e,
    );
    expect(pgError(duplicate)).toMatchObject({ code: "23505", constraint: "payments_ticket_id_key" });
    const iuranWithTicket = await insertPayment(sql, userId, "renewal", { ticketId: ticketB }).catch(
      (e: unknown) => e,
    );
    expect(pgError(iuranWithTicket).constraint).toBe("payments_ticket_chk");
  });

  it("alasan penolakan wajib dan tidak hanya spasi (AC F04-2)", async () => {
    const paymentId = await insertPayment(sql, await insertUser(sql), "registration");
    const err = await sql`
      update app.payments set status = 'rejected', decided_at = now(), rejection_reason = '   '
      where id = ${paymentId}`.catch((e: unknown) => e);
    expect(pgError(err).constraint).toBe("payments_rejected_chk");
  });
});

describe("AC F04-3 / PRD 6.4: satu aktivasi per payment paid (membership_events unik per payment)", () => {
  it("dua keputusan bersamaan: hanya satu UPDATE bersyarat menang dan hanya satu membership_event tercatat", async () => {
    const userId = await insertUser(sql);
    const paymentId = await insertPayment(sql, userId, "registration");
    await sql`update app.payments set proof_version = 1, proof_file_id = null, submitted_at = now()
              where id = ${paymentId}`;

    const results = await concurrently(2, async (tx) => {
      const won = await tx`
        update app.payments set status = 'paid', decided_at = now(), version = version + 1
        where id = ${paymentId} and status = 'pending' and version = 1 returning id`;
      if (won.length === 0) return "conflict";
      await tx`
        insert into app.membership_events (id, user_id, kind, payment_id, after_starts_at, after_expires_at)
        values (${id()}, ${userId}, 'activation', ${paymentId}, now(), now() + interval '12 months')`;
      return "approved";
    });
    const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value : "error"));
    expect(outcomes.sort()).toEqual(["approved", "conflict"]);
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.membership_events where payment_id = ${paymentId}`;
    expect(row!.n).toBe(1);
  });

  it("penulisan membership_event ganda bersamaan untuk payment yang sama ditolak unique key", async () => {
    const userId = await insertUser(sql);
    const paymentId = await insertPayment(sql, userId, "renewal", { status: "paid" });
    const results = await concurrently(
      2,
      (tx) =>
        tx`
        insert into app.membership_events (id, user_id, kind, payment_id, after_starts_at, after_expires_at)
        values (${id()}, ${userId}, 'renewal', ${paymentId}, now(), now() + interval '12 months')`,
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(pgError(rejected[0]!.reason)).toMatchObject({
      code: "23505",
      constraint: "membership_events_payment_id_key",
    });
  });

  it("payment yang sudah dirujuk histori keanggotaan tidak dapat dihapus", async () => {
    const userId = await insertUser(sql);
    const paymentId = await insertPayment(sql, userId, "registration", { status: "paid" });
    await sql`
      insert into app.membership_events (id, user_id, kind, payment_id, after_starts_at, after_expires_at)
      values (${id()}, ${userId}, 'activation', ${paymentId}, now(), now() + interval '12 months')`;
    const err = await sql`delete from app.payments where id = ${paymentId}`.catch((e: unknown) => e);
    expect(pgError(err).code).toBe("23503");
  });
});
