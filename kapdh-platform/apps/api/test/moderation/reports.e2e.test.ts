import { alumni, auditLogs, files, notifications, reports, roomMembers, users } from "@kapdh/database";
import { and, eq, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import type { Tx } from "../../src/core/db/types.js";
import { FilesService } from "../../src/core/files/files.service.js";
import { DEFAULT_UNSUSPEND_MESSAGE, MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { addBusinessDaysJakarta } from "../../src/modules/moderation/due-at.js";
import { anonymizeEvidenceOf } from "../../src/modules/moderation/evidence-anonymize.js";
import { expectOperation } from "../support/contract.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  addRoomMember,
  createDirectRoom,
  createGroupRoom,
  createMessage,
  postReport,
  recordRealtime,
  reportOk,
} from "./fixtures.js";

/**
 * Laporan dan banding anggota (F-12, PRD 3.12, AC F12-2; kontrak moderation.yaml listMyReports/createReport/
 * getMyReport/createAppeal), bukti terminimalkan dan retensi berkas bukti (D2).
 */

let t: TestApp;
let kernel: MembershipKernel;

beforeAll(async () => {
  t = await createTestApp();
  kernel = t.app.get(MembershipKernel);
  recordRealtime(t.app);
});
afterAll(async () => {
  await t.app.close();
});

const api = () => httpClient(t.app);
const HOUR = 3600_000;

type Status = "verified" | "expiring" | "expired" | "suspended" | "unverified";

async function member(
  status: Status = "verified",
  options: { fullName?: string; showInDirectory?: boolean } = {},
) {
  const fixture = await createAlumni(t, {
    status,
    fullName: options.fullName ?? `Anggota ${status}`,
    showInDirectory: options.showInDirectory,
  });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken };
}

function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runAsSystem(() => withTx(t.db, fn));
}

async function reportRow(id: string) {
  const [row] = await t.db.select().from(reports).where(eq(reports.id, id));
  return row!;
}

