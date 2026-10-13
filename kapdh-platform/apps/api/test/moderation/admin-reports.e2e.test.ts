import type { Permission } from "@kapdh/contracts";
import {
  alumni,
  auditLogs,
  membershipEvents,
  messages,
  notifications,
  reports,
  sessions,
  users,
} from "@kapdh/database";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { expectOperation, expectRealtimeEnvelope } from "../support/contract.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  addRoomMember,
  createGroupRoom,
  createMessage,
  postReport,
  type RecordedEmit,
  recordRealtime,
  reportOk,
  reportVersion,
  resolveReport,
} from "./fixtures.js";

/**
 * Detail berbukti, klaim, dan keputusan moderasi pengurus (F-12; PRD 3.12, 4.2, 4.5; AC F12-3, F12-4, F12-5, F17-1;
 * kontrak admin-moderation.yaml adminGetReport/adminClaimReport/adminResolveReport).
 */

let t: TestApp;
let kernel: MembershipKernel;
let emits: RecordedEmit[];
const MODERATOR: Permission[] = ["moderation.read", "moderation.resolve"];
const DAY = 24 * 3600_000;

beforeAll(async () => {
  t = await createTestApp();
  kernel = t.app.get(MembershipKernel);
  emits = recordRealtime(t.app);
});
afterAll(async () => {
  await t.app.close();
});
beforeEach(() => {
  emits.length = 0;
});

const api = () => httpClient(t.app);

type Status = "verified" | "expiring" | "expired" | "suspended";

async function member(fullName: string, status: Status = "verified") {
  const fixture = await createAlumni(t, { fullName, status });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken };
}

async function moderator(
  options: { permissions?: Permission[]; linkedAlumniUserId?: string; name?: string } = {},
) {
  const admin = await createAdmin(t, {
    permissions: options.permissions ?? MODERATOR,
    linkedAlumniUserId: options.linkedAlumniUserId ?? null,
    displayName: options.name ?? "Moderator Uji",
  });
  return { ...admin, token: (await signInAdmin(t, admin)).accessToken };
}

type Detail = Record<string, unknown> & {
  id: string;
  version: string;
  status: string;
  evidence: {
    messages: Record<string, unknown>[];
    profile: Record<string, unknown> | null;
    room: Record<string, unknown> | null;
    contested_suspension: Record<string, unknown> | null;
  };
  resolution: Record<string, unknown> | null;
};

async function detail(token: string, id: string): Promise<Detail> {
  const res = await api().get(`/admin/reports/${id}`, { token });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/admin/reports/{reportId}", res) as Detail;
}

async function resolveOk(token: string, id: string, body: Record<string, unknown>): Promise<Detail> {
  const res = await resolveReport(t.app, token, id, await reportVersion(t.app, token, id), body);
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("post", "/admin/reports/{reportId}/resolve", res) as Detail;
}

const auditsOf = (entityId: string, action: string) =>
  t.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, entityId), eq(auditLogs.action, action)));

const inboxOf = (userId: string) => t.db.select().from(notifications).where(eq(notifications.userId, userId));

async function userReport(reporterToken: string, targetUserId: string, category = "harassment") {
  return reportOk(t.app, reporterToken, { target_type: "user", target_user_id: targetUserId, category });
}

