import {
  alumni,
  alumniProfessions,
  alumniSkills,
  auditLogs,
  deviceTokens,
  events,
  masterProfessions,
  masterSkills,
  membershipEvents,
  notifications,
  otpCodes,
  outboxEvents,
  reports,
  sessions,
  tickets,
  users,
} from "@kapdh/database";
import { and, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { otpHmac } from "../../src/core/identity/crypto.js";
import { addCalendarMonthsJakarta } from "../../src/core/membership/period.js";
import { expectOperation, expectSchema } from "../support/contract.js";
import { type AlumniFixture, createAlumni, signInAlumni } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  type AdminActor,
  adminWith,
  approveMembershipPayment,
  getCard,
  parseQr,
  reauthTokenFor,
  verifyKta,
} from "./helpers.js";

/**
 * Anggota untuk pengurus (kontrak admin-members.yaml; F-15, F-16; PRD 2.3, 4.2): daftar server-side, detail tersaring
 * per izin, koreksi administratif, suspend/unsuspend (AC F12-3..F12-5), pemulihan sandi oleh Super Admin (AC F16-4) dan
 * histori keanggotaan, termasuk uji negatif hak akses.
 */

let t: TestApp;
const DAY_MS = 24 * 3600_000;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

type Page = { items: Record<string, unknown>[]; next_cursor: string | null; total: number };
type Detail = Record<string, unknown> & { version: string; member_number: string | null };

const api = () => httpClient(t.app);

async function list(token: string, query: Record<string, string>): Promise<Page> {
  const res = await api().get("/admin/members", { token, query });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/admin/members", res) as Page;
}

