/**
 * Idempotency-Key di bawah konkurensi pada PostgreSQL 17 nyata (PRD 4.3, PRD 9.2 "idempotent replay under
 * concurrency"). Indeks unik idempotency_keys_scope_endpoint_key_key menjamin hanya satu permintaan yang mengeksekusi
 * operasi; permintaan bersamaan lain mendapat 409 IDEMPOTENCY_CONFLICT (masih diproses) atau hasil pertama diputar
 * ulang. API berjalan dengan login role kapdh_app (grant production).
 */
import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import {
  connectAs,
  createPgTestDatabase,
  PG_CONSENT_VERSION,
  type PgTestDatabase,
  publishLegalVersions,
  type Sql,
} from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
let mailer: MemoryMailer;
let sql: Sql;

beforeAll(async () => {
  tdb = await createPgTestDatabase("idempotency");
  sql = tdb.sql;
  api = connectAs(tdb, "kapdh_app", 10);
  mailer = new MemoryMailer();
  app = await createApp(
    {
      env: testEnv,
      db: api.db as unknown as Db,
      mailer,
      clock: new TestClock(),
      push: new FakePush(),
      redis: null,
    },
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await publishLegalVersions(tdb.sql);
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});

function registerBody(email: string) {
  return {
    full_name: "Alumni Uji Idempoten",
    gender: "male",
    email,
    password: "Kapdh#2026",
    cohort: 21,
    class_in: 1,
    class_out: 6,
    accept_policy_version: PG_CONSENT_VERSION,
  };
}

const register = (body: object, key: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: body,
    headers: { "idempotency-key": key },
  });

describe("PRD 9.2: idempotent replay under concurrency (PostgreSQL 17, role kapdh_app)", () => {
  it("permintaan bersamaan dengan key + payload sama: satu eksekusi, sisanya 409 atau putar ulang hasil yang sama", async () => {
    for (let round = 0; round < 3; round++) {
      const email = `idem-${round}-${uuidv7().slice(-12)}@contoh.test`;
      const key = uuidv7();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => register(registerBody(email), key)),
      );
      const statuses = responses.map((r) => r.statusCode);
      expect(
        statuses.every((s) => s === 201 || s === 409),
        statuses.join(","),
      ).toBe(true);
      const created = responses.filter((r) => r.statusCode === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);
      // Semua 201 adalah hasil yang sama (eksekusi pertama atau putar ulangnya).
      expect(new Set(created.map((r) => r.json().challenge_id)).size).toBe(1);
      for (const conflict of responses.filter((r) => r.statusCode === 409))
        expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");

      const [users] = await sql<
        { n: number }[]
      >`select count(*)::int as n from app.users where email = ${email}`;
      expect(users!.n).toBe(1);
      // Kode OTP hanya dikirim sekali (operasi tidak dieksekusi ulang).
      expect(mailer.sent.filter((m) => m.to === email)).toHaveLength(1);
      const keys = await sql<{ status: string; response_status: number; scope: string }[]>`
        select status, response_status, scope from app.idempotency_keys where key = ${key}`;
      expect(keys).toEqual([{ status: "completed", response_status: 201, scope: "anon" }]);

      // Setelah selesai: pengulangan memutar ulang hasil pertama; payload berbeda dengan key sama → 409.
      const replay = await register(registerBody(email), key);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.json()).toEqual(created[0]!.json());
      const different = await register({ ...registerBody(email), full_name: "Nama Lain" }, key);
      expect(different.statusCode).toBe(409);
      expect(different.json().code).toBe("IDEMPOTENCY_CONFLICT");
    }
  });
});