describe("GET /admin/reports/{reportId}: bukti terminimalkan, akses diaudit (PRD 3.12, AC F17-1)", () => {
  it("AC F17-1: bukti pesan + konteks dengan gambar URL bertanda tangan sesi admin; audit moderation.report_viewed tanpa isi", async () => {
    const admin = await moderator();
    const reporter = await member("Pelapor Bukti");
    const sender = await member("Pengirim Bukti");
    const group = await createGroupRoom(t, { name: "Grup Bukti", adminId: reporter.userId });
    await addRoomMember(t, group, sender.userId);
    const image = await uploadTestFile(t, sender.token, "chat_image");
    const context = await createMessage(t, group, sender.userId, { body: "Isi konteks rahasia" });
    const reported = await createMessage(t, group, sender.userId, {
      imageFileId: image.id,
      body: "keterangan",
    });
    const id = await reportOk(t.app, reporter.token, {
      target_type: "message",
      message_id: reported,
      context_message_ids: [context],
      category: "sexual",
      description: "Gambar tidak pantas.",
    });

    const body = await detail(admin.token, id);
    expect(body).toMatchObject({
      id,
      category: "sexual",
      status: "open",
      target_type: "message",
      description: "Gambar tidak pantas.",
      room_id: group,
      room_name: "Grup Bukti",
      reporter: { user_id: reporter.userId, full_name: "Pelapor Bukti" },
      subject: { user_id: sender.userId, full_name: "Pengirim Bukti" },
      target_member: { user_id: sender.userId, effective_status: "verified", suspended_at: null },
      target_history: [],
      open_reports_against_target: 0,
      resolution: null,
      conflict_of_interest: false,
      version: "1",
    });
    expect(body.evidence.messages).toHaveLength(2);
    expect(body.evidence.messages[0]).toMatchObject({
      message_id: context,
      reported: false,
      sender_name: "Pengirim Bukti",
      body: "Isi konteks rahasia",
      image: null,
      deleted_since_report: false,
    });
    const evidenceImage = body.evidence.messages[1]!.image as {
      file_id: string;
      url: string;
      url_expires_at: string;
    };
    expect(evidenceImage.file_id).toBe(image.id);
    expect(new Date(evidenceImage.url_expires_at).getTime() - t.clock.now().getTime()).toBeLessThanOrEqual(
      600_000,
    );
    // URL bertanda tangan dapat dibuka sesi admin ber-izin moderation.read (kebijakan akses berkas bukti).
    const content = await t.app.inject({ method: "GET", url: new URL(evidenceImage.url).pathname });
    expect(content.statusCode).toBe(200);
    expect(String(content.headers["content-type"])).toMatch(/^image\//);

    const [viewed] = await auditsOf(id, "moderation.report_viewed");
    expect(viewed).toMatchObject({ actorAdminId: admin.adminId, entityType: "report" });
    expect(JSON.stringify(viewed!.after)).not.toContain("rahasia");
    expect(JSON.stringify(viewed!.after)).not.toContain("tidak pantas");

    // Pesan kemudian dihapus pengirim: snapshot tetap utuh, ditandai deleted_since_report.
    await t.db.update(messages).set({ deletedAt: t.clock.now(), body: null }).where(eq(messages.id, context));
    const again = await detail(admin.token, id);
    expect(again.evidence.messages[0]).toMatchObject({
      body: "Isi konteks rahasia",
      deleted_since_report: true,
    });
    expect(await auditsOf(id, "moderation.report_viewed")).toHaveLength(2);

    // D2, AC F14-3: akun pengirim dihapus → identitas anonim di bukti, isi chatnya menjadi placeholder tanpa isi,
    // subjek dan target_member null, gambar tidak dilayani.
    await t.db.update(users).set({ status: "deleted" }).where(eq(users.id, sender.userId));
    const anonymous = await detail(admin.token, id);
    expect(anonymous).toMatchObject({ subject: null, target_member: null });
    expect(anonymous.evidence.messages[1]).toMatchObject({
      sender_user_id: null,
      sender_name: null,
      body: null,
      image: { file_id: null, url: null, url_expires_at: null },
    });
  });

  it("AC F12-2: bukti profil dan grup memuat avatar saat laporan dibuat; tanpa izin moderation.read → 403; id tidak ada → 404", async () => {
    const admin = await moderator();
    const reporter = await member("Pelapor Profil");
    const target = await member("Pemilik Avatar");
    const avatar = await uploadTestFile(t, target.token, "avatar");
    await t.db
      .update(alumni)
      .set({ avatarFileId: avatar.id, bio: "Bio publik" })
      .where(eq(alumni.userId, target.userId));
    const id = await userReport(reporter.token, target.userId);
    const body = await detail(admin.token, id);
    expect(body.evidence.profile).toMatchObject({ full_name: "Pemilik Avatar", bio: "Bio publik" });
    expect((body.evidence.profile!.avatar as { file_id: string; url: string }).file_id).toBe(avatar.id);

    const groupAvatar = await uploadTestFile(t, reporter.token, "chat_image");
    const group = await createGroupRoom(t, {
      name: "Grup Avatar",
      adminId: target.userId,
      avatarFileId: groupAvatar.id,
    });
    await addRoomMember(t, group, reporter.userId);
    const roomReport = await reportOk(t.app, reporter.token, {
      target_type: "room",
      room_id: group,
      category: "hate",
    });
    const roomBody = await detail(admin.token, roomReport);
    expect(roomBody).toMatchObject({ subject: null, target_member: null, room_name: "Grup Avatar" });
    expect(roomBody.evidence.room).toMatchObject({
      room_id: group,
      kind: "group",
      name: "Grup Avatar",
      member_count: 2,
    });
    expect((roomBody.evidence.room!.avatar as { file_id: string }).file_id).toBe(groupAvatar.id);

    const noRead = await moderator({ permissions: ["members.read", "moderation.resolve"] });
    const denied = await api().get(`/admin/reports/${id}`, { token: noRead.token });
    expect(denied.statusCode).toBe(403);
    expectOperation("get", "/admin/reports/{reportId}", denied);
    expect((await api().get(`/admin/reports/${uuidv7()}`, { token: admin.token })).statusCode).toBe(404);
    expect((await api().get("/admin/reports/bukan-uuid", { token: admin.token })).statusCode).toBe(404);
    expect((await api().get(`/admin/reports/${id}`, { token: reporter.token })).statusCode).toBe(403);
  });
});

describe("POST /admin/reports/{reportId}/claim", () => {
  it("AC F12-3: klaim open → in_review; klaim ulang pengurus sama idempoten; versi usang 409 dengan current; ambil alih dengan versi terbaru", async () => {
    const first = await moderator({ name: "Moderator Satu" });
    const second = await moderator({ name: "Moderator Dua" });
    const reporter = await member("Pelapor Klaim");
    const target = await member("Terlapor Klaim");
    const id = await userReport(reporter.token, target.userId);
    const claim = (token: string, version: string, headers: Record<string, string> = {}) =>
      api().post(`/admin/reports/${id}/claim`, undefined, {
        token,
        headers: { "if-match": version, ...headers },
      });

    const claimed = await claim(first.token, "1");
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(expectOperation("post", "/admin/reports/{reportId}/claim", claimed)).toMatchObject({
      status: "in_review",
      claimed_by: { admin_id: first.adminId, display_name: "Moderator Satu" },
      version: "2",
    });
    expect(await auditsOf(id, "moderation.report_claimed")).toHaveLength(1);

    const repeat = await claim(first.token, "1");
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toMatchObject({ version: "2", claimed_by: { admin_id: first.adminId } });
    expect(await auditsOf(id, "moderation.report_claimed")).toHaveLength(1);

    const stale = await claim(second.token, "1");
    expect(stale.statusCode).toBe(409);
    const conflict = expectOperation("post", "/admin/reports/{reportId}/claim", stale) as {
      code: string;
      current: Detail;
    };
    expect(conflict.code).toBe("VERSION_CONFLICT");
    expect(conflict.current).toMatchObject({ id, version: "2", claimed_by: { admin_id: first.adminId } });
    // Bukti di `current` juga tercatat sebagai pembacaan.
    expect((await auditsOf(id, "moderation.report_viewed")).map((a) => a.actorAdminId)).toContain(
      second.adminId,
    );

    const takeover = await claim(second.token, "2");
    expect(takeover.statusCode).toBe(200);
    expect(takeover.json()).toMatchObject({ claimed_by: { admin_id: second.adminId }, version: "3" });
    const [, takenOver] = await auditsOf(id, "moderation.report_claimed");
    expect(takenOver!.after).toMatchObject({ taken_over: true });

    const missing = await api().post(`/admin/reports/${id}/claim`, undefined, { token: first.token });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().field_errors).toHaveProperty("If-Match");
    const readOnly = await moderator({ permissions: ["moderation.read"] });
    const forbidden = await claim(readOnly.token, "3");
    expect(forbidden.statusCode).toBe(403);
    expectOperation("post", "/admin/reports/{reportId}/claim", forbidden);

    await resolveOk(second.token, id, { action: "dismiss", note: "Tidak terbukti." });
    const afterDecision = await claim(first.token, "4");
    expect(afterDecision.statusCode).toBe(409);
    expect(afterDecision.json().current).toMatchObject({ status: "dismissed" });
  });
});