async function allPages(token: string, query: Record<string, string>): Promise<Page["items"]> {
  const items: Page["items"] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const page = await list(token, { ...query, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return items;
}

async function detailOf(token: string, userId: string): Promise<Detail> {
  const res = await api().get(`/admin/members/${userId}`, { token });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/admin/members/{userId}", res) as Detail;
}

async function seedMaster(kind: "profession" | "skill") {
  const id = uuidv7();
  const now = t.clock.now();
  await t.db
    .insert(kind === "profession" ? masterProfessions : masterSkills)
    .values({ id, label: `${kind} admin ${id.slice(-8)}`, createdAt: now, updatedAt: now });
  return id;
}

async function insertReport(
  targetUserId: string,
  options: {
    category?: "spam" | "appeal";
    status?: "open" | "in_review" | "resolved";
    reporterId?: string;
  } = {},
) {
  const id = uuidv7();
  const now = t.clock.now();
  const status = options.status ?? "open";
  await t.db.insert(reports).values({
    id,
    reporterId: options.reporterId ?? (options.category === "appeal" ? targetUserId : null),
    targetType: "user",
    targetUserId,
    category: options.category ?? "spam",
    status,
    claimedAt: status === "in_review" ? now : null,
    resolutionNote: status === "resolved" ? "Ditangani (uji)" : null,
    resolvedAt: status === "resolved" ? now : null,
    action: status === "resolved" ? "dismiss" : null,
    dueAt: new Date(now.getTime() + 2 * DAY_MS),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("GET /admin/members (F-15, AC F10-1)", () => {
  const COHORT = 7;
  let fixtures: Record<string, AlumniFixture>;
  let reader: AdminActor;
  let professionId: string;
  let skillId: string;

  beforeAll(async () => {
    reader = await adminWith(t, ["members.read"]);
    const make = (status: Parameters<typeof createAlumni>[1]) =>
      createAlumni(t, { cohort: COHORT, ...status });
    fixtures = {
      verified: await make({ status: "verified", fullName: "Zainal Verified", city: "Cianjur" }),
      expiring: await make({
        status: "expiring",
        fullName: "Aisyah Expiring",
        gender: "female",
        city: "cianjur",
      }),
      expired: await make({ status: "expired", fullName: "Budi Expired", city: "Garut" }),
      unverified: await make({ status: "unverified", fullName: "Citra Belum Bayar", gender: "female" }),
      suspended: await make({ status: "suspended", fullName: "Dodi Dibatasi" }),
      pending: await make({ status: "pending_otp", fullName: "Eka Belum OTP" }),
      disabled: await make({ status: "verified", accountStatus: "disabled", fullName: "Fajar Nonaktif" }),
      deleting: await make({ status: "verified", accountStatus: "deletion_pending", fullName: "Gita Hapus" }),
      deleted: await make({ status: "verified", accountStatus: "deleted", fullName: "Hadi Terhapus" }),
    };
    professionId = await seedMaster("profession");
    skillId = await seedMaster("skill");
    const now = t.clock.now();
    await t.db
      .insert(alumniProfessions)
      .values({ alumniUserId: fixtures.verified!.userId, professionId, createdAt: now });
    await t.db
      .insert(alumniSkills)
      .values({ alumniUserId: fixtures.expired!.userId, skillId, createdAt: now });
    await adminWith(t, ["payments.read"], { linkedAlumniUserId: fixtures.expiring!.userId });
  });

  it("AC F10-1: total sesuai filter, akun terhapus tidak tampil, effective_status dari timestamp", async () => {
    const page = await list(reader.token, { cohort: String(COHORT), limit: "100" });
    expect(page.total).toBe(8);
    const ids = page.items.map((item) => item.user_id);
    expect(ids).not.toContain(fixtures.deleted!.userId);
    const byId = new Map(page.items.map((item) => [item.user_id, item]));
    expect(byId.get(fixtures.verified!.userId)).toMatchObject({
      effective_status: "verified",
      account_status: "active",
      cohort_code: "KAPDH 7",
      profession_label: expect.any(String),
      has_linked_admin: false,
    });
    expect(byId.get(fixtures.pending!.userId)).toMatchObject({
      effective_status: "pending_otp",
      member_number: null,
    });
    expect(byId.get(fixtures.disabled!.userId)).toMatchObject({ effective_status: "disabled" });
    expect(byId.get(fixtures.expiring!.userId)).toMatchObject({ has_linked_admin: true });

    for (const [status, key] of [
      ["verified", "verified"],
      ["expiring", "expiring"],
      ["expired", "expired"],
      ["unverified", "unverified"],
      ["suspended", "suspended"],
      ["pending_otp", "pending"],
      ["disabled", "disabled"],
      ["deletion_pending", "deleting"],
    ] as const) {
      const filtered = await list(reader.token, { cohort: String(COHORT), effective_status: status });
      expect(filtered.total, status).toBe(1);
      expect(filtered.items[0]!.user_id, status).toBe(fixtures[key]!.userId);
    }
  });

  it("AC F10-1: filter kota (tidak peka huruf besar), jenis kelamin, profesi, keahlian, tertaut admin dan pencarian q", async () => {
    const base = { cohort: String(COHORT) };
    const ids = async (query: Record<string, string>) =>
      (await list(reader.token, { ...base, ...query, limit: "100" })).items
        .map((item) => item.user_id)
        .sort();
    expect(await ids({ city: "CIANJUR" })).toEqual(
      [fixtures.verified!.userId, fixtures.expiring!.userId].sort(),
    );
    expect(await ids({ gender: "female" })).toEqual(
      [fixtures.expiring!.userId, fixtures.unverified!.userId].sort(),
    );
    expect(await ids({ profession_id: professionId })).toEqual([fixtures.verified!.userId]);
    expect(await ids({ skill_id: skillId })).toEqual([fixtures.expired!.userId]);
    expect(await ids({ has_linked_admin: "true" })).toEqual([fixtures.expiring!.userId]);
    expect((await ids({ has_linked_admin: "false" })).length).toBe(7);
    expect(await ids({ q: "dibatasi" })).toEqual([fixtures.suspended!.userId]);
    expect(await ids({ q: fixtures.expired!.email.toUpperCase() })).toEqual([fixtures.expired!.userId]);
    expect(await ids({ q: fixtures.verified!.memberNumber! })).toEqual([fixtures.verified!.userId]);
    expect(await ids({ q: "garut" })).toEqual([fixtures.expired!.userId]);
    // Karakter wildcard dari masukan diperlakukan literal.
    expect(await ids({ q: "%" })).toEqual([]);
  });

  it("AC F10-1: paging keyset setiap urutan tanpa duplikasi/terlewat; expires_at null di akhir; cursor terikat filter", async () => {
    const base = { cohort: String(COHORT), limit: "3" };
    for (const sort of [
      "registered_desc",
      "registered_asc",
      "name_asc",
      "name_desc",
      "cohort_asc",
      "cohort_desc",
      "member_number_asc",
      "expires_at_asc",
      "expires_at_desc",
    ]) {
      const items = await allPages(reader.token, { ...base, sort });
      const ids = items.map((item) => item.user_id);
      expect(ids, sort).toHaveLength(8);
      expect(new Set(ids).size, sort).toBe(8);
      if (sort === "name_asc") {
        const names = items.map((item) => String(item.full_name).toLowerCase());
        expect(names).toEqual([...names].sort());
      }
      if (sort.startsWith("expires_at")) {
        const nulls = items.map((item) => item.expires_at === null);
        expect(nulls.slice(nulls.indexOf(true)).every(Boolean), sort).toBe(true);
        const dates = items.filter((item) => item.expires_at).map((item) => String(item.expires_at));
        const sorted = [...dates].sort();
        expect(dates, sort).toEqual(sort === "expires_at_asc" ? sorted : sorted.reverse());
      }
      if (sort === "member_number_asc") expect(items[items.length - 1]!.member_number).toBeNull();
    }
    const first = await list(reader.token, { ...base, sort: "name_asc" });
    const reused = await api().get("/admin/members", {
      token: reader.token,
      query: { cohort: "8", sort: "name_asc", cursor: first.next_cursor! },
    });
    expect(reused.statusCode).toBe(400);
    expect(expectOperation("get", "/admin/members", reused)).toMatchObject({
      field_errors: { cursor: [expect.any(String)] },
    });
    const otherSort = await api().get("/admin/members", {
      token: reader.token,
      query: { ...base, sort: "name_desc", cursor: first.next_cursor! },
    });
    expect(otherSort.statusCode).toBe(400);
    const garbage = await api().get("/admin/members", {
      token: reader.token,
      query: { cursor: "bukan-cursor" },
    });
    expect(garbage.statusCode).toBe(400);
  });

  it("AC F15-1: tanpa members.read 403; token anggota 403; tanpa sesi 401; parameter tidak valid 400", async () => {
    const payments = await adminWith(t, ["payments.read"]);
    const denied = await api().get("/admin/members", { token: payments.token });
    expect(denied.statusCode).toBe(403);
    expect(expectOperation("get", "/admin/members", denied)).toMatchObject({ code: "FORBIDDEN" });
    const member = await signInAlumni(t, fixtures.verified!);
    expect((await api().get("/admin/members", { token: member.accessToken })).statusCode).toBe(403);
    expect((await api().get("/admin/members")).statusCode).toBe(401);
    const invalid = await api().get("/admin/members", {
      token: reader.token,
      query: { effective_status: "aktif", cohort: "0" },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("GET /admin/members/{userId} (F-10, F-15, AC F15-1)", () => {
  it("AC F15-1, F-10: kontak tampil terlepas dari privasi; setiap pembukaan dicatat audit member.viewed tanpa salinan data", async () => {
    const member = await createAlumni(t, { status: "verified" });
    await t.db
      .update(alumni)
      .set({ phone: "+62 811 1111 2222", socialX: "alumni_x", showPhone: false })
      .where(eq(alumni.userId, member.userId));
    const reader = await adminWith(t, ["members.read"]);
    const detail = await detailOf(reader.token, member.userId);
    expect(detail).toMatchObject({
      phone: "+62 811 1111 2222",
      social_x: "alumni_x",
      privacy: { show_phone: false },
      email: member.email,
      linked_admin: null,
      suspension: null,
      version: expect.any(String),
    });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "member.viewed"), eq(auditLogs.entityId, member.userId)));
    expect(audit).toMatchObject({ actorAdminId: reader.admin.adminId, before: null, after: null });
  });

  it("AC F15-1: recent_payments, recent_tickets, moderation dan alasan suspend disaring per izin", async () => {
    const member = await createAlumni(t, { status: "suspended" });
    await approveMembershipPayment(t, member.userId, "renewal");
    const now = t.clock.now();
    const eventId = uuidv7();
    await t.db.insert(events).values({
      id: eventId,
      title: "Reuni Akbar (uji)",
      startsAt: new Date(now.getTime() + 10 * DAY_MS),
      endsAt: new Date(now.getTime() + 10 * DAY_MS + 4 * 3600_000),
      registrationOpensAt: new Date(now.getTime() - DAY_MS),
      registrationClosesAt: new Date(now.getTime() + 9 * DAY_MS),
      price: "50000.00",
      seatsTotal: 50,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(tickets).values({
      id: uuidv7(),
      eventId,
      userId: member.userId,
      status: "expired",
      totalSnapshot: "50000.00",
      createdAt: now,
      updatedAt: now,
    });
    await insertReport(member.userId, { status: "open" });
    await insertReport(member.userId, { status: "resolved" });
    await insertReport(member.userId, { category: "appeal" });
    await t.db.insert(membershipEvents).values({
      id: uuidv7(),
      userId: member.userId,
      kind: "warn",
      reason: "Peringatan (uji)",
      createdAt: now,
    });

    const reader = await adminWith(t, ["members.read"]);
    const minimal = await detailOf(reader.token, member.userId);
    expect(minimal).toMatchObject({
      recent_payments: null,
      recent_tickets: null,
      moderation: null,
      suspension: { reason: null, reason_redacted: true, member_message: expect.any(String) },
      effective_status: "suspended",
    });

    const events_ = await adminWith(t, ["members.read", "events.manage"]);
    const withTickets = await detailOf(events_.token, member.userId);
    expect(withTickets.recent_payments).toBeNull();
    expect(withTickets.recent_tickets).toEqual([
      expect.objectContaining({ event_title: "Reuni Akbar (uji)", status: "expired", total: "50000.00" }),
    ]);

    const full = await adminWith(t, ["members.read", "payments.read", "moderation.read"]);
    const detail = await detailOf(full.token, member.userId);
    expect(detail.recent_payments).toEqual([expect.objectContaining({ type: "renewal", status: "paid" })]);
    expect(detail.recent_tickets).toHaveLength(1);
    expect(detail.moderation).toEqual({
      open_report_count: 1,
      total_report_count: 2,
      warning_count: 1,
      last_action_at: now.toISOString(),
    });
    expect(detail.suspension).toMatchObject({ reason: expect.any(String), reason_redacted: false });
    expect(detail.periods).toEqual([expect.objectContaining({ kind: "renewal" })]);

    // Konflik kepentingan C6 butir c: pengurus yang membuka akun tertautnya sendiri tidak melihat hitungan laporan.
    const self = await adminWith(t, ["members.read", "moderation.read"], {
      linkedAlumniUserId: member.userId,
    });
    const own = await detailOf(self.token, member.userId);
    expect(own.moderation).toMatchObject({ open_report_count: 0, total_report_count: 0 });
    expect(own.linked_admin).toMatchObject({ admin_id: self.admin.adminId, role: "admin", status: "active" });
  });

  it("AC F15-1, N-09: 404 untuk akun bukan alumni, id acak, akun terhapus dan id bukan UUID", async () => {
    const reader = await adminWith(t, ["members.read"]);
    const deleted = await createAlumni(t, { status: "verified", accountStatus: "deleted" });
    for (const id of [reader.admin.userId, uuidv7(), deleted.userId, "bukan-uuid"]) {
      const res = await api().get(`/admin/members/${id}`, { token: reader.token });
      expect(res.statusCode, id).toBe(404);
      expectOperation("get", "/admin/members/{userId}", res);
    }
  });
});

describe("PATCH /admin/members/{userId} (PRD 2.3, 3.5, AC F15-4)", () => {
  it("AC F17-1, F10-4: koreksi data administratif beralasan dengan audit tanpa salinan kontak; master aktif; hapus foto", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    const avatar = await uploadTestFile(t, session.accessToken, "avatar");
    await t.db.update(alumni).set({ avatarFileId: avatar.id }).where(eq(alumni.userId, member.userId));
    const manager = await adminWith(t, ["members.read", "members.manage"]);
    const before = await detailOf(manager.token, member.userId);
    const profession = await seedMaster("profession");
    const res = await api().patch(
      `/admin/members/${member.userId}`,
      {
        reason: "Permintaan anggota lewat bantuan",
        full_name: "Nama Dikoreksi",
        phone: "+62 812 0000 1111",
        social_instagram: "@baru",
        profession_id: profession,
        remove_avatar: true,
      },
      { token: manager.token, headers: { "if-match": before.version } },
    );
    expect(res.statusCode, res.body).toBe(200);
    const updated = expectOperation("patch", "/admin/members/{userId}", res) as Detail;
    expect(updated).toMatchObject({
      full_name: "Nama Dikoreksi",
      phone: "+62 812 0000 1111",
      social_instagram: "baru",
      profession: { id: profession },
      avatar_file_id: null,
      avatar_url: null,
    });
    expect(Number(updated.version)).toBeGreaterThan(Number(before.version));
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "member.updated"), eq(auditLogs.entityId, member.userId)));
    expect(audit).toMatchObject({
      reason: "Permintaan anggota lewat bantuan",
      actorAdminId: manager.admin.adminId,
    });
    expect(audit!.before).toMatchObject({ full_name: "Alumni Uji", avatar_removed: false });
    expect(audit!.after).toMatchObject({
      full_name: "Nama Dikoreksi",
      changed_contact_fields: ["phone", "social_instagram"],
    });
    expect(JSON.stringify(audit!.after)).not.toContain("0000 1111");

    // Master nonaktif tidak dapat dipilih baru oleh pengurus (AC F10-4).
    const inactive = uuidv7();
    await t.db.insert(masterSkills).values({
      id: inactive,
      label: `nonaktif ${inactive.slice(-8)}`,
      active: false,
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });
    const badSkill = await api().patch(
      `/admin/members/${member.userId}`,
      { reason: "Tambah keahlian", skill_ids: [inactive] },
      { token: manager.token, headers: { "if-match": updated.version } },
    );
    expect(badSkill.statusCode).toBe(400);
  });

  it("profil berulang: pengurus mengganti profesi, pendidikan dan tautan; audit hanya nama field; daftar dan filter memakai profesi mana pun", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const manager = await adminWith(t, ["members.read", "members.manage"]);
    const before = await detailOf(manager.token, member.userId);
    const profession = await seedMaster("profession");
    const [master] = await t.db.select().from(masterProfessions).where(eq(masterProfessions.id, profession));
    const res = await api().patch(
      `/admin/members/${member.userId}`,
      {
        reason: "Koreksi riwayat sesuai permintaan anggota",
        professions: ["Wiraswasta Kuliner", master!.label.toUpperCase()],
        education: [
          { institution: "Universitas Contoh", level: "s1", graduation_year: 2016 },
          { institution: "Universitas Lanjut", major: "Manajemen", level: "s2", graduation_year: 2021 },
        ],
        social_links: [{ platform: "threads", value: "@rahasia.threads" }],
      },
      { token: manager.token, headers: { "if-match": before.version } },
    );
    expect(res.statusCode, res.body).toBe(200);
    const updated = expectOperation("patch", "/admin/members/{userId}", res) as Detail;
    expect(updated).toMatchObject({
      professions: ["Wiraswasta Kuliner", master!.label],
      profession: { id: profession },
      profession_label: "Wiraswasta Kuliner",
      education: [
        { institution: "Universitas Lanjut", major: "Manajemen", level: "s2", graduation_year: 2021 },
        { institution: "Universitas Contoh", major: null, level: "s1", graduation_year: 2016 },
      ],
      social_links: [{ platform: "threads", value: "rahasia.threads" }],
      last_education_institution: "Universitas Lanjut",
    });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "member.updated"), eq(auditLogs.entityId, member.userId)));
    expect(audit!.after).toMatchObject({
      changed_contact_fields: ["professions", "education", "social_links"],
    });
    for (const secret of ["Wiraswasta", "Universitas Lanjut", "rahasia.threads"])
      expect(JSON.stringify([audit!.before, audit!.after])).not.toContain(secret);

    // Daftar pengurus: label profesi utama = profesi pertama; filter cocok dengan profesi kedua (bertaut master).
    const list = await api().get("/admin/members", {
      token: manager.token,
      query: { profession_id: profession },
    });
    const page = expectOperation("get", "/admin/members", list) as { items: Record<string, unknown>[] };
    expect(page.items.find((item) => item.user_id === member.userId)).toMatchObject({
      profession_label: "Wiraswasta Kuliner",
    });

    const mixed = await api().patch(
      `/admin/members/${member.userId}`,
      { reason: "Campur field lama", social_links: [], social_linkedin: null },
      { token: manager.token, headers: { "if-match": updated.version } },
    );
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().field_errors).toHaveProperty("social_linkedin");
  });

  it("AC F10-4: profession_entries sejajar dengan professions dan menandai SETIAP master nonaktif, bukan hanya profesi bertaut pertama", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const manager = await adminWith(t, ["members.read", "members.manage"]);
    const first = await seedMaster("profession");
    const second = await seedMaster("profession");
    const labelOf = async (id: string) =>
      (await t.db.select().from(masterProfessions).where(eq(masterProfessions.id, id)))[0]!.label;
    const firstLabel = await labelOf(first);
    const secondLabel = await labelOf(second);
    const before = await detailOf(manager.token, member.userId);
    expect(before.profession_entries).toEqual([]);
    const res = await api().patch(
      `/admin/members/${member.userId}`,
      { reason: "Profesi jamak anggota", professions: [firstLabel, "Penulis Lepas", secondLabel] },
      { token: manager.token, headers: { "if-match": before.version } },
    );
    expect(res.statusCode, res.body).toBe(200);
    // Master kedua dinonaktifkan setelah terpasang: tetap tertaut sebagai label historis.
    await t.db.update(masterProfessions).set({ active: false }).where(eq(masterProfessions.id, second));

    const detail = await detailOf(manager.token, member.userId);
    expect(detail.profession).toEqual({ id: first, label: firstLabel, active: true });
    expect(detail.profession_entries).toEqual([
      { label: firstLabel, master: { id: first, label: firstLabel, active: true } },
      { label: "Penulis Lepas", master: null },
      { label: secondLabel, master: { id: second, label: secondLabel, active: false } },
    ]);
    expect((detail.profession_entries as { label: string }[]).map((e) => e.label)).toEqual(
      detail.professions,
    );
  });

  it("AC F15-4: versi lama → 409 dengan current tersaring; validasi alasan/field; tertaut sendiri 403; deletion_pending 400; izin", async () => {
    const member = await createAlumni(t, { status: "suspended" });
    const manager = await adminWith(t, ["members.read", "members.manage"]);
    const v = (await detailOf(manager.token, member.userId)).version;
    const patch = (body: unknown, token = manager.token, version = v, id = member.userId) =>
      api().patch(`/admin/members/${id}`, body, { token, headers: { "if-match": version } });

    expect((await patch({ reason: "Koreksi kota", city: "Ciamis" })).statusCode).toBe(200);
    const stale = await patch({ reason: "Koreksi kota lagi", city: "Banjar" });
    expect(stale.statusCode).toBe(409);
    const conflict = expectOperation("patch", "/admin/members/{userId}", stale) as {
      code: string;
      current: Detail;
    };
    expect(conflict.code).toBe("VERSION_CONFLICT");
    expectSchema("AdminMemberDetail", conflict.current);
    expect(conflict.current).toMatchObject({
      city: "Ciamis",
      recent_payments: null,
      moderation: null,
      suspension: { reason: null, reason_redacted: true },
    });

    const fresh = conflict.current.version;
    for (const [body, field] of [
      [{ city: "X" }, "reason"],
      [{ reason: "   ", city: "Banjar" }, "reason"],
      [{ reason: "Hanya alasan" }, "_"],
      [{ reason: "Email baru", email: "baru@contoh.test" }, "email"],
      [{ reason: "Privasi", privacy: { show_phone: true } }, "privacy"],
      [{ reason: "Kelas", class_in: 5, class_out: 4 }, "class_out"],
    ] as const) {
      const res = await patch(body, manager.token, fresh);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().field_errors, JSON.stringify(body)).toHaveProperty([field]);
    }
    expect((await patch({ reason: "Tanpa If-Match", city: "Banjar" }, manager.token, "")).statusCode).toBe(
      400,
    );

    const readOnly = await adminWith(t, ["members.read"]);
    expect((await patch({ reason: "Coba", city: "Banjar" }, readOnly.token, fresh)).statusCode).toBe(403);
    const self = await adminWith(t, ["members.read", "members.manage"], {
      linkedAlumniUserId: member.userId,
    });
    const own = await patch({ reason: "Ubah akun sendiri", city: "Banjar" }, self.token, fresh);
    expect(own.statusCode).toBe(403);
    expect(own.json().code).toBe("FORBIDDEN");

    const deleting = await createAlumni(t, { status: "verified", accountStatus: "deletion_pending" });
    const dv = (await detailOf(manager.token, deleting.userId)).version;
    expect(
      (await patch({ reason: "Koreksi", city: "Banjar" }, manager.token, dv, deleting.userId)).statusCode,
    ).toBe(400);
  });

  it("AC F05-6: koreksi identitas akun pending_otp (belum bernomor) tercatat member.identity_corrected tanpa nomor", async () => {
    const member = await createAlumni(t, { status: "pending_otp", cohort: 20 });
    const manager = await adminWith(t, ["members.read", "members.manage"]);
    const v = (await detailOf(manager.token, member.userId)).version;
    const res = await api().patch(
      `/admin/members/${member.userId}`,
      { reason: "Salah pilih angkatan", cohort: 21 },
      { token: manager.token, headers: { "if-match": v } },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ cohort: 21, member_number: null, cohort_code: "KAPDH 21" });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "member.identity_corrected"), eq(auditLogs.entityId, member.userId)));
    expect(audit).toBeDefined();
  });
});

