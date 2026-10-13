/**
 * Jejaring dan master pada PostgreSQL 17 nyata (ARCHITECTURE §9.2, PRD 6.4; AC F10-1, F10-4, F15-4). API berjalan
 * dengan login role kapdh_app (grant production), bukan superuser.
 * - Ubah master bersamaan dengan If-Match yang sama: tepat satu menang, sisanya 409 VERSION_CONFLICT (AC F15-4).
 * - Label ganda bersamaan: satu 201, sisanya 409 VALIDATION_ERROR, tidak pernah 500.
 * - Hapus master menunggu pemasangan profesi/keahlian yang sedang berjalan (FOR UPDATE vs FOR KEY SHARE dari FK)
 *   lalu menolak 409 dengan usage_count terbaru; tidak pernah ada relasi yatim (AC F10-4).
 * - Direktori: urutan keyset byte-wise (~<~), paging tanpa duplikasi, dan rencana kueri berindeks juga di PG 17.
 */
import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { directoryPageQuery } from "../../src/modules/network/directory.query.js";
import {
  type AlumniFixture,
  createAdmin,
  createAlumni,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, createPgTestDatabase, id, type PgTestDatabase, withLockWaitGate } from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
const clock = new TestClock();
let owner: { db: Db; clock: TestClock };
let manager: string;

beforeAll(async () => {
  tdb = await createPgTestDatabase("network", 8);
  api = connectAs(tdb, "kapdh_app", 16);
  owner = { db: tdb.db as unknown as Db, clock };
  app = await createApp(
    {
      env: testEnv,
      db: api.db as unknown as Db,
      mailer: new MemoryMailer(),
      clock,
      push: new FakePush(),
      redis: null,
    },
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const admin = await createAdmin(owner, { permissions: ["master.manage"] });
  manager = (await signInAdmin({ app, clock }, admin)).accessToken;
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb?.drop();
});

const inject = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  options: { token?: string; payload?: object; ifMatch?: string; query?: Record<string, string> } = {},
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      authorization: `Bearer ${options.token ?? manager}`,
      ...(options.ifMatch ? { "if-match": options.ifMatch } : {}),
    },
    ...(options.payload ? { payload: options.payload } : {}),
    ...(options.query ? { query: options.query } : {}),
  });

