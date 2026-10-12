import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgTestDatabase, id, insertUser, type PgTestDatabase, pgError, type Sql } from "./support.js";

let tdb: PgTestDatabase;
let sql: Sql;
let paymentId: string;

beforeAll(async () => {
  tdb = await createPgTestDatabase("append_only");
  sql = tdb.sql;
  const userId = await insertUser(sql);
  paymentId = id();
  await sql`
    insert into app.payments (id, user_id, type, amount, lines_snapshot, method_snapshot, settings_version)
    values (${paymentId}, ${userId}, 'registration', '60000.00', '[]'::jsonb, '{}'::jsonb, 1)`;
});
afterAll(async () => {
  await tdb.drop();
});

async function insertAudit(): Promise<string> {
  const auditId = id();
  await sql`
    insert into app.audit_logs (id, effective_role, action, entity_type, entity_id, request_id)
    values (${auditId}, 'system', 'uji.append_only', 'payment', ${paymentId}, 'req-uji-0001')`;
  return auditId;
}

async function insertPaymentEvent(): Promise<string> {
  const eventId = id();
  await sql`
    insert into app.payment_events (id, payment_id, kind) values (${eventId}, ${paymentId}, 'created')`;
  return eventId;
}

/** Menjalankan statement dengan role tertentu dalam transaksi singkat. */
function asRole(role: string | null, run: (tx: Sql) => Promise<unknown>) {
  return sql.begin(async (tx) => {
    if (role) await tx.unsafe(`set local role ${role}`);
    await run(tx as unknown as Sql);
  });
}

describe("F-17 / PRD 6.2: audit_logs dan payment_events append-only (PostgreSQL 17)", () => {
  for (const table of ["audit_logs", "payment_events"] as const) {
    const insertRow = () => (table === "audit_logs" ? insertAudit() : insertPaymentEvent());

    it(`${table}: pemilik tabel pun tidak dapat UPDATE, DELETE, atau TRUNCATE (trigger)`, async () => {
      const rowId = await insertRow();
      const appendOnly = { code: "42501", message: expect.stringContaining("append-only") };
      const update = await asRole(null, (tx) =>
        tx.unsafe(`update app.${table} set created_at = created_at where id = $1`, [rowId]),
      ).catch((e: unknown) => e);
      expect(pgError(update)).toMatchObject(appendOnly);
      const del = await asRole(null, (tx) =>
        tx.unsafe(`delete from app.${table} where id = $1`, [rowId]),
      ).catch((e: unknown) => e);
      expect(pgError(del)).toMatchObject(appendOnly);
      const truncate = await asRole(null, (tx) => tx.unsafe(`truncate app.${table} cascade`)).catch(
        (e: unknown) => e,
      );
      expect(pgError(truncate)).toMatchObject(appendOnly);
      const [row] = await sql.unsafe(`select count(*)::int as n from app.${table} where id = $1`, [rowId]);
      expect(row!.n).toBe(1);
    });

    for (const role of ["kapdh_app", "kapdh_worker"]) {
      it(`${table}: ${role} boleh INSERT/SELECT tetapi tidak punya hak UPDATE/DELETE`, async () => {
        const rowId = id();
        await asRole(role, (tx) =>
          table === "audit_logs"
            ? tx`insert into app.audit_logs (id, effective_role, action, entity_type, request_id)
                 values (${rowId}, 'system', 'uji.role', 'payment', 'req-uji-0002')`
            : tx`insert into app.payment_events (id, payment_id, kind) values (${rowId}, ${paymentId}, 'created')`,
        );
        // Ditolak oleh grant (permission denied) sebelum trigger berjalan.
        const denied = { code: "42501", message: expect.stringContaining("permission denied") };
        const update = await asRole(role, (tx) =>
          tx.unsafe(`update app.${table} set created_at = created_at where id = $1`, [rowId]),
        ).catch((e: unknown) => e);
        expect(pgError(update)).toMatchObject(denied);
        const del = await asRole(role, (tx) =>
          tx.unsafe(`delete from app.${table} where id = $1`, [rowId]),
        ).catch((e: unknown) => e);
        expect(pgError(del)).toMatchObject(denied);
      });
    }

    it(`${table}: pembersihan resmi hanya lewat SET ROLE kapdh_audit_purge (D2)`, async () => {
      const rowId = await insertRow();
      await asRole("kapdh_audit_purge", (tx) =>
        table === "audit_logs"
          ? tx`update app.audit_logs set actor_user_id = null, before = null, after = null where id = ${rowId}`
          : tx`update app.payment_events set actor_user_id = null where id = ${rowId}`,
      );
      await asRole("kapdh_audit_purge", (tx) => tx.unsafe(`delete from app.${table} where id = $1`, [rowId]));
      const [row] = await sql.unsafe(`select count(*)::int as n from app.${table} where id = $1`, [rowId]);
      expect(row!.n).toBe(0);
    });
  }

  it("worker tidak memiliki akses ke secret TOTP (least privilege)", async () => {
    const err = await asRole(
      "kapdh_worker",
      (tx) => tx`select secret_encrypted from app.mfa_totp limit 1`,
    ).catch((e: unknown) => e);
    expect(pgError(err).code).toBe("42501");
  });

  it("kapdh_app dapat mengalokasikan nomor urut anggota dari sequence", async () => {
    let seq = 0;
    await asRole("kapdh_app", async (tx) => {
      const [row] = await tx<{ n: string }[]>`select nextval('app.membership_no_seq')::text as n`;
      seq = Number(row!.n);
    });
    expect(seq).toBeGreaterThan(0);
  });
});
