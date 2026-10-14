import { deviceTokens, notifications, paymentAdjustments, payments, sessions } from "@kapdh/database";
import { and, eq, isNull } from "drizzle-orm";
import { decodeJwt } from "jose";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { block, groupWith, type Member, member, openDirect, sendText, setAvatar } from "../chat/support.js";
import { insertPost } from "../content/support.js";
import { createEventRow, insertTicket } from "../events/support.js";
import { notify, registerDeviceOk } from "../notifications/support.js";
import { reportOk } from "../moderation/fixtures.js";
import {
  createAdmin,
  type CreateAdminOptions,
  createMembershipPayment,
  createPaymentMethod,
  signInAdmin,
} from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Audit D1 (Phase D): sampel otorisasi tingkat objek (IDOR, N-09, AC F10-5, F11-4, PRD 2.1 "kepemilikan objek").
 * Penyerang adalah anggota AKTIF yang sah (lolos @MemberAccess) dan mengganti id objek di path/body dengan id milik
 * anggota lain; server wajib menolak (404 tanpa membedakan ada/tidak, atau 403 untuk peran di objek yang memang dapat
 * ia lihat) DAN tidak mengubah data korban. Satu tes per modul berobjek; kasus yang sudah diketahui gagal ditandai
 * `it.fails` dengan id temuan.
 */

let t: TestApp;
let attacker: Member;
let victim: Member;
let third: Member;

const api = () => httpClient(t.app);
const as = (who: { token: string }) => ({ token: who.token });

beforeAll(async () => {
  t = await createTestApp();
  attacker = await member(t, "verified", { fullName: "Penyerang Uji" });
  victim = await member(t, "verified", { fullName: "Korban Uji" });
  third = await member(t, "verified", { fullName: "Pihak Ketiga Uji" });
});
afterAll(async () => {
  await t.app.close();
});

async function adminWith(
  options: Omit<CreateAdminOptions, "status">,
): Promise<{ token: string; adminId: string; userId: string }> {
  const admin = await createAdmin(t, options);
  const session = await signInAdmin(t, admin);
  return { token: session.accessToken, adminId: admin.adminId, userId: admin.userId };
}

