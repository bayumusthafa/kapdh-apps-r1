import type { PGlite } from "@electric-sql/pglite";
import {
  alumni,
  alumniProfessions,
  alumniSkills,
  blocks,
  masterProfessions,
  masterSkills,
  users,
} from "@kapdh/database";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/core/db/types.js";
import {
  type DirectoryFilters,
  type DirectoryPosition,
  type DirectorySort,
  directoryPageQuery,
} from "../../src/modules/network/directory.query.js";
import { createTestDatabase } from "../support/test-app.js";

/**
 * Rencana kueri direktori pada skema PGlite (N-01: p95 <= 500 ms untuk baca sederhana pada 5.000 profil; PRD 3.10,
 * AC F10-1). Data sintetis 5.000 alumni + statistik ANALYZE, lalu EXPLAIN kueri halaman PERSIS seperti yang dipakai
 * DirectoryService (directoryPageQuery). Bukti: halaman diambil lewat pemindaian indeks berurutan dengan LIMIT
 * (tanpa Seq Scan dan tanpa Sort penuh pada alumni), dan cursor keyset menjadi Index Cond sehingga halaman berikutnya
 * langsung melompat ke posisinya (bukan OFFSET).
 */

const PROFILES = 5000;
const NAMES = [
  "ahmad",
  "budi",
  "citra",
  "dewi",
  "eko",
  "fajar",
  "gita",
  "hadi",
  "indah",
  "joko",
  "kiki",
  "lutfi",
];
const CITIES = ["Bandung", "Jakarta", "Garut", "Tasikmalaya", "Pekanbaru", "Bogor", "Cirebon", "Depok"];

let pg: PGlite;
let db: Db;
const now = new Date("2026-10-13T02:00:00Z");
const viewerId = uuidv7();
let professionId = "";
let skillId = "";

beforeAll(async () => {
  ({ pg, db } = await createTestDatabase());
  const [profession] = await db
    .insert(masterProfessions)
    .values({ id: uuidv7(), label: "Profesi Rencana", createdAt: now, updatedAt: now })
    .returning();
  const [skill] = await db
    .insert(masterSkills)
    .values({ id: uuidv7(), label: "Keahlian Rencana", createdAt: now, updatedAt: now })
    .returning();
  professionId = profession!.id;
  skillId = skill!.id;
  const ids: string[] = [];
  for (let batch = 0; batch < PROFILES / 500; batch++) {
    const userRows: (typeof users.$inferInsert)[] = [];
    const alumniRows: (typeof alumni.$inferInsert)[] = [];
    for (let i = 0; i < 500; i++) {
      const n = batch * 500 + i;
      const id = uuidv7();
      ids.push(id);
      userRows.push({
        id,
        email: `rencana-${n}@contoh.test`,
        passwordHash: "x",
        status: n % 97 === 0 ? "disabled" : "active",
        kind: "alumni",
        createdAt: now,
        updatedAt: now,
      });
      alumniRows.push({
        userId: id,
        fullName: `${NAMES[n % NAMES.length]} ${NAMES[(n * 7) % NAMES.length]} ${n}`,
        gender: n % 2 ? "male" : "female",
        cohort: (n % 30) + 1,
        classIn: 1 + (n % 3),
        classOut: 6,
        city: CITIES[n % CITIES.length],
        showInDirectory: n % 13 !== 0,
        startsAt: new Date(now.getTime() - 30 * 86_400_000),
        expiresAt: new Date(now.getTime() + ((n % 50) - 5) * 86_400_000 + 3600_000),
        suspendedAt: n % 101 === 0 ? now : null,
        createdAt: now,
        updatedAt: now,
      });
    }
    await db.insert(users).values(userRows);
    await db.insert(alumni).values(alumniRows);
  }
  await db.insert(users).values({
    id: viewerId,
    email: "penonton@contoh.test",
    passwordHash: "x",
    status: "active",
    kind: "alumni",
  });
  await db
    .insert(alumniProfessions)
    .values(ids.filter((_, i) => i % 9 === 0).map((id) => ({ alumniUserId: id, professionId })));
  await db
    .insert(alumniSkills)
    .values(ids.filter((_, i) => i % 7 === 0).map((id) => ({ alumniUserId: id, skillId })));
  await db
    .insert(blocks)
    .values(
      ids
        .slice(0, 300)
        .map((id, i) =>
          i % 2 ? { blockerId: id, blockedId: ids[i + 1000]! } : { blockerId: id, blockedId: viewerId },
        ),
    );
  await pg.query("analyze");
}, 120_000);
afterAll(async () => {
  await pg?.close();
});

