/**
 * Indeks unik profil berulang (migrasi 0009: lower() PostgreSQL) pada PostgreSQL 17 nyata dengan ctype UTF-8. Cluster
 * jalur PG memakai --locale=C sehingga lower() hanya mengubah huruf ASCII dan sigma akhir tidak pernah teruji di
 * database template. Database uji ini dibuat dari template0 dengan locale bawaan C.UTF-8 (lower() Unicode per
 * karakter, seperti locale libc UTF-8 production) lalu dimigrasi dengan job migrasi production.
 *
 * 'ΑΣ' dan 'ασ' lolos pemeriksaan ganda zod (JavaScript: 'ας' vs 'ασ') tetapi sama bagi indeks (keduanya 'ασ').
 * Pelanggaran 23505 dari driver postgres-js (`constraint_name`) wajib menjadi 400 VALIDATION_ERROR pada field daftar,
 * bukan 500, dan transaksi batal tanpa mengubah daftar. Jalur HTTP: test/membership/profile-lists-duplicates.e2e.test.ts.
 */
import { runMigrations } from "@kapdh/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/core/db/types.js";
import { AppException } from "../../src/core/errors/app-exception.js";
import { profileUpdateSchema, type SocialLinkInput } from "../../src/modules/membership/profile-input.js";
import {
  markListWriter,
  replaceProfessions,
  replaceSocialLinks,
} from "../../src/modules/membership/profile-lists.js";
import { createEmptyPgDatabase, insertUser, type PgTestDatabase } from "./support.js";

let tdb: PgTestDatabase;
let db: Db;
const now = new Date("2026-10-13T02:00:00Z");

beforeAll(async () => {
  tdb = await createEmptyPgDatabase(
    "profile_lists_utf8",
    4,
    "template template0 encoding 'UTF8' locale_provider builtin builtin_locale 'C.UTF-8'",
  );
  await runMigrations({ url: tdb.url });
  db = tdb.db as unknown as Db;
});
afterAll(async () => {
  await tdb?.drop();
});

async function alumniUser(): Promise<string> {
  const userId = await insertUser(tdb.sql);
  await tdb.sql`
    insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out)
    values (${userId}, 'Alumni Uji', 'male', 12, 1, 6)`;
  return userId;
}

/** Galat transaksi tulis daftar seperti layanan profil (penanda penulis API lalu ganti daftar). */
async function failureOf(run: Parameters<Db["transaction"]>[0]): Promise<unknown> {
  return db.transaction(run).then(
    () => null,
    (error: unknown) => error,
  );
}

describe("profil berulang pada PostgreSQL 17 dengan locale UTF-8: ganda menurut indeks → 400", () => {
  it("prasyarat: lower() database ini menyamakan sigma akhir, collation C (cluster jalur PG) tidak; zod menerima", async () => {
    const [row] = await tdb.sql<{ utf8: boolean; c: boolean; provider: string }[]>`
      select lower('ΑΣ') = lower('ασ') as utf8, lower('ΑΣ' collate "C") = lower('ασ' collate "C") as c,
             (select datlocprovider::text from pg_database where datname = current_database()) as provider`;
    expect(row).toEqual({ utf8: true, c: false, provider: "b" });
    expect(profileUpdateSchema.safeParse({ professions: ["ΑΣ", "ασ"] }).success).toBe(true);
  });

  it("profesi ketikan sendiri 'ΑΣ' dan 'ασ': 23505 alumni_profession_entries_label_key menjadi 400 professions", async () => {
    const userId = await alumniUser();
    await db.transaction(async (tx) => {
      await markListWriter(tx);
      await replaceProfessions(tx, userId, ["Penulis Lepas"], now);
    });
    const failure = await failureOf(async (tx) => {
      await markListWriter(tx);
      await replaceProfessions(tx, userId, ["ΑΣ", "ασ"], now);
    });
    expect(failure).toBeInstanceOf(AppException);
    expect(failure).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      extra: { fieldErrors: { professions: ["Profesi tidak boleh ganda"] } },
    });
    const labels = await tdb.sql<{ label: string }[]>`
      select label from app.alumni_profession_entries where alumni_user_id = ${userId} order by position`;
    expect(labels).toEqual([{ label: "Penulis Lepas" }]);
  });

  it("tautan situs web '/ΑΣ' dan '/ασ': 23505 alumni_social_links_value_key menjadi 400 social_links.2.value", async () => {
    const userId = await alumniUser();
    const links: SocialLinkInput[] = [
      { platform: "instagram", value: "alumni.uji" },
      { platform: "website", value: "https://contoh.test/ΑΣ" },
      { platform: "website", value: "https://contoh.test/ασ" },
    ];
    expect(profileUpdateSchema.safeParse({ social_links: links }).success).toBe(true);
    const failure = await failureOf(async (tx) => {
      await markListWriter(tx);
      await replaceSocialLinks(tx, userId, links, now);
    });
    expect(failure).toBeInstanceOf(AppException);
    expect(failure).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      extra: { fieldErrors: { "social_links.2.value": ["Tautan ini sudah ada"] } },
    });
    const [count] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from app.alumni_social_links where alumni_user_id = ${userId}`;
    expect(count!.n).toBe(0);
  });
});