describe("D1 IDOR payments (F-03, F-04, D6)", () => {
  it("anggota lain tidak dapat membaca, mengganti metode, mengirim bukti, membatalkan, atau mengisi rekening refund", async () => {
    const method = await createPaymentMethod(t);
    const pay = await createMembershipPayment(t, {
      userId: victim.userId,
      type: "renewal",
      status: "pending",
    });
    const proof = await uploadTestFile(t, attacker.token, "payment_proof");
    const base = `/me/payments/${pay.id}`;
    expect((await api().get(base, as(attacker))).statusCode).toBe(404);
    expect(
      (
        await api().put(
          `${base}/method`,
          { payment_method_id: method.id },
          {
            ...as(attacker),
            headers: { "if-match": String(pay.version) },
          },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api().put(
          `${base}/proof`,
          { file_id: proof.id, expected_proof_version: pay.proofVersion },
          as(attacker),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api().post(
          `${base}/cancel`,
          {},
          { ...as(attacker), headers: { "if-match": String(pay.version) } },
        )
      ).statusCode,
    ).toBe(404);

    // Pasangan path campuran: payment milik penyerang + penyesuaian refund milik korban, dan sebaliknya.
    const own = await createMembershipPayment(t, {
      userId: attacker.userId,
      type: "renewal",
      status: "paid",
    });
    const victimPaid = await createMembershipPayment(t, {
      userId: victim.userId,
      type: "renewal",
      status: "paid",
    });
    const adjustmentId = uuidv7();
    await t.db.insert(paymentAdjustments).values({
      id: adjustmentId,
      paymentId: victimPaid.id,
      kind: "refund",
      amount: "10000.00",
      reason: "Refund uji IDOR",
      status: "pending",
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });
    const destination = {
      provider: "Bank Penyerang",
      account_number: "1234567890",
      account_holder: "Penyerang",
    };
    for (const paymentId of [own.id, victimPaid.id]) {
      const res = await api().put(
        `/me/payments/${paymentId}/adjustments/${adjustmentId}/refund-destination`,
        destination,
        { ...as(attacker), headers: { "if-match": "1" } },
      );
      expect(res.statusCode, `${paymentId}: ${res.body}`).toBe(404);
    }
    const [adjustment] = await t.db
      .select()
      .from(paymentAdjustments)
      .where(eq(paymentAdjustments.id, adjustmentId));
    expect(adjustment!.refundDestination).toBeNull();
    const [after] = await t.db.select().from(payments).where(eq(payments.id, pay.id));
    expect(after).toMatchObject({ status: "pending", version: pay.version, proofVersion: pay.proofVersion });
  });
});

describe("D1 IDOR files (PRD 5.4, N-09)", () => {
  it("bukti bayar dan avatar privat anggota lain tidak dapat dibuka; admin tanpa izin terkait juga tidak", async () => {
    const proof = await uploadTestFile(t, victim.token, "payment_proof");
    expect((await api().get(`/files/${proof.id}/access`, as(attacker))).statusCode).toBe(404);
    const membersOnly = await adminWith({ permissions: ["members.read"] });
    expect((await api().get(`/files/${proof.id}/access`, as(membersOnly))).statusCode).toBe(404);
    const treasurer = await adminWith({ permissions: ["payments.read"] });
    expect((await api().get(`/files/${proof.id}/access`, as(treasurer))).statusCode).toBe(200);

    // Gambar chat hanya untuk anggota room (AC F11-4), bahkan Super Admin tanpa laporan tidak dapat membukanya.
    const room = await openDirect(t, victim, third);
    const image = await uploadTestFile(t, victim.token, "chat_image");
    const sent = await api().post(
      `/chat/rooms/${room.id}/messages`,
      { client_message_id: uuidv7(), kind: "image", image_file_id: image.id },
      as(victim),
    );
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await api().get(`/files/${image.id}/access`, as(third))).statusCode).toBe(200);
    expect((await api().get(`/files/${image.id}/access`, as(attacker))).statusCode).toBe(404);
    const superAdmin = await adminWith({ role: "super_admin" });
    expect((await api().get(`/files/${image.id}/access`, as(superAdmin))).statusCode).toBe(404);
  });
});

describe("D1 IDOR tiket dan event (F-09, PRD 2.2)", () => {
  it("tiket anggota lain dan event draft tidak dapat dibaca atau diubah", async () => {
    const event = await createEventRow(t);
    const ticket = await insertTicket(t, { eventId: event.id, userId: victim.userId, status: "paid" });
    expect((await api().get(`/me/tickets/${ticket.id}`, as(attacker))).statusCode).toBe(404);
    const cancel = await api().post(
      `/me/tickets/${ticket.id}/cancel`,
      { expected_refund_eligible: false },
      { ...as(attacker), headers: { "if-match": String(ticket.version) } },
    );
    expect(cancel.statusCode, cancel.body).toBe(404);
    expect((await api().get(`/me/tickets/${ticket.id}`, as(victim))).json()).toMatchObject({
      status: "paid",
    });

    const draft = await createEventRow(t, { status: "draft" });
    expect((await api().get(`/events/${draft.id}`, as(attacker))).statusCode).toBe(404);
    expect((await api().get(`/events/${draft.id}/participants`, as(attacker))).statusCode).toBe(404);
    const reserve = await api().post(
      `/events/${draft.id}/reservations`,
      { expected_price: draft.price },
      as(attacker),
    );
    expect(reserve.statusCode, reserve.body).toBe(404);
  });
});