describe("POST /reports — pengguna (AC F12-2)", () => {
  it("AC F12-2: laporan terdaftar, dapat dipantau pelapor, dan tidak dibuka kepada pihak terlapor", async () => {
    const reporter = await member("verified", { fullName: "Pelapor Uji" });
    const target = await member("expiring", { fullName: "Terlapor Uji" });

    const res = await postReport(t.app, reporter.token, {
      target_type: "user",
      target_user_id: target.userId,
      category: "harassment",
      description: "Mengirim pesan yang merendahkan berulang kali.",
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = expectOperation("post", "/reports", res) as Record<string, string | null>;
    expect(created).toMatchObject({
      category: "harassment",
      target_type: "user",
      target_name: "Terlapor Uji",
      room_name: null,
      status: "open",
      priority: "normal",
      outcome: null,
      decision_message: null,
      resolved_at: null,
    });
    // Target penanganan 2 hari kerja WIB sejak dibuat (v3.2).
    expect(created.due_at).toBe(addBusinessDaysJakarta(new Date(created.created_at!), 2).toISOString());
    // Respons pelapor tidak memuat identitas pelapor/terlapor maupun bukti (additionalProperties false di kontrak).
    expect(Object.keys(created)).not.toContain("target_user_id");
    expect(Object.keys(created)).not.toContain("evidence");

    // Dipantau pelapor.
    const mine = expectOperation(
      "get",
      "/reports",
      await api().get("/reports", { token: reporter.token }),
    ) as {
      items: { id: string }[];
    };
    expect(mine.items.map((i) => i.id)).toContain(created.id);
    const detail = await api().get(`/reports/${created.id}`, { token: reporter.token });
    expect(expectOperation("get", "/reports/{reportId}", detail)).toMatchObject({ id: created.id });

    // Tidak dibuka kepada terlapor: tidak ada di daftarnya, detail 404 seperti laporan yang tidak ada (N-09).
    const theirs = expectOperation(
      "get",
      "/reports",
      await api().get("/reports", { token: target.token }),
    ) as {
      items: unknown[];
    };
    expect(theirs.items).toEqual([]);
    const hidden = await api().get(`/reports/${created.id}`, { token: target.token });
    expect(hidden.statusCode).toBe(404);
    expectOperation("get", "/reports/{reportId}", hidden);
    expect((await api().get(`/reports/${uuidv7()}`, { token: reporter.token })).statusCode).toBe(404);
    expect((await api().get("/reports/bukan-uuid", { token: reporter.token })).statusCode).toBe(404);
    // Terlapor tidak menerima notifikasi apa pun tentang laporan.
    expect(await t.db.select().from(notifications).where(eq(notifications.userId, target.userId))).toEqual(
      [],
    );

    // Bukti profil publik minimum + audit tanpa deskripsi pelapor.
    const row = await reportRow(created.id!);
    expect(row).toMatchObject({ reporterId: reporter.userId, targetUserId: target.userId, roomId: null });
    expect(row.evidence).toMatchObject({
      v: 1,
      messages: [],
      room: null,
      profile: { user_id: target.userId, full_name: "Terlapor Uji", bio: null, avatar_file_id: null },
      contested_suspension: null,
    });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.id!), eq(auditLogs.action, "moderation.report_created")));
    expect(audit).toMatchObject({ actorUserId: reporter.userId, effectiveRole: "alumni" });
    expect(JSON.stringify(audit!.after)).not.toContain("merendahkan");

    // Laporan aktif atas target yang sama dikembalikan (200) tanpa laporan baru.
    const duplicate = await postReport(t.app, reporter.token, {
      target_type: "user",
      target_user_id: target.userId,
      category: "spam",
    });
    expect(duplicate.statusCode).toBe(200);
    expect(expectOperation("post", "/reports", duplicate)).toMatchObject({
      id: created.id,
      category: "harassment",
    });
  });

  it("AC F12-2: violence_threat menjadi urgent dengan target 24 jam", async () => {
    const reporter = await member();
    const target = await member();
    const res = await postReport(t.app, reporter.token, {
      target_type: "user",
      target_user_id: target.userId,
      category: "violence_threat",
    });
    const body = expectOperation("post", "/reports", res) as {
      priority: string;
      created_at: string;
      due_at: string;
    };
    expect(body.priority).toBe("urgent");
    expect(new Date(body.due_at).getTime() - new Date(body.created_at).getTime()).toBe(24 * HOUR);
  });

  it("AC F12-2: Idempotency-Key: pengulangan mengembalikan hasil pertama", async () => {
    const reporter = await member();
    const target = await member();
    const key = uuidv7();
    const body = { target_type: "user", target_user_id: target.userId, category: "scam" };
    const first = await postReport(t.app, reporter.token, body, { "idempotency-key": key });
    const replay = await postReport(t.app, reporter.token, body, { "idempotency-key": key });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json().id).toBe(first.json().id);
    const conflict = await postReport(
      t.app,
      reporter.token,
      { ...body, category: "spam" },
      { "idempotency-key": key },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("AC F12-2: hanya pengguna yang dapat diakses pelapor (direktori atau pernah satu room); selain itu 404", async () => {
    const reporter = await member();
    const hiddenProfile = await member("verified", { showInDirectory: false });
    const expired = await member("expired");
    const notFoundBody = { target_type: "user", category: "spam" };

    const hidden = await postReport(t.app, reporter.token, {
      ...notFoundBody,
      target_user_id: hiddenProfile.userId,
    });
    expect(hidden.statusCode).toBe(404);
    expectOperation("post", "/reports", hidden);
    expect(
      (await postReport(t.app, reporter.token, { ...notFoundBody, target_user_id: expired.userId }))
        .statusCode,
    ).toBe(404);
    expect(
      (await postReport(t.app, reporter.token, { ...notFoundBody, target_user_id: uuidv7() })).statusCode,
    ).toBe(404);
    const admin = await createAdmin(t);
    expect(
      (await postReport(t.app, reporter.token, { ...notFoundBody, target_user_id: admin.userId })).statusCode,
    ).toBe(404);

    // Pernah berada di room yang sama (termasuk yang sudah keluar) → dapat dilaporkan.
    const group = await createGroupRoom(t, { adminId: reporter.userId });
    await addRoomMember(t, group, expired.userId, { status: "left" });
    await reportOk(t.app, reporter.token, { ...notFoundBody, target_user_id: expired.userId });
    await createDirectRoom(t, reporter.userId, hiddenProfile.userId);
    await reportOk(t.app, reporter.token, { ...notFoundBody, target_user_id: hiddenProfile.userId });
  });

  it("AC F12-2: undangan yang dibatalkan sebelum diterima bukan 'pernah satu room' (404); anggota yang dikeluarkan setelah bergabung tetap terhitung", async () => {
    const reporter = await member();
    const invitee = await member("verified", { showInDirectory: false });
    const formerMember = await member("verified", { showInDirectory: false });
    const group = await createGroupRoom(t, { adminId: reporter.userId });
    await addRoomMember(t, group, invitee.userId, { status: "invited", invitedBy: reporter.userId });
    // Blokir membatalkan undangan tertunda (invited → removed, joined_at kosong), lalu blokir dibuka lagi.
    expect(
      (await api().put(`/blocks/${invitee.userId}`, undefined, { token: reporter.token })).statusCode,
    ).toBe(200);
    expect((await api().delete(`/blocks/${invitee.userId}`, { token: reporter.token })).statusCode).toBe(204);
    const [membership] = await t.db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, group), eq(roomMembers.userId, invitee.userId)));
    expect(membership).toMatchObject({ status: "removed", joinedAt: null });

    const body = { target_type: "user", category: "spam" };
    const neverJoined = await postReport(t.app, reporter.token, { ...body, target_user_id: invitee.userId });
    expect(neverJoined.statusCode, neverJoined.body).toBe(404);
    expectOperation("post", "/reports", neverJoined);
    expect(await t.db.select().from(reports).where(eq(reports.targetUserId, invitee.userId))).toEqual([]);

    // Dikeluarkan admin grup SETELAH bergabung (removed dengan joined_at) tetap "pernah satu room".
    await addRoomMember(t, group, formerMember.userId, { status: "removed" });
    await reportOk(t.app, reporter.token, { ...body, target_user_id: formerMember.userId });
  });
});

