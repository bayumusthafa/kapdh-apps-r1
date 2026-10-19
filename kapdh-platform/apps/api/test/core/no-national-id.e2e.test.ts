import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spec } from "../support/contract.js";
import { publishLegalVersions, TEST_CONSENT_VERSION } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Audit traceability D2 (PRD 2.4 N-09, v3.3 F-01): tidak ada NIK/Nomor KTP pada skema, payload kontrak maupun log.
 * Penjaga regresi: skema database (information_schema), kontrak OpenAPI dan skema event realtime tidak memiliki
 * kolom/properti identitas kependudukan, dan NIK yang dikirim klien pada registrasi tidak tersimpan maupun tercatat.
 */

/** Nama kolom/properti/parameter yang menandai nomor identitas kependudukan. */
const NATIONAL_ID =
  /(^|[_-])(nik|ktp|no_?ktp|nomor_?ktp|national_?id|id_?card|identity_?number|nik_?number)([_-]|$)/i;

class LogSink extends Writable {
  readonly raw: string[] = [];
  override _write(chunk: Buffer, _encoding: string, callback: () => void) {
    this.raw.push(chunk.toString("utf8"));
    callback();
  }
}

let t: TestApp;
const sink = new LogSink();

beforeAll(async () => {
  t = await createTestApp({ logDestination: sink, env: { LOG_LEVEL: "debug" } });
  await publishLegalVersions(t);
});
afterAll(async () => {
  await t.app.close();
});

/** Semua kunci objek (nama properti/parameter) di dokumen JSON/YAML, beserta jalurnya. */
function keysOf(node: unknown, path: string, out: { key: string; path: string }[]) {
  if (Array.isArray(node)) node.forEach((item, i) => keysOf(item, `${path}[${i}]`, out));
  else if (node && typeof node === "object")
    for (const [key, value] of Object.entries(node)) {
      out.push({ key, path: `${path}.${key}` });
      // Nama parameter (in: query/path/header) berada di nilai `name`, bukan kunci.
      if (key === "name" && typeof value === "string") out.push({ key: value, path: `${path}.name` });
      keysOf(value, `${path}.${key}`, out);
    }
  return out;
}

describe("N-09: tidak ada NIK pada skema, kontrak, dan payload tersimpan", () => {
  it("N-09: skema database tidak memiliki kolom NIK/KTP/nomor identitas", async () => {
    const result = await t.db.execute(sql`
      select table_schema, table_name, column_name
      from information_schema.columns
      where table_schema not in ('pg_catalog', 'information_schema')`);
    const rows = (
      result as unknown as { rows: { table_schema: string; table_name: string; column_name: string }[] }
    ).rows;
    // Pengaman: kueri benar-benar membaca skema aplikasi.
    expect(rows.some((r) => r.table_name === "alumni" && r.column_name === "member_number")).toBe(true);
    const offending = rows
      .filter((r) => NATIONAL_ID.test(r.column_name))
      .map((r) => `${r.table_schema}.${r.table_name}.${r.column_name}`);
    expect(offending).toEqual([]);
  });

  it("N-09: kontrak OpenAPI dan skema event realtime tidak memiliki properti/parameter NIK/KTP", () => {
    const contractKeys = keysOf(spec, "openapi", []);
    // Pengaman: penelusuran menemukan properti yang pasti ada.
    expect(contractKeys.some((k) => k.key === "member_number")).toBe(true);
    expect(contractKeys.filter((k) => NATIONAL_ID.test(k.key)).map((k) => k.path)).toEqual([]);

    const require = createRequire(import.meta.url);
    const eventsDir = dirname(require.resolve("@kapdh/contracts/events/envelope.schema.json"));
    const files = readdirSync(eventsDir).filter((name) => name.endsWith(".schema.json"));
    expect(files.length).toBeGreaterThan(5);
    const eventKeys = files.flatMap((file) =>
      keysOf(JSON.parse(readFileSync(join(eventsDir, file), "utf8")), file, []),
    );
    expect(eventKeys.filter((k) => NATIONAL_ID.test(k.key)).map((k) => k.path)).toEqual([]);
  });

  it("N-09: NIK yang dikirim klien pada registrasi diabaikan: tidak tersimpan di tabel mana pun dan tidak tercatat di log", async () => {
    const nik = "9901010101900001";
    const email = "tanpa.nik@contoh.id";
    const res = await httpClient(t.app).post("/auth/register", {
      full_name: "Alumni Tanpa NIK",
      gender: "male",
      email,
      password: "Kapdh#2026",
      cohort: 25,
      class_in: 1,
      class_out: 6,
      accept_policy_version: TEST_CONSENT_VERSION,
      nik,
      nomor_ktp: nik,
    });
    // Kunci di luar skema registrasi dibuang (bukan disimpan); registrasi tetap berhasil.
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain(nik);

    // Pindai seluruh kolom teks/json di skema aplikasi: nilai NIK tidak pernah tersimpan.
    const columns = (
      (await t.db.execute(sql`
        select table_schema, table_name, column_name
        from information_schema.columns
        where table_schema not in ('pg_catalog', 'information_schema')
          and data_type in ('text', 'character varying', 'jsonb', 'json')`)) as unknown as {
        rows: { table_schema: string; table_name: string; column_name: string }[];
      }
    ).rows;
    expect(columns.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const c of columns) {
      const found = (await t.db.execute(
        sql`select 1 as hit from ${sql.identifier(c.table_schema)}.${sql.identifier(c.table_name)}
            where ${sql.identifier(c.column_name)}::text like ${`%${nik}%`} limit 1`,
      )) as unknown as { rows: unknown[] };
      if (found.rows.length > 0) hits.push(`${c.table_schema}.${c.table_name}.${c.column_name}`);
    }
    expect(hits).toEqual([]);
    // Pengaman: pemindaian menemukan data registrasi yang memang tersimpan (email ternormalisasi).
    const emailHit = (await t.db.execute(
      sql`select 1 as hit from app.users where email = ${email} limit 1`,
    )) as unknown as { rows: unknown[] };
    expect(emailHit.rows).toHaveLength(1);

    // Pengaman: log aplikasi uji benar-benar aktif dan mencatat request registrasi.
    expect(sink.raw.join("")).toContain("/auth/register");
    expect(sink.raw.join("")).not.toContain(nik);
  });
});