describe("POST /admin/members/{userId}/suspend dan /unsuspend (AC F12-3, F12-4, F12-5)", () => {
  const moderatorPermissions = ["members.read", "moderation.read", "moderation.resolve"] as const;

  async function suspendCall(
    actor: AdminActor,
    userId: string,
    version: string,
    key = uuidv7(),
    body?: unknown,
  ) {
    return api().post(
      `/admin/members/${userId}/suspend`,
      body ?? {
        reason: "Spam berulang di grup (uji)",
        member_message: "Akun Anda dibatasi karena spam.",
        confirm: true,
      },
      { token: actor.token, headers: { "if-match": version, "idempotency-key": key } },
    );
  }

  it("AC F12-3, F12-4: suspend mencatat alasan/aktor/waktu, mencabut sesi, notifikasi /restricted, periode tetap, KTA Tidak aktif; idempoten", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    const qr = parseQr((await getCard(t, session.accessToken)).qr!.url);
    const moderator = await adminWith(t, [...moderatorPermissions]);
    const v = (await detailOf(moderator.token, member.userId)).version;

    const unconfirmed = await suspendCall(moderator, member.userId, v, uuidv7(), {
      reason: "Spam",
      member_message: "Dibatasi",
      confirm: false,
    });
    expect(unconfirmed.statusCode).toBe(400);

    const key = uuidv7();
    const res = await suspendCall(moderator, member.userId, v, key);
    expect(res.statusCode, res.body).toBe(200);
    const detail = expectOperation("post", "/admin/members/{userId}/suspend", res) as Detail;
    expect(detail).toMatchObject({
      effective_status: "suspended",
      expires_at: member.expiresAt!.toISOString(),
      suspension: {
        reason: "Spam berulang di grup (uji)",
        reason_redacted: false,
        member_message: "Akun Anda dibatasi karena spam.",
        suspended_by: { admin_id: moderator.admin.adminId },
        suspended_at: t.clock.now().toISOString(),
      },
    });
    const replay = await suspendCall(moderator, member.userId, v, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(res.json());
    const again = await suspendCall(moderator, member.userId, detail.version);
    expect(again.statusCode).toBe(400);

    const [event] = await t.db
      .select()
      .from(membershipEvents)
      .where(and(eq(membershipEvents.userId, member.userId), eq(membershipEvents.kind, "suspend")));
    expect(event).toMatchObject({
      actorAdminId: moderator.admin.adminId,
      reason: "Spam berulang di grup (uji)",
    });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "member.suspended"), eq(auditLogs.entityId, member.userId)));
    expect(audit).toMatchObject({
      actorAdminId: moderator.admin.adminId,
      reason: "Spam berulang di grup (uji)",
    });
    const [notice] = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, member.userId), eq(notifications.category, "account")));
    expect(notice).toMatchObject({ body: "Akun Anda dibatasi karena spam.", data: { route: "/restricted" } });
    expect((await api().get("/me", { token: session.accessToken })).statusCode).toBe(401);
    expect((await verifyKta(t, qr.memberNumber, qr.token)).body.result).toBe("inactive");
  });

  it("AC F12-3: izin sama dengan jalur moderasi; akun tertaut sendiri 403; If-Match lama 409 dengan current", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const noModerationRead = await adminWith(t, ["members.read", "moderation.resolve"]);
    const reader = await adminWith(t, ["members.read"]);
    const v = (await detailOf(reader.token, member.userId)).version;
    expect((await suspendCall(noModerationRead, member.userId, v)).statusCode).toBe(403);
    const self = await adminWith(t, [...moderatorPermissions], { linkedAlumniUserId: member.userId });
    expect((await suspendCall(self, member.userId, v)).statusCode).toBe(403);
    const moderator = await adminWith(t, [...moderatorPermissions]);
    const stale = await suspendCall(moderator, member.userId, String(Number(v) + 5));
    expect(stale.statusCode).toBe(409);
    const conflict = expectOperation("post", "/admin/members/{userId}/suspend", stale) as { current: Detail };
    expectSchema("AdminMemberDetail", conflict.current);
  });

  it("AC F12-5: unsuspend menghitung ulang dari expires_at; banding aktif ditutup dikabulkan dengan satu notifikasi", async () => {
    const member = await createAlumni(t, { status: "suspended" });
    // Masa aktif habis selama dibatasi → hasil unsuspend expired, bukan otomatis verified.
    const expiredAt = new Date(t.clock.now().getTime() - DAY_MS);
    await t.db
      .update(alumni)
      .set({ startsAt: addCalendarMonthsJakarta(expiredAt, -12), expiresAt: expiredAt })
      .where(eq(alumni.userId, member.userId));
    const appealId = await insertReport(member.userId, { category: "appeal", status: "in_review" });
    const moderator = await adminWith(t, [...moderatorPermissions]);
    const v = (await detailOf(moderator.token, member.userId)).version;
    const res = await api().post(
      `/admin/members/${member.userId}/unsuspend`,
      {
        reason: "Banding diterima setelah klarifikasi",
        member_message: "Terima kasih atas klarifikasinya.",
        confirm: true,
      },
      { token: moderator.token, headers: { "if-match": v, "idempotency-key": uuidv7() } },
    );
    expect(res.statusCode, res.body).toBe(200);
    const detail = expectOperation("post", "/admin/members/{userId}/unsuspend", res) as Detail;
    expect(detail).toMatchObject({ effective_status: "expired", suspension: null });

    const [appeal] = await t.db.select().from(reports).where(eq(reports.id, appealId));
    expect(appeal).toMatchObject({
      status: "resolved",
      action: "unsuspend",
      resolvedByAdminId: moderator.admin.adminId,
      memberMessage: "Terima kasih atas klarifikasinya.",
      version: 2,
    });
    expect(appeal!.resolutionNote).toContain("Banding diterima setelah klarifikasi");
    const appealAudits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "moderation.report_resolved"), eq(auditLogs.entityId, appealId)));
    expect(appealAudits).toHaveLength(1);
    const inbox = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, member.userId), eq(notifications.category, "account")));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ title: "Banding dikabulkan", data: { route: "/renewal" } });
    expect(inbox[0]!.body).toContain("Terima kasih atas klarifikasinya.");

    // Belum pernah paid → unverified; tidak sedang dibatasi → 400.
    const unpaid = await createAlumni(t, { status: "suspended" });
    await t.db
      .update(alumni)
      .set({ startsAt: null, expiresAt: null })
      .where(eq(alumni.userId, unpaid.userId));
    const uv = (await detailOf(moderator.token, unpaid.userId)).version;
    const unpaidRes = await api().post(
      `/admin/members/${unpaid.userId}/unsuspend`,
      { reason: "Pembatasan tidak diperlukan", confirm: true },
      { token: moderator.token, headers: { "if-match": uv } },
    );
    expect(unpaidRes.json()).toMatchObject({ effective_status: "unverified" });
    const notSuspended = await api().post(
      `/admin/members/${unpaid.userId}/unsuspend`,
      { reason: "Ulang", confirm: true },
      { token: moderator.token, headers: { "if-match": String(unpaidRes.json().version) } },
    );
    expect(notSuspended.statusCode).toBe(400);
    expectOperation("post", "/admin/members/{userId}/unsuspend", notSuspended);
  });
});

