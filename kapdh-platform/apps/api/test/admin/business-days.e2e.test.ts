import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../../src/core/db/rows.js";
import type { Db } from "../../src/core/db/types.js";
import { addBusinessDaysJakarta, addBusinessDaysSql } from "../../src/modules/admin/business-days.js";
import { createTestDatabase } from "../support/test-app.js";

let pg: PGlite;
let db: Db;

beforeAll(async () => {
  ({ pg, db } = await createTestDatabase());
});
afterAll(async () => {
  await pg.close();
});

describe("Hari kerja SQL = hari kerja TypeScript (kontrak C7 DashboardPayments: satu rumus, AC F15-1)", () => {
  it("SQL addBusinessDaysSql identik dengan addBusinessDaysJakarta untuk setiap jam selama tiga pekan", async () => {
    const start = Date.parse("2026-10-11T17:00:00.000Z"); // Senin 00.00 WIB
    const samples: { at: Date; days: number }[] = [];
    for (let hour = 0; hour < 21 * 24; hour += 5)
      for (const days of [0, 1, 2, 3, 5, 7]) samples.push({ at: new Date(start + hour * 3600_000), days });
    // Zona sesi database sengaja bukan Asia/Jakarta: hasil tidak boleh bergantung TimeZone sesi.
    await db.execute(sql`set time zone 'America/New_York'`);
    const results = await Promise.all(
      samples.map(async ({ at, days }) => {
        const [row] = rows<{ due: string }>(
          await db.execute(
            sql`select to_char(${addBusinessDaysSql(sql`${at.toISOString()}::timestamptz`, days)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as due`,
          ),
        );
        return { expected: addBusinessDaysJakarta(at, days).toISOString(), actual: row!.due, at, days };
      }),
    );
    const mismatches = results.filter((r) => r.expected !== r.actual);
    expect(mismatches).toEqual([]);
  });
});
