import {
  alumni,
  alumniEducation,
  alumniProfessionEntries,
  alumniProfessions,
  alumniSkills,
  alumniSocialLinks,
  blocks,
  masterProfessions,
  masterSkills,
  roomMembers,
  rooms,
} from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateLimitService } from "../../src/core/rate-limit/rate-limit.service.js";
import { DIRECTORY_RATE_LIMITS, directoryRateLimitKey } from "../../src/modules/network/directory.service.js";
import { expectOperation } from "../support/contract.js";
import {
  type AlumniFixture,
  type AlumniFixtureStatus,
  createAdmin,
  createAlumni,
  type CreateAlumniOptions,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { type HttpClient, httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Jejaring alumni (F-10, PRD 3.10; kontrak network.yaml): direktori dan profil anggota lain. Setiap uji memakai kota
 * unik sebagai lingkup data sehingga anggota dari uji lain tidak memengaruhi hasil dan total.
 */

type Json = Record<string, unknown>;
type AlumniRow = typeof alumni.$inferInsert;

let t: TestApp;
let api: HttpClient;

beforeAll(async () => {
  t = await createTestApp();
  api = httpClient(t.app);
});
afterAll(async () => {
  await t.app.close();
});

const uniqueCity = () => `Kota Uji ${uuidv7().slice(-12)}`;
const uniqueLabel = (prefix: string) => `${prefix} ${uuidv7().slice(-12)}`;

interface Member extends AlumniFixture {
  token: string;
}

async function member(
  options: CreateAlumniOptions & { profile?: Partial<AlumniRow> } = {},
): Promise<AlumniFixture> {
  const { profile, ...fixture } = options;
  const created = await createAlumni(t, fixture);
  if (profile) await t.db.update(alumni).set(profile).where(eq(alumni.userId, created.userId));
  return created;
}

async function viewer(options: CreateAlumniOptions & { profile?: Partial<AlumniRow> } = {}): Promise<Member> {
  const created = await member({ status: "verified", ...options });
  const session = await signInAlumni(t, created);
  return { ...created, token: session.accessToken };
}

async function search(token: string, query: Record<string, string> = {}) {
  return api.get("/directory", { token, query });
}

async function searchOk(token: string, query: Record<string, string>): Promise<Json & { items: Json[] }> {
  const res = await search(token, query);
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/directory", res) as Json & { items: Json[] };
}

async function profileOf(token: string, userId: string) {
  return api.get(`/directory/${userId}`, { token });
}

async function block(blockerId: string, blockedId: string) {
  await t.db.insert(blocks).values({ blockerId, blockedId, createdAt: t.clock.now() });
}

async function master(kind: "professions" | "skills", active = true) {
  const table = kind === "professions" ? masterProfessions : masterSkills;
  const [row] = await t.db
    .insert(table)
    .values({
      id: uuidv7(),
      label: uniqueLabel(kind === "professions" ? "Profesi" : "Keahlian"),
      active,
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    })
    .returning();
  return row!;
}

/** Semua halaman direktori dengan limit kecil; memeriksa total konsisten di setiap halaman. */
async function walk(token: string, query: Record<string, string>) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let total: number | null = null;
  do {
    const body = await searchOk(token, { ...query, ...(cursor ? { cursor } : {}) });
    if (total === null) total = body.total as number;
    expect(body.total).toBe(total);
    ids.push(...body.items.map((item) => item.user_id as string));
    cursor = body.next_cursor as string | null;
    pages++;
    expect(pages).toBeLessThan(50);
  } while (cursor);
  return { ids, total: total ?? 0, pages };
}

describe("AC F10-3: hanya anggota aktif yang dapat memanggil direktori", () => {
  it("AC F10-3: tanpa sesi 401; unverified/expired 403 MEMBERSHIP_REQUIRED; suspended 403 ACCOUNT_SUSPENDED", async () => {
    const target = await member({ status: "verified" });
    for (const path of ["/directory", `/directory/${target.userId}`] as const) {
      const contractPath = path === "/directory" ? "/directory" : "/directory/{userId}";
      const anonymous = await api.get(path);
      expect(anonymous.statusCode).toBe(401);
      expect(expectOperation("get", contractPath, anonymous)).toMatchObject({ code: "UNAUTHENTICATED" });

      const expected: [AlumniFixtureStatus, string][] = [
        ["unverified", "MEMBERSHIP_REQUIRED"],
        ["expired", "MEMBERSHIP_REQUIRED"],
        ["suspended", "ACCOUNT_SUSPENDED"],
      ];
      for (const [status, code] of expected) {
        const caller = await viewer({ status });
        const res = await api.get(path, { token: caller.token });
        expect(res.statusCode, `${status} ${path}`).toBe(403);
        expect(expectOperation("get", contractPath, res)).toMatchObject({ code });
      }
    }
  });

  it("AC F10-3: sesi admin (audience salah) ditolak 403 FORBIDDEN walau memiliki izin members.read", async () => {
    const target = await member({ status: "verified" });
    const admin = await createAdmin(t, { role: "super_admin" });
    const session = await signInAdmin(t, admin);
    const list = await api.get("/directory", { token: session.accessToken });
    expect(list.statusCode).toBe(403);
    expect(expectOperation("get", "/directory", list)).toMatchObject({ code: "FORBIDDEN" });
    const one = await api.get(`/directory/${target.userId}`, { token: session.accessToken });
    expect(one.statusCode).toBe(403);
    expect(expectOperation("get", "/directory/{userId}", one)).toMatchObject({ code: "FORBIDDEN" });
  });

  it("AC F10-3: verified dan expiring boleh memakai direktori", async () => {
    for (const status of ["verified", "expiring"] as const) {
      const caller = await viewer({ status });
      const city = uniqueCity();
      await searchOk(caller.token, { city });
    }
  });
});

describe("AC F10-1: hasil hanya anggota yang tampil menurut status terkini", () => {
  it("AC F10-1: hanya verified/expiring, tidak suspended, show_in_directory=true, akun aktif; tanpa diri sendiri dan pemblokir", async () => {
    const city = uniqueCity();
    const caller = await viewer({ city, fullName: "Penonton Direktori" });
    const verified = await member({ city, status: "verified", fullName: "Anggota Verified" });
    const expiring = await member({ city, status: "expiring", fullName: "Anggota Expiring" });
    const blockedByMe = await member({ city, status: "verified", fullName: "Anggota Diblokir Saya" });
    await block(caller.userId, blockedByMe.userId);
    const blocksMe = await member({ city, status: "verified", fullName: "Anggota Memblokir Saya" });
    await block(blocksMe.userId, caller.userId);
    const hidden = [
      await member({ city, status: "unverified", fullName: "Anggota Unverified" }),
      await member({ city, status: "expired", fullName: "Anggota Expired" }),
      await member({ city, status: "suspended", fullName: "Anggota Suspended" }),
      await member({ city, status: "verified", showInDirectory: false, fullName: "Anggota Tersembunyi" }),
      await member({ city, status: "verified", accountStatus: "disabled", fullName: "Anggota Disabled" }),
      await member({
        city,
        status: "verified",
        accountStatus: "deletion_pending",
        fullName: "Anggota Hapus Akun",
      }),
    ];

    const body = await searchOk(caller.token, { city });
    const ids = body.items.map((item) => item.user_id);
    expect(new Set(ids)).toEqual(new Set([verified.userId, expiring.userId, blockedByMe.userId]));
    expect(body.total).toBe(3);
    for (const excluded of [caller, blocksMe, ...hidden]) expect(ids).not.toContain(excluded.userId);
  });

  it("AC F10-1: status dihitung saat request: masa aktif habis atau suspend langsung menghilangkan anggota", async () => {
    const city = uniqueCity();
    const caller = await viewer({ city });
    const soon = await member({ city, status: "expiring", fullName: "Segera Habis" });
    const later = await member({ city, status: "verified", fullName: "Masih Aktif" });
    await t.db
      .update(alumni)
      .set({ expiresAt: new Date(t.clock.now().getTime() + 60_000) })
      .where(eq(alumni.userId, soon.userId));
    expect((await searchOk(caller.token, { city })).total).toBe(2);

    // Tanpa job/worker: hanya waktu yang bergerak (PRD 4.2, AC F07-3).
    t.clock.advance(2 * 60_000);
    let body = await searchOk(caller.token, { city });
    expect(body.items.map((item) => item.user_id)).toEqual([later.userId]);
    expect(body.total).toBe(1);

    await t.db
      .update(alumni)
      .set({ suspendedAt: t.clock.now(), suspensionReason: "uji", suspensionMessage: "uji" })
      .where(eq(alumni.userId, later.userId));
    body = await searchOk(caller.token, { city });
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("AC F10-1: paging keyset name_asc tanpa duplikasi, urut (nama, user_id), total sama di setiap halaman", async () => {
    const city = uniqueCity();
    const caller = await viewer({ city: "Kota Lain" });
    const names = ["Sama Nama", "Sama Nama", "sama nama", "Budi", "andi", "budi", "Zaki", "Ahmad Zaki"];
    const created = [];
    for (const [i, fullName] of names.entries())
      created.push({
        ...(await member({ city, fullName, cohort: 10 + (i % 3) })),
        fullName,
        cohort: 10 + (i % 3),
      });

    const expected = [...created]
      .sort((a, b) => {
        const an = a.fullName.toLowerCase();
        const bn = b.fullName.toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
        return a.userId < b.userId ? -1 : 1;
      })
      .map((m) => m.userId);
    for (const limit of ["1", "2", "3"]) {
      const walked = await walk(caller.token, { city, limit });
      expect(walked.ids).toEqual(expected);
      expect(walked.total).toBe(names.length);
    }
  });

  it("AC F10-1: paging keyset cohort_desc = (angkatan menurun, nama, user_id) tanpa duplikasi", async () => {
    const city = uniqueCity();
    const caller = await viewer();
    const specs = [
      { fullName: "Citra", cohort: 5 },
      { fullName: "Citra", cohort: 5 },
      { fullName: "Bagus", cohort: 20 },
      { fullName: "Andi", cohort: 5 },
      { fullName: "Zahra", cohort: 20 },
      { fullName: "Dimas", cohort: 12 },
    ];
    const created = [];
    for (const spec of specs) created.push({ ...(await member({ city, ...spec })), ...spec });
    const expected = [...created]
      .sort((a, b) => {
        if (a.cohort !== b.cohort) return b.cohort - a.cohort;
        const an = a.fullName.toLowerCase();
        const bn = b.fullName.toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
        return a.userId < b.userId ? -1 : 1;
      })
      .map((m) => m.userId);
    const walked = await walk(caller.token, { city, sort: "cohort_desc", limit: "2" });
    expect(walked.ids).toEqual(expected);
    expect(walked.total).toBe(specs.length);
  });

  it("AC F10-1: anggota baru di tengah paging tidak menggandakan maupun menggeser halaman berikutnya", async () => {
    const city = uniqueCity();
    const caller = await viewer();
    const base = [];
    for (const fullName of ["Bayu", "Cahya", "Dani", "Eka"]) base.push(await member({ city, fullName }));
    const first = await searchOk(caller.token, { city, limit: "2" });
    expect(first.items.map((i) => i.full_name)).toEqual(["Bayu", "Cahya"]);

    // Anggota baru sebelum dan sesudah posisi cursor.
    await member({ city, fullName: "Aan" });
    const late = await member({ city, fullName: "Zul" });
    const second = await searchOk(caller.token, { city, limit: "2", cursor: first.next_cursor as string });
    expect(second.items.map((i) => i.full_name)).toEqual(["Dani", "Eka"]);
    expect(second.total).toBe(6);
    const third = await searchOk(caller.token, { city, limit: "2", cursor: second.next_cursor as string });
    expect(third.items.map((i) => i.user_id)).toEqual([late.userId]);
    expect(third.next_cursor).toBeNull();
  });

  it("AC F10-1: limit bawaan 30 dan maksimum 100", async () => {
    const city = uniqueCity();
    const caller = await viewer();
    for (let i = 0; i < 31; i++) await member({ city, fullName: `Anggota ${String(i).padStart(2, "0")}` });
    const first = await searchOk(caller.token, { city });
    expect(first.items).toHaveLength(30);
    expect(first.total).toBe(31);
    expect(first.next_cursor).toEqual(expect.any(String));
    const all = await searchOk(caller.token, { city, limit: "100" });
    expect(all.items).toHaveLength(31);
    expect(all.next_cursor).toBeNull();
    const tooMany = await search(caller.token, { city, limit: "101" });
    expect(tooMany.statusCode).toBe(400);
    expect(expectOperation("get", "/directory", tooMany)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { limit: expect.any(Array) },
    });
  });
});

describe("AC F10-1: pencarian nama, angkatan, kelas, kota dan filter master", () => {
  it("AC F10-1: q mencocokkan sebagian nama tanpa membedakan huruf; semua kata wajib cocok; wildcard diperlakukan teks", async () => {
    const city = uniqueCity();
    const caller = await viewer();
    const ahmad = await member({ city, fullName: "Ahmad Fauzi" });
    const muhammad = await member({ city, fullName: "Muhammad Rizki" });
    await member({ city, fullName: "Siti Aminah" });
    const names = async (q: string) =>
      new Set((await searchOk(caller.token, { city, q })).items.map((item) => item.user_id));
    expect(await names("MAD")).toEqual(new Set([ahmad.userId, muhammad.userId]));
    expect(await names("  ah   fau ")).toEqual(new Set([ahmad.userId]));
    expect(await names("riz mad")).toEqual(new Set([muhammad.userId]));
    expect(await names("a%")).toEqual(new Set());
    expect(await names("_i")).toEqual(new Set());
    const totals = await searchOk(caller.token, { city, q: "mad" });
    expect(totals.total).toBe(2);
  });

  it("AC F10-1: filter angkatan, kelas yang pernah ditempuh dan kota (persis, tanpa huruf besar/kecil) digabung AND", async () => {
    const city = uniqueCity();
    const caller = await viewer();
    const mts = await member({ city, cohort: 10, classIn: 1, classOut: 3, fullName: "Lulus MTs" });
    const aliyah = await member({ city, cohort: 10, classIn: 4, classOut: 6, fullName: "Lulus Aliyah" });
    const full = await member({ city, cohort: 11, classIn: 1, classOut: 6, fullName: "Enam Tahun" });
    const ids = async (query: Record<string, string>) =>
      new Set((await searchOk(caller.token, { city, ...query })).items.map((item) => item.user_id));

    expect(await ids({ cohort: "10" })).toEqual(new Set([mts.userId, aliyah.userId]));
    expect(await ids({ class_level: "2" })).toEqual(new Set([mts.userId, full.userId]));
    expect(await ids({ class_level: "5" })).toEqual(new Set([aliyah.userId, full.userId]));
    expect(await ids({ cohort: "10", class_level: "5" })).toEqual(new Set([aliyah.userId]));
    // Kota cocok persis tanpa membedakan huruf besar/kecil; sebagian nama kota tidak cocok.
    const upper = await searchOk(caller.token, { city: city.toUpperCase() });
    expect(upper.total).toBe(3);
    const partial = await searchOk(caller.token, { city: city.slice(0, -2) });
    expect(partial.total).toBe(0);
  });

  it("AC F10-1, F10-4: filter profesi/keahlian memakai master terkontrol, termasuk master yang sudah nonaktif", async () => {
    const city = uniqueCity();
    const caller = await viewer();
    const retired = await master("professions", false);
    const skill = await master("skills");
    const other = await master("skills");
    const doctor = await member({ city, fullName: "Dokter Lama" });
    const coder = await member({ city, fullName: "Pemrogram" });
    await member({ city, fullName: "Tanpa Profesi" });
    await t.db.insert(alumniProfessions).values({ alumniUserId: doctor.userId, professionId: retired.id });
    await t.db.insert(alumniSkills).values([
      { alumniUserId: coder.userId, skillId: skill.id },
      { alumniUserId: coder.userId, skillId: other.id },
      { alumniUserId: doctor.userId, skillId: other.id },
    ]);
    const ids = async (query: Record<string, string>) =>
      (await searchOk(caller.token, { city, ...query })).items.map((item) => item.user_id);

    expect(await ids({ profession_id: retired.id })).toEqual([doctor.userId]);
    expect(await ids({ skill_id: skill.id })).toEqual([coder.userId]);
    expect(new Set(await ids({ skill_id: other.id }))).toEqual(new Set([doctor.userId, coder.userId]));
    expect(await ids({ skill_id: other.id, profession_id: retired.id })).toEqual([doctor.userId]);
    expect(await ids({ profession_id: uuidv7() })).toEqual([]);
  });

  it("AC F10-1: parameter tidak valid ditolak 400 VALIDATION_ERROR dengan field_errors", async () => {
    const caller = await viewer();
    const cases: [Record<string, string>, string][] = [
      [{ q: "a" }, "q"],
      [{ q: " b " }, "q"],
      [{ q: "x".repeat(101) }, "q"],
      [{ cohort: "0" }, "cohort"],
      [{ cohort: "abc" }, "cohort"],
      [{ class_level: "7" }, "class_level"],
      [{ city: "   " }, "city"],
      [{ profession_id: "bukan-uuid" }, "profession_id"],
      [{ skill_id: "123" }, "skill_id"],
      [{ sort: "random" }, "sort"],
      [{ limit: "0" }, "limit"],
      [{ cursor: "bukan cursor!" }, "cursor"],
      [{ cursor: "eyJ2IjoxLCJwIjp7fX0" }, "cursor"],
    ];
    for (const [query, field] of cases) {
      const res = await search(caller.token, query);
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
      const body = expectOperation("get", "/directory", res) as Json;
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(Object.keys(body.field_errors as Json), JSON.stringify(query)).toContain(field);
    }
  });

  it("AC F10-1, PRD 5.2: karakter kontrol (NUL) pada q/city dan cursor palsu → 400 VALIDATION_ERROR, bukan 500", async () => {
    const caller = await viewer();
    const forged = (position: Json) =>
      Buffer.from(JSON.stringify({ v: 1, p: position }), "utf8").toString("base64url");
    const cases: [Record<string, string>, string][] = [
      [{ q: "ab\u0000cd" }, "q"],
      [{ q: "Ahmad\u0007Fauzi" }, "q"],
      [{ city: "ab\u0000" }, "city"],
      [{ city: "Kota\u001bUji" }, "city"],
      [{ cursor: forged({ s: "name_asc", n: "a\u0000b", id: uuidv7() }) }, "cursor"],
      [
        { sort: "cohort_desc", cursor: forged({ s: "cohort_desc", c: 5, n: "x\u0000", id: uuidv7() }) },
        "cursor",
      ],
    ];
    for (const [query, field] of cases) {
      const res = await search(caller.token, query);
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
      const body = expectOperation("get", "/directory", res) as Json;
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(Object.keys(body.field_errors as Json), JSON.stringify(query)).toContain(field);
    }
    // Cursor sah hasil server tetap diterima (nama tanpa karakter kontrol).
    const ok = await searchOk(caller.token, {
      cursor: forged({ s: "name_asc", n: "ahmad", id: uuidv7() }),
    });
    expect(ok.items).toEqual(expect.any(Array));
  });

  it("AC F10-1: cursor dari urutan lain ditolak (tidak pernah dipakai pada urutan berbeda)", async () => {
    const city = uniqueCity();
    const caller = await viewer();
    for (const fullName of ["Satu", "Dua", "Tiga"]) await member({ city, fullName });
    const page = await searchOk(caller.token, { city, limit: "1" });
    const res = await search(caller.token, {
      city,
      limit: "1",
      sort: "cohort_desc",
      cursor: page.next_cursor as string,
    });
    expect(res.statusCode).toBe(400);
    expect(expectOperation("get", "/directory", res)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { cursor: expect.any(Array) },
    });
  });
});

describe("AC F10-2: field tersembunyi tidak ikut payload", () => {
  const contact = {
    phone: "+62 812 0000 7777",
    socialInstagram: "kontak.rahasia",
    socialX: "@xrahasia",
    socialFacebook: "https://facebook.com/rahasia",
    socialLinkedin: "https://linkedin.com/in/rahasia",
    bio: "Guru matematika.",
  };

  it("AC F10-2: kartu direktori tidak pernah memuat email, telepon maupun sosial walau flag aktif", async () => {
    const city = uniqueCity();
    const caller = await viewer();
    const open = await member({
      city,
      fullName: "Kontak Terbuka",
      profile: { ...contact, showPhone: true, showEmail: true, showSocial: true },
    });
    const res = await search(caller.token, { city });
    const body = expectOperation("get", "/directory", res) as { items: Json[] };
    expect(body.items).toHaveLength(1);
    const card = body.items[0]!;
    expect(Object.keys(card).sort()).toEqual(
      [
        "user_id",
        "full_name",
        "avatar_url",
        "cohort",
        "cohort_code",
        "city",
        "profession",
        "professions",
        "latest_education",
        "last_education_institution",
        "last_education_city",
        "skills",
      ].sort(),
    );
    for (const secret of [contact.phone, open.email, "kontak.rahasia", "member_number", "expires_at"])
      expect(res.body).not.toContain(secret);
  });

  it("AC F10-2: show_phone/show_email/show_social=false → kuncinya tidak ada di profil (bukan sekadar disamarkan)", async () => {
    const caller = await viewer();
    const target = await member({
      profile: { ...contact, showPhone: false, showEmail: false, showSocial: false },
    });
    const res = await profileOf(caller.token, target.userId);
    expect(res.statusCode).toBe(200);
    const body = expectOperation("get", "/directory/{userId}", res) as Json;
    expect(body).not.toHaveProperty("phone");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("social");
    expect(body).not.toHaveProperty("social_links");
    expect(body.bio).toBe(contact.bio);
    for (const secret of [contact.phone, target.email, "kontak.rahasia", "xrahasia", "linkedin.com"])
      expect(res.body).not.toContain(secret);
  });

  it("AC F10-2: flag aktif → hanya field yang diizinkan pemilik yang dikirim", async () => {
    const caller = await viewer();
    const phoneOnly = await member({ profile: { ...contact, showPhone: true } });
    const phoneBody = expectOperation(
      "get",
      "/directory/{userId}",
      await profileOf(caller.token, phoneOnly.userId),
    ) as Json;
    expect(phoneBody.phone).toBe(contact.phone);
    expect(phoneBody).not.toHaveProperty("email");
    expect(phoneBody).not.toHaveProperty("social");
    expect(phoneBody).not.toHaveProperty("social_links");

    const all = await member({ profile: { ...contact, showPhone: true, showEmail: true, showSocial: true } });
    const allBody = expectOperation(
      "get",
      "/directory/{userId}",
      await profileOf(caller.token, all.userId),
    ) as Json;
    expect(allBody).toMatchObject({
      email: all.email,
      phone: contact.phone,
      social: {
        instagram: "kontak.rahasia",
        x: "@xrahasia",
        facebook: "https://facebook.com/rahasia",
        linkedin: "https://linkedin.com/in/rahasia",
      },
      // Kolom lama yang ditulis penulis lama ikut menjadi daftar tautan (jembatan migrasi 0010).
      social_links: [
        { platform: "instagram", value: "kontak.rahasia" },
        { platform: "x", value: "@xrahasia" },
        { platform: "facebook", value: "https://facebook.com/rahasia" },
        { platform: "linkedin", value: "https://linkedin.com/in/rahasia" },
      ],
    });

    // Flag aktif tetapi data kosong: kunci ada dengan nilai null (kontrak NetworkMemberProfile).
    const empty = await member({ profile: { showPhone: true, showSocial: true } });
    const emptyBody = expectOperation(
      "get",
      "/directory/{userId}",
      await profileOf(caller.token, empty.userId),
    ) as Json;
    expect(emptyBody.phone).toBeNull();
    expect(emptyBody.social).toEqual({ instagram: null, x: null, facebook: null, linkedin: null });
    expect(emptyBody.social_links).toEqual([]);
  });
});

describe("Profil berulang di direktori (professions, education, social_links)", () => {
  it("profesi jamak, pendidikan teratas di kartu, filter profesi cocok dengan profesi mana pun, tautan mengikuti show_social", async () => {
    const city = uniqueCity();
    const caller = await viewer();
    const other = await master("professions");
    const second = await master("professions");
    const target = await member({ status: "verified", city, profile: { showSocial: true } });
    const hidden = await member({ status: "verified", city, profile: { showSocial: false } });
    const now = t.clock.now();
    for (const owner of [target, hidden]) {
      await t.db.insert(alumniProfessionEntries).values([
        { alumniUserId: owner.userId, position: 0, label: "Penulis Lepas", createdAt: now },
        { alumniUserId: owner.userId, position: 1, professionId: second.id, createdAt: now },
      ]);
      await t.db.insert(alumniEducation).values([
        {
          alumniUserId: owner.userId,
          position: 0,
          institution: "UIN Contoh",
          major: "Pendidikan Agama Islam",
          level: "s2",
          graduationYear: 2022,
          createdAt: now,
        },
        {
          alumniUserId: owner.userId,
          position: 1,
          institution: "Universitas Contoh",
          level: "s1",
          createdAt: now,
        },
      ]);
      await t.db.insert(alumniSocialLinks).values({
        alumniUserId: owner.userId,
        position: 0,
        platform: "tiktok",
        value: "uji.tiktok",
        createdAt: now,
      });
    }

    const found = await searchOk(caller.token, { city, profession_id: second.id });
    expect(found.items.map((item) => item.user_id).sort()).toEqual([target.userId, hidden.userId].sort());
    expect(found.items[0]).toMatchObject({
      professions: ["Penulis Lepas", second.label],
      latest_education: {
        institution: "UIN Contoh",
        major: "Pendidikan Agama Islam",
        level: "s2",
        graduation_year: 2022,
      },
    });
    expect((await searchOk(caller.token, { city, profession_id: other.id })).items).toEqual([]);

    const profile = expectOperation(
      "get",
      "/directory/{userId}",
      await profileOf(caller.token, target.userId),
    ) as Json;
    expect(profile).toMatchObject({
      professions: ["Penulis Lepas", second.label],
      education: [
        { institution: "UIN Contoh", major: "Pendidikan Agama Islam", level: "s2", graduation_year: 2022 },
        { institution: "Universitas Contoh", major: null, level: "s1", graduation_year: null },
      ],
      social_links: [{ platform: "tiktok", value: "uji.tiktok" }],
    });
    const private_ = await profileOf(caller.token, hidden.userId);
    expect(expectOperation("get", "/directory/{userId}", private_)).not.toHaveProperty("social_links");
    expect(private_.body).not.toContain("uji.tiktok");
  });
});

describe("Profil anggota lain (GET /directory/{userId})", () => {
  it("AC F10-4: profil menampilkan identitas komunitas dan label master historis (active=false)", async () => {
    const caller = await viewer();
    const retiredProfession = await master("professions", false);
    const skillA = await master("skills");
    const skillB = await master("skills", false);
    const target = await member({
      fullName: "Ahmad Islam",
      cohort: 1,
      city: "Pekanbaru",
      profile: { lastEducationInstitution: "Universitas Indonesia", lastEducationCity: "Jakarta" },
    });
    await t.db
      .insert(alumniProfessions)
      .values({ alumniUserId: target.userId, professionId: retiredProfession.id });
    await t.db.insert(alumniSkills).values([
      { alumniUserId: target.userId, skillId: skillB.id },
      { alumniUserId: target.userId, skillId: skillA.id },
    ]);
    const res = await profileOf(caller.token, target.userId);
    expect(res.statusCode).toBe(200);
    const body = expectOperation("get", "/directory/{userId}", res) as Json;
    const expectedSkills = [skillA, skillB]
      .sort((a, b) => (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1))
      .map((s) => ({ id: s.id, label: s.label, active: s.active }));
    expect(body).toMatchObject({
      user_id: target.userId,
      full_name: "Ahmad Islam",
      cohort: 1,
      cohort_code: "KAPDH 1",
      graduation_year: 1997,
      city: "Pekanbaru",
      last_education_institution: "Universitas Indonesia",
      last_education_city: "Jakarta",
      profession: { id: retiredProfession.id, label: retiredProfession.label, active: false },
      skills: expectedSkills,
      is_me: false,
      is_blocked_by_me: false,
      can_message: true,
      direct_room_id: null,
      avatar_url: null,
    });

    // Kartu direktori memakai label historis yang sama.
    const card = (await searchOk(caller.token, { city: "Pekanbaru", q: "ahmad islam" })).items.find(
      (item) => item.user_id === target.userId,
    );
    expect(card).toMatchObject({
      profession: { id: retiredProfession.id, active: false },
      skills: expectedSkills,
    });
  });

  it("N-09: profil yang tidak tampil di direktori atau pemiliknya memblokir pemanggil → 404 yang sama", async () => {
    const caller = await viewer();
    const blocker = await member({ status: "verified" });
    await block(blocker.userId, caller.userId);
    const targets = [
      await member({ status: "unverified" }),
      await member({ status: "expired" }),
      await member({ status: "suspended" }),
      await member({ status: "verified", showInDirectory: false }),
      await member({ status: "verified", accountStatus: "disabled" }),
      await member({ status: "verified", accountStatus: "deletion_pending" }),
      blocker,
    ];
    const bodies = [];
    for (const target of [...targets.map((m) => m.userId), uuidv7()]) {
      const res = await profileOf(caller.token, target);
      expect(res.statusCode, target).toBe(404);
      bodies.push(expectOperation("get", "/directory/{userId}", res) as Json);
    }
    // Pesan dan kode tidak membedakan alasan (blokir tidak diungkap).
    expect(new Set(bodies.map((b) => `${b.code}:${b.message}`)).size).toBe(1);
    expect(bodies[0]).toMatchObject({ code: "NOT_FOUND" });
  });

  it("userId bukan UUID → 400 VALIDATION_ERROR", async () => {
    const caller = await viewer();
    const res = await profileOf(caller.token, "bukan-uuid");
    expect(res.statusCode).toBe(400);
    expect(expectOperation("get", "/directory/{userId}", res)).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("profil sendiri dapat dipratinjau (is_me) walau show_in_directory=false, tanpa tombol pesan", async () => {
    const caller = await viewer({
      showInDirectory: false,
      profile: { phone: "+62 811 1111 2222", showPhone: false },
    });
    const res = await profileOf(caller.token, caller.userId);
    expect(res.statusCode).toBe(200);
    const body = expectOperation("get", "/directory/{userId}", res) as Json;
    expect(body).toMatchObject({
      user_id: caller.userId,
      is_me: true,
      is_blocked_by_me: false,
      can_message: false,
      direct_room_id: null,
    });
    // Pratinjau tampilan publik: flag privasi pemilik tetap berlaku.
    expect(body).not.toHaveProperty("phone");
  });

  it("AC F12-1: blokir tercermin: is_blocked_by_me=true dan can_message=false; profil tetap dapat dibuka", async () => {
    const caller = await viewer();
    const target = await member();
    await block(caller.userId, target.userId);
    const body = expectOperation(
      "get",
      "/directory/{userId}",
      await profileOf(caller.token, target.userId),
    ) as Json;
    expect(body).toMatchObject({ is_blocked_by_me: true, can_message: false });
  });

  it("direct_room_id berisi room direct yang sudah ada bila pemanggil anggota joined", async () => {
    const caller = await viewer();
    const target = await member();
    const now = t.clock.now();
    const [low, high] =
      caller.userId < target.userId ? [caller.userId, target.userId] : [target.userId, caller.userId];
    const roomId = uuidv7();
    await t.db.insert(rooms).values({
      id: roomId,
      kind: "direct",
      directKey: `${low}:${high}`,
      createdBy: caller.userId,
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(roomMembers).values(
      [caller.userId, target.userId].map((userId) => ({
        roomId,
        userId,
        status: "joined" as const,
        joinedAt: now,
        historyVisibleFrom: now,
        createdAt: now,
        updatedAt: now,
      })),
    );
    const body = expectOperation(
      "get",
      "/directory/{userId}",
      await profileOf(caller.token, target.userId),
    ) as Json;
    expect(body.direct_room_id).toBe(roomId);
    expect(body.can_message).toBe(true);

    // Room milik pasangan lain tidak pernah bocor.
    const stranger = await viewer();
    const other = expectOperation(
      "get",
      "/directory/{userId}",
      await profileOf(stranger.token, target.userId),
    ) as Json;
    expect(other.direct_room_id).toBeNull();
  });
});

describe("PRD 5.4: avatar anggota lain", () => {
  it("PRD 5.4, N-09: avatar_url bertanda tangan dapat dibuka penampil berhak dan mati saat profil disembunyikan", async () => {
    const city = uniqueCity();
    const caller = await viewer();
    const owner = await viewer({ city, fullName: "Pemilik Avatar" });
    const avatar = await uploadTestFile(t, owner.token, "avatar");
    await t.db.update(alumni).set({ avatarFileId: avatar.id }).where(eq(alumni.userId, owner.userId));

    const card = (await searchOk(caller.token, { city })).items[0]!;
    const url = String(card.avatar_url);
    expect(url.startsWith(`${t.env.API_PUBLIC_URL}/api/v1/files/content/`)).toBe(true);
    const open = () => t.app.inject({ method: "GET", url: url.slice(t.env.API_PUBLIC_URL.length) });
    expect((await open()).statusCode).toBe(200);
    const profile = expectOperation(
      "get",
      "/directory/{userId}",
      await profileOf(caller.token, owner.userId),
    ) as Json;
    expect(String(profile.avatar_url)).toContain("/api/v1/files/content/");

    // Akses dinilai ulang saat dibuka: pemilik keluar dari direktori → URL yang beredar tidak berlaku.
    await t.db.update(alumni).set({ showInDirectory: false }).where(eq(alumni.userId, owner.userId));
    expect((await open()).statusCode).toBe(404);
    await t.db.update(alumni).set({ showInDirectory: true }).where(eq(alumni.userId, owner.userId));
    expect((await open()).statusCode).toBe(200);
    // Blokir oleh pemilik juga mematikan URL.
    await block(owner.userId, caller.userId);
    expect((await open()).statusCode).toBe(404);

    // GET /files/{id}/access memakai kebijakan yang sama.
    const stranger = await viewer();
    const access = await api.get(`/files/${avatar.id}/access`, { token: stranger.token });
    expect(access.statusCode).toBe(200);
    const expired = await viewer({ status: "expired" });
    expect((await api.get(`/files/${avatar.id}/access`, { token: expired.token })).statusCode).toBe(404);
  });
});

describe("Batas laju anti-scraping", () => {
  /** Mengisi kuota langsung lewat RateLimitService (kunci yang sama dengan layanan) agar uji tidak membanjiri API. */
  async function spend(kind: "search" | "profile", windowMs: number, userId: string, hits: number) {
    const limits = t.app.get(RateLimitService);
    const rule = DIRECTORY_RATE_LIMITS[kind].find((r) => r.windowMs === windowMs)!;
    for (let i = 0; i < hits; i++)
      expect(await limits.consume(directoryRateLimitKey(kind, windowMs, userId), rule.limit, windowMs)).toBe(
        0,
      );
  }

  it("pencarian: permintaan ke-61 dalam semenit → 429 RATE_LIMITED dengan retry_after_seconds", async () => {
    const caller = await viewer();
    const city = uniqueCity();
    expect((await search(caller.token, { city })).statusCode).toBe(200);
    await spend("search", 60_000, caller.userId, 58);
    expect((await search(caller.token, { city })).statusCode).toBe(200);
    const limited = await search(caller.token, { city });
    expect(limited.statusCode).toBe(429);
    expect(expectOperation("get", "/directory", limited)).toMatchObject({
      code: "RATE_LIMITED",
      retry_after_seconds: expect.any(Number),
    });
    // Pengguna lain tidak terdampak.
    const other = await viewer();
    expect((await search(other.token, { city })).statusCode).toBe(200);
    // Jendela menit berlalu → boleh lagi.
    t.clock.advance(61_000);
    expect((await search(caller.token, { city })).statusCode).toBe(200);
  });

  it("pencarian: kuota per jam (600) menahan pengumpulan massal walau laju per menit rendah", async () => {
    const caller = await viewer();
    await spend("search", 3600_000, caller.userId, 599);
    expect((await search(caller.token)).statusCode).toBe(200);
    const limited = await search(caller.token);
    expect(limited.statusCode).toBe(429);
    expectOperation("get", "/directory", limited);
  });

  it("profil: permintaan ke-121 dalam semenit → 429 RATE_LIMITED", async () => {
    const caller = await viewer();
    const target = await member();
    await spend("profile", 60_000, caller.userId, 119);
    expect((await profileOf(caller.token, target.userId)).statusCode).toBe(200);
    const limited = await profileOf(caller.token, target.userId);
    expect(limited.statusCode).toBe(429);
    expect(expectOperation("get", "/directory/{userId}", limited)).toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("AC F10-5: jejaring tidak pernah mengubah profil", () => {
  it("AC F10-5: PATCH/PUT/POST/DELETE ke profil orang lain lewat jejaring ditolak 404 dan tidak ada field yang berubah", async () => {
    const caller = await viewer();
    const target = await member({ fullName: "Nama Asli", city: "Kota Asli" });
    const [before] = await t.db.select().from(alumni).where(eq(alumni.userId, target.userId));
    const payload = { full_name: "Nama Palsu", city: "Kota Palsu", phone: "+62 899 0000 0000" };
    for (const method of ["PATCH", "PUT", "POST", "DELETE"] as const) {
      for (const url of [`/api/v1/directory/${target.userId}`, "/api/v1/directory"]) {
        const res = await t.app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${caller.token}`, "if-match": String(before!.version) },
          ...(method === "DELETE" ? {} : { payload: { ...payload, user_id: target.userId } }),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
      }
    }
    const [after] = await t.db.select().from(alumni).where(eq(alumni.userId, target.userId));
    expect(after).toEqual(before);
  });
});
