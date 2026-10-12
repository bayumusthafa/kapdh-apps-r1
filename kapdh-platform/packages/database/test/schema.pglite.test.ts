/**
 * Kompatibilitas PGlite (jalur uji bawaan API, ARCHITECTURE §9.1): migrasi journal yang sama dengan production
 * berjalan di PGlite 0.5.x, trigger dan constraint skema bekerja, dan seed dapat diulang. Konkurensi nyata dan
 * PostgreSQL 17 dibuktikan di apps/api test/pg (pnpm test:pg).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/client.js";
import { schema } from "../src/client.js";
import { MIGRATIONS_FOLDER } from "../src/migrate.js";
import { APP_SETTING_KEYS } from "../src/schema/settings.js";
import { seedDev } from "../seeds/dev.js";
import { seedReference } from "../seeds/reference.js";

let pg: PGlite;
let db: Database;

const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
  entries: { tag: string; when: number }[];
};

beforeAll(async () => {
  pg = new PGlite();
  const migrator = drizzle(pg, { schema });
  await migrate(migrator, { migrationsFolder: MIGRATIONS_FOLDER });
  db = migrator as unknown as Database;
});
afterAll(async () => {
  await pg.close();
});

async function errorOf(
  statement: string,
  params: unknown[] = [],
): Promise<{ code?: string; constraint?: string }> {
  try {
    await pg.query(statement, params);
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return { code: err.code, constraint: err.constraint };
  }
  throw new Error(`Statement seharusnya gagal: ${statement}`);
}

async function insertUser(kind: "alumni" | "admin" = "alumni", email?: string): Promise<string> {
  const id = uuidv7();
  await pg.query(
    "insert into app.users (id, email, password_hash, status, kind) values ($1, $2, 'hash', 'active', $3)",
    [id, email ?? `u-${id}@contoh.test`, kind],
  );
  return id;
}

async function insertSuperAdmin(): Promise<string> {
  const userId = await insertUser("admin");
  const id = uuidv7();
  await pg.query(
    `insert into app.admins (id, user_id, display_name, role, status, activated_at)
     values ($1, $2, 'Super Admin Uji', 'super_admin', 'active', now())`,
    [id, userId],
  );
  return id;
}

describe("migrasi journal pada PGlite", () => {
  it("menerapkan seluruh entri _journal.json berurutan dan mencatatnya seperti migrator production", async () => {
    const recorded = await pg.query<{ created_at: string }>(
      "select created_at from drizzle.__drizzle_migrations order by id",
    );
    expect(recorded.rows.map((r) => Number(r.created_at))).toEqual(journal.entries.map((e) => e.when));
    const tables = await pg.query<{ n: number }>(
      "select count(*)::int as n from pg_tables where schemaname = 'app'",
    );
    expect(tables.rows[0]!.n).toBe(39);
  });

  it("journal berurutan naik dan setiap migrasi memisahkan satu statement per breakpoint", () => {
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    for (const entry of journal.entries) {
      const text = readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8");
      for (const chunk of text.split("--> statement-breakpoint")) {
        const body = chunk.replace(/\$\$[\s\S]*?\$\$/g, "$$$$").replace(/--[^\n]*/g, "");
        expect(body.split(";").filter((s) => s.trim()).length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("trigger skema pada PGlite", () => {
  it("AC F16-2: Super Admin aktif terakhir tidak dapat dinonaktifkan atau dihapus", async () => {
    const only = await insertSuperAdmin();
    expect(
      await errorOf("update app.admins set status = 'disabled', disabled_at = now() where id = $1", [only]),
    ).toMatchObject({ code: "23514", constraint: "admins_last_super_admin_chk" });
    expect(await errorOf("delete from app.admins where id = $1", [only])).toMatchObject({
      constraint: "admins_last_super_admin_chk",
    });
    const second = await insertSuperAdmin();
    await pg.query("update app.admins set role = 'admin' where id = $1", [second]);
  });

  it("F-17: audit_logs dan payment_events append-only", async () => {
    const id = uuidv7();
    await pg.query(
      "insert into app.audit_logs (id, effective_role, action, entity_type, request_id) values ($1, 'system', 'uji', 'x', 'req-1')",
      [id],
    );
    expect((await errorOf("update app.audit_logs set reason = 'ubah' where id = $1", [id])).code).toBe(
      "42501",
    );
    expect((await errorOf("delete from app.audit_logs where id = $1", [id])).code).toBe("42501");
    expect((await errorOf("truncate app.payment_events")).code).toBe("42501");
  });

  it("maksimal 10 keahlian per alumni", async () => {
    const userId = await insertUser();
    await pg.query(
      `insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out)
       values ($1, 'Alumni Uji', 'male', 20, 1, 6)`,
      [userId],
    );
    const skillIds: string[] = [];
    for (let i = 0; i < 11; i++) {
      const id = uuidv7();
      skillIds.push(id);
      await pg.query("insert into app.master_skills (id, label) values ($1, $2)", [id, `Keahlian Uji ${i}`]);
    }
    for (const skillId of skillIds.slice(0, 10)) {
      await pg.query("insert into app.alumni_skills (alumni_user_id, skill_id) values ($1, $2)", [
        userId,
        skillId,
      ]);
    }
    expect(
      await errorOf("insert into app.alumni_skills (alumni_user_id, skill_id) values ($1, $2)", [
        userId,
        skillIds[10],
      ]),
    ).toMatchObject({ code: "23514", constraint: "alumni_skills_limit_chk" });
    // Master yang dipakai tidak dapat dihapus (AC F10-4). ON DELETE RESTRICT: PostgreSQL 17 melaporkan 23503,
    // PostgreSQL 18 (PGlite) melaporkan 23001 restrict_violation; helper galat API wajib menerima keduanya.
    const restricted = await errorOf("delete from app.master_skills where id = $1", [skillIds[0]]);
    expect(["23503", "23001"]).toContain(restricted.code);
    expect(restricted.constraint).toBe("alumni_skills_skill_id_master_skills_id_fk");
  });
});

describe("constraint data pada PGlite", () => {
  it("nomor anggota harus sama dengan segmen AA.SS.JK.N yang tersimpan (PRD 3.5)", async () => {
    const userId = await insertUser();
    const insert = (seq: number, number: string) =>
      errorOf(
        `insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out, member_seq, member_number)
         values ($1, 'Alumni Uji', 'male', 12, 1, 3, $2, $3)`,
        [userId, seq, number],
      );
    expect((await insert(7, "12.01.01.7")).constraint).toBe("alumni_member_number_chk");
    expect((await insert(7, "12.02.01.8")).constraint).toBe("alumni_member_number_chk");
    await pg.query(
      `insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out, member_seq, member_number)
       values ($1, 'Alumni Uji', 'male', 12, 1, 3, 7, '12.02.01.7')`,
      [userId],
    );
    // Koreksi admin (AC F05-6): kelas keluar menjadi 6, prefix dihitung ulang, N tetap.
    await pg.query("update app.alumni set class_out = 6, member_number = '12.01.01.7' where user_id = $1", [
      userId,
    ]);
  });

  it("email tersimpan ternormalisasi dan unik per jenis identitas selama belum terhapus", async () => {
    expect(
      (
        await errorOf("insert into app.users (id, email, password_hash) values ($1, 'A@Contoh.test', 'h')", [
          uuidv7(),
        ])
      ).constraint,
    ).toBe("users_email_normalized_chk");
    await insertUser("alumni", "sama@contoh.test");
    await insertUser("admin", "sama@contoh.test");
    expect(
      (
        await errorOf(
          "insert into app.users (id, email, password_hash, kind) values ($1, 'sama@contoh.test', 'h', 'alumni')",
          [uuidv7()],
        )
      ).constraint,
    ).toBe("users_kind_email_key");
  });

  it("preferensi keamanan tidak dapat dibuat/dimatikan dan email hanya untuk kategori yang didukung", async () => {
    const userId = await insertUser();
    const insert = (category: string, channel: string) =>
      errorOf(
        "insert into app.notification_preferences (user_id, category, channel, enabled) values ($1, $2, $3, false)",
        [userId, category, channel],
      );
    expect((await insert("security", "push")).constraint).toBe("notification_preferences_category_chk");
    expect((await insert("chat", "email")).constraint).toBe("notification_preferences_category_chk");
  });

  it("direct_key harus kanonik min:max", async () => {
    const [a, b] = [uuidv7(), uuidv7()].sort();
    expect(
      (
        await errorOf("insert into app.rooms (id, kind, direct_key) values ($1, 'direct', $2)", [
          uuidv7(),
          `${b}:${a}`,
        ])
      ).constraint,
    ).toBe("rooms_direct_key_canonical_chk");
    await pg.query("insert into app.rooms (id, kind, direct_key) values ($1, 'direct', $2)", [
      uuidv7(),
      `${a}:${b}`,
    ]);
  });
});

describe("seed pada PGlite", () => {
  it("seed referensi dan dev idempoten", async () => {
    const first = await seedReference(db);
    expect(first.settings_inserted).toBe(APP_SETTING_KEYS.length);
    expect((await seedReference(db)).settings_inserted).toBe(0);
    const dev = await seedDev(db);
    expect(dev.alumni_inserted).toBe(3);
    expect((await seedDev(db)).alumni_inserted).toBe(0);
  });
});