async function plan(input: {
  filters?: Partial<DirectoryFilters>;
  sort?: DirectorySort;
  after?: DirectoryPosition | null;
}) {
  const query = directoryPageQuery(db, {
    viewerId,
    filters: { nameTokens: [], ...input.filters },
    now,
    sort: input.sort ?? "name_asc",
    after: input.after ?? null,
    limit: 30,
  }).toSQL();
  const result = await pg.query<{ "QUERY PLAN": string }>(`explain ${query.sql}`, query.params as unknown[]);
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/** Rencana halaman: LIMIT di atas pemindaian indeks berurutan; tidak ada Seq Scan maupun Sort penuh. */
function expectIndexedPage(text: string): void {
  expect(text).toMatch(/^Limit/);
  expect(text).not.toContain("Seq Scan");
  // Hanya Incremental Sort (pemutus seri user_id di dalam nama yang sama), bukan pengurutan seluruh hasil.
  expect(text).not.toMatch(/(^|->)\s*Sort\s+\(cost/m);
  expect(text).toContain("Incremental Sort");
  // Pemblokir disaring lewat indeks primer blocks; akun aktif lewat users_pkey (per baris kandidat).
  expect(text).toContain("blocks_blocker_id_blocked_id_pk");
  expect(text).toContain("users_pkey");
}

describe("N-01, AC F10-1: rencana kueri direktori memakai indeks dan keyset (EXPLAIN, PGlite)", () => {
  it("AC F10-1: name_asc memindai alumni_full_name_idx berurutan; cursor menjadi Index Cond (lompat ke posisi)", async () => {
    const first = await plan({});
    expectIndexedPage(first);
    expect(first).toContain("Index Scan using alumni_full_name_idx on alumni");
    expect(first).toContain("Presorted Key: (lower(alumni.full_name))");

    const next = await plan({ after: { s: "name_asc", n: "dewi", id: uuidv7() } });
    expectIndexedPage(next);
    expect(next).toContain("Index Scan using alumni_full_name_idx on alumni");
    expect(next).toContain("Index Cond: (lower(full_name) ~>=~ 'dewi'::text)");
  });

  it("AC F10-1: cohort_desc memindai alumni_cohort_class_idx mundur; cursor angkatan menjadi Index Cond", async () => {
    const first = await plan({ sort: "cohort_desc" });
    expectIndexedPage(first);
    expect(first).toContain("Index Scan Backward using alumni_cohort_class_idx on alumni");

    const next = await plan({
      sort: "cohort_desc",
      after: { s: "cohort_desc", c: 12, n: "dewi", id: uuidv7() },
    });
    expectIndexedPage(next);
    expect(next).toContain("Index Scan Backward using alumni_cohort_class_idx on alumni");
    expect(next).toContain("Index Cond: (cohort <= '12'::smallint)");
  });

  it("AC F10-1: filter nama, kota, angkatan, profesi dan keahlian tetap memakai rencana halaman berindeks", async () => {
    for (const filters of [{ nameTokens: ["ahm"] }, { city: "garut" }, { cohort: 5 }, { classLevel: 2 }])
      expectIndexedPage(await plan({ filters }));
    const byProfession = await plan({ filters: { professionId } });
    expectIndexedPage(byProfession);
    expect(byProfession).toMatch(/using alumni_professions_\w+ on alumni_professions/);
    const bySkill = await plan({ filters: { skillId } });
    expectIndexedPage(bySkill);
    expect(bySkill).toMatch(/using alumni_skills_\w+ on alumni_skills/);
  });
});
