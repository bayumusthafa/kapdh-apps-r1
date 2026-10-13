/**
 * Pemeriksaan hasil job penghapusan akun per tabel (AC F14-3, F14-4, F14-5) beserta bukti bahwa data pengguna lain dan
 * transaksi tidak ikut berubah atau dihitung ulang (AC F14-2). Dipakai jalur PGlite dan PostgreSQL 17 (test/pg).
 */
import {
  accountDeletions,
  admins,
  alumni,
  alumniProfessions,
  auditLogs,
  blocks,
  deviceTokens,
  events,
  files,
  idempotencyKeys,
  membershipEvents,
  messageReactions,
  messages,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  otpCodes,
  paymentAdjustments,
  paymentEvents,
  payments,
  postLikes,
  posts,
  reports,
  roomMembers,
  rooms,
  sessions,
  tickets,
} from "@kapdh/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { expect } from "vitest";
import { FORFEIT_REASON, SYSTEM_MESSAGES } from "../../src/modules/account/deletion-policy.js";
import {
  DELETION_STEPS,
  deletedEmailFor,
  remainingPersonalData,
} from "../../src/modules/account/deletion-steps.js";
import type { TestApp } from "../support/test-app.js";
import { personalDataHits, personalTerms, type RichMember, userRow } from "./support.js";

async function count<T>(query: Promise<T[]>): Promise<number> {
  return (await query).length;
}

