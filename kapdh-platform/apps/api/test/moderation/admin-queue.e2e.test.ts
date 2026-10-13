import type { Permission } from "@kapdh/contracts";
import { auditLogs } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModerationVisibility } from "../../src/modules/moderation/moderation-visibility.js";
import { accessMismatches, expectOperation, spec } from "../support/contract.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { addRoomMember, createGroupRoom, recordRealtime, reportOk, reportVersion, resolveReport } from "./fixtures.js";

/**
 * Antrean moderasi pengurus (F-12, F-15; kontrak admin-moderation.yaml adminListReports) dengan SLA v3.2, filter,
 * paging keyset, dan aturan konflik kepentingan (PRD 2.3, AC F12-2: laporan tidak dibuka kepada pihak terlapor,
 * termasuk pengurus yang akun alumninya tertaut ke pihak terlapor). Aplikasi uji sendiri agar hitungan deterministik.
 */

let t: TestApp;
const HOUR = 3600_000;
const MODERATOR: Permission[] = ["moderation.read", "moderation.resolve"];

beforeAll(async () => {
  t = await createTestApp();
  recordRealtime(t.app);
});
afterAll(async () => {
  await t.app.close();
});

const api = () => httpClient(t.app);

async function member(fullName: string) {
  const fixture = await createAlumni(t, { fullName });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken };
}

async function moderator(options: { permissions?: Permission[]; linkedAlumniUserId?: string; role?: "super_admin" } = {}) {
  const admin = await createAdmin(t, {
    permissions: options.permissions ?? MODERATOR,
    linkedAlumniUserId: options.linkedAlumniUserId ?? null,
    role: options.role ?? "admin",
  });
  return { ...admin, token: (await signInAdmin(t, admin)).accessToken };
}

type QueuePage = {
  items: { id: string; [key: string]: unknown }[];
  total: number;
  next_cursor: string | null;
  counts: { open: number; in_review: number; overdue: number; urgent: number };
};

async function queue(token: string, query: Record<string, string> = {}): Promise<QueuePage> {
  const res = await api().get("/admin/reports", { token, query });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/admin/reports", res) as QueuePage;
}

describe("x-kapdh-access modul moderation (ARCHITECTURE §4.3)", () => {
  it("dekorator setiap operasi moderation.yaml dan admin-moderation.yaml sama dengan kontrak", () => {
    const controllers = ["BlocksController", "ReportsController", "AdminReportsController"];
    const routes = routeAccessList(t.app).filter((route) => controllers.some((c) => route.name.startsWith(`${c}.`)));
    const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { tags?: string[]; operationId?: string }>)
        .filter(([, op]) => op.tags?.includes("Moderation") || op.tags?.includes("Admin Moderation"))
        .map(([method, op]) => ({ path, method, operationId: op.operationId })),
    );
    expect(operations.map((op) => op.operationId).sort()).toEqual(
      [
        "adminClaimReport",
        "adminGetReport",
        "adminListReports",
        "adminResolveReport",
        "blockMember",
        "createAppeal",
        "createReport",
        "getMyReport",
        "listBlocks",
        "listMyReports",
        "unblockMember",
      ].sort(),
    );
    // Setiap operasi kontrak memiliki tepat satu handler, dan dekoratornya sama dengan x-kapdh-access.
    for (const op of operations)
      expect(
        routes.filter((route) => route.method === op.method && route.path === op.path),
        `${op.method} ${op.path}`,
      ).toHaveLength(1);
    expect(routes).toHaveLength(operations.length);
    expect(accessMismatches(routes)).toEqual([]);
  });
});