describe("D1 IDOR chat (F-11, AC F11-4)", () => {
  it("bukan anggota room direct: semua operasi room/pesan 404, tidak ada perubahan", async () => {
    const room = await openDirect(t, victim, third);
    const message = await sendText(t, victim, room.id, "Rahasia berdua");
    const base = `/chat/rooms/${room.id}`;
    const probes = [
      await api().get(base, as(attacker)),
      await api().get(`${base}/messages`, as(attacker)),
      await api().get(`${base}/members`, as(attacker)),
      await api().post(
        `${base}/messages`,
        { client_message_id: uuidv7(), kind: "text", body: "Halo" },
        as(attacker),
      ),
      await api().put(`${base}/read`, { message_id: message.id }, as(attacker)),
      await api().put(`${base}/mute`, { muted: true }, as(attacker)),
      await api().post(`${base}/leave`, {}, as(attacker)),
      await api().delete(`${base}/messages/${message.id}`, as(attacker)),
      await api().put(
        `${base}/messages/${message.id}/reactions/${encodeURIComponent("👍")}`,
        {},
        as(attacker),
      ),
      await api().post(`/chat/invitations/${room.id}/accept`, {}, as(attacker)),
    ];
    expect(probes.map((res) => `${res.statusCode}`)).toEqual(probes.map(() => "404"));
    expect(JSON.stringify(probes.map((res) => res.body))).not.toContain("Rahasia berdua");
  });

  it("bukan anggota grup: ubah grup, undang, keluarkan, ubah peran 404; anggota biasa: 403", async () => {
    const roomId = await groupWith(t, victim, [third], "Grup Korban");
    const base = `/chat/rooms/${roomId}`;
    const outsider = [
      await api().patch(base, { name: "Diambil alih" }, { ...as(attacker), headers: { "if-match": "1" } }),
      await api().post(`${base}/invitations`, { user_ids: [attacker.userId] }, as(attacker)),
      await api().delete(`${base}/members/${third.userId}`, as(attacker)),
      await api().patch(`${base}/members/${attacker.userId}`, { role: "admin" }, as(attacker)),
    ];
    expect(outsider.map((res) => res.statusCode)).toEqual([404, 404, 404, 404]);

    const joined = await groupWith(t, victim, [attacker, third], "Grup Bersama");
    const sent = await sendText(t, third, joined, "Pesan pihak ketiga");
    const shared = `/chat/rooms/${joined}`;
    const plain = [
      await api().patch(shared, { name: "Diambil alih" }, { ...as(attacker), headers: { "if-match": "1" } }),
      await api().delete(`${shared}/members/${third.userId}`, as(attacker)),
      await api().patch(`${shared}/members/${attacker.userId}`, { role: "admin" }, as(attacker)),
      await api().post(`${shared}/invitations`, { user_ids: [uuidv7()] }, as(attacker)),
      await api().delete(`${shared}/messages/${sent.id}`, as(attacker)),
    ];
    expect(plain.map((res) => res.statusCode)).toEqual([403, 403, 403, 403, 403]);
  });

  it("calon anggota (diundang) dan mantan anggota tidak dapat membaca riwayat, anggota, atau mengirim", async () => {
    const invitee = await member(t, "verified");
    const leaver = await member(t, "verified");
    const roomId = await groupWith(t, victim, [leaver], "Grup Undangan");
    await sendText(t, victim, roomId, "Sebelum undangan");
    const invited = await api().post(
      `/chat/rooms/${roomId}/invitations`,
      { user_ids: [invitee.userId] },
      as(victim),
    );
    expect(invited.statusCode, invited.body).toBe(200);
    const left = await api().post(`/chat/rooms/${roomId}/leave`, {}, as(leaver));
    expect(left.statusCode, left.body).toBe(204);
    for (const who of [invitee, leaver]) {
      const base = `/chat/rooms/${roomId}`;
      const statuses = [
        (await api().get(`${base}/messages`, as(who))).statusCode,
        (await api().get(`${base}/members`, as(who))).statusCode,
        (
          await api().post(
            `${base}/messages`,
            { client_message_id: uuidv7(), kind: "text", body: "x" },
            as(who),
          )
        ).statusCode,
      ];
      expect(statuses, who === invitee ? "diundang" : "keluar").toEqual([404, 404, 404]);
    }
  });
});