describe("POST /admin/members/{userId}/password-reset (F-16, AC F16-4)", () => {
  async function reset(actor: AdminActor, userId: string, options: { reauth?: boolean; key?: string } = {}) {
    const headers: Record<string, string> = { "idempotency-key": options.key ?? uuidv7() };
    if (options.reauth !== false) headers["x-reauth-token"] = await reauthTokenFor(t, actor.token);
    return api().post(
      `/admin/members/${userId}/password-reset`,
      { reason: "Anggota kehilangan akses email lama (tiket bantuan)", confirm: true },
      { token: actor.token, headers },
    );
  }

  it("AC F16-4: seluruh sesi target dicabut, notifikasi keamanan, challenge hanya ke email terverifikasi dengan tautan kanonik; kode tidak bocor", async () => {
    const member = await createAlumni(t, { status: "suspended" });
    const first = await signInAlumni(t, member);
    const second = await signInAlumni(t, member);
    await t.db.insert(deviceTokens).values({
      id: uuidv7(),
      userId: member.userId,
      platform: "android",
      token: `fcm-uji-${uuidv7()}`,
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });
    const superAdmin = await adminWith(t, [], { role: "super_admin" });

    const res = await reset(superAdmin, member.userId);
    expect(res.statusCode, res.body).toBe(202);
    const body = expectOperation("post", "/admin/members/{userId}/password-reset", res) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(["challenge_expires_at", "initiated_at", "sessions_revoked"]);
    expect(body.sessions_revoked).toBe(2);
    expect(body.challenge_expires_at).toBe(new Date(t.clock.now().getTime() + 10 * 60_000).toISOString());

    for (const session of [first, second])
      expect((await api().get("/me", { token: session.accessToken })).statusCode).toBe(401);
    const active = await t.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, member.userId)));
    expect(active.every((s) => s.revokedAt !== null)).toBe(true);
    const [device] = await t.db.select().from(deviceTokens).where(eq(deviceTokens.userId, member.userId));
    expect(device!.revokedAt).not.toBeNull();

    const [challenge] = await t.db
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.userId, member.userId), eq(otpCodes.purpose, "password_reset")))
      .orderBy(desc(otpCodes.createdAt));
    const mail = t.mailer.sent.filter((m) => m.to === member.email).at(-1)!;
    expect(mail).toMatchObject({
      purpose: "password_reset",
      options: { adminInitiatedChallengeId: challenge!.id },
    });
    expect(mail.text).toContain(`kapdh://app/forgot/otp?challenge_id=${challenge!.id}`);
    expect(mail.text).toContain(mail.code);
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(challenge!.codeHmac).toBe(otpHmac(t.env.OTP_HMAC_SECRET, challenge!.id, mail.code));

    const [notice] = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, member.userId), eq(notifications.category, "security")));
    expect(notice!.title).toBe("Pemulihan sandi dimulai pengurus");
    expect(JSON.stringify(notice)).not.toContain(challenge!.id);
    expect(JSON.stringify(notice)).not.toContain(mail.code);
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "member.password_reset_initiated"), eq(auditLogs.entityId, member.userId)),
      );
    expect(audit).toMatchObject({ actorAdminId: superAdmin.admin.adminId, effectiveRole: "super_admin" });
    expect(JSON.stringify(audit)).not.toContain(mail.code);
    expect(res.body).not.toContain(mail.code);

    // Outbox topik diproses handler modul (tidak menjadi event mati); pemberitahuan tidak digandakan.
    const [event] = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.topic, "member.password_reset_initiated"))
      .orderBy(desc(outboxEvents.createdAt))
      .limit(1);
    expect(event!.dedupKey).not.toContain(challenge!.id);
    expect(event).toMatchObject({
      topic: "member.password_reset_initiated",
      payload: { user_id: member.userId },
    });
    await t.jobs.dispatchOutbox();
    const [processed] = await t.db.select().from(outboxEvents).where(eq(outboxEvents.id, event!.id));
    expect(processed!.status).toBe("dispatched");
    const notices = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, member.userId), eq(notifications.category, "security")));
    expect(notices).toHaveLength(1);

    // Inisiasi berikutnya mensupersede challenge sebelumnya (PRD 2.5).
    t.clock.advance(61_000);
    expect((await reset(superAdmin, member.userId)).statusCode).toBe(202);
    const [old] = await t.db.select().from(otpCodes).where(eq(otpCodes.id, challenge!.id));
    expect(old!.supersededAt).not.toBeNull();
  });

  it("AC F16-4 negatif: hanya Super Admin dengan reautentikasi; akun tidak aktif 400; akun tertaut sendiri 403; replay tidak mengirim challenge kedua; batas kirim 429", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const powerful = await adminWith(t, [
      "members.read",
      "members.manage",
      "admins.manage",
      "moderation.resolve",
      "moderation.read",
    ]);
    const denied = await reset(powerful, member.userId);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("FORBIDDEN");

    const superAdmin = await adminWith(t, [], { role: "super_admin" });
    const noReauth = await reset(superAdmin, member.userId, { reauth: false });
    expect(noReauth.statusCode).toBe(403);
    expect(expectOperation("post", "/admin/members/{userId}/password-reset", noReauth)).toMatchObject({
      code: "REAUTH_REQUIRED",
    });

    for (const accountStatus of ["disabled", "deletion_pending"] as const) {
      const inactive = await createAlumni(t, { status: "verified", accountStatus });
      expect((await reset(superAdmin, inactive.userId)).statusCode, accountStatus).toBe(400);
    }
    const pending = await createAlumni(t, { status: "pending_otp" });
    expect((await reset(superAdmin, pending.userId)).statusCode).toBe(400);
    expect((await reset(superAdmin, uuidv7())).statusCode).toBe(404);
    expect((await reset(superAdmin, superAdmin.admin.userId)).statusCode).toBe(404);

    const linkedSuper = await adminWith(t, [], { role: "super_admin", linkedAlumniUserId: member.userId });
    expect((await reset(linkedSuper, member.userId)).statusCode).toBe(403);

    const key = uuidv7();
    const sentBefore = t.mailer.sent.filter((m) => m.to === member.email).length;
    expect((await reset(superAdmin, member.userId, { key })).statusCode).toBe(202);
    const replay = await reset(superAdmin, member.userId, { key });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(t.mailer.sent.filter((m) => m.to === member.email).length).toBe(sentBefore + 1);

    // Kuota kirim OTP per email (PRD 2.5): kunci yang sama dengan alur lupa sandi.
    for (let i = 0; i < 4; i++) expect((await reset(superAdmin, member.userId)).statusCode).toBe(202);
    const limited = await reset(superAdmin, member.userId);
    expect(limited.statusCode).toBe(429);
    expect(expectOperation("post", "/admin/members/{userId}/password-reset", limited)).toMatchObject({
      code: "RATE_LIMITED",
    });
    expect((await t.db.select().from(users).where(eq(users.id, member.userId)))[0]!.status).toBe("active");
  });
});