describe("GET /admin/reports (PRD 3.12 target penanganan, F-15)", () => {
  it("AC F12-2: bawaan active urut due; urgent dan yang lewat target lebih dulu; filter, total, counts, paging", async () => {
    const admin = await moderator();
    const reporter = await member("Pelapor Antrean");
    const t1 = await member("Bunga Citra Lestari");
    const t2 = await member("Dimas Anggara");
    const t3 = await member("Eko Prasetyo");

    const r1 = await reportOk(t.app, reporter.token, { target_type: "user", target_user_id: t1.userId, category: "spam" });
    t.clock.advance(60_000);
    const r2 = await reportOk(t.app, reporter.token, {
      target_type: "user",
      target_user_id: t2.userId,
      category: "violence_threat",
    });
    t.clock.advance(60_000);
    const r3 = await reportOk(t.app, reporter.token, {
      target_type: "user",
      target_user_id: t3.userId,
      category: "harassment",
    });

    const initial = await queue(admin.token);
    expect(initial.items.map((i) => i.id)).toEqual([r2, r1, r3]);
    expect(initial.total).toBe(3);
    expect(initial.counts).toEqual({ open: 3, in_review: 0, overdue: 0, urgent: 1 });
    const item = initial.items[0]!;
    expect(item).toMatchObject({
      category: "violence_threat",
      priority: "urgent",
      status: "open",
      target_type: "user",
      subject: { user_id: t2.userId, full_name: "Dimas Anggara", member_number: t2.memberNumber, cohort: 29 },
      overdue: false,
      claimed_by: null,
      action: null,
    });
    // Minimisasi (PRD 3.12): item antrean tanpa bukti, deskripsi, maupun identitas pelapor.
    for (const key of ["description", "reporter", "evidence"]) expect(item).not.toHaveProperty(key);

    // Lewat 24 jam: laporan urgent menjadi overdue (sesi admin dibuka ulang setelah jam dimajukan).
    t.clock.advance(30 * HOUR);
    admin.token = (await signInAdmin(t, admin)).accessToken;
    const overdue = await queue(admin.token, { overdue: "true" });
    expect(overdue.items.map((i) => i.id)).toEqual([r2]);
    expect(overdue.total).toBe(1);
    expect(overdue.items[0]!.overdue).toBe(true);
    expect(overdue.counts).toEqual({ open: 3, in_review: 0, overdue: 1, urgent: 1 });
    expect((await queue(admin.token, { overdue: "false" })).total).toBe(3);

    expect((await queue(admin.token, { priority: "urgent" })).items.map((i) => i.id)).toEqual([r2]);
    expect((await queue(admin.token, { category: "spam" })).items.map((i) => i.id)).toEqual([r1]);
    expect((await queue(admin.token, { target_type: "room" })).total).toBe(0);
    expect((await queue(admin.token, { sort: "newest" })).items.map((i) => i.id)).toEqual([r3, r2, r1]);
    expect((await queue(admin.token, { sort: "oldest" })).items.map((i) => i.id)).toEqual([r1, r2, r3]);
    expect((await queue(admin.token, { q: "bunga" })).items.map((i) => i.id)).toEqual([r1]);
    expect((await queue(admin.token, { q: t3.memberNumber!.slice(0, -1) })).items.map((i) => i.id)).toContain(r3);
    expect((await queue(admin.token, { q: "%" })).total).toBe(0);

    const page1 = await queue(admin.token, { limit: "2" });
    expect(page1.items.map((i) => i.id)).toEqual([r2, r1]);
    expect(page1.total).toBe(3);
    const page2 = await queue(admin.token, { limit: "2", cursor: page1.next_cursor! });
    expect(page2.items.map((i) => i.id)).toEqual([r3]);
    expect(page2.next_cursor).toBeNull();
    const mismatched = await api().get("/admin/reports", {
      token: admin.token,
      query: { sort: "newest", cursor: page1.next_cursor! },
    });
    expect(mismatched.statusCode).toBe(400);
    expectOperation("get", "/admin/reports", mismatched);
    for (const query of [{ status: "x" }, { priority: "tinggi" }, { overdue: "ya" }, { limit: "0" }, { sort: "due_at" }]) {
      const bad = await api().get("/admin/reports", { token: admin.token, query });
      expect(bad.statusCode, JSON.stringify(query)).toBe(400);
    }

    // Laporan yang diputus keluar dari antrean bawaan, tampil di status dismissed/all.
    const version = await reportVersion(t.app, admin.token, r1);
    const dismissed = await resolveReport(t.app, admin.token, r1, version, { action: "dismiss", note: "Bukan spam." });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect((await queue(admin.token)).items.map((i) => i.id)).toEqual([r2, r3]);
    expect((await queue(admin.token, { status: "dismissed" })).items.map((i) => i.id)).toEqual([r1]);
    expect((await queue(admin.token, { status: "all" })).total).toBe(3);
    expect((await queue(admin.token)).counts).toEqual({ open: 2, in_review: 0, overdue: 1, urgent: 1 });
  });

  it("AC F12-2 / PRD 2.3: laporan terhadap akun tertaut pemanggil tidak pernah terlihat (items, total, counts, q, detail, klaim, keputusan)", async () => {
    const reporter = await member("Pelapor Konflik");
    const linkedMember = await member("Pengurus Sebagai Alumni");
    const other = await member("Anggota Grup Lain");
    const linked = await moderator({ linkedAlumniUserId: linkedMember.userId });
    const linkedSuper = await moderator({ role: "super_admin", linkedAlumniUserId: other.userId });
    const neutral = await moderator();

    const againstLinked = await reportOk(t.app, reporter.token, {
      target_type: "user",
      target_user_id: linkedMember.userId,
      category: "harassment",
    });
    // Laporan grup tanpa subjek: semua anggota joined grup itu dianggap pihak terlapor.
    const group = await createGroupRoom(t, { name: "Grup Konflik", adminId: reporter.userId });
    await addRoomMember(t, group, linkedMember.userId);
    await addRoomMember(t, group, other.userId);
    const groupReport = await reportOk(t.app, reporter.token, { target_type: "room", room_id: group, category: "spam" });

    const neutralView = await queue(neutral.token, { status: "all" });
    expect(neutralView.items.map((i) => i.id)).toEqual(expect.arrayContaining([againstLinked, groupReport]));
    const linkedView = await queue(linked.token, { status: "all" });
    expect(linkedView.items.map((i) => i.id)).not.toContain(againstLinked);
    expect(linkedView.items.map((i) => i.id)).not.toContain(groupReport);
    expect(linkedView.total).toBe(neutralView.total - 2);
    const neutralCounts = (await queue(neutral.token)).counts;
    const linkedCounts = (await queue(linked.token)).counts;
    expect(linkedCounts.open).toBe(neutralCounts.open - 2);
    // Sumber bersama untuk dasbor/lencana menu (aturan domain butir c) = counts antrean.
    const visibility = t.app.get(ModerationVisibility);
    expect(await visibility.counts(linkedMember.userId)).toEqual(linkedCounts);
    expect(await visibility.counts(null)).toEqual(neutralCounts);
    expect((await queue(linked.token, { q: "Pengurus Sebagai" })).total).toBe(0);
    // super_admin tidak dikecualikan dari aturan ini.
    expect((await queue(linkedSuper.token, { status: "all" })).items.map((i) => i.id)).not.toContain(groupReport);

    for (const id of [againstLinked, groupReport]) {
      const detail = await api().get(`/admin/reports/${id}`, { token: linked.token });
      expect(detail.statusCode).toBe(404);
      expectOperation("get", "/admin/reports/{reportId}", detail);
      const claim = await api().post(`/admin/reports/${id}/claim`, undefined, {
        token: linked.token,
        headers: { "if-match": "1" },
      });
      expect(claim.statusCode).toBe(404);
      const resolve = await resolveReport(t.app, linked.token, id, "1", { action: "dismiss", note: "Ditutup." });
      expect(resolve.statusCode).toBe(404);
    }
    // 404 konflik kepentingan tanpa audit pembacaan bukti.
    const viewed = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, againstLinked), eq(auditLogs.action, "moderation.report_viewed")));
    expect(viewed).toEqual([]);

    // Subjek grup ditetapkan anggota lain → laporan kini hanya tersembunyi dari akun subjek itu.
    const version = await reportVersion(t.app, neutral.token, groupReport);
    const warned = await resolveReport(t.app, neutral.token, groupReport, version, {
      action: "warn",
      note: "Admin grup menyebarkan spam.",
      member_message: "Mohon tidak menyebarkan promosi berulang di grup.",
      subject_user_id: other.userId,
    });
    expect(warned.statusCode, warned.body).toBe(200);
    expect((await queue(linked.token, { status: "all" })).items.map((i) => i.id)).toContain(groupReport);
    expect((await queue(linkedSuper.token, { status: "all" })).items.map((i) => i.id)).not.toContain(groupReport);
  });

  it("pengurus yang tertaut ke pelapor: laporan terlihat dengan conflict_of_interest, klaim/keputusan 403", async () => {
    const reporter = await member("Pelapor Pengurus");
    const target = await member("Terlapor Biasa");
    const linkedToReporter = await moderator({ linkedAlumniUserId: reporter.userId });
    const id = await reportOk(t.app, reporter.token, { target_type: "user", target_user_id: target.userId, category: "scam" });
    expect((await queue(linkedToReporter.token)).items.map((i) => i.id)).toContain(id);
    const detail = await api().get(`/admin/reports/${id}`, { token: linkedToReporter.token });
    expect(expectOperation("get", "/admin/reports/{reportId}", detail)).toMatchObject({ conflict_of_interest: true });
    const claim = await api().post(`/admin/reports/${id}/claim`, undefined, {
      token: linkedToReporter.token,
      headers: { "if-match": "1" },
    });
    expect(claim.statusCode).toBe(403);
    expectOperation("post", "/admin/reports/{reportId}/claim", claim);
    const resolve = await resolveReport(t.app, linkedToReporter.token, id, "1", { action: "dismiss", note: "Tutup." });
    expect(resolve.statusCode).toBe(403);
  });

  it("otorisasi: moderation.read wajib (dari database setiap request); sesi anggota 403; tanpa sesi 401", async () => {
    const other = await moderator({ permissions: ["members.read"] });
    const denied = await api().get("/admin/reports", { token: other.token });
    expect(denied.statusCode).toBe(403);
    expectOperation("get", "/admin/reports", denied);
    const alumniMember = await member("Anggota Biasa");
    expect((await api().get("/admin/reports", { token: alumniMember.token })).statusCode).toBe(403);
    expect((await api().get("/admin/reports")).statusCode).toBe(401);
    const superAdmin = await moderator({ role: "super_admin", permissions: [] });
    expect((await api().get("/admin/reports", { token: superAdmin.token })).statusCode).toBe(200);
  });
});