describe("POST /admin/reports/{reportId}/resolve (AC F12-3..F12-5)", () => {
  it("AC F12-3: dismiss — anggota tidak berubah; pelapor diberi tahu tanpa rincian; outcome no_action; satu keputusan", async () => {
    const admin = await moderator();
    const reporter = await member("Pelapor Dismiss");
    const target = await member("Terlapor Dismiss");
    const id = await userReport(reporter.token, target.userId);
    const decided = await resolveOk(admin.token, id, {
      action: "dismiss",
      note: "Percakapan wajar, tidak melanggar.",
    });
    expect(decided).toMatchObject({
      status: "dismissed",
      action: "dismiss",
      resolution: {
        action: "dismiss",
        note: "Percakapan wajar, tidak melanggar.",
        member_message: null,
        message_removed: false,
        resolved_by: { admin_id: admin.adminId },
      },
    });
    expect(
      await t.db.select().from(membershipEvents).where(eq(membershipEvents.userId, target.userId)),
    ).toEqual([]);
    const [notice] = await inboxOf(reporter.userId);
    expect(notice).toMatchObject({ category: "account", title: "Laporan Anda selesai ditinjau" });
    expect(notice!.data).toEqual({ route: "/account/reports" });
    expect(await inboxOf(target.userId)).toEqual([]);
    const view = (await api().get(`/reports/${id}`, { token: reporter.token })).json();
    expect(view).toMatchObject({ status: "dismissed", outcome: "no_action", decision_message: null });

    // Keputusan kedua dengan versi lama kalah: 409 dengan detail terbaru.
    const late = await resolveReport(t.app, admin.token, id, "1", {
      action: "warn",
      note: "x".repeat(5),
      member_message: "Mohon sopan.",
    });
    expect(late.statusCode).toBe(409);
    expect(expectOperation("post", "/admin/reports/{reportId}/resolve", late)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { status: "dismissed", version: "2" },
    });
  });

  it("AC F12-3: warn mencatat membership_events tanpa mengubah tanggal; alasan, aktor, waktu, rujukan bukti diaudit", async () => {
    const admin = await moderator({ name: "Moderator Warn" });
    const reporter = await member("Pelapor Warn");
    const target = await member("Terlapor Warn", "expiring");
    const [before] = await t.db.select().from(alumni).where(eq(alumni.userId, target.userId));
    const id = await userReport(reporter.token, target.userId);

    const decided = await resolveOk(admin.token, id, {
      action: "warn",
      note: "Kata kasar berulang di chat.",
      member_message: "Mohon menjaga bahasa sesuai ketentuan komunitas.",
    });
    expect(decided).toMatchObject({
      status: "resolved",
      action: "warn",
      target_history: [
        { kind: "warn", reason: "Kata kasar berulang di chat.", actor_name: "Moderator Warn" },
      ],
      resolution: { action: "warn", member_message: "Mohon menjaga bahasa sesuai ketentuan komunitas." },
    });
    const [after] = await t.db.select().from(alumni).where(eq(alumni.userId, target.userId));
    expect(after!.startsAt).toEqual(before!.startsAt);
    expect(after!.expiresAt).toEqual(before!.expiresAt);
    expect(after!.suspendedAt).toBeNull();
    const [event] = await t.db
      .select()
      .from(membershipEvents)
      .where(eq(membershipEvents.userId, target.userId));
    expect(event).toMatchObject({
      kind: "warn",
      actorAdminId: admin.adminId,
      reason: "Kata kasar berulang di chat.",
    });
    expect(event!.afterExpiresAt).toBeNull();

    const [audit] = await auditsOf(id, "moderation.report_resolved");
    expect(audit).toMatchObject({ actorAdminId: admin.adminId, reason: "Kata kasar berulang di chat." });
    expect(audit!.after).toMatchObject({
      action: "warn",
      membership_event_id: event!.id,
      subject_user_id: target.userId,
    });
    expect((audit!.after as { evidence_captured_at: string }).evidence_captured_at).toBeTruthy();
    expect(await auditsOf(target.userId, "member.warned")).toHaveLength(1);

    const warning = (await inboxOf(target.userId)).find((n) => n.title === "Peringatan dari pengurus");
    expect(warning).toMatchObject({
      category: "account",
      body: "Mohon menjaga bahasa sesuai ketentuan komunitas.",
    });
    // Pesan aman tidak menyebut pelapor maupun alasan internal.
    expect(warning!.body).not.toContain("Pelapor");
    expect(warning!.body).not.toContain("Kata kasar");
    expect((await api().get("/me", { token: target.token })).json().effective_status).toBe("expiring");
  });

  it("AC F12-4: suspend (konfirmasi wajib) mencabut sesi dan akses komunitas, menyembunyikan dari direktori, KTA tidak aktif", async () => {
    const admin = await moderator();
    const reporter = await member("Pelapor Suspend");
    const target = await member("Terlapor Suspend");
    const id = await userReport(reporter.token, target.userId, "scam");

    const noConfirm = await resolveReport(t.app, admin.token, id, "1", {
      action: "suspend",
      note: "Penipuan transfer.",
      member_message: "Akun Anda dibatasi karena laporan penipuan.",
    });
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json().field_errors).toHaveProperty("confirm");

    const decided = await resolveOk(admin.token, id, {
      action: "suspend",
      note: "Penipuan transfer terbukti.",
      member_message: "Akun Anda dibatasi karena laporan penipuan.",
      confirm: true,
    });
    expect(decided).toMatchObject({
      status: "resolved",
      action: "suspend",
      target_member: {
        effective_status: "suspended",
        suspension_message: "Akun Anda dibatasi karena laporan penipuan.",
      },
    });
    // Sesi umum dicabut: token lama ditolak, socket diputus (session.revoked).
    expect((await api().get("/me", { token: target.token })).statusCode).toBe(401);
    expect(
      await t.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, target.userId), isNull(sessions.revokedAt))),
    ).toEqual([]);
    const revoked = emits.find(
      (e) => e.event === "session.revoked" && e.channels.includes(`user:${target.userId}`),
    );
    expect(revoked).toBeDefined();
    expectRealtimeEnvelope(revoked!.data);
    expect(revoked!.data.payload).toMatchObject({ reason: "account_suspended", all_sessions: true });

    // Akses komunitas ditolak walau login ulang (portal pembatasan), KTA/verifikasi publik membaca status suspended.
    const relogin = await signInAlumni(t, target);
    const community = await api().get("/blocks", { token: relogin.accessToken });
    expect(community.statusCode).toBe(403);
    expect(community.json().code).toBe("ACCOUNT_SUSPENDED");
    expect((await kernel.effectiveStatusFor(target.userId))?.status).toBe("suspended");
    // Direktori menyembunyikan profil: anggota tanpa room bersama tidak lagi dapat menjangkaunya.
    const stranger = await member("Anggota Asing");
    expect(
      (
        await postReport(t.app, stranger.token, {
          target_type: "user",
          target_user_id: target.userId,
          category: "spam",
        })
      ).statusCode,
    ).toBe(404);
    const [audit] = await auditsOf(target.userId, "member.suspended");
    expect(audit).toMatchObject({ actorAdminId: admin.adminId, reason: "Penipuan transfer terbukti." });

    // Subjek yang sudah suspended → 400 dengan keadaan terkini; laporan tetap aktif (pernah satu room dengan pelapor).
    const group = await createGroupRoom(t, { adminId: reporter.userId });
    await addRoomMember(t, group, target.userId, { status: "left" });
    const second = await userReport(reporter.token, target.userId, "spam");
    const already = await resolveReport(t.app, admin.token, second, "1", {
      action: "suspend",
      note: "Laporan lain.",
      member_message: "Akun Anda dibatasi.",
      confirm: true,
    });
    expect(already.statusCode).toBe(400);
    expect(already.json().current).toMatchObject({ account_status: "active" });
    expect((await t.db.select().from(reports).where(eq(reports.id, second)))[0]!.status).toBe("open");
  });

  it("AC F12-5: unsuspend menghitung ulang dari expires_at (expired, bukan verified) dan menutup banding aktif lain", async () => {
    const admin = await moderator();
    const reporter = await member("Pelapor Unsuspend");
    const subject = await member("Anggota Dibatasi", "suspended");
    const appeal = (
      await api().post(
        "/appeals",
        { description: "Saya mohon pembatasan dicabut." },
        { token: subject.token },
      )
    ).json().id as string;
    // Laporan biasa terhadap anggota yang dibatasi (pernah satu room) lalu diputus unsuspend; masa aktif sudah habis.
    const group = await createGroupRoom(t, { adminId: reporter.userId });
    await addRoomMember(t, group, subject.userId, { status: "left" });
    const report = await reportOk(t.app, reporter.token, {
      target_type: "user",
      target_user_id: subject.userId,
      category: "other",
      description: "Pembatasan sebelumnya keliru orang.",
    });
    await t.db
      .update(alumni)
      .set({
        expiresAt: new Date(t.clock.now().getTime() - DAY),
        startsAt: new Date(t.clock.now().getTime() - 400 * DAY),
      })
      .where(eq(alumni.userId, subject.userId));

    const decided = await resolveOk(admin.token, report, {
      action: "unsuspend",
      note: "Identitas tertukar; pembatasan dicabut.",
      confirm: true,
    });
    expect(decided).toMatchObject({
      status: "resolved",
      action: "unsuspend",
      target_member: { effective_status: "expired", suspended_at: null },
    });
    expect((await kernel.effectiveStatusFor(subject.userId))?.status).toBe("expired");
    // Banding aktif pemohon ditutup sebagai dikabulkan dalam transaksi yang sama; satu notifikasi.
    const [appealRow] = await t.db.select().from(reports).where(eq(reports.id, appeal));
    expect(appealRow).toMatchObject({
      status: "resolved",
      action: "unsuspend",
      resolvedByAdminId: admin.adminId,
    });
    expect(appealRow!.resolutionNote).toContain(report);
    const granted = (await inboxOf(subject.userId)).filter((n) => n.title === "Banding dikabulkan");
    expect(granted).toHaveLength(1);
    expect(granted[0]!.data).toEqual({ route: "/renewal" });

    const notSuspended = await reportOk(t.app, reporter.token, {
      target_type: "user",
      target_user_id: subject.userId,
      category: "spam",
    });
    const refused = await resolveReport(t.app, admin.token, notSuspended, "1", {
      action: "unsuspend",
      note: "Cabut lagi.",
      confirm: true,
    });
    expect(refused.statusCode).toBe(400);
    expect((await t.db.select().from(reports).where(eq(reports.id, notSuspended)))[0]!.status).toBe("open");
  });

  it("AC F12-3: banding hanya dismiss (ditolak) atau unsuspend (dikabulkan, satu notifikasi); member_message wajib", async () => {
    const admin = await moderator();
    const rejected = await member("Pemohon Ditolak", "suspended");
    const rejectedAppeal = (
      await api().post("/appeals", { description: "Mohon ditinjau kembali." }, { token: rejected.token })
    ).json().id as string;
    const version = await reportVersion(t.app, admin.token, rejectedAppeal);
    const appealDetail = await detail(admin.token, rejectedAppeal);
    expect(appealDetail).toMatchObject({ category: "appeal", subject: { user_id: rejected.userId } });
    expect(appealDetail.evidence.contested_suspension).toMatchObject({ in_force: true, suspended_by: null });

    for (const body of [
      { action: "warn", note: "Tidak boleh.", member_message: "Peringatan." },
      { action: "suspend", note: "Tidak boleh.", member_message: "Peringatan.", confirm: true },
      { action: "dismiss", note: "Ditolak tanpa pesan." },
    ]) {
      const res = await resolveReport(t.app, admin.token, rejectedAppeal, version, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const dismissed = await resolveOk(admin.token, rejectedAppeal, {
      action: "dismiss",
      note: "Bukti pelanggaran kuat.",
      member_message: "Banding Anda belum dapat dikabulkan.",
    });
    expect(dismissed).toMatchObject({ status: "dismissed" });
    const [notice] = (await inboxOf(rejected.userId)).filter((n) => n.title === "Banding ditolak");
    expect(notice).toMatchObject({
      body: "Banding Anda belum dapat dikabulkan.",
      data: { route: "/account/reports" },
    });
    const view = (await api().get(`/reports/${rejectedAppeal}`, { token: rejected.token })).json();
    expect(view).toMatchObject({
      outcome: "no_action",
      decision_message: "Banding Anda belum dapat dikabulkan.",
    });
    expect((await kernel.effectiveStatusFor(rejected.userId))?.status).toBe("suspended");

    const grantedMember = await member("Pemohon Dikabulkan", "suspended");
    const grantedAppeal = (
      await api().post(
        "/appeals",
        { description: "Mohon dicabut, sudah klarifikasi." },
        { token: grantedMember.token },
      )
    ).json().id as string;
    const granted = await resolveOk(admin.token, grantedAppeal, {
      action: "unsuspend",
      note: "Klarifikasi diterima.",
      member_message: "Banding diterima, terima kasih atas klarifikasinya.",
      confirm: true,
    });
    expect(granted).toMatchObject({
      status: "resolved",
      action: "unsuspend",
      target_member: { effective_status: "verified" },
    });
    const inbox = await inboxOf(grantedMember.userId);
    expect(inbox.filter((n) => n.title === "Banding dikabulkan")).toHaveLength(1);
    const view2 = (
      await api().get(`/reports/${grantedAppeal}`, {
        token: (await signInAlumni(t, grantedMember)).accessToken,
      })
    ).json();
    expect(view2).toMatchObject({
      outcome: "action_taken",
      decision_message: "Banding diterima, terima kasih atas klarifikasinya.",
    });
  });

  it("AC F12-5: banding usang (suspend sudah dicabut lewat jalur lain): dismiss 400; unsuspend menutup tanpa mengubah keanggotaan", async () => {
    const admin = await moderator();
    const appellant = await member("Pemohon Usang", "suspended");
    const appeal = (
      await api().post("/appeals", { description: "Banding atas suspend lama." }, { token: appellant.token })
    ).json().id as string;
    // Jalur pencabutan yang keliru tidak menutup banding (jaring pengaman kontrak).
    await t.db
      .update(alumni)
      .set({ suspendedAt: null, suspensionReason: null, suspensionMessage: null })
      .where(eq(alumni.userId, appellant.userId));
    const stale = await detail(admin.token, appeal);
    expect(stale.evidence.contested_suspension).toMatchObject({ in_force: false });

    const dismiss = await resolveReport(t.app, admin.token, appeal, stale.version, {
      action: "dismiss",
      note: "Tolak.",
      member_message: "Banding ditolak.",
    });
    expect(dismiss.statusCode).toBe(400);
    expect(dismiss.json().field_errors).toHaveProperty("action");
    const eventsBefore = await t.db
      .select()
      .from(membershipEvents)
      .where(eq(membershipEvents.userId, appellant.userId));
    const closed = await resolveOk(admin.token, appeal, {
      action: "unsuspend",
      note: "Suspend sudah dicabut sebelumnya.",
      member_message: "Pembatasan Anda sudah tidak berlaku.",
      confirm: true,
    });
    expect(closed).toMatchObject({ status: "resolved", action: "unsuspend" });
    expect(
      await t.db.select().from(membershipEvents).where(eq(membershipEvents.userId, appellant.userId)),
    ).toEqual(eventsBefore);
    const [audit] = await auditsOf(appeal, "moderation.report_resolved");
    expect(audit!.after).toMatchObject({ stale_appeal: true, membership_unchanged: true });
    expect((await inboxOf(appellant.userId)).filter((n) => n.title === "Banding dikabulkan")).toHaveLength(1);
  });

  it("AC F12-3: remove_message: pesan terlapor menjadi placeholder, message.deleted ke room, bukti tetap utuh", async () => {
    const admin = await moderator();
    const reporter = await member("Pelapor Pesan");
    const sender = await member("Pengirim Pesan");
    const group = await createGroupRoom(t, { adminId: reporter.userId });
    await addRoomMember(t, group, sender.userId);
    const message = await createMessage(t, group, sender.userId, { body: "Isi kasar yang dilaporkan" });
    const id = await reportOk(t.app, reporter.token, {
      target_type: "message",
      message_id: message,
      category: "harassment",
    });

    const decided = await resolveOk(admin.token, id, {
      action: "warn",
      note: "Bahasa kasar.",
      member_message: "Pesan Anda dihapus karena melanggar ketentuan.",
      remove_message: true,
    });
    expect(decided.resolution).toMatchObject({ message_removed: true });
    expect(decided.evidence.messages[0]).toMatchObject({
      body: "Isi kasar yang dilaporkan",
      deleted_since_report: true,
    });
    const [row] = await t.db.select().from(messages).where(eq(messages.id, message));
    expect(row).toMatchObject({ body: null, imageFileId: null });
    expect(row!.deletedAt).not.toBeNull();
    const deleted = emits.find((e) => e.event === "message.deleted");
    expect(deleted?.channels).toEqual([`room:${group}`]);
    expectRealtimeEnvelope(deleted!.data);
    expect(deleted!.data.payload).toMatchObject({ room_id: group, message_id: message });
  });

  it("AC F12-3: laporan grup: subjek wajib untuk tindakan, anggota/mantan anggota grup, bukan akun tertaut pemanggil", async () => {
    const reporter = await member("Pelapor Grup");
    const culprit = await member("Pelaku Grup");
    const outsider = await member("Bukan Anggota");
    const linkedAdmin = await moderator({ linkedAlumniUserId: outsider.userId });
    const admin = await moderator();
    const group = await createGroupRoom(t, { adminId: culprit.userId });
    await addRoomMember(t, group, reporter.userId);
    const id = await reportOk(t.app, reporter.token, {
      target_type: "room",
      room_id: group,
      category: "spam",
    });
    const send = (token: string, body: Record<string, unknown>) => resolveReport(t.app, token, id, "1", body);
    const warn = { action: "warn", note: "Spam promosi.", member_message: "Hentikan promosi di grup." };

    expect((await send(admin.token, warn)).json().field_errors).toHaveProperty("subject_user_id");
    expect((await send(admin.token, { ...warn, subject_user_id: outsider.userId })).statusCode).toBe(400);
    expect((await send(linkedAdmin.token, { ...warn, subject_user_id: outsider.userId })).statusCode).toBe(
      403,
    );
    expect(
      (await send(admin.token, { action: "dismiss", note: "Tutup.", subject_user_id: culprit.userId }))
        .statusCode,
    ).toBe(400);
    const decided = await send(admin.token, { ...warn, subject_user_id: culprit.userId });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json()).toMatchObject({
      subject: { user_id: culprit.userId },
      target_member: { user_id: culprit.userId },
    });
    expect((await t.db.select().from(reports).where(eq(reports.id, id)))[0]!.targetUserId).toBe(
      culprit.userId,
    );
    // Pelapor tetap tidak melihat siapa yang dikenai tindakan (target_name null untuk laporan grup).
    expect((await api().get(`/reports/${id}`, { token: reporter.token })).json()).toMatchObject({
      target_name: null,
      outcome: "action_taken",
    });
  });

  it("AC F12-3: validasi: note kosong/spasi, member_message wajib untuk warn/suspend, subject/remove_message tidak sesuai jenis → 400", async () => {
    const admin = await moderator();
    const reporter = await member("Pelapor Validasi");
    const target = await member("Terlapor Validasi");
    const id = await userReport(reporter.token, target.userId);
    const cases: [Record<string, unknown>, string][] = [
      [{ action: "dismiss", note: "   " }, "note"],
      [{ action: "dismiss" }, "note"],
      [{ action: "hapus", note: "Alasan." }, "action"],
      [{ action: "warn", note: "Alasan cukup." }, "member_message"],
      [{ action: "suspend", note: "Alasan cukup.", confirm: true }, "member_message"],
      [
        { action: "warn", note: "Alasan cukup.", member_message: "Pesan.", subject_user_id: target.userId },
        "subject_user_id",
      ],
      [{ action: "dismiss", note: "Alasan cukup.", remove_message: true }, "remove_message"],
      [{ action: "dismiss", note: "x".repeat(1001) }, "note"],
    ];
    for (const [body, field] of cases) {
      const res = await resolveReport(t.app, admin.token, id, "1", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expectOperation("post", "/admin/reports/{reportId}/resolve", res);
      expect(res.json().field_errors, JSON.stringify(body)).toHaveProperty(field);
    }
    const noIfMatch = await api().post(
      `/admin/reports/${id}/resolve`,
      { action: "dismiss", note: "Tutup." },
      { token: admin.token },
    );
    expect(noIfMatch.statusCode).toBe(400);
    const readOnly = await moderator({ permissions: ["moderation.read"] });
    expect(
      (await resolveReport(t.app, readOnly.token, id, "1", { action: "dismiss", note: "Tutup." })).statusCode,
    ).toBe(403);
    expect(
      (await resolveReport(t.app, reporter.token, id, "1", { action: "dismiss", note: "Tutup." })).statusCode,
    ).toBe(403);
    expect(
      (await resolveReport(t.app, admin.token, uuidv7(), "1", { action: "dismiss", note: "Tutup." }))
        .statusCode,
    ).toBe(404);

    // Akun terlapor dihapus: hanya dismiss.
    await t.db.update(users).set({ status: "deleted" }).where(eq(users.id, target.userId));
    const gone = await resolveReport(t.app, admin.token, id, "1", {
      action: "warn",
      note: "Alasan.",
      member_message: "Pesan.",
    });
    expect(gone.statusCode).toBe(400);
    const closed = await resolveReport(t.app, admin.token, id, "1", {
      action: "dismiss",
      note: "Akun sudah dihapus.",
    });
    expect(closed.statusCode, closed.body).toBe(200);

    // Idempotency-Key: keputusan yang diulang mengembalikan hasil pertama.
    const another = await userReport(reporter.token, (await member("Terlapor Idem")).userId);
    const key = uuidv7();
    const once = await resolveReport(
      t.app,
      admin.token,
      another,
      "1",
      { action: "dismiss", note: "Tutup." },
      { "idempotency-key": key },
    );
    const replay = await resolveReport(
      t.app,
      admin.token,
      another,
      "1",
      { action: "dismiss", note: "Tutup." },
      { "idempotency-key": key },
    );
    expect(once.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(await auditsOf(another, "moderation.report_resolved")).toHaveLength(1);
  });
});
