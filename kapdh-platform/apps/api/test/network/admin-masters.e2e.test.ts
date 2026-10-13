import type { Permission } from "@kapdh/contracts";
import { alumniProfessions, alumniSkills, auditLogs, masterProfessions, masterSkills } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { type HttpClient, httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Manajemen master profesi dan keahlian (F-15, guideline hal. 16; kontrak admin-masters.yaml; AC F10-4, F15-1, F15-4,
 * F17-1).
 */

type Json = Record<string, unknown>;
type Kind = "professions" | "skills";

let t: TestApp;
let api: HttpClient;
let manager: string;
let reader: string;

beforeAll(async () => {
  t = await createTestApp();
  api = httpClient(t.app);
  manager = await adminToken(["master.manage"]);
  reader = await adminToken(["members.read"]);
});
afterAll(async () => {
  await t.app.close();
});

async function adminToken(permissions: Permission[], role: "admin" | "super_admin" = "admin") {
  const admin = await createAdmin(t, { role, permissions });
  return (await signInAdmin(t, admin)).accessToken;
}

const uniqueLabel = (prefix = "Master Uji") => `${prefix} ${uuidv7().slice(-12)}`;

async function create(kind: Kind, body: Json, token = manager) {
  const res = await api.post(`/admin/masters/${kind}`, body, { token });
  expect(res.statusCode, res.body).toBe(201);
  return expectOperation("post", "/admin/masters/{kind}", res) as Json & { id: string; version: string };
}

async function list(query: Record<string, string>, kind: Kind = "professions", token = manager) {
  const res = await api.get(`/admin/masters/${kind}`, { token, query });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/admin/masters/{kind}", res) as Json & { items: Json[] };
}

async function audits(entityId: string) {
  return t.db.select().from(auditLogs).where(eq(auditLogs.entityId, entityId)).orderBy(auditLogs.createdAt);
}

describe("AC F15-1: izin pengurus dievaluasi per operasi", () => {
  it("AC F15-1: tanpa sesi 401, sesi anggota 403, admin tanpa izin master/anggota 403 di semua operasi", async () => {
    const created = await create("professions", { label: uniqueLabel() });
    const member = await createAlumni(t, { status: "verified" });
    const memberToken = (await signInAlumni(t, member)).accessToken;
    const payments = await adminToken(["payments.read", "payments.decide"]);
    const calls = [
      ["get", "/admin/masters/{kind}", "/admin/masters/professions"],
      ["post", "/admin/masters/{kind}", "/admin/masters/professions"],
      ["get", "/admin/masters/{kind}/{masterId}", `/admin/masters/professions/${created.id}`],
      ["patch", "/admin/masters/{kind}/{masterId}", `/admin/masters/professions/${created.id}`],
      ["delete", "/admin/masters/{kind}/{masterId}", `/admin/masters/professions/${created.id}`],
    ] as const;
    for (const [method, template, url] of calls) {
      const body = method === "post" || method === "patch" ? { label: uniqueLabel() } : undefined;
      const headers = { "if-match": created.version };
      for (const [token, status, code] of [
        [undefined, 401, "UNAUTHENTICATED"],
        [memberToken, 403, "FORBIDDEN"],
        [payments, 403, "FORBIDDEN"],
      ] as const) {
        const res = await t.app.inject({
          method: method.toUpperCase() as "GET",
          url: `/api/v1${url}`,
          headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
          ...(body ? { payload: body } : {}),
        });
        expect(res.statusCode, `${method} ${url} ${status}`).toBe(status);
        expect(expectOperation(method, template, res)).toMatchObject({ code });
      }
    }
    // Tidak ada perubahan oleh pemanggil yang ditolak.
    const [row] = await t.db.select().from(masterProfessions).where(eq(masterProfessions.id, created.id));
    expect(row).toMatchObject({ label: created.label, version: 1 });
  });

  it("AC F15-1: members.read cukup untuk daftar (filter daftar anggota) tetapi tidak untuk perubahan maupun detail", async () => {
    const created = await create("skills", { label: uniqueLabel() });
    const body = await list({ q: String(created.label) }, "skills", reader);
    expect(body.items.map((item) => item.id)).toEqual([created.id]);
    for (const res of [
      await api.post("/admin/masters/skills", { label: uniqueLabel() }, { token: reader }),
      await api.get(`/admin/masters/skills/${created.id}`, { token: reader }),
      await api.patch(
        `/admin/masters/skills/${created.id}`,
        { active: false },
        { token: reader, headers: { "if-match": "1" } },
      ),
      await api.delete(`/admin/masters/skills/${created.id}`, {
        token: reader,
        headers: { "if-match": "1" },
      }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("AC F15-1: Super Admin memiliki semua izin master", async () => {
    const superAdmin = await adminToken([], "super_admin");
    const created = await create("professions", { label: uniqueLabel() }, superAdmin);
    const res = await api.get(`/admin/masters/professions/${created.id}`, { token: superAdmin });
    expect(res.statusCode).toBe(200);
    expectOperation("get", "/admin/masters/{kind}/{masterId}", res);
  });
});

describe("POST /admin/masters/{kind} (adminCreateMaster)", () => {
  it("F-15, AC F17-1: label dipangkas, bawaan aktif dan sort_order 0, audit master.created dalam transaksi", async () => {
    const label = uniqueLabel("Arsitek");
    const created = await create("professions", { label: `   ${label}  ` });
    expect(created).toMatchObject({
      kind: "professions",
      label,
      active: true,
      sort_order: 0,
      usage_count: 0,
      version: "1",
      created_at: t.clock.now().toISOString(),
    });
    const [entry] = await audits(created.id);
    expect(entry).toMatchObject({
      action: "master.created",
      entityType: "master_profession",
      effectiveRole: "admin",
      after: { kind: "professions", label, active: true, sort_order: 0, version: 1 },
    });

    const skill = await create("skills", { label: uniqueLabel("Kaligrafi"), active: false, sort_order: -5 });
    expect(skill).toMatchObject({ kind: "skills", active: false, sort_order: -5 });
    const [skillRow] = await t.db.select().from(masterSkills).where(eq(masterSkills.id, skill.id));
    expect(skillRow).toBeDefined();
    expect((await audits(skill.id))[0]).toMatchObject({ entityType: "master_skill" });
  });

  it("AC F10-4: label ganda per jenis (tanpa huruf besar/kecil, termasuk master nonaktif) → 409 VALIDATION_ERROR", async () => {
    const label = uniqueLabel("Penerjemah");
    await create("professions", { label, active: false });
    const dup = await api.post(
      "/admin/masters/professions",
      { label: ` ${label.toUpperCase()} ` },
      { token: manager },
    );
    expect(dup.statusCode).toBe(409);
    expect(expectOperation("post", "/admin/masters/{kind}", dup)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { label: expect.any(Array) },
    });
    // Jenis lain boleh memakai label yang sama.
    await create("skills", { label });
  });

  it("validasi body, jenis master dan label seeded → 400", async () => {
    const cases: [Kind | string, unknown, string][] = [
      ["professions", {}, "label"],
      ["professions", { label: "    " }, "label"],
      ["professions", { label: "x".repeat(101) }, "label"],
      ["professions", { label: "Baris\nBaru" }, "label"],
      ["professions", { label: "Valid", active: "ya" }, "active"],
      ["professions", { label: "Valid", sort_order: 40000 }, "sort_order"],
      ["professions", { label: "Valid", sort_order: 1.5 }, "sort_order"],
      ["professions", { label: "Valid", kind: "skills" }, "_"],
      ["classes", { label: "Valid" }, "kind"],
    ];
    for (const [kind, body, field] of cases) {
      const res = await api.post(`/admin/masters/${kind}`, body, { token: manager });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      const error = expectOperation("post", "/admin/masters/{kind}", res) as Json;
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(Object.keys(error.field_errors as Json), JSON.stringify(body)).toContain(field);
    }
  });
});

describe("GET /admin/masters/{kind} (adminListMasters)", () => {
  it("F-15: aktif dan nonaktif, filter q/active, usage_count, total, paging keyset tanpa duplikasi untuk setiap urutan", async () => {
    const tag = uuidv7().slice(-10);
    const specs = [
      { label: `Zeta ${tag}`, sort_order: 1, active: true, uses: 0 },
      { label: `alfa ${tag}`, sort_order: 2, active: false, uses: 3 },
      { label: `Beta ${tag}`, sort_order: 1, active: true, uses: 1 },
      { label: `Gama ${tag}`, sort_order: -1, active: true, uses: 3 },
      { label: `delta ${tag}`, sort_order: 2, active: true, uses: 0 },
    ];
    const created = [];
    for (const spec of specs) {
      const item = await create("skills", {
        label: spec.label,
        sort_order: spec.sort_order,
        active: spec.active,
      });
      for (let i = 0; i < spec.uses; i++) {
        const member = await createAlumni(t, { status: "verified" });
        await t.db.insert(alumniSkills).values({ alumniUserId: member.userId, skillId: item.id });
      }
      created.push({ ...spec, id: item.id });
    }
    const lower = (s: string) => s.toLowerCase();
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
    const expected: Record<string, string[]> = {
      manual: [...created]
        .sort(
          (a, b) => a.sort_order - b.sort_order || (lower(a.label) < lower(b.label) ? -1 : 1) || byId(a, b),
        )
        .map((m) => m.id),
      label_asc: [...created].sort((a, b) => (lower(a.label) < lower(b.label) ? -1 : 1)).map((m) => m.id),
      label_desc: [...created].sort((a, b) => (lower(a.label) > lower(b.label) ? -1 : 1)).map((m) => m.id),
      usage_desc: [...created]
        .sort((a, b) => b.uses - a.uses || (lower(a.label) < lower(b.label) ? -1 : 1))
        .map((m) => m.id),
    };
    for (const [sort, ids] of Object.entries(expected)) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await list({ q: tag, sort, limit: "2", ...(cursor ? { cursor } : {}) }, "skills");
        expect(page.total).toBe(5);
        seen.push(...page.items.map((item) => item.id as string));
        cursor = page.next_cursor as string | null;
      } while (cursor);
      expect(seen, sort).toEqual(ids);
    }

    const all = await list({ q: tag.toUpperCase(), limit: "100" }, "skills");
    for (const spec of created)
      expect(all.items.find((item) => item.id === spec.id)).toMatchObject({
        usage_count: spec.uses,
        active: spec.active,
      });
    const inactive = await list({ q: tag, active: "false" }, "skills");
    expect(inactive.items.map((item) => item.id)).toEqual([created[1]!.id]);
    expect(inactive.total).toBe(1);
    const active = await list({ q: tag, active: "true" }, "skills");
    expect(active.total).toBe(4);
    // Master profesi tidak tercampur.
    expect((await list({ q: tag }, "professions")).total).toBe(0);
  });

  it("master referensi (seed, nonaktif) ikut tampil; parameter tidak valid → 400", async () => {
    const seeded = await list({ q: "Guru", active: "false" });
    expect(seeded.items.some((item) => item.label === "Guru")).toBe(true);
    const invalid: Record<string, string>[] = [
      { sort: "acak" },
      { active: "mungkin" },
      { limit: "101" },
      { cursor: "!!" },
      { q: "" },
    ];
    for (const query of invalid) {
      const res = await api.get("/admin/masters/professions", { token: manager, query });
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
      expect(expectOperation("get", "/admin/masters/{kind}", res)).toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    const page = await list({ limit: "1" });
    const mismatch = await api.get("/admin/masters/professions", {
      token: manager,
      query: { sort: "usage_desc", cursor: String(page.next_cursor) },
    });
    expect(mismatch.statusCode).toBe(400);
  });
});

describe("GET/PATCH /admin/masters/{kind}/{masterId}", () => {
  it("adminGetMaster: detail dengan version; id jenis lain, tidak ada atau bukan UUID → 404", async () => {
    const created = await create("professions", { label: uniqueLabel() });
    const res = await api.get(`/admin/masters/professions/${created.id}`, { token: manager });
    expect(res.statusCode).toBe(200);
    expect(expectOperation("get", "/admin/masters/{kind}/{masterId}", res)).toEqual(created);
    for (const url of [
      `/admin/masters/skills/${created.id}`,
      `/admin/masters/professions/${uuidv7()}`,
      "/admin/masters/professions/bukan-uuid",
    ]) {
      const missing = await api.get(url, { token: manager });
      expect(missing.statusCode, url).toBe(404);
      expect(expectOperation("get", "/admin/masters/{kind}/{masterId}", missing)).toMatchObject({
        code: "NOT_FOUND",
      });
    }
  });

  it("AC F15-4: If-Match wajib; versi lama → 409 VERSION_CONFLICT dengan current; berhasil menaikkan versi dan diaudit", async () => {
    const created = await create("professions", { label: uniqueLabel("Bidan") });
    const url = `/admin/masters/professions/${created.id}`;
    const noIfMatch = await api.patch(url, { sort_order: 3 }, { token: manager });
    expect(noIfMatch.statusCode).toBe(400);
    expect(expectOperation("patch", "/admin/masters/{kind}/{masterId}", noIfMatch)).toMatchObject({
      field_errors: { "If-Match": expect.any(Array) },
    });

    const newLabel = uniqueLabel("Bidan Desa");
    t.clock.advance(1000);
    const ok = await api.patch(
      url,
      { label: ` ${newLabel} `, sort_order: 3 },
      { token: manager, headers: { "if-match": "1" } },
    );
    expect(ok.statusCode).toBe(200);
    const updated = expectOperation("patch", "/admin/masters/{kind}/{masterId}", ok) as Json;
    expect(updated).toMatchObject({
      label: newLabel,
      sort_order: 3,
      active: true,
      version: "2",
      updated_at: t.clock.now().toISOString(),
    });

    const stale = await api.patch(url, { active: false }, { token: manager, headers: { "if-match": "1" } });
    expect(stale.statusCode).toBe(409);
    expect(expectOperation("patch", "/admin/masters/{kind}/{masterId}", stale)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { id: created.id, label: newLabel, version: "2", usage_count: 0 },
    });
    const [row] = await t.db.select().from(masterProfessions).where(eq(masterProfessions.id, created.id));
    expect(row).toMatchObject({ active: true, version: 2 });

    const entries = await audits(created.id);
    expect(entries.map((entry) => entry.action)).toEqual(["master.created", "master.updated"]);
    expect(entries[1]).toMatchObject({
      before: { label: created.label, sort_order: 0, version: 1 },
      after: { label: newLabel, sort_order: 3, version: 2 },
    });

    // Tanpa perubahan nyata: tidak menaikkan versi maupun menulis audit.
    const same = await api.patch(url, { sort_order: 3 }, { token: manager, headers: { "if-match": "2" } });
    expect(same.statusCode).toBe(200);
    expect((same.json() as Json).version).toBe("2");
    expect(await audits(created.id)).toHaveLength(2);
  });

  it("AC F10-4: menonaktifkan master mempertahankan label historis pada profil yang sudah memakainya", async () => {
    const created = await create("professions", { label: uniqueLabel("Apoteker") });
    const owner = await createAlumni(t, { status: "verified" });
    await t.db.insert(alumniProfessions).values({ alumniUserId: owner.userId, professionId: created.id });
    const res = await api.patch(
      `/admin/masters/professions/${created.id}`,
      { active: false },
      { token: manager, headers: { "if-match": created.version } },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ active: false, usage_count: 1, version: "2" });

    const viewer = await createAlumni(t, { status: "verified" });
    const token = (await signInAlumni(t, viewer)).accessToken;
    const profile = await api.get(`/directory/${owner.userId}`, { token });
    expect(profile.statusCode).toBe(200);
    expect(expectOperation("get", "/directory/{userId}", profile)).toMatchObject({
      profession: { id: created.id, label: created.label, active: false },
    });
    // Relasi profil tidak tersentuh.
    const links = await t.db
      .select()
      .from(alumniProfessions)
      .where(
        and(eq(alumniProfessions.alumniUserId, owner.userId), eq(alumniProfessions.professionId, created.id)),
      );
    expect(links).toHaveLength(1);
  });

  it("label ganda saat ubah → 409 VALIDATION_ERROR; body kosong/field asing → 400", async () => {
    const first = await create("skills", { label: uniqueLabel("Menjahit") });
    const second = await create("skills", { label: uniqueLabel("Memasak") });
    const url = `/admin/masters/skills/${second.id}`;
    const dup = await api.patch(
      url,
      { label: String(first.label).toLowerCase() },
      { token: manager, headers: { "if-match": "1" } },
    );
    expect(dup.statusCode).toBe(409);
    expect(expectOperation("patch", "/admin/masters/{kind}/{masterId}", dup)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { label: expect.any(Array) },
    });
    for (const body of [{}, { usage_count: 0 }, { label: "" }]) {
      const res = await api.patch(url, body, { token: manager, headers: { "if-match": "1" } });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const missing = await api.patch(
      `/admin/masters/skills/${uuidv7()}`,
      { active: false },
      { token: manager, headers: { "if-match": "1" } },
    );
    expect(missing.statusCode).toBe(404);
    expectOperation("patch", "/admin/masters/{kind}/{masterId}", missing);
  });
});

describe("DELETE /admin/masters/{kind}/{masterId} (adminDeleteMaster)", () => {
  it("AC F10-4: master yang dipakai ditolak 409 VALIDATION_ERROR dengan current dan saran menonaktifkan", async () => {
    const created = await create("skills", { label: uniqueLabel("Bertani") });
    const owner = await createAlumni(t, { status: "verified" });
    await t.db.insert(alumniSkills).values({ alumniUserId: owner.userId, skillId: created.id });
    const res = await api.delete(`/admin/masters/skills/${created.id}`, {
      token: manager,
      headers: { "if-match": "1" },
    });
    expect(res.statusCode).toBe(409);
    expect(expectOperation("delete", "/admin/masters/{kind}/{masterId}", res)).toMatchObject({
      code: "VALIDATION_ERROR",
      current: { id: created.id, usage_count: 1, version: "1" },
    });
    const [row] = await t.db.select().from(masterSkills).where(eq(masterSkills.id, created.id));
    expect(row).toBeDefined();
    expect((await audits(created.id)).map((entry) => entry.action)).toEqual(["master.created"]);
  });

  it("AC F15-4: If-Match lama → 409 VERSION_CONFLICT; master tak terpakai dihapus 204 dan diaudit", async () => {
    const created = await create("professions", { label: uniqueLabel("Penyiar") });
    const url = `/admin/masters/professions/${created.id}`;
    const missingHeader = await api.delete(url, { token: manager });
    expect(missingHeader.statusCode).toBe(400);
    expectOperation("delete", "/admin/masters/{kind}/{masterId}", missingHeader);
    const stale = await api.delete(url, { token: manager, headers: { "if-match": "7" } });
    expect(stale.statusCode).toBe(409);
    expect(expectOperation("delete", "/admin/masters/{kind}/{masterId}", stale)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { id: created.id, version: "1" },
    });

    const ok = await api.delete(url, { token: manager, headers: { "if-match": "1" } });
    expect(ok.statusCode).toBe(204);
    expectOperation("delete", "/admin/masters/{kind}/{masterId}", ok);
    expect(await t.db.select().from(masterProfessions).where(eq(masterProfessions.id, created.id))).toEqual(
      [],
    );
    const entries = await audits(created.id);
    expect(entries.map((entry) => entry.action)).toEqual(["master.created", "master.deleted"]);
    expect(entries[1]).toMatchObject({ before: { label: created.label, version: 1 } });

    const again = await api.delete(url, { token: manager, headers: { "if-match": "1" } });
    expect(again.statusCode).toBe(404);
  });
});
