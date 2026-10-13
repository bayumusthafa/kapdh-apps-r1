import { alumni, files, masterProfessions, masterSkills } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation, expectSchema } from "../support/contract.js";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminWith, getCard } from "./helpers.js";

/**
 * PATCH /me/profile (kontrak me.yaml updateMyProfile; F-10, PRD 3.5, 6.4): master aktif untuk pilihan baru dan label
 * historis (AC F10-4), identitas/nomor tidak dapat diubah anggota (AC F05-6), If-Match (AC F15-4), privasi dan tautan
 * sosial (AC F10-2, N-09), avatar milik sendiri (PRD 5.4).
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

type MeBody = {
  version: string;
  effective_status: string;
  member_number: string;
  profile: Record<string, unknown> & {
    profession: { id: string; label: string; active: boolean } | null;
    skills: { id: string; label: string; active: boolean }[];
    privacy: Record<string, boolean>;
    avatar_file_id: string | null;
  };
};

async function setup(status: "verified" | "unverified" | "expired" | "suspended" = "verified") {
  const fixture = await createAlumni(t, { status });
  const session = await signInAlumni(t, fixture);
  const api = httpClient(t.app);
  const get = async (): Promise<MeBody> => {
    const res = await api.get("/me", { token: session.accessToken });
    expect(res.statusCode).toBe(200);
    return expectOperation("get", "/me", res) as MeBody;
  };
  const patch = async (body: unknown, version?: string) =>
    api.patch("/me/profile", body, {
      token: session.accessToken,
      headers: version === undefined ? {} : { "if-match": version },
    });
  return { fixture, token: session.accessToken, get, patch };
}

async function master(kind: "profession" | "skill", active = true, sortOrder = 0) {
  const id = uuidv7();
  const table = kind === "profession" ? masterProfessions : masterSkills;
  const now = t.clock.now();
  await t.db
    .insert(table)
    .values({ id, label: `${kind} uji ${id.slice(-8)}`, active, sortOrder, createdAt: now, updatedAt: now });
  return id;
}

describe("PATCH /me/profile (F-10)", () => {
  it("AC F10-4: pilihan baru wajib master aktif; master nonaktif yang sudah terpasang tetap tampil sebagai label historis", async () => {
    const m = await setup();
    const inactiveProfession = await master("profession", false);
    const activeProfession = await master("profession");
    const v1 = (await m.get()).version;

    const rejected = await m.patch({ profession_id: inactiveProfession }, v1);
    expect(rejected.statusCode).toBe(400);
    expect(expectOperation("patch", "/me/profile", rejected)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { profession_id: [expect.any(String)] },
    });
    expect((await m.get()).version).toBe(v1);

    const skills = [await master("skill"), await master("skill"), await master("skill")];
    const ok = await m.patch({ profession_id: activeProfession, skill_ids: skills }, v1);
    expect(ok.statusCode, ok.body).toBe(200);
    const updated = expectOperation("patch", "/me/profile", ok) as MeBody;
    expect(updated.profile.profession).toMatchObject({ id: activeProfession, active: true });
    expect(updated.profile.skills.map((s) => s.id).sort()).toEqual([...skills].sort());
    expect(Number(updated.version)).toBeGreaterThan(Number(v1));

    // Master dinonaktifkan pengurus setelah dipakai: label historis tetap, pilihan ulang yang sama diterima.
    await t.db.update(masterProfessions).set({ active: false }).where(eq(masterProfessions.id, activeProfession));
    await t.db.update(masterSkills).set({ active: false }).where(eq(masterSkills.id, skills[0]!));
    const historic = await m.get();
    expect(historic.profile.profession).toMatchObject({ id: activeProfession, active: false });
    expect(historic.profile.skills.find((s) => s.id === skills[0])).toMatchObject({ active: false });
    const keep = await m.patch({ profession_id: activeProfession, skill_ids: [skills[0]!, skills[1]!] }, historic.version);
    expect(keep.statusCode, keep.body).toBe(200);
    expect(((keep.json() as MeBody).profile.skills).map((s) => s.id).sort()).toEqual([skills[0]!, skills[1]!].sort());

    // Keahlian nonaktif yang BELUM terpasang tidak dapat dipilih baru.
    const inactiveSkill = await master("skill", false);
    const current = await m.get();
    const badSkill = await m.patch({ skill_ids: [skills[1]!, inactiveSkill] }, current.version);
    expect(badSkill.statusCode).toBe(400);
    expect(badSkill.json().field_errors).toHaveProperty("skill_ids");

    // Kartu memakai label historis yang sama (AC F10-4) dan [] menghapus semua keahlian.
    expect((await getCard(t, m.token)).profession_label).toBe(historic.profile.profession!.label);
    const cleared = await m.patch({ skill_ids: [], profession_id: null }, current.version);
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as MeBody).profile).toMatchObject({ skills: [], profession: null });
  });

  it("AC F10-4: keahlian maksimal 10 tanpa duplikat; himpunan diganti seluruhnya", async () => {
    const m = await setup();
    const eleven: string[] = [];
    for (let i = 0; i < 11; i++) eleven.push(await master("skill"));
    const version = (await m.get()).version;
    const tooMany = await m.patch({ skill_ids: eleven }, version);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().field_errors).toHaveProperty("skill_ids");
    const duplicate = await m.patch({ skill_ids: [eleven[0], eleven[0]] }, version);
    expect(duplicate.statusCode).toBe(400);

    const first = await m.patch({ skill_ids: eleven.slice(0, 10) }, version);
    expect(first.statusCode).toBe(200);
    const replaced = await m.patch({ skill_ids: eleven.slice(5, 11) }, (first.json() as MeBody).version);
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect((replaced.json() as MeBody).profile.skills.map((s) => s.id).sort()).toEqual(eleven.slice(5, 11).sort());
  });

  it("AC F05-6: identitas keanggotaan, email dan nomor tidak dapat diubah anggota; field di luar skema ditolak tanpa perubahan", async () => {
    const m = await setup();
    const before = await m.get();
    const res = await m.patch(
      {
        city: "Tasikmalaya",
        full_name: "Nama Baru",
        cohort: 1,
        class_out: 3,
        member_number: "01.01.01.1",
        email: "baru@contoh.test",
        hobby: "x",
      },
      before.version,
    );
    expect(res.statusCode).toBe(400);
    const body = expectOperation("patch", "/me/profile", res) as { field_errors: Record<string, string[]> };
    expect(Object.keys(body.field_errors).sort()).toEqual(
      ["class_out", "cohort", "email", "full_name", "hobby", "member_number"].sort(),
    );
    const after = await m.get();
    expect(after).toEqual(before);

    const empty = await m.patch({}, before.version);
    expect(empty.statusCode).toBe(400);
  });

  it("AC F15-4: If-Match wajib; versi lama → 409 VERSION_CONFLICT dengan current berbentuk Me", async () => {
    const m = await setup();
    const v1 = (await m.get()).version;
    const missing = await m.patch({ city: "Cirebon" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().field_errors).toHaveProperty("If-Match");

    expect((await m.patch({ city: "Cirebon" }, v1)).statusCode).toBe(200);
    const stale = await m.patch({ city: "Bogor" }, v1);
    expect(stale.statusCode).toBe(409);
    const conflict = expectOperation("patch", "/me/profile", stale) as { code: string; current: MeBody };
    expect(conflict.code).toBe("VERSION_CONFLICT");
    expectSchema("Me", conflict.current);
    expect(conflict.current.profile.city).toBe("Cirebon");
  });

  it("AC F10-2, N-09: privasi parsial, kontak dan tautan sosial (SocialHandle dinormalkan, skema lain ditolak)", async () => {
    const m = await setup();
    let version = (await m.get()).version;
    const ok = await m.patch(
      {
        city: "  Sumedang ",
        phone: "+62 812-3456-7890",
        bio: "   ",
        last_education_institution: "Universitas Uji",
        social_instagram: "@alumni.uji",
        social_linkedin: "https://www.linkedin.com/in/alumni-uji",
        privacy: { show_phone: true },
      },
      version,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    const me = ok.json() as MeBody;
    expect(me.profile).toMatchObject({
      city: "Sumedang",
      phone: "+62 812-3456-7890",
      bio: null,
      last_education_institution: "Universitas Uji",
      social_instagram: "alumni.uji",
      social_linkedin: "https://www.linkedin.com/in/alumni-uji",
      privacy: { show_phone: true, show_email: false, show_social: false, show_in_directory: true },
    });
    version = me.version;

    for (const [field, value] of [
      ["social_x", "javascript:alert(1)"],
      ["social_facebook", "http://facebook.com/uji"],
      ["social_instagram", "nama dengan spasi"],
      ["phone", "(022) 123"],
      ["city", "   "],
      ["privacy", { show_phone: "ya" }],
      ["privacy", { lainnya: true }],
    ] as const) {
      const res = await m.patch({ [field]: value }, version);
      expect(res.statusCode, `${field}=${JSON.stringify(value)}`).toBe(400);
      expect(Object.keys(res.json().field_errors).some((key) => key.startsWith(field)), field).toBe(true);
    }
    const nulled = await m.patch({ phone: null, social_instagram: null }, version);
    expect((nulled.json() as MeBody).profile).toMatchObject({ phone: null, social_instagram: null });
  });

  it("PRD 5.4: avatar wajib berkas avatar milik sendiri yang siap (422 FILE_INVALID); foto lama dibuang; null menghapus", async () => {
    const m = await setup();
    const other = await setup();
    const first = await uploadTestFile(t, m.token, "avatar");
    let version = (await m.get()).version;
    const attached = await m.patch({ avatar_file_id: first.id }, version);
    expect(attached.statusCode, attached.body).toBe(200);
    expect((attached.json() as MeBody).profile.avatar_file_id).toBe(first.id);
    version = (attached.json() as MeBody).version;

    // Berkas milik orang lain, purpose lain, atau id acak → 422 tanpa membedakan (N-09).
    const foreign = await uploadTestFile(t, other.token, "avatar");
    const proof = await uploadTestFile(t, m.token, "payment_proof");
    for (const id of [foreign.id, proof.id, uuidv7()]) {
      const res = await m.patch({ avatar_file_id: id }, version);
      expect(res.statusCode).toBe(422);
      expect(expectOperation("patch", "/me/profile", res)).toMatchObject({ code: "FILE_INVALID" });
    }

    const second = await uploadTestFile(t, m.token, "avatar");
    const replaced = await m.patch({ avatar_file_id: second.id }, version);
    expect(replaced.statusCode).toBe(200);
    const [old] = await t.db.select().from(files).where(eq(files.id, first.id));
    expect(old!.status).toBe("deleted");
    expect((await getCard(t, m.token)).avatar_url).toEqual(expect.stringContaining("/api/v1/files/content/"));

    const removed = await m.patch({ avatar_file_id: null }, (replaced.json() as MeBody).version);
    expect((removed.json() as MeBody).profile).toMatchObject({ avatar_file_id: null, avatar_url: null });
    const [row] = await t.db.select().from(alumni).where(eq(alumni.userId, m.fixture.userId));
    expect(row!.avatarFileId).toBeNull();
  });

  it("PRD 2.2: unverified dan expired boleh mengubah profil; suspended 403 ACCOUNT_SUSPENDED; admin 403; tanpa sesi 401", async () => {
    for (const status of ["unverified", "expired"] as const) {
      const m = await setup(status);
      const res = await m.patch({ city: "Banjar" }, (await m.get()).version);
      expect(res.statusCode, status).toBe(200);
    }
    const suspended = await setup("suspended");
    const denied = await suspended.patch({ city: "Banjar" }, (await suspended.get()).version);
    expect(denied.statusCode).toBe(403);
    expect(expectOperation("patch", "/me/profile", denied)).toMatchObject({ code: "ACCOUNT_SUSPENDED" });

    const api = httpClient(t.app);
    const { token } = await adminWith(t, ["members.manage", "members.read"]);
    expect((await api.patch("/me/profile", { city: "X" }, { token, headers: { "if-match": "1" } })).statusCode).toBe(
      403,
    );
    expect((await api.patch("/me/profile", { city: "X" }, { headers: { "if-match": "1" } })).statusCode).toBe(401);
  });
});

describe("GET /masters/{kind} (F-10, AC F10-4)", () => {
  it("AC F10-4: hanya master aktif terurut sort_order lalu label; jenis tidak dikenal 400; suspended 403", async () => {
    const m = await setup();
    const api = httpClient(t.app);
    const late = await master("profession", true, 900);
    const early = await master("profession", true, -900);
    const hidden = await master("profession", false, -1000);
    const res = await api.get("/masters/professions", { token: m.token });
    expect(res.statusCode).toBe(200);
    const items = (expectOperation("get", "/masters/{kind}", res) as { items: { id: string }[] }).items;
    const ids = items.map((item) => item.id);
    expect(ids).not.toContain(hidden);
    expect(ids.indexOf(early)).toBeLessThan(ids.indexOf(late));
    expect(items.every((item) => (item as { active?: boolean }).active === true)).toBe(true);

    const skills = await api.get("/masters/skills", { token: m.token });
    expect(skills.statusCode).toBe(200);
    expectOperation("get", "/masters/{kind}", skills);

    const bad = await api.get("/masters/kota", { token: m.token });
    expect(bad.statusCode).toBe(400);
    expectOperation("get", "/masters/{kind}", bad);

    const suspended = await setup("suspended");
    const denied = await api.get("/masters/skills", { token: suspended.token });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("ACCOUNT_SUSPENDED");
  });
});