function tally(responses: { statusCode: number; json(): { code?: string } }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const res of responses) {
    const key = `${res.statusCode}:${res.statusCode >= 400 ? res.json().code : "ok"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function createMaster(kind: "professions" | "skills", label = `Master PG ${id().slice(-12)}`) {
  const res = await inject("POST", `/admin/masters/${kind}`, { payload: { label } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; label: string; version: string };
}

describe("AC F15-4: perubahan master bersamaan (PostgreSQL 17, role kapdh_app)", () => {
  it("AC F15-4: 8 PATCH paralel dengan If-Match sama → tepat satu 200, tujuh 409 VERSION_CONFLICT, satu audit", async () => {
    const master = await createMaster("professions");
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        inject("PATCH", `/admin/masters/professions/${master.id}`, {
          payload: { label: `${master.label} v${i}` },
          ifMatch: master.version,
        }),
      ),
    );
    expect(tally(responses)).toEqual({ "200:ok": 1, "409:VERSION_CONFLICT": 7 });
    const [row] = await tdb.sql<{ version: number }[]>`
      select version from app.master_professions where id = ${master.id}`;
    expect(row!.version).toBe(2);
    const [audits] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from app.audit_logs where entity_id = ${master.id} and action = 'master.updated'`;
    expect(audits!.n).toBe(1);
  });

  it("label sama (beda huruf) dibuat paralel → satu 201, sisanya 409 VALIDATION_ERROR, tanpa 500", async () => {
    const label = `Paralel ${id().slice(-12)}`;
    const responses = await Promise.all(
      [label, label.toUpperCase(), label.toLowerCase(), ` ${label} `, label, label.toUpperCase()].map(
        (value) => inject("POST", "/admin/masters/skills", { payload: { label: value } }),
      ),
    );
    expect(tally(responses)).toEqual({ "201:ok": 1, "409:VALIDATION_ERROR": 5 });
  });

  it("AC F10-4: DELETE menunggu pemasangan keahlian yang belum commit lalu menolak 409 dengan usage_count terbaru", async () => {
    const master = await createMaster("skills");
    const member = await createAlumni(owner, { status: "verified" });
    const { result, lockWaitObserved } = await withLockWaitGate(tdb, async (hold) => {
      let inserted!: () => void;
      const insertedNow = new Promise<void>((resolve) => (inserted = resolve));
      const assign = api.sql.begin(async (tx) => {
        await tx`insert into app.alumni_skills (alumni_user_id, skill_id) values (${member.userId}, ${master.id})`;
        inserted();
        await hold();
      });
      await insertedNow;
      const [, res] = await Promise.all([
        assign,
        inject("DELETE", `/admin/masters/skills/${master.id}`, { ifMatch: master.version }),
      ]);
      return res;
    });
    expect(lockWaitObserved).toBe(true);
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      current: { id: master.id, usage_count: 1 },
    });
    const [row] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from app.master_skills where id = ${master.id}`;
    expect(row!.n).toBe(1);
  });
});

describe("F-15: daftar master pada PostgreSQL 17", () => {
  it("paging keyset usage_desc dan manual tanpa duplikasi (parameter bigint/smallint pada cursor)", async () => {
    const tag = id().slice(-10);
    const created = [];
    for (const [i, uses] of [2, 0, 1, 2, 0].entries()) {
      const res = await inject("POST", "/admin/masters/professions", {
        payload: { label: `Urut ${tag} ${i}`, sort_order: i % 2 },
      });
      const master = res.json() as { id: string; label: string };
      for (let u = 0; u < uses; u++) {
        const member = await createAlumni(owner, { status: "verified" });
        await tdb.sql`insert into app.alumni_professions (alumni_user_id, profession_id)
                      values (${member.userId}, ${master.id})`;
      }
      created.push({ ...master, uses, sortOrder: i % 2 });
    }
    const walk = async (sort: string) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await inject("GET", "/admin/masters/professions", {
          query: { q: tag, sort, limit: "2", ...(cursor ? { cursor } : {}) },
        });
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json() as { items: { id: string }[]; total: number; next_cursor: string | null };
        expect(body.total).toBe(5);
        ids.push(...body.items.map((item) => item.id));
        cursor = body.next_cursor;
      } while (cursor);
      return ids;
    };
    const byLabel = (a: { label: string }, b: { label: string }) => (a.label < b.label ? -1 : 1);
    expect(await walk("usage_desc")).toEqual(
      [...created].sort((a, b) => b.uses - a.uses || byLabel(a, b)).map((m) => m.id),
    );
    expect(await walk("manual")).toEqual(
      [...created].sort((a, b) => a.sortOrder - b.sortOrder || byLabel(a, b)).map((m) => m.id),
    );
  });
});

describe("AC F10-1: direktori pada PostgreSQL 17", () => {
  it("AC F10-1: paging keyset name_asc dan cohort_desc tanpa duplikasi; urutan byte-wise sama dengan PGlite", async () => {
    const city = `Kota PG ${id().slice(-10)}`;
    const viewer = await createAlumni(owner, { status: "verified" });
    const token = (await signInAlumni({ app }, viewer)).accessToken;
    const specs = [
      "Zaki",
      "ahmad",
      "Ahmad",
      "Ahmad Zaki",
      "Ahmadi",
      "budi",
      "Budi",
      "Élan",
      "Ömer",
      "Sama",
    ].map((fullName, i) => ({ fullName, cohort: 10 + (i % 4) }));
    const created: (AlumniFixture & { fullName: string; cohort: number })[] = [];
    for (const spec of specs) created.push({ ...(await createAlumni(owner, { city, ...spec })), ...spec });
    const [lowered] = await tdb.sql<{ names: string[] }[]>`
      select array_agg(lower(full_name) order by user_id) as names from app.alumni where city = ${city}`;
    const lowerOf = new Map(
      [...created]
        .sort((a, b) => (a.userId < b.userId ? -1 : 1))
        .map((m, i) => [m.userId, lowered!.names[i]!]),
    );
    const bytes = (s: string) => Buffer.from(s, "utf8");
    const byName = (a: { userId: string }, b: { userId: string }) =>
      Buffer.compare(bytes(lowerOf.get(a.userId)!), bytes(lowerOf.get(b.userId)!)) ||
      (a.userId < b.userId ? -1 : 1);

    for (const [sort, compare] of [
      ["name_asc", byName],
      [
        "cohort_desc",
        (a: (typeof created)[number], b: (typeof created)[number]) => b.cohort - a.cohort || byName(a, b),
      ],
    ] as const) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await inject("GET", "/directory", {
          token,
          query: { city, sort, limit: "3", ...(cursor ? { cursor } : {}) },
        });
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json() as {
          items: { user_id: string }[];
          total: number;
          next_cursor: string | null;
        };
        expect(body.total).toBe(specs.length);
        ids.push(...body.items.map((item) => item.user_id));
        cursor = body.next_cursor;
      } while (cursor);
      expect(ids, sort).toEqual([...created].sort(compare as typeof byName).map((m) => m.userId));
    }

    const wildcard = await inject("GET", "/directory", { token, query: { city, q: "%a" } });
    expect(wildcard.json()).toMatchObject({ items: [], total: 0 });
    const partial = await inject("GET", "/directory", { token, query: { city, q: "HMAD" } });
    expect((partial.json() as { total: number }).total).toBe(4);
  });

  it("N-01: rencana halaman di PostgreSQL 17 memakai indeks berurutan + LIMIT, cursor sebagai Index Cond", async () => {
    const now = clock.now();
    const names = ["ahmad", "budi", "citra", "dewi", "eko", "fajar", "gita", "hadi"];
    const userRows = [];
    const alumniRows = [];
    for (let n = 0; n < 4000; n++) {
      const userId = id();
      userRows.push({
        id: userId,
        email: `rencana-${n}-${userId.slice(-6)}@contoh.test`,
        password_hash: "x",
        status: "active",
        kind: "alumni",
      });
      alumniRows.push({
        user_id: userId,
        full_name: `${names[n % 8]} ${names[(n * 5) % 8]} ${n}`,
        gender: "male",
        cohort: (n % 30) + 1,
        class_in: 1,
        class_out: 6,
        city: "Bandung",
        show_in_directory: true,
        starts_at: new Date(now.getTime() - 86_400_000).toISOString(),
        expires_at: new Date(now.getTime() + 200 * 86_400_000).toISOString(),
      });
    }
    for (let i = 0; i < userRows.length; i += 500) {
      await tdb.sql`insert into app.users ${tdb.sql(userRows.slice(i, i + 500))}`;
      await tdb.sql`insert into app.alumni ${tdb.sql(alumniRows.slice(i, i + 500))}`;
    }
    await tdb.sql`analyze`;
    const explain = async (input: Parameters<typeof directoryPageQuery>[1]) => {
      const query = directoryPageQuery(tdb.db as unknown as Db, input).toSQL();
      const rows = await tdb.sql.unsafe(`explain ${query.sql}`, query.params as never[]);
      return (rows as unknown as { "QUERY PLAN": string }[]).map((row) => row["QUERY PLAN"]).join("\n");
    };
    const base = { viewerId: id(), filters: { nameTokens: [] }, now, limit: 30 };
    const first = await explain({ ...base, sort: "name_asc", after: null });
    expect(first).toMatch(/^Limit/);
    expect(first).toContain("Index Scan using alumni_full_name_idx on alumni");
    expect(first).not.toContain("Seq Scan on alumni");
    const next = await explain({ ...base, sort: "name_asc", after: { s: "name_asc", n: "dewi", id: id() } });
    expect(next).toContain("Index Cond: (lower(full_name) ~>=~ 'dewi'::text)");
    const cohort = await explain({ ...base, sort: "cohort_desc", after: null });
    expect(cohort).toContain("Index Scan Backward using alumni_cohort_class_idx on alumni");
    expect(cohort).not.toContain("Seq Scan on alumni");
  });
});