describe("D1 anggota tersembunyi dari direktori (PRD 3.10, N-09, N-15; kontrak openDirectRoom)", () => {
  // openDirectRoom hanya membuat room bila lawan bicara terlihat di direktori bagi pemanggil atau pernah satu grup,
  // dengan 404 seragam untuk semua alasan. Diperbaiki: inviteChatMembers/createChatGroup memakai syarat yang sama, sehingga
  // user_id anggota tersembunyi (mis. dari klaim `sub` QR KTA yang pernah dipindai) tidak dapat dipakai mengirim undangan
  // berisi nama grup bebas ke kotak masuknya, dan hasilnya (not_invitable) sama dengan akun yang tidak aktif/tidak ada.
  it("[D1-03] undangan grup tidak dapat dipakai menghubungi atau memeriksa status anggota tersembunyi", async () => {
    const hidden = await member(t, "verified", { showInDirectory: false });
    const hiddenSuspended = await member(t, "suspended", { showInDirectory: false });
    const direct = await api().post("/chat/direct", { user_id: hidden.userId }, as(attacker));
    expect(direct.statusCode, direct.body).toBe(404);
    const created = await api().post(
      "/chat/rooms",
      { name: "Hubungi saya di 0812", invitee_user_ids: [hidden.userId, hiddenSuspended.userId] },
      as(attacker),
    );
    expect(created.statusCode, created.body).toBe(201);
    const outcome = (
      created.json() as {
        invitations: { invited_user_ids: string[]; skipped: { user_id: string; reason: string }[] };
      }
    ).invitations;
    expect(outcome.invited_user_ids).not.toContain(hidden.userId);
    // Status keanggotaan tidak dapat dibedakan: aktif dan suspended sama-sama not_invitable.
    expect(outcome.skipped).toEqual([
      { user_id: hidden.userId, reason: "not_invitable" },
      { user_id: hiddenSuspended.userId, reason: "not_invitable" },
    ]);
    const inbox = await t.db.select().from(notifications).where(eq(notifications.userId, hidden.userId));
    expect(inbox.map((n) => n.body ?? "").join(" ")).not.toContain("0812");
  });
});

describe("D1 berkas bukti moderasi dan konflik kepentingan (kontrak admin-moderation butir a/c)", () => {
  // Laporan terhadap akun alumni tertaut pengurus tidak pernah terlihat olehnya dan tidak boleh dapat disimpulkan
  // (ModerationVisibility). Diperbaiki: kebijakan berkas bukti (moderation/evidence-file-policy.ts) hanya mengizinkan
  // bila ada laporan perujuk yang TERLIHAT bagi pengurus, sehingga GET /files/{avatar}/access tidak lagi berubah
  // 404 → 200 begitu ada laporan tersembunyi terhadap akun tertautnya.
  it("[D1-02] keberadaan laporan tersembunyi tidak dapat disimpulkan lewat akses berkas bukti", async () => {
    const linked = await member(t, "verified", { fullName: "Alumni Pengurus" });
    const avatarId = await setAvatar(t, linked);
    const moderator = await adminWith({
      permissions: ["moderation.read"],
      linkedAlumniUserId: linked.userId,
    });
    const colleague = await adminWith({ permissions: ["moderation.read"] });
    const before = await api().get(`/files/${avatarId}/access`, as(moderator));
    expect(before.statusCode).toBe(404);
    const reportId = await reportOk(t.app, third.token, {
      target_type: "user",
      target_user_id: linked.userId,
      category: "spam",
    });
    // Laporan memang tersembunyi bagi pengurus itu (404) ...
    expect((await api().get(`/admin/reports/${reportId}`, as(moderator))).statusCode).toBe(404);
    // ... dan akses berkas bukti tetap 404: tidak ada oracle keberadaan laporan.
    const after = await api().get(`/files/${avatarId}/access`, as(moderator));
    expect(after.statusCode, after.body).toBe(404);
    // Pengurus lain tanpa konflik tetap dapat membuka bukti laporan yang terlihat baginya.
    expect((await api().get(`/files/${avatarId}/access`, as(colleague))).statusCode).toBe(200);
  });
});