export async function expectFullyDeleted(
  app: Pick<TestApp, "db" | "storage">,
  rich: RichMember,
  requestNumber: string,
) {
  const db = app.db;
  const userId = rich.member.userId;

  // Kredensial dan profil (AC F14-3).
  const user = await userRow(db, userId);
  expect(user).toMatchObject({
    status: "deleted",
    email: deletedEmailFor(userId),
    passwordHash: "!deleted",
    emailVerifiedAt: null,
    policyVersion: null,
    policyAcceptedAt: null,
    lastLoginAt: null,
  });
  expect(await count(db.select().from(alumni).where(eq(alumni.userId, userId)))).toBe(0);
  expect(
    await count(db.select().from(alumniProfessions).where(eq(alumniProfessions.alumniUserId, userId))),
  ).toBe(0);
  expect(await remainingPersonalData(db, userId)).toEqual(
    Object.fromEntries(Object.keys(await remainingPersonalData(db, userId)).map((key) => [key, 0])),
  );
  expect(await count(db.select().from(sessions).where(eq(sessions.userId, userId)))).toBe(0);
  expect(await count(db.select().from(otpCodes).where(eq(otpCodes.userId, userId)))).toBe(0);
  expect(await count(db.select().from(idempotencyKeys).where(eq(idempotencyKeys.scope, userId)))).toBe(0);
  expect(await count(db.select().from(deviceTokens).where(eq(deviceTokens.userId, userId)))).toBe(0);
  expect(await count(db.select().from(notifications).where(eq(notifications.userId, userId)))).toBe(0);
  expect(
    await count(db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId))),
  ).toBe(0);
  expect(await count(db.select().from(notificationDeliveries))).toBe(
    await count(
      db
        .select()
        .from(notificationDeliveries)
        .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId)),
    ),
  );

  // Berkas: avatar, unggahan chat, avatar grup, bukti transfer (termasuk versi lama dan bukti yang diunggah pengurus)
  // dan bukti penyesuaian dihapus dari storage dan barisnya `deleted` tanpa pemilik (AC F14-3, F14-4).
  const deletedFiles = [
    rich.files.avatar,
    rich.files.chatImage,
    rich.files.groupAvatar,
    rich.files.proofPaid,
    rich.files.proofOld,
    rich.files.proofReview,
    rich.files.adminProof,
    rich.files.proofTicket,
    rich.files.evidence,
  ];
  for (const file of deletedFiles) {
    expect(await app.storage.exists(file.objectKey), file.objectKey).toBe(false);
    const [row] = await db.select().from(files).where(eq(files.id, file.id));
    expect(row).toMatchObject({ status: "deleted", ownerUserId: null });
    expect(row!.deletedAt).not.toBeNull();
  }
  expect(await app.storage.exists(rich.files.peerAvatar.objectKey)).toBe(true);
  const [peerAvatar] = await db.select().from(files).where(eq(files.id, rich.files.peerAvatar.id));
  expect(peerAvatar).toMatchObject({ status: "ready", ownerUserId: rich.peer.userId });

  // Pembayaran anonim: jumlah, tanggal, status dan referensi tetap; pemilik, catatan transfer dan bukti hilang
  // (AC F14-4). Payment pending tanpa bukti dibatalkan sistem sekali; payment berbukti tetap pending (PRD 4.4).
  const paymentRows = await db
    .select()
    .from(payments)
    .where(inArray(payments.id, Object.values(rich.payments)));
  const byPayment = Object.fromEntries(paymentRows.map((p) => [p.id, p]));
  for (const payment of paymentRows) {
    expect(payment).toMatchObject({ userId: null, transferNote: null, proofFileId: null });
    expect(payment.createdAt).toBeInstanceOf(Date);
  }
  expect(byPayment[rich.payments.registration]).toMatchObject({
    status: "paid",
    amount: "60000.00",
    proofVersion: 1,
  });
  expect(byPayment[rich.payments.registration]!.decidedAt).not.toBeNull();
  expect(byPayment[rich.payments.renewalNoProof]).toMatchObject({
    status: "cancelled",
    cancelReason: FORFEIT_REASON,
  });
  expect(byPayment[rich.payments.ticketNoProof]).toMatchObject({
    status: "cancelled",
    cancelReason: FORFEIT_REASON,
  });
  expect(byPayment[rich.payments.ticketWithProof]).toMatchObject({ status: "pending", proofVersion: 1 });
  expect(byPayment[rich.payments.ticketPaid]).toMatchObject({ status: "paid" });
  expect(byPayment[rich.payments.ticketPast]).toMatchObject({ status: "paid" });
  // Alasan pembatalan yang ditulis pemilik dihapus; status dan waktu pembatalan tetap (AC F14-4, D2).
  for (const id of [rich.payments.ownerCancelled, rich.payments.ticketSelfCancelled]) {
    expect(byPayment[id]).toMatchObject({ status: "cancelled", cancelReason: null });
    expect(byPayment[id]!.cancelledAt).not.toBeNull();
  }
  const paymentEventRows = await db
    .select()
    .from(paymentEvents)
    .where(inArray(paymentEvents.paymentId, Object.values(rich.payments)));
  expect(paymentEventRows.filter((e) => e.actorUserId === userId)).toEqual([]);
  expect(paymentEventRows.filter((e) => e.reason === "Transfer dari rekening a.n. pemilik")).toEqual([]);
  // Satu event pembatalan per payment yang dibatalkan, tidak pernah dihitung ulang (AC F14-2).
  const cancelledEvents = paymentEventRows.filter((e) => e.kind === "cancelled").map((e) => e.paymentId);
  expect(cancelledEvents.sort()).toEqual(
    [
      rich.payments.renewalNoProof,
      rich.payments.ticketNoProof,
      rich.payments.ownerCancelled,
      rich.payments.ticketSelfCancelled,
    ].sort(),
  );

  // Penyesuaian: refund pending tidak diselesaikan/dibatalkan job; rekening tujuan dihapus (D2, PRD 4.4).
  const [refund] = await db
    .select()
    .from(paymentAdjustments)
    .where(eq(paymentAdjustments.id, rich.adjustments.refund));
  expect(refund).toMatchObject({ status: "pending", amount: "50000.00", refundDestination: null });
  const [correction] = await db
    .select()
    .from(paymentAdjustments)
    .where(eq(paymentAdjustments.id, rich.adjustments.correction));
  expect(correction).toMatchObject({ status: "completed", amount: "10000.00", evidenceFileId: null });

  // Tiket: tiket aktif event mendatang hangus sekali (kursi dilepas sekali), tiket event selesai tetap; semua anonim.
  const ticketRows = await db
    .select()
    .from(tickets)
    .where(inArray(tickets.id, Object.values(rich.tickets)));
  const byTicket = Object.fromEntries(ticketRows.map((x) => [x.id, x]));
  for (const ticket of ticketRows) expect(ticket.userId).toBeNull();
  for (const id of [rich.tickets.paid, rich.tickets.noProof, rich.tickets.withProof])
    expect(byTicket[id]).toMatchObject({
      status: "cancelled",
      cancelledBy: "system",
      cancelReason: FORFEIT_REASON,
    });
  expect(byTicket[rich.tickets.past]).toMatchObject({ status: "paid", totalSnapshot: "50000.00" });
  // Tiket yang dibatalkan peserta: pelaku dan waktu tetap, alasan tertulis peserta dihapus (D2).
  expect(byTicket[rich.tickets.selfCancelled]).toMatchObject({
    status: "cancelled",
    cancelledBy: "self",
    cancelReason: null,
  });
  const eventRows = await db
    .select()
    .from(events)
    .where(inArray(events.id, Object.values(rich.events)));
  const byEvent = Object.fromEntries(eventRows.map((e) => [e.id, e]));
  expect(byEvent[rich.events.paid]).toMatchObject({ heldQuantity: 0, paidQuantity: 0 });
  expect(byEvent[rich.events.noProof]).toMatchObject({ heldQuantity: 0, paidQuantity: 0 });
  expect(byEvent[rich.events.withProof]).toMatchObject({ heldQuantity: 0, paidQuantity: 0 });
  expect(byEvent[rich.events.past]).toMatchObject({ heldQuantity: 0, paidQuantity: 1 });
  const ticketAudits = await db
    .select()
    .from(auditLogs)
    .where(
      and(eq(auditLogs.action, "ticket.cancelled"), inArray(auditLogs.entityId, Object.values(rich.tickets))),
    );
  expect(ticketAudits.map((a) => a.entityId).sort()).toEqual(
    [rich.tickets.paid, rich.tickets.noProof, rich.tickets.withProof].sort(),
  );

  // Histori keanggotaan anonim tanpa nomor anggota dan alasan tertulis; koreksi nomor dihapus.
  const periods = await db
    .select()
    .from(membershipEvents)
    .where(eq(membershipEvents.paymentId, rich.payments.registration));
  expect(periods).toEqual([expect.objectContaining({ userId: null, kind: "activation", reason: null })]);
  expect(
    await count(
      db.select().from(membershipEvents).where(eq(membershipEvents.reason, "Peringatan untuk Budi")),
    ),
  ).toBe(0);

  // Komunitas: like dihapus (penghitung dijaga trigger), blokir dua arah dihapus; like rekan tetap.
  expect(await count(db.select().from(postLikes).where(eq(postLikes.userId, userId)))).toBe(0);
  expect(await count(db.select().from(postLikes).where(eq(postLikes.userId, rich.peer.userId)))).toBe(1);
  const [post] = await db.select().from(posts).where(eq(posts.id, rich.postId));
  expect(post!.likeCount).toBe(1);
  expect(
    await count(
      db
        .select()
        .from(blocks)
        .where(sql`${blocks.blockerId} = ${userId} or ${blocks.blockedId} = ${userId}`),
    ),
  ).toBe(0);

  // Chat (AC F14-3, F14-5): pesan pengguna menjadi placeholder tanpa isi dan tanpa pengirim; pesan rekan utuh.
  const memberMessages = await db
    .select()
    .from(messages)
    .where(inArray(messages.id, [rich.messages.memberText, rich.messages.memberImage]));
  for (const message of memberMessages) {
    expect(message).toMatchObject({ senderId: null, body: null, imageFileId: null });
    expect(message.deletedAt).not.toBeNull();
  }
  const peerMessages = await db
    .select()
    .from(messages)
    .where(inArray(messages.id, [rich.messages.peerText, rich.messages.peerDirect]));
  expect(peerMessages.map((m) => m.body).sort()).toEqual(["Balasan Ahmad", "Pesan direct Ahmad"]);
  expect(peerMessages.every((m) => m.senderId === rich.peer.userId && m.deletedAt === null)).toBe(true);
  expect(await count(db.select().from(messageReactions).where(eq(messageReactions.userId, userId)))).toBe(0);
  expect(
    await count(
      db.select().from(messageReactions).where(eq(messageReactions.messageId, rich.messages.memberText)),
    ),
  ).toBe(1);

  const members = async (roomId: string) =>
    db
      .select({ userId: roomMembers.userId, role: roomMembers.role, status: roomMembers.status })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId))
      .orderBy(asc(roomMembers.userId));
  const systemMessages = async (roomId: string) =>
    (
      await db
        .select({ body: messages.body })
        .from(messages)
        .where(and(eq(messages.roomId, roomId), eq(messages.kind, "system")))
    ).map((m) => m.body);
  // Admin terakhir: dialihkan ke anggota aktif yang memenuhi kebijakan (rekan expired yang bergabung lebih dulu
  // dilewati), tanpa menunggu respons anggota lain (AC F14-5).
  expect(await members(rich.rooms.transfer)).toEqual(
    expect.arrayContaining([
      { userId: rich.peer.userId, role: "admin", status: "joined" },
      { userId: rich.expiredPeer.userId, role: "member", status: "joined" },
    ]),
  );
  expect(await systemMessages(rich.rooms.transfer)).toEqual([SYSTEM_MESSAGES.adminTransferred]);
  // Tidak ada anggota yang memenuhi kebijakan: grup ditutup dan undangan tertunda dibatalkan.
  const [closedRoom] = await db.select().from(rooms).where(eq(rooms.id, rich.rooms.close));
  expect(closedRoom!.closedAt).not.toBeNull();
  expect(closedRoom!.createdBy).toBeNull();
  expect(await members(rich.rooms.close)).toEqual(
    expect.arrayContaining([
      { userId: rich.expiredPeer.userId, role: "member", status: "joined" },
      { userId: rich.invitee.userId, role: "member", status: "removed" },
    ]),
  );
  expect(await systemMessages(rich.rooms.close)).toEqual([SYSTEM_MESSAGES.groupClosed]);
  // Grup dengan admin lain: hanya keluar; room direct: keanggotaan pengguna hilang, rekan tetap.
  expect(await members(rich.rooms.coAdmin)).toEqual([
    { userId: rich.peer.userId, role: "admin", status: "joined" },
  ]);
  expect(await systemMessages(rich.rooms.coAdmin)).toEqual([SYSTEM_MESSAGES.memberDeleted]);
  expect(await members(rich.rooms.direct)).toEqual([
    { userId: rich.peer.userId, role: "member", status: "joined" },
  ]);
  const [transferRoom] = await db.select().from(rooms).where(eq(rooms.id, rich.rooms.transfer));
  expect(transferRoom).toMatchObject({ avatarFileId: null, createdBy: null, closedAt: null });

  // Laporan moderasi anonim; bukti dibersihkan dari nama/isi/foto pengguna, data rekan di bukti tetap.
  const reportRows = await db
    .select()
    .from(reports)
    .where(inArray(reports.id, Object.values(rich.reports)));
  const byReport = Object.fromEntries(reportRows.map((r) => [r.id, r]));
  expect(byReport[rich.reports.byMember]).toMatchObject({
    reporterId: null,
    description: null,
    targetUserId: rich.peer.userId,
  });
  expect(byReport[rich.reports.byMember]!.evidence).toMatchObject({ profile: { full_name: "Ahmad Rekan" } });
  expect(byReport[rich.reports.aboutMemberMessage]).toMatchObject({
    targetUserId: null,
    memberMessage: null,
    reporterId: rich.peer.userId,
    description: "Spam dari anggota ini",
  });
  expect(byReport[rich.reports.aboutMemberMessage]!.evidence).toMatchObject({
    messages: [
      { sender_user_id: null, sender_name: null, body: null, image: { file_id: null }, kind: "image" },
    ],
  });
  expect(byReport[rich.reports.contextOnly]!.evidence).toMatchObject({
    messages: [
      { sender_user_id: rich.peer.userId, sender_name: "Ahmad Rekan", body: "Balasan Ahmad" },
      { sender_user_id: null, sender_name: null, body: null },
    ],
    room: { avatar: { file_id: null }, name: "Angkatan 29" },
  });

  // Audit: aktor akun dianonimkan, snapshot hanya nilai non-identitas (F-17, D2).
  const [memberAudit] = await db.select().from(auditLogs).where(eq(auditLogs.id, rich.auditIds.memberActor));
  expect(memberAudit).toMatchObject({
    actorUserId: null,
    reason: null,
    before: {},
    after: { show_phone: true, version: 3 },
  });
  const [adminAudit] = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.id, rich.auditIds.adminOnPayment));
  expect(adminAudit).toMatchObject({
    actorAdminId: expect.any(String),
    reason: "Dana sesuai mutasi",
    after: { status: "paid", amount: "60000.00" },
  });
  // Koreksi identitas atas akun: angkatan, kelas, jenis kelamin dan nomor anggota tidak tersisa (AC F14-4).
  const [identityAudit] = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.id, rich.auditIds.identityCorrection));
  expect(identityAudit).toMatchObject({
    action: "member.number_corrected",
    actorAdminId: expect.any(String),
    reason: null,
    before: {},
    after: {},
  });
  expect(await count(db.select().from(auditLogs).where(eq(auditLogs.actorUserId, userId)))).toBe(0);

  // Identitas pengurus tertaut tidak ikut terhapus; tautannya diputus (PRD 3.14).
  const [admin] = await db.select().from(admins).where(eq(admins.id, rich.superAdmin.adminId));
  expect(admin).toMatchObject({ status: "active", role: "super_admin", linkedAlumniUserId: null });
  expect((await userRow(db, rich.superAdmin.userId))!.status).toBe("active");

  // Data rekan tidak tersentuh (AC F14-2).
  const [peerProfile] = await db.select().from(alumni).where(eq(alumni.userId, rich.peer.userId));
  expect(peerProfile).toMatchObject({ fullName: "Ahmad Rekan", avatarFileId: rich.files.peerAvatar.id });
  expect((await userRow(db, rich.peer.userId))!.status).toBe("active");

  // Tidak ada teks pribadi tersisa di tabel mana pun (D2, AC F14-3, F14-4).
  expect(await personalDataHits(db, personalTerms(rich))).toEqual({});

  // Permintaan selesai; salinan kerja ledger hanya id/object key.
  const [deletion] = await db
    .select()
    .from(accountDeletions)
    .where(eq(accountDeletions.requestNumber, requestNumber));
  expect(deletion).toMatchObject({ status: "completed", lastError: null, nextAttemptAt: null });
  expect(deletion!.completedAt).not.toBeNull();
  expect([...deletion!.stepsDone].sort()).toEqual([...DELETION_STEPS].sort());
  return deletion!;
}