describe("POST /reports — pesan dan grup (PRD 3.12 bukti terminimalkan)", () => {
  it("AC F12-2: pesan orang lain di room joined; bukti snapshot pesan + konteks; pengirim menjadi terlapor", async () => {
    const reporter = await member();
    const sender = await member("verified", { fullName: "Pengirim Uji" });
    const group = await createGroupRoom(t, { name: "Alumni 29", adminId: reporter.userId });
    await addRoomMember(t, group, sender.userId);
    const image = await uploadTestFile(t, sender.token, "chat_image");
    const before = await createMessage(t, group, sender.userId, { body: "Konteks sebelum" });
    const reported = await createMessage(t, group, sender.userId, { imageFileId: image.id });
    const after = await createMessage(t, group, reporter.userId, { body: "Tolong jangan begitu" });

    const res = await postReport(t.app, reporter.token, {
      target_type: "message",
      message_id: reported,
      context_message_ids: [after, before],
      category: "sexual",
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = expectOperation("post", "/reports", res) as Record<string, unknown>;
    expect(body).toMatchObject({
      target_type: "message",
      target_name: "Pengirim Uji",
      room_name: "Alumni 29",
    });

    const row = await reportRow(body.id as string);
    expect(row).toMatchObject({ targetUserId: sender.userId, targetMessageId: reported, roomId: group });
    const evidence = row.evidence as {
      file_ids: string[];
      room_name: string;
      messages: { message_id: string; reported: boolean; sender_name: string | null; body: string | null }[];
    };
    expect(evidence.room_name).toBe("Alumni 29");
    expect(evidence.file_ids).toEqual([image.id]);
    expect(evidence.messages.map((m) => [m.message_id, m.reported])).toEqual([
      [before, false],
      [reported, true],
      [after, false],
    ]);
    expect(evidence.messages[0]).toMatchObject({ sender_name: "Pengirim Uji", body: "Konteks sebelum" });
  });

  it("AC F12-2: pesan: sendiri/sistem → 400; bukan anggota, dihapus, atau sebelum history_visible_from → 404; konteks salah → 400", async () => {
    const reporter = await member();
    const sender = await member();
    const outsider = await member();
    const group = await createGroupRoom(t, { adminId: sender.userId });
    const early = await createMessage(t, group, sender.userId, { body: "Sebelum bergabung" });
    await addRoomMember(t, group, reporter.userId, { historyVisibleFrom: t.clock.now() });
    const visible = await createMessage(t, group, sender.userId, { body: "Sesudah bergabung" });
    const own = await createMessage(t, group, reporter.userId);
    const system = await createMessage(t, group, null, { kind: "system", body: "Anggota bergabung" });
    const otherRoom = await createGroupRoom(t, { adminId: outsider.userId });
    const foreign = await createMessage(t, otherRoom, outsider.userId);
    const report = (body: Record<string, unknown>) =>
      postReport(t.app, reporter.token, { target_type: "message", category: "spam", ...body });

    expect((await report({ message_id: own })).statusCode).toBe(400);
    expect((await report({ message_id: system })).statusCode).toBe(400);
    expect((await report({ message_id: early })).statusCode).toBe(404);
    expect((await report({ message_id: foreign })).statusCode).toBe(404);
    expect((await report({ message_id: uuidv7() })).statusCode).toBe(404);
    const contextElsewhere = await report({ message_id: visible, context_message_ids: [foreign] });
    expect(contextElsewhere.statusCode).toBe(400);
    expect(contextElsewhere.json().field_errors).toHaveProperty("context_message_ids");
    expect((await report({ message_id: visible, context_message_ids: [early] })).statusCode).toBe(400);
    expect((await report({ message_id: visible, context_message_ids: [visible] })).statusCode).toBe(400);
    expect(
      (await report({ message_id: visible, context_message_ids: [own, own] })).statusCode,
      "konteks berulang",
    ).toBe(400);
    const tooMany = await report({
      message_id: visible,
      context_message_ids: Array.from({ length: 6 }, () => uuidv7()),
    });
    expect(tooMany.statusCode).toBe(400);

    // Pelapor keluar dari grup → pesan tidak lagi terlihat baginya.
    const leaver = await member();
    await addRoomMember(t, group, leaver.userId, { status: "left" });
    expect(
      (
        await postReport(t.app, leaver.token, {
          target_type: "message",
          category: "spam",
          message_id: visible,
        })
      ).statusCode,
    ).toBe(404);

    await reportOk(t.app, reporter.token, { target_type: "message", category: "spam", message_id: visible });
  });

  it("AC F12-2: grup: bukti nama, avatar dan jumlah anggota; room direct → 400; bukan anggota → 404", async () => {
    const reporter = await member();
    const owner = await member();
    const avatar = await uploadTestFile(t, owner.token, "chat_image");
    const group = await createGroupRoom(t, {
      name: "Grup Dilaporkan",
      adminId: owner.userId,
      avatarFileId: avatar.id,
    });
    await addRoomMember(t, group, reporter.userId);
    await addRoomMember(t, group, (await member()).userId, { status: "invited", invitedBy: owner.userId });

    const res = await postReport(t.app, reporter.token, {
      target_type: "room",
      room_id: group,
      category: "hate",
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(expectOperation("post", "/reports", res)).toMatchObject({
      target_type: "room",
      target_name: null,
      room_name: "Grup Dilaporkan",
    });
    const row = await reportRow(res.json().id);
    expect(row.targetUserId).toBeNull();
    expect(row.evidence).toMatchObject({
      file_ids: [avatar.id],
      room: {
        room_id: group,
        kind: "group",
        name: "Grup Dilaporkan",
        avatar_file_id: avatar.id,
        member_count: 2,
      },
    });

    const direct = await createDirectRoom(t, reporter.userId, owner.userId);
    const directRes = await postReport(t.app, reporter.token, {
      target_type: "room",
      room_id: direct,
      category: "hate",
    });
    expect(directRes.statusCode).toBe(400);
    expect(directRes.json().field_errors).toHaveProperty("room_id");
    const outsider = await member();
    expect(
      (await postReport(t.app, outsider.token, { target_type: "room", room_id: group, category: "hate" }))
        .statusCode,
    ).toBe(404);
  });
});

describe("POST /reports — validasi, laju dan otorisasi", () => {
  it("AC F12-2: field target sesuai target_type, kategori other wajib penjelasan, diri sendiri → 400", async () => {
    const reporter = await member();
    const target = await member();
    const cases: [Record<string, unknown>, string][] = [
      [{ target_type: "user", category: "spam" }, "target_user_id"],
      [
        { target_type: "user", target_user_id: target.userId, message_id: uuidv7(), category: "spam" },
        "message_id",
      ],
      [{ target_type: "message", message_id: uuidv7(), room_id: uuidv7(), category: "spam" }, "room_id"],
      [
        { target_type: "room", room_id: uuidv7(), context_message_ids: [uuidv7()], category: "spam" },
        "context_message_ids",
      ],
      [
        { target_type: "user", target_user_id: target.userId, category: "other", description: "  singkat  " },
        "description",
      ],
      [{ target_type: "user", target_user_id: target.userId, category: "appeal" }, "category"],
      [{ target_type: "user", target_user_id: "bukan-uuid", category: "spam" }, "target_user_id"],
      [{ target_type: "user", target_user_id: reporter.userId, category: "spam" }, "target_user_id"],
      [{ target_type: "grup", category: "spam" }, "target_type"],
    ];
    for (const [body, field] of cases) {
      const res = await postReport(t.app, reporter.token, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expectOperation("post", "/reports", res);
      expect(res.json().field_errors, JSON.stringify(body)).toHaveProperty(field);
    }
    await reportOk(t.app, reporter.token, {
      target_type: "user",
      target_user_id: target.userId,
      category: "other",
      description: "Menyebarkan data pribadi anggota lain.",
    });
  });

  it("AC F12-2: laju pelaporan dibatasi 10 per jam per pelapor (429 dengan retry_after_seconds)", async () => {
    const reporter = await member();
    const target = await member();
    const body = { target_type: "user", target_user_id: target.userId, category: "spam" };
    for (let i = 0; i < 10; i++)
      expect((await postReport(t.app, reporter.token, body)).statusCode).toBeLessThan(300);
    const limited = await postReport(t.app, reporter.token, body);
    expect(limited.statusCode).toBe(429);
    expectOperation("post", "/reports", limited);
    expect(limited.json().retry_after_seconds).toBeGreaterThan(0);
  });

  it("AC F12-2: otorisasi: melapor hanya anggota aktif; riwayat laporan sendiri untuk semua status; sesi admin 403; tanpa sesi 401", async () => {
    const target = await member();
    const body = { target_type: "user", target_user_id: target.userId, category: "spam" };
    const expired = await member("expired");
    const expiredRes = await postReport(t.app, expired.token, body);
    expect(expiredRes.statusCode).toBe(403);
    expect(expiredRes.json().code).toBe("MEMBERSHIP_REQUIRED");
    expect((await api().get("/reports", { token: expired.token })).statusCode).toBe(200);
    const suspended = await member("suspended");
    const suspendedRes = await postReport(t.app, suspended.token, body);
    expect(suspendedRes.statusCode).toBe(403);
    expect(suspendedRes.json().code).toBe("ACCOUNT_SUSPENDED");
    expect((await api().get("/reports", { token: suspended.token })).statusCode).toBe(200);
    const unverified = await member("unverified");
    expect((await postReport(t.app, unverified.token, body)).json().code).toBe("MEMBERSHIP_REQUIRED");

    const admin = await createAdmin(t, { role: "super_admin" });
    const adminToken = (await signInAdmin(t, admin)).accessToken;
    expect((await api().get("/reports", { token: adminToken })).statusCode).toBe(403);
    expect((await postReport(t.app, adminToken, body)).statusCode).toBe(403);
    expect(
      (await api().post("/appeals", { description: "x".repeat(20) }, { token: adminToken })).statusCode,
    ).toBe(403);
    expect((await api().get("/reports")).statusCode).toBe(401);
    expect((await api().post("/appeals", { description: "x".repeat(20) })).statusCode).toBe(401);
  });
});

describe("Retensi berkas bukti (PRD 3.12, D2; core FilesService.discard)", () => {
  it("AC F12-2 / D2: gambar pesan dan avatar yang dirujuk bukti ditahan saat dihapus/diganti; dihapus bila akun pemilik dihapus", async () => {
    const reporter = await member();
    const sender = await member();
    const filesService = t.app.get(FilesService);
    const group = await createGroupRoom(t, { adminId: reporter.userId });
    await addRoomMember(t, group, sender.userId);
    const image = await uploadTestFile(t, sender.token, "chat_image");
    const unrelated = await uploadTestFile(t, sender.token, "chat_image");
    const message = await createMessage(t, group, sender.userId, { imageFileId: image.id });
    const avatar = await uploadTestFile(t, sender.token, "avatar");
    await t.db.update(alumni).set({ avatarFileId: avatar.id }).where(eq(alumni.userId, sender.userId));
    // Avatar publik (pengaturan privasi pemilik) dijadikan privat saat ditahan sebagai bukti.
    await t.db.update(files).set({ visibility: "public" }).where(eq(files.id, avatar.id));

    await reportOk(t.app, reporter.token, { target_type: "message", message_id: message, category: "scam" });
    await reportOk(t.app, reporter.token, {
      target_type: "user",
      target_user_id: sender.userId,
      category: "scam",
    });

    const fileRow = async (id: string) => (await t.db.select().from(files).where(eq(files.id, id)))[0]!;
    // Pengirim menghapus pesan / mengganti avatar: modul pemilik memanggil discard → berkas bukti ditahan.
    expect(await t.db.transaction((tx) => filesService.discard(tx, image.id))).toBe(false);
    expect(await t.db.transaction((tx) => filesService.discard(tx, avatar.id))).toBe(false);
    expect(await fileRow(image.id)).toMatchObject({ status: "ready" });
    expect(await fileRow(avatar.id)).toMatchObject({ status: "ready", visibility: "private" });
    // Berkas yang tidak dirujuk bukti tetap dihapus seperti biasa.
    expect(await t.db.transaction((tx) => filesService.discard(tx, unrelated.id))).toBe(true);
    expect((await fileRow(unrelated.id)).status).toBe("deleted");

    // D2: akun pemilik dihapus → unggahannya dihapus walaupun dirujuk bukti.
    await t.db.update(users).set({ status: "deletion_pending" }).where(eq(users.id, sender.userId));
    expect(await t.db.transaction((tx) => filesService.discard(tx, image.id))).toBe(true);
    expect((await fileRow(image.id)).status).toBe("deleted");
  });

  it("AC F14-3 / D2: akun dihapus → nama, foto dan isi chatnya di bukti dianonimkan; laporan tetap ada; idempoten", async () => {
    const reporter = await member("verified", { fullName: "Pelapor Anonimisasi" });
    const sender = await member("verified", { fullName: "Pengirim Dihapus" });
    const admin = await createAdmin(t, { permissions: ["moderation.read"] });
    const adminToken = (await signInAdmin(t, admin)).accessToken;
    const group = await createGroupRoom(t, { name: "Grup D2", adminId: reporter.userId });
    await addRoomMember(t, group, sender.userId);
    const image = await uploadTestFile(t, sender.token, "chat_image");
    const avatar = await uploadTestFile(t, sender.token, "avatar");
    await t.db
      .update(alumni)
      .set({ avatarFileId: avatar.id, bio: "Bio pengirim pribadi" })
      .where(eq(alumni.userId, sender.userId));
    const context = await createMessage(t, group, reporter.userId, { body: "Konteks dari pelapor" });
    const reported = await createMessage(t, group, sender.userId, {
      imageFileId: image.id,
      body: "Isi chat pengirim",
    });
    const messageReport = await reportOk(t.app, reporter.token, {
      target_type: "message",
      message_id: reported,
      context_message_ids: [context],
      category: "harassment",
    });
    const profileReport = await reportOk(t.app, reporter.token, {
      target_type: "user",
      target_user_id: sender.userId,
      category: "harassment",
    });

    // Begitu akun berstatus deleted, tampilan bukti sudah anonim walaupun snapshot belum dibersihkan job.
    await t.db.update(users).set({ status: "deleted" }).where(eq(users.id, sender.userId));
    const view = await api().get(`/admin/reports/${messageReport}`, { token: adminToken });
    const shown = (
      expectOperation("get", "/admin/reports/{reportId}", view) as {
        evidence: { messages: { message_id: string }[] };
      }
    ).evidence.messages;
    expect(shown.find((m) => m.message_id === reported)).toMatchObject({
      sender_user_id: null,
      sender_name: null,
      body: null,
      image: { file_id: null, url: null },
    });
    expect(shown.find((m) => m.message_id === context)).toMatchObject({
      sender_user_id: reporter.userId,
      body: "Konteks dari pelapor",
    });

    // Langkah job penghapusan akun (modul account): snapshot dibersihkan; pemanggilan ulang tidak mengubah apa pun.
    expect(await inTx((tx) => anonymizeEvidenceOf(tx, sender.userId, t.clock.now()))).toBe(2);
    expect(await inTx((tx) => anonymizeEvidenceOf(tx, sender.userId, t.clock.now()))).toBe(0);
    const messageEvidence = (await reportRow(messageReport)).evidence as {
      file_ids: string[];
      messages: Record<string, unknown>[];
    };
    expect(messageEvidence.file_ids).toEqual([]);
    expect(messageEvidence.messages.find((m) => m.message_id === reported)).toMatchObject({
      reported: true,
      sender_user_id: null,
      sender_name: null,
      body: null,
      image_file_id: null,
    });
    expect(messageEvidence.messages.find((m) => m.message_id === context)).toMatchObject({
      sender_user_id: reporter.userId,
      sender_name: "Pelapor Anonimisasi",
      body: "Konteks dari pelapor",
    });
    const profileRow = await reportRow(profileReport);
    expect(profileRow.evidence).toMatchObject({
      file_ids: [],
      profile: { user_id: sender.userId, full_name: null, bio: null, avatar_file_id: null },
    });
    for (const stored of [messageEvidence, profileRow.evidence]) {
      expect(JSON.stringify(stored)).not.toContain("Pengirim Dihapus");
      expect(JSON.stringify(stored)).not.toContain("Isi chat pengirim");
      expect(JSON.stringify(stored)).not.toContain("Bio pengirim pribadi");
    }
    // Laporan tetap tersimpan dan dapat diputus (hanya dismiss karena akun terlapor sudah dihapus).
    expect(profileRow.status).toBe("open");
  });

  it("AC F14-3 / D2: deskripsi laporan dan alasan banding tulisan akun yang dihapus tidak ditampilkan lalu dikosongkan; laporan pihak lain tetap utuh; idempoten", async () => {
    const admin = await createAdmin(t, { permissions: ["moderation.read"] });
    const adminToken = (await signInAdmin(t, admin)).accessToken;
    const author = await member("verified", { fullName: "Budi Santoso" });
    const target = await member("verified", { fullName: "Terlapor D2" });
    const witness = await member("verified", { fullName: "Saksi Aktif" });
    const appellant = await member("suspended", { fullName: "Siti Aminah" });

    const ownReport = await reportOk(t.app, author.token, {
      target_type: "user",
      target_user_id: target.userId,
      category: "scam",
      description: "Saya Budi Santoso, telp 0812-3456-7890, ditipu orang ini.",
    });
    const aboutAuthor = await reportOk(t.app, witness.token, {
      target_type: "user",
      target_user_id: author.userId,
      category: "harassment",
      description: "Orang ini mengancam saya di grup.",
    });
    const appealRes = await api().post(
      "/appeals",
      { description: "Saya Siti Aminah, alamat Jl. Melati 5, mohon pembatasan dicabut." },
      { token: appellant.token },
    );
    expect(appealRes.statusCode, appealRes.body).toBe(201);
    const appeal = appealRes.json().id as string;

    await t.db
      .update(users)
      .set({ status: "deleted" })
      .where(inArray(users.id, [author.userId, appellant.userId]));
    const detailOf = async (id: string) =>
      expectOperation(
        "get",
        "/admin/reports/{reportId}",
        await api().get(`/admin/reports/${id}`, { token: adminToken }),
      ) as Record<string, unknown>;
    // Tampilan pengurus sudah anonim begitu akun berstatus deleted, sebelum job membersihkan kolomnya.
    expect(await detailOf(ownReport)).toMatchObject({
      description: null,
      reporter: null,
      subject: { user_id: target.userId },
    });
    expect(await detailOf(appeal)).toMatchObject({
      category: "appeal",
      description: null,
      reporter: null,
      subject: null,
    });
    // Laporan pihak lain tentang akun yang dihapus: deskripsi penulisnya yang masih ada tetap tampil.
    expect(await detailOf(aboutAuthor)).toMatchObject({
      description: "Orang ini mengancam saya di grup.",
      reporter: { user_id: witness.userId },
      subject: null,
    });

    // Langkah job penghapusan akun: deskripsi tulisan akun itu dikosongkan, snapshot profilnya di laporan lain
    // dibersihkan; pemanggilan ulang tidak mengubah apa pun.
    expect(await inTx((tx) => anonymizeEvidenceOf(tx, author.userId, t.clock.now()))).toBe(2);
    expect(await inTx((tx) => anonymizeEvidenceOf(tx, author.userId, t.clock.now()))).toBe(0);
    expect(await inTx((tx) => anonymizeEvidenceOf(tx, appellant.userId, t.clock.now()))).toBe(1);
    expect(await inTx((tx) => anonymizeEvidenceOf(tx, appellant.userId, t.clock.now()))).toBe(0);
    const own = await reportRow(ownReport);
    expect(own.description).toBeNull();
    // Bukti laporan itu (profil pihak terlapor yang masih ada) tidak berubah.
    expect(own.evidence).toMatchObject({ profile: { user_id: target.userId, full_name: "Terlapor D2" } });
    const about = await reportRow(aboutAuthor);
    expect(about.description).toBe("Orang ini mengancam saya di grup.");
    expect(about.evidence).toMatchObject({ profile: { user_id: author.userId, full_name: null } });
    const appealRow = await reportRow(appeal);
    expect(appealRow).toMatchObject({ category: "appeal", status: "open", description: null });
    for (const row of [own, about, appealRow]) {
      const stored = JSON.stringify(row);
      expect(stored).not.toContain("0812-3456-7890");
      expect(stored).not.toContain("Budi Santoso");
      expect(stored).not.toContain("Siti Aminah");
      expect(stored).not.toContain("Jl. Melati");
    }
  });
});

describe("POST /appeals (PRD 3.12 mekanisme banding)", () => {
  it("AC F12-2: banding atas suspend yang berlaku dari portal pembatasan; satu banding aktif; dipantau pemohon", async () => {
    const appellant = await member("suspended", { fullName: "Pemohon Uji" });
    const res = await api().post(
      "/appeals",
      { description: "Saya keberatan, pesan itu disalahpahami." },
      { token: appellant.token },
    );
    expect(res.statusCode, res.body).toBe(201);
    const appeal = expectOperation("post", "/appeals", res) as Record<string, string>;
    expect(appeal).toMatchObject({
      category: "appeal",
      target_type: "user",
      target_name: "Pemohon Uji",
      priority: "normal",
      status: "open",
      outcome: null,
    });
    expect(appeal.due_at).toBe(addBusinessDaysJakarta(new Date(appeal.created_at!), 2).toISOString());
    const row = await reportRow(appeal.id!);
    expect(row).toMatchObject({
      reporterId: appellant.userId,
      targetUserId: appellant.userId,
      category: "appeal",
    });
    const [profile] = await t.db.select().from(alumni).where(eq(alumni.userId, appellant.userId));
    expect(row.evidence).toMatchObject({
      contested_suspension: {
        suspended_at: profile!.suspendedAt!.toISOString(),
        suspension_message: "Akun dibatasi sementara.",
      },
    });

    const again = await api().post(
      "/appeals",
      { description: "Mohon ditinjau kembali segera." },
      { token: appellant.token },
    );
    expect(again.statusCode).toBe(200);
    expect(expectOperation("post", "/appeals", again)).toMatchObject({ id: appeal.id });
    const mine = (await api().get("/reports", { token: appellant.token })).json() as {
      items: { id: string }[];
    };
    expect(mine.items.map((i) => i.id)).toEqual([appeal.id]);
  });

  it("hanya suspend yang sedang berlaku (selain itu 403); validasi alasan minimal 10 karakter bukan spasi", async () => {
    const active = await member();
    const forbidden = await api().post(
      "/appeals",
      { description: "Saya ingin banding peringatan." },
      { token: active.token },
    );
    expect(forbidden.statusCode).toBe(403);
    expectOperation("post", "/appeals", forbidden);
    expect(forbidden.json().code).toBe("FORBIDDEN");
    const expired = await member("expired");
    expect(
      (await api().post("/appeals", { description: "Saya keberatan sekali." }, { token: expired.token }))
        .statusCode,
    ).toBe(403);

    const suspended = await member("suspended");
    for (const body of [
      {},
      { description: "terlalu" },
      { description: "a b c d e f g h i" },
      { description: "x".repeat(2001) },
    ]) {
      const res = await api().post("/appeals", body, { token: suspended.token });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expectOperation("post", "/appeals", res);
    }
  });

  it("AC F12-5: unsuspend dari menu anggota (MembershipKernel) menutup banding aktif sebagai dikabulkan; satu notifikasi", async () => {
    const appellant = await member("suspended");
    const appealId = (
      await api().post(
        "/appeals",
        { description: "Mohon cabut pembatasan saya." },
        { token: appellant.token },
      )
    ).json().id as string;
    const admin = await createAdmin(t, {
      permissions: ["members.read", "moderation.read", "moderation.resolve"],
    });
    const outcome = await inTx((tx) =>
      kernel.unsuspend(tx, appellant.userId, { reason: "Klarifikasi diterima", actorAdminId: admin.adminId }),
    );
    expect(outcome.closedAppealIds).toEqual([appealId]);

    const fresh = await signInAlumni(t, appellant);
    const view = expectOperation(
      "get",
      "/reports/{reportId}",
      await api().get(`/reports/${appealId}`, { token: fresh.accessToken }),
    );
    expect(view).toMatchObject({
      status: "resolved",
      outcome: "action_taken",
      decision_message: DEFAULT_UNSUSPEND_MESSAGE,
    });
    const row = await reportRow(appealId);
    expect(row).toMatchObject({ action: "unsuspend", resolvedByAdminId: admin.adminId });
    expect(row.resolutionNote).toContain("Klarifikasi diterima");
    const inbox = await t.db.select().from(notifications).where(eq(notifications.userId, appellant.userId));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ category: "account", title: "Banding dikabulkan" });
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, appealId), eq(auditLogs.action, "moderation.report_resolved")));
    expect(audits).toHaveLength(1);
  });

  it("AC F12-3: jaring pengaman: banding usang ditutup oleh sistem (aktor audit system) sebagai dikabulkan lalu banding baru dibuat", async () => {
    const appellant = await member("suspended");
    const first = (
      await api().post("/appeals", { description: "Banding pertama saya." }, { token: appellant.token })
    ).json().id as string;
    // Pencabutan lewat jalur yang (keliru) tidak menutup banding, lalu disuspend lagi.
    await t.db
      .update(alumni)
      .set({ suspendedAt: null, suspensionReason: null, suspensionMessage: null })
      .where(eq(alumni.userId, appellant.userId));
    t.clock.advance(HOUR);
    await inTx((tx) =>
      kernel.suspend(tx, appellant.userId, {
        reason: "Pelanggaran baru",
        memberMessage: "Akun dibatasi kembali.",
        actorAdminId: null,
      }),
    );
    const session = await signInAlumni(t, appellant);
    const res = await api().post(
      "/appeals",
      { description: "Banding atas pembatasan baru." },
      { token: session.accessToken },
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().id).not.toBe(first);
    expect(await reportRow(first)).toMatchObject({
      status: "resolved",
      action: "unsuspend",
      resolvedByAdminId: null,
    });
    const old = (await api().get(`/reports/${first}`, { token: session.accessToken })).json();
    expect(old).toMatchObject({ outcome: "action_taken" });

    // Aktor keputusan penutupan adalah sistem, bukan pemohon yang memicu permintaan (AC F12-3, F17-1).
    const auditOf = async (entityId: string, action: string) =>
      (
        await t.db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.entityId, entityId), eq(auditLogs.action, action)))
      )[0];
    const closedAudit = await auditOf(first, "moderation.report_resolved");
    expect(closedAudit).toMatchObject({ actorUserId: null, actorAdminId: null, effectiveRole: "system" });
    expect(closedAudit!.after).toMatchObject({
      closed_by: "system",
      stale_appeal: true,
      membership_unchanged: true,
    });
    // Banding baru tetap tercatat atas nama pemohon.
    expect(await auditOf(res.json().id as string, "moderation.appeal_created")).toMatchObject({
      actorUserId: appellant.userId,
      effectiveRole: "alumni",
    });
  });
});