describe("D1 IDOR moderasi, notifikasi, sesi, perangkat, direktori, konten", () => {
  it("laporan orang lain tidak dapat dibaca pelapor lain maupun terlapor", async () => {
    const reportId = await reportOk(t.app, victim.token, {
      target_type: "user",
      target_user_id: third.userId,
      category: "spam",
    });
    expect((await api().get(`/reports/${reportId}`, as(attacker))).statusCode).toBe(404);
    expect((await api().get(`/reports/${reportId}`, as(third))).statusCode).toBe(404);
  });

  it("notifikasi anggota lain tidak dapat dibaca atau ditandai dibaca", async () => {
    const created = await notify(t, victim.userId);
    const id =
      (created as { id: string } | undefined)?.id ??
      (await t.db.select().from(notifications).where(eq(notifications.userId, victim.userId)))[0]!.id;
    expect((await api().get(`/notifications/${id}`, as(attacker))).statusCode).toBe(404);
    const mark = await api().post("/notifications/read", { ids: [id] }, as(attacker));
    expect(mark.statusCode, mark.body).toBe(200);
    const [row] = await t.db.select().from(notifications).where(eq(notifications.id, id));
    expect(row!.readAt).toBeNull();
  });

  it("sesi dan token perangkat anggota lain tidak dapat dicabut", async () => {
    const claims = decodeJwt(victim.token);
    const [session] = await t.db
      .select({ familyId: sessions.familyId })
      .from(sessions)
      .where(eq(sessions.id, String(claims.sid)));
    expect((await api().delete(`/auth/sessions/${session!.familyId}`, as(attacker))).statusCode).toBe(404);
    expect((await api().get("/me", as(victim))).statusCode).toBe(200);

    const fcm = `fcm-${uuidv7()}`;
    await registerDeviceOk(t, victim.token, fcm);
    expect((await api().post("/devices/unregister", { token: fcm }, as(attacker))).statusCode).toBe(204);
    const live = await t.db
      .select()
      .from(deviceTokens)
      .where(and(eq(deviceTokens.userId, victim.userId), isNull(deviceTokens.revokedAt)));
    expect(live).toHaveLength(1);
  });

  it("profil tersembunyi atau pemblokir tidak dapat dibuka lewat id (AC F10-3, F12-1)", async () => {
    const hidden = await member(t, "verified", { showInDirectory: false });
    expect((await api().get(`/directory/${hidden.userId}`, as(attacker))).statusCode).toBe(404);
    const blocker = await member(t, "verified");
    await block(t, blocker, attacker);
    expect((await api().get(`/directory/${blocker.userId}`, as(attacker))).statusCode).toBe(404);
  });

  it("berita draf tidak dapat dibaca atau disukai lewat slug", async () => {
    const draft = await insertPost(t, { status: "draft" });
    expect((await api().get(`/posts/${draft.slug}`, as(attacker))).statusCode).toBe(404);
    expect((await api().put(`/posts/${draft.slug}/like`, {}, as(attacker))).statusCode).toBe(404);
  });
});

describe("D1 objek admin: konflik kepentingan dan kepemilikan (PRD 2.3, AC F17-2)", () => {
  it("bendahara yang tertaut ke anggota tidak dapat memutus atau mencatat pembayaran anggota itu", async () => {
    const owner = await member(t, "expiring");
    const linked = await adminWith({
      permissions: ["payments.read", "payments.decide"],
      linkedAlumniUserId: owner.userId,
    });
    const pay = await createMembershipPayment(t, {
      userId: owner.userId,
      type: "renewal",
      status: "pending",
    });
    const decision = await api().post(
      `/admin/payments/${pay.id}/decision`,
      {
        decision: "approve",
        expected_proof_version: pay.proofVersion,
        expected_version: String(pay.version),
        funds_verified: true,
      },
      as(linked),
    );
    expect(decision.statusCode, decision.body).toBe(403);
    const cancel = await api().post(
      `/admin/payments/${pay.id}/cancel`,
      { reason: "Uji konflik" },
      { ...as(linked), headers: { "if-match": String(pay.version) } },
    );
    expect(cancel.statusCode, cancel.body).toBe(403);
  });

  it("ekspor audit admin lain tidak terlihat oleh admin non-Super Admin dengan izin sama", async () => {
    const owner = await adminWith({ permissions: ["audit.read", "audit.export"] });
    const other = await adminWith({ permissions: ["audit.read", "audit.export"] });
    const created = await api().post("/admin/audit/exports", {}, as(owner));
    expect(created.statusCode, created.body).toBe(202);
    const exportId = (created.json() as { id: string }).id;
    expect((await api().get(`/admin/audit/exports/${exportId}`, as(owner))).statusCode).toBe(200);
    expect((await api().get(`/admin/audit/exports/${exportId}`, as(other))).statusCode).toBe(404);
    expect((await api().get(`/admin/audit/exports/${exportId}/access`, as(other))).statusCode).toBe(404);
  });
});