describe("GET /admin/members/{userId}/membership-events (PRD 4.2, 6.3)", () => {
  it("AC F12-3, F15-1: histori beraktor dan beralasan, keyset dengan total; tanpa moderation.read warn disembunyikan dan alasan suspend disunting", async () => {
    const member = await createAlumni(t, { status: "unverified", cohort: 12, classIn: 1, classOut: 4 });
    await approveMembershipPayment(t, member.userId, "registration");
    const superAdmin = await adminWith(t, [], { role: "super_admin" });
    const versionOf = async () => (await detailOf(superAdmin.token, member.userId)).version;
    t.clock.advance(1000);
    expect(
      (
        await api().patch(
          `/admin/members/${member.userId}`,
          { reason: "Koreksi kelas keluar", class_out: 6 },
          { token: superAdmin.token, headers: { "if-match": await versionOf() } },
        )
      ).statusCode,
    ).toBe(200);
    t.clock.advance(1000);
    await t.db.insert(membershipEvents).values({
      id: uuidv7(),
      userId: member.userId,
      kind: "warn",
      actorAdminId: superAdmin.admin.adminId,
      reason: "Peringatan bahasa kasar",
      createdAt: t.clock.now(),
    });
    t.clock.advance(1000);
    expect(
      (
        await api().post(
          `/admin/members/${member.userId}/suspend`,
          { reason: "Alasan internal suspend", member_message: "Akun dibatasi.", confirm: true },
          { token: superAdmin.token, headers: { "if-match": await versionOf() } },
        )
      ).statusCode,
    ).toBe(200);
    t.clock.advance(1000);
    expect(
      (
        await api().post(
          `/admin/members/${member.userId}/unsuspend`,
          { reason: "Alasan internal unsuspend", confirm: true },
          { token: superAdmin.token, headers: { "if-match": await versionOf() } },
        )
      ).statusCode,
    ).toBe(200);

    const get = (token: string, query: Record<string, string> = {}) =>
      api().get(`/admin/members/${member.userId}/membership-events`, { token, query });
    const full = await get(superAdmin.token);
    expect(full.statusCode).toBe(200);
    const page = expectOperation("get", "/admin/members/{userId}/membership-events", full) as Page;
    expect(page.total).toBe(5);
    expect(page.items.map((item) => item.kind)).toEqual([
      "unsuspend",
      "suspend",
      "warn",
      "number_correction",
      "activation",
    ]);
    expect(page.items[1]).toMatchObject({
      reason: "Alasan internal suspend",
      reason_redacted: false,
      actor: { admin_id: superAdmin.admin.adminId },
    });
    expect(page.items[4]).toMatchObject({ actor: null, payment_id: expect.any(String), reason: null });

    const reader = await adminWith(t, ["members.read"]);
    const limited = expectOperation(
      "get",
      "/admin/members/{userId}/membership-events",
      await get(reader.token),
    ) as Page;
    expect(limited.total).toBe(4);
    expect(limited.items.map((item) => item.kind)).not.toContain("warn");
    expect(limited.items.find((item) => item.kind === "suspend")).toMatchObject({
      reason: null,
      reason_redacted: true,
    });
    expect(limited.items.find((item) => item.kind === "number_correction")).toMatchObject({
      reason: "Koreksi kelas keluar",
      reason_redacted: false,
      before_member_number: expect.stringMatching(/^12\.02\.01\./),
      after_member_number: expect.stringMatching(/^12\.01\.01\./),
    });
    const warnDenied = await get(reader.token, { kind: "warn" });
    expect(warnDenied.statusCode).toBe(403);

    // Paging keyset tanpa duplikasi; cursor terikat filter.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await get(superAdmin.token, { limit: "2", ...(cursor ? { cursor } : {}) });
      const body = res.json() as Page;
      seen.push(...body.items.map((item) => String(item.id)));
      cursor = body.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const firstPage = (await get(superAdmin.token, { limit: "2" })).json() as Page;
    const mismatch = await get(superAdmin.token, { kind: "suspend", cursor: firstPage.next_cursor! });
    expect(mismatch.statusCode).toBe(400);
    expect((await get(superAdmin.token, { kind: "suspend" })).json().total).toBe(1);

    expect(
      (await api().get(`/admin/members/${uuidv7()}/membership-events`, { token: reader.token })).statusCode,
    ).toBe(404);
    const noPermission = await adminWith(t, ["payments.read"]);
    expect((await get(noPermission.token)).statusCode).toBe(403);
  });
});
