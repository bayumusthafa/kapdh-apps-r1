import { alumniProfessionEntries, alumniSocialLinks } from "@kapdh/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { firstRow } from "../../src/core/db/rows.js";
import { adminMemberUpdateSchema, profileUpdateSchema } from "../../src/modules/membership/profile-input.js";
import { expectOperation } from "../support/contract.js";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminWith } from "./helpers.js";

/**
 * Entri ganda menurut indeks unik daftar (migrasi 0009, lower() PostgreSQL) yang lolos pemeriksaan ganda zod
 * (toLowerCase() JavaScript). Sigma akhir: JavaScript mengubah 'ΑΣ' menjadi 'ας', sedangkan PostgreSQL dengan ctype
 * UTF-8 (PGlite C.UTF-8, production en_US.utf8) mengubahnya menjadi 'ασ'; 'İ' menjadi 'i̇' di JavaScript tetapi 'i'
 * di PostgreSQL. Pelanggaran 23505 wajib menjadi 400 VALIDATION_ERROR pada field daftar (bukan 500) tanpa perubahan
 * profil, lewat PATCH /me/profile maupun PATCH /admin/members/{userId}. Bukti PostgreSQL 17 nyata:
 * test/pg/profile-lists.pg.test.ts.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const api = () => httpClient(t.app);

const SIGMA_PROFESSIONS = ["ΑΣ", "ασ"];
const SIGMA_LINKS = [
  { platform: "website", value: "https://contoh.test/ΑΣ" },
  { platform: "website", value: "https://contoh.test/ασ" },
];
/** Sama bagi lower() PostgreSQL, berbeda bagi JavaScript, juga bila diperkecil per karakter (posisi tidak diketahui). */
const DOTTED_I_LINKS = [
  { platform: "website", value: "https://contoh.test/İ" },
  { platform: "website", value: "https://contoh.test/i" },
];

async function lists(userId: string) {
  const professions = await t.db
    .select({ label: alumniProfessionEntries.label })
    .from(alumniProfessionEntries)
    .where(eq(alumniProfessionEntries.alumniUserId, userId));
  const links = await t.db
    .select({ value: alumniSocialLinks.value })
    .from(alumniSocialLinks)
    .where(eq(alumniSocialLinks.alumniUserId, userId));
  return { professions, links };
}

describe("profil berulang: ganda menurut indeks basis data tetapi lolos zod → 400, bukan 500", () => {
  it("prasyarat: zod menerima kiriman, sedangkan lower() basis data uji menganggap nilainya sama", async () => {
    for (const body of [
      { professions: SIGMA_PROFESSIONS },
      { social_links: SIGMA_LINKS },
      { social_links: DOTTED_I_LINKS },
    ]) {
      expect(profileUpdateSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
      expect(adminMemberUpdateSchema.safeParse({ reason: "Koreksi", ...body }).success).toBe(true);
    }
    const same = firstRow<{ sigma: boolean; dotted: boolean }>(
      await t.db.execute(sql`select lower('ΑΣ') = lower('ασ') as sigma, lower('İ') = lower('i') as dotted`),
    );
    expect(same).toEqual({ sigma: true, dotted: true });
  });

  it("PATCH /me/profile: profesi → professions, tautan → social_links.1.value atau social_links; profil tidak berubah", async () => {
    const fixture = await createAlumni(t, { status: "verified" });
    const { accessToken: token } = await signInAlumni(t, fixture);
    const me = async () => {
      const res = await api().get("/me", { token });
      expect(res.statusCode).toBe(200);
      return expectOperation("get", "/me", res) as { version: string; profile: Record<string, unknown> };
    };
    const seeded = await api().patch(
      "/me/profile",
      { professions: ["Penulis Lepas"], social_links: [{ platform: "instagram", value: "alumni.uji" }] },
      { token, headers: { "if-match": (await me()).version } },
    );
    expect(seeded.statusCode, seeded.body).toBe(200);
    const before = await me();

    for (const [body, key] of [
      [{ professions: SIGMA_PROFESSIONS }, "professions"],
      [{ social_links: SIGMA_LINKS }, "social_links.1.value"],
      [{ social_links: DOTTED_I_LINKS }, "social_links"],
    ] as const) {
      const res = await api().patch("/me/profile", body, { token, headers: { "if-match": before.version } });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({
        code: "VALIDATION_ERROR",
        field_errors: { [key]: [expect.any(String)] },
      });
      expect(Object.keys(res.json().field_errors), key).toEqual([key]);
    }
    // Transaksi dibatalkan: versi dan daftar tetap.
    const after = await me();
    expect(after.version).toBe(before.version);
    expect(after.profile).toMatchObject({
      professions: ["Penulis Lepas"],
      social_links: [{ platform: "instagram", value: "alumni.uji" }],
    });
    expect(await lists(fixture.userId)).toEqual({
      professions: [{ label: "Penulis Lepas" }],
      links: [{ value: "alumni.uji" }],
    });
  });

  it("PATCH /admin/members/{userId}: pemetaan yang sama untuk koreksi pengurus", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const manager = await adminWith(t, ["members.read", "members.manage"]);
    const detail = await api().get(`/admin/members/${member.userId}`, { token: manager.token });
    expect(detail.statusCode, detail.body).toBe(200);
    const version = (detail.json() as { version: string }).version;

    for (const [body, key] of [
      [{ professions: SIGMA_PROFESSIONS }, "professions"],
      [{ social_links: SIGMA_LINKS }, "social_links.1.value"],
      [{ social_links: DOTTED_I_LINKS }, "social_links"],
    ] as const) {
      const res = await api().patch(
        `/admin/members/${member.userId}`,
        { reason: "Koreksi profil anggota", ...body },
        { token: manager.token, headers: { "if-match": version } },
      );
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({
        code: "VALIDATION_ERROR",
        field_errors: { [key]: [expect.any(String)] },
      });
    }
    const unchanged = await api().get(`/admin/members/${member.userId}`, { token: manager.token });
    expect((unchanged.json() as { version: string }).version).toBe(version);
    expect(await lists(member.userId)).toEqual({ professions: [], links: [] });
  });
});
