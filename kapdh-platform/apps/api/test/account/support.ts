/**
 * Fixture uji modul account (F-14): akun alumni dengan data lengkap di setiap tabel yang disentuh penghapusan akun,
 * sehingga uji dapat membuktikan AC F14-3/F14-4/F14-5 dengan memeriksa tabel satu per satu. Data sintetis (.test).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  accountDeletions,
  alumniProfessions,
  alumni,
  auditLogs,
  blocks,
  deviceTokens,
  events,
  files,
  idempotencyKeys,
  masterProfessions,
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
  schema,
  sessions,
  tickets,
  users,
} from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { decodeJwt } from "jose";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { rows } from "../../src/core/db/rows.js";
import { commitAwareDb } from "../../src/core/db/tx.js";
import type { Db } from "../../src/core/db/types.js";
import { TokenService } from "../../src/core/identity/token.service.js";
import { JobRunner } from "../../src/core/jobs/job-runner.js";
import { MemoryRateLimitStore } from "../../src/core/rate-limit/store.js";
import { SettingsService } from "../../src/core/settings/settings.service.js";
import { LEDGER_PREFIX } from "../../src/modules/account/deletion-ledger.js";
import { AccountDeletionProcessor } from "../../src/modules/account/deletion-processor.js";
import { DELETION_STEPS } from "../../src/modules/account/deletion-steps.js";
import {
  type AlumniFixture,
  type AlumniSession,
  createAdmin,
  createAlumni,
  type EnrolledAdminFixture,
  signInAlumni,
} from "../support/factories.js";
import { FakePush, TestClock } from "../support/fakes.js";
import { httpClient } from "../support/http.js";
import { pgliteFromTemplate } from "../support/pglite-template.js";
import { testEnv, type TestApp } from "../support/test-app.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * Jalur uji superuser (PGlite): role kapdh_audit_purge dibuat dengan grant yang sama dengan infra/db/roles.sql
 * (USAGE skema app; SELECT/UPDATE/DELETE audit_logs dan payment_events), lalu job berpindah ke role itu dengan
 * `SET LOCAL ROLE kapdh_audit_purge` persis seperti login kapdh_worker di production.
 */
export async function ensureAuditPurgeRole(db: Db): Promise<void> {
  await db.execute(sql`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'kapdh_audit_purge') then
      create role kapdh_audit_purge nologin;
    end if;
  end $$`);
  await db.execute(sql`grant usage on schema app to kapdh_audit_purge`);
  await db.execute(
    sql`grant select, update, delete on app.audit_logs, app.payment_events to kapdh_audit_purge`,
  );
}

/** Header X-Reauth-Token untuk keluarga sesi access token (POST /auth/reauth milik modul auth; F-14). */
export async function reauthHeader(
  t: { app: NestFastifyApplication; db: Db },
  accessToken: string,
): Promise<Record<string, string>> {
  const claims = decodeJwt(accessToken);
  const [session] = await t.db
    .select({ familyId: sessions.familyId, userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.id, String(claims.sid)));
  const { token } = await t.app
    .get(TokenService)
    .signReauth({ userId: session!.userId, familyId: session!.familyId, level: 1 });
  return { "x-reauth-token": token };
}

/** Berkas tersimpan (baris files `ready` + objek di storage) tanpa melewati endpoint unggah. */
export async function storeFile(
  t: Pick<TestApp, "db" | "clock" | "storage">,
  ownerUserId: string | null,
  purpose: "avatar" | "chat_image" | "payment_proof" | "adjustment_evidence",
): Promise<{ id: string; objectKey: string }> {
  const id = uuidv7();
  const now = t.clock.now();
  const objectKey = `${purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
  await t.storage.put(objectKey, Buffer.from(`isi-uji-${id}`), { contentType: "image/jpeg" });
  await t.db.insert(files).values({
    id,
    ownerUserId,
    purpose,
    storageDriver: "local",
    objectKey,
    mime: "image/jpeg",
    bytes: 20,
    sha256: "0".repeat(64),
    visibility: "private",
    status: "ready",
    attachedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { id, objectKey };
}

export async function insertEvent(
  t: Pick<TestApp, "db" | "clock">,
  options: {
    startsInDays: number;
    status?: "open" | "closed" | "done";
    price?: string;
    held?: number;
    paid?: number;
  },
) {
  const now = t.clock.now();
  const startsAt = new Date(now.getTime() + options.startsInDays * DAY);
  const id = uuidv7();
  await t.db.insert(events).values({
    id,
    title: `Event Uji ${id.slice(-4)}`,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 4 * HOUR),
    registrationOpensAt: new Date(startsAt.getTime() - 30 * DAY),
    registrationClosesAt: new Date(startsAt.getTime() - HOUR),
    price: options.price ?? "50000.00",
    seatsTotal: 50,
    heldQuantity: options.held ?? 0,
    paidQuantity: options.paid ?? 0,
    status: options.status ?? "open",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

const METHOD_SNAPSHOT = {
  kind: "bank",
  provider: "Bank Uji",
  account_number: "7000123456",
  account_holder: "KAPDH",
};

async function insertPayment(
  t: Pick<TestApp, "db" | "clock">,
  input: {
    userId: string;
    type: "registration" | "renewal" | "ticket";
    status: "pending" | "paid";
    ticketId?: string;
    proofFileId?: string | null;
    amount?: string;
    transferNote?: string | null;
  },
) {
  const now = t.clock.now();
  const id = uuidv7();
  const proofVersion = input.proofFileId ? 1 : 0;
  await t.db.insert(payments).values({
    id,
    userId: input.userId,
    type: input.type,
    status: input.status,
    amount: input.amount ?? "50000.00",
    linesSnapshot: [{ code: input.type, label: "Baris uji", amount: input.amount ?? "50000.00" }],
    methodSnapshot: METHOD_SNAPSHOT,
    settingsVersion: input.type === "ticket" ? null : 1,
    ticketId: input.ticketId ?? null,
    proofFileId: input.proofFileId ?? null,
    proofVersion,
    transferNote: input.transferNote ?? null,
    submittedAt: proofVersion ? now : null,
    decidedAt: input.status === "paid" ? now : null,
    createdAt: now,
    updatedAt: now,
  });
  await t.db
    .insert(paymentEvents)
    .values({ id: uuidv7(), paymentId: id, kind: "created", actorUserId: input.userId, createdAt: now });
  if (input.proofFileId)
    await t.db.insert(paymentEvents).values({
      id: uuidv7(),
      paymentId: id,
      kind: "proof_submitted",
      proofVersion: 1,
      proofFileId: input.proofFileId,
      actorUserId: input.userId,
      reason: "Transfer dari rekening a.n. pemilik",
      createdAt: now,
    });
  return id;
}

/** Pembatalan payment pending oleh pemiliknya: status, alasan dan histori `cancelled` beraktor pemilik. */
async function cancelPaymentAsOwner(
  t: Pick<TestApp, "db" | "clock">,
  paymentId: string,
  userId: string,
  reason: string,
) {
  const now = t.clock.now();
  await t.db
    .update(payments)
    .set({ status: "cancelled", cancelledAt: now, cancelReason: reason, updatedAt: now })
    .where(eq(payments.id, paymentId));
  await t.db
    .insert(paymentEvents)
    .values({ id: uuidv7(), paymentId, kind: "cancelled", actorUserId: userId, reason, createdAt: now });
}

async function insertTicket(
  t: Pick<TestApp, "db" | "clock">,
  input: {
    eventId: string;
    userId: string;
    status: "awaiting_payment" | "awaiting_review" | "paid";
    total?: string;
  },
) {
  const now = t.clock.now();
  const id = uuidv7();
  await t.db.insert(tickets).values({
    id,
    eventId: input.eventId,
    userId: input.userId,
    status: input.status,
    totalSnapshot: input.total ?? "50000.00",
    holdExpiresAt: input.status === "awaiting_payment" ? new Date(now.getTime() + 20 * HOUR) : null,
    qrCode: input.status === "paid" ? `qr-${uuidv7()}` : null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function insertMessage(
  t: Pick<TestApp, "db">,
  input: { roomId: string; senderId: string; body?: string; imageFileId?: string; at: Date },
) {
  const id = uuidv7();
  await t.db.insert(messages).values({
    id,
    roomId: input.roomId,
    senderId: input.senderId,
    clientMessageId: uuidv7(),
    kind: input.imageFileId ? "image" : "text",
    body: input.body ?? null,
    imageFileId: input.imageFileId ?? null,
    createdAt: input.at,
  });
  await t.db.update(rooms).set({ lastMessageAt: input.at }).where(eq(rooms.id, input.roomId));
  return id;
}

async function insertRoom(
  t: Pick<TestApp, "db" | "clock">,
  input: {
    kind: "group" | "direct";
    name?: string;
    createdBy: string;
    members: [string, string][];
    avatarFileId?: string;
  },
) {
  const now = t.clock.now();
  const id = uuidv7();
  const directKey =
    input.kind === "direct" ? [input.members[0]![0], input.members[1]![0]].sort().join(":") : null;
  await t.db.insert(rooms).values({
    id,
    kind: input.kind,
    directKey,
    name: input.kind === "group" ? (input.name ?? "Grup Uji") : null,
    createdBy: input.createdBy,
    avatarFileId: input.avatarFileId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  let offset = 0;
  for (const [userId, role] of input.members) {
    const status = role === "invited" ? "invited" : "joined";
    await t.db.insert(roomMembers).values({
      roomId: id,
      userId,
      role: role === "admin" ? "admin" : "member",
      status,
      invitedBy: input.createdBy === userId ? null : input.createdBy,
      invitedAt: new Date(now.getTime() - 10 * DAY + offset),
      joinedAt: status === "joined" ? new Date(now.getTime() - 10 * DAY + offset) : null,
      historyVisibleFrom: status === "joined" ? new Date(now.getTime() - 10 * DAY + offset) : null,
      createdAt: now,
      updatedAt: now,
    });
    offset += HOUR;
  }
  return id;
}

export interface RichMember {
  member: AlumniFixture;
  session: AlumniSession;
  peer: AlumniFixture;
  expiredPeer: AlumniFixture;
  invitee: AlumniFixture;
  superAdmin: EnrolledAdminFixture;
  files: {
    avatar: { id: string; objectKey: string };
    chatImage: { id: string; objectKey: string };
    groupAvatar: { id: string; objectKey: string };
    proofPaid: { id: string; objectKey: string };
    proofOld: { id: string; objectKey: string };
    proofReview: { id: string; objectKey: string };
    adminProof: { id: string; objectKey: string };
    proofTicket: { id: string; objectKey: string };
    evidence: { id: string; objectKey: string };
    peerAvatar: { id: string; objectKey: string };
  };
  payments: {
    registration: string;
    renewalNoProof: string;
    ticketPaid: string;
    ticketNoProof: string;
    ticketWithProof: string;
    ticketPast: string;
    /** Dibatalkan pemiliknya dengan alasan tertulis (payment_events cancelled beraktor anggota). */
    ownerCancelled: string;
    ticketSelfCancelled: string;
  };
  events: { paid: string; noProof: string; withProof: string; past: string; selfCancelled: string };
  tickets: { paid: string; noProof: string; withProof: string; past: string; selfCancelled: string };
  adjustments: { refund: string; correction: string };
  rooms: { transfer: string; close: string; coAdmin: string; direct: string };
  messages: { memberText: string; memberImage: string; peerText: string; peerDirect: string };
  postId: string;
  reports: { byMember: string; aboutMemberMessage: string; contextOnly: string };
  auditIds: { memberActor: string; adminOnPayment: string; identityCorrection: string };
}

/**
 * Anggota verified dengan data di semua tabel yang disentuh F-14, ditautkan ke identitas Super Admin, beserta pihak
 * lain (rekan aktif, rekan expired, calon anggota grup) yang datanya TIDAK boleh ikut terhapus (AC F14-2).
 */
export async function createRichMember(
  t: Pick<TestApp, "app" | "db" | "clock" | "storage">,
): Promise<RichMember> {
  const now = t.clock.now();
  const member = await createAlumni(t, { status: "verified", fullName: "Budi Penghapus" });
  const expiredPeer = await createAlumni(t, { status: "expired", fullName: "Citra Kedaluwarsa" });
  const peer = await createAlumni(t, { status: "verified", fullName: "Ahmad Rekan" });
  const invitee = await createAlumni(t, { status: "verified", fullName: "Dewi Undangan" });
  const superAdmin = await createAdmin(t, {
    role: "super_admin",
    linkedAlumniUserId: member.userId,
    displayName: "Pengurus Budi",
  });
  const payer = await createAdmin(t, { permissions: ["payments.read", "payments.decide"] });
  const session = await signInAlumni(t, member);

  // Profil lengkap (kontak, sosial, profesi) dan avatar.
  const avatar = await storeFile(t, member.userId, "avatar");
  const peerAvatar = await storeFile(t, peer.userId, "avatar");
  // Master profesi dari seed referensi (PGlite); database jalur PG tanpa seed mendapat satu master uji.
  let [profession] = await t.db.select({ id: masterProfessions.id }).from(masterProfessions).limit(1);
  if (!profession) {
    profession = { id: uuidv7() };
    await t.db
      .insert(masterProfessions)
      .values({ id: profession.id, label: "Profesi Uji", createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    [profession] = await t.db.select({ id: masterProfessions.id }).from(masterProfessions).limit(1);
  }
  await t.db
    .update(alumni)
    .set({
      phone: "081234567890",
      bio: "Bio pribadi Budi",
      socialInstagram: "budi.penghapus",
      avatarFileId: avatar.id,
    })
    .where(eq(alumni.userId, member.userId));
  await t.db.update(alumni).set({ avatarFileId: peerAvatar.id }).where(eq(alumni.userId, peer.userId));
  await t.db.insert(alumniProfessions).values({ alumniUserId: member.userId, professionId: profession!.id });

  // Pembayaran iuran: registrasi lunas (bukti versi lama dan baru), perpanjangan pending tanpa bukti.
  const proofOld = await storeFile(t, member.userId, "payment_proof");
  const proofPaid = await storeFile(t, member.userId, "payment_proof");
  const registration = await insertPayment(t, {
    userId: member.userId,
    type: "registration",
    status: "paid",
    proofFileId: proofPaid.id,
    amount: "60000.00",
    transferNote: "Transfer a.n. Budi Penghapus",
  });
  await t.db.insert(paymentEvents).values({
    id: uuidv7(),
    paymentId: registration,
    kind: "proof_replaced",
    proofVersion: 1,
    proofFileId: proofOld.id,
    actorUserId: member.userId,
    createdAt: now,
  });
  await t.db.insert(membershipEvents).values({
    id: uuidv7(),
    userId: member.userId,
    kind: "activation",
    paymentId: registration,
    afterStartsAt: member.startsAt!,
    afterExpiresAt: member.expiresAt!,
    createdAt: now,
  });
  await t.db.insert(membershipEvents).values({
    id: uuidv7(),
    userId: member.userId,
    kind: "number_correction",
    reason: "Koreksi kelas Budi",
    beforeMemberNumber: "29.02.01.1",
    afterMemberNumber: member.memberNumber!,
    createdAt: now,
  });
  await t.db.insert(membershipEvents).values({
    id: uuidv7(),
    userId: member.userId,
    kind: "warn",
    reason: "Peringatan untuk Budi",
    createdAt: now,
  });
  // Instruksi perpanjangan yang dibatalkan pemiliknya dengan alasan tertulis (kontrak payments cancelMyPayment).
  const ownerCancelled = await insertPayment(t, {
    userId: member.userId,
    type: "renewal",
    status: "pending",
  });
  await cancelPaymentAsOwner(t, ownerCancelled, member.userId, "Salah nominal, Budi ulang");
  const renewalNoProof = await insertPayment(t, {
    userId: member.userId,
    type: "renewal",
    status: "pending",
  });

  // Event: tiket lunas (event mendatang), hold tanpa bukti, menunggu review (berbukti), tiket event yang sudah selesai.
  const eventPaid = await insertEvent(t, { startsInDays: 10, paid: 1 });
  const eventNoProof = await insertEvent(t, { startsInDays: 12, held: 1 });
  const eventWithProof = await insertEvent(t, { startsInDays: 14, held: 1 });
  const eventPast = await insertEvent(t, { startsInDays: -20, status: "done", paid: 1 });
  const ticketPaid = await insertTicket(t, { eventId: eventPaid, userId: member.userId, status: "paid" });
  const ticketNoProof = await insertTicket(t, {
    eventId: eventNoProof,
    userId: member.userId,
    status: "awaiting_payment",
  });
  const ticketWithProof = await insertTicket(t, {
    eventId: eventWithProof,
    userId: member.userId,
    status: "awaiting_review",
  });
  const ticketPast = await insertTicket(t, { eventId: eventPast, userId: member.userId, status: "paid" });
  const proofTicketPaid = await storeFile(t, member.userId, "payment_proof");
  const proofReview = await storeFile(t, member.userId, "payment_proof");
  const adminProof = await storeFile(t, payer.userId, "payment_proof");
  const ticketPaidPayment = await insertPayment(t, {
    userId: member.userId,
    type: "ticket",
    status: "paid",
    ticketId: ticketPaid,
    proofFileId: proofTicketPaid.id,
  });
  const ticketNoProofPayment = await insertPayment(t, {
    userId: member.userId,
    type: "ticket",
    status: "pending",
    ticketId: ticketNoProof,
  });
  const ticketWithProofPayment = await insertPayment(t, {
    userId: member.userId,
    type: "ticket",
    status: "pending",
    ticketId: ticketWithProof,
    proofFileId: proofReview.id,
    transferNote: "Sudah transfer, Budi",
  });
  const ticketPastPayment = await insertPayment(t, {
    userId: member.userId,
    type: "ticket",
    status: "paid",
    ticketId: ticketPast,
    proofFileId: adminProof.id,
  });
  // Tiket yang dibatalkan peserta sendiri dengan alasan tertulis (kontrak events cancelMyTicket, cancelled_by self);
  // payment pending-nya ikut dibatalkan dengan aktor peserta.
  const eventSelfCancelled = await insertEvent(t, { startsInDays: 16 });
  const ticketSelfCancelled = await insertTicket(t, {
    eventId: eventSelfCancelled,
    userId: member.userId,
    status: "awaiting_payment",
  });
  const ticketSelfCancelledPayment = await insertPayment(t, {
    userId: member.userId,
    type: "ticket",
    status: "pending",
    ticketId: ticketSelfCancelled,
  });
  await t.db
    .update(tickets)
    .set({
      status: "cancelled",
      cancelledAt: now,
      cancelledBy: "self",
      cancelReason: "Batal karena Budi sakit",
      updatedAt: now,
    })
    .where(eq(tickets.id, ticketSelfCancelled));
  await cancelPaymentAsOwner(t, ticketSelfCancelledPayment, member.userId, "Batal karena Budi sakit");

  // Penyesuaian: refund pending dengan rekening tujuan, koreksi selesai dengan bukti pengurus.
  const evidence = await storeFile(t, payer.userId, "adjustment_evidence");
  const refund = uuidv7();
  const correction = uuidv7();
  await t.db.insert(paymentAdjustments).values([
    {
      id: refund,
      paymentId: ticketPastPayment,
      kind: "refund",
      amount: "50000.00",
      reason: "Refund sebagian event",
      status: "pending",
      refundDestination: { bank: "Bank Uji", account_number: "1234567890", account_holder: "Budi Penghapus" },
      createdByAdminId: payer.adminId,
      dueAt: new Date(now.getTime() + 7 * DAY),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: correction,
      paymentId: registration,
      kind: "correction",
      amount: "10000.00",
      reason: "Koreksi nominal",
      status: "completed",
      evidenceFileId: evidence.id,
      createdByAdminId: payer.adminId,
      completedByAdminId: payer.adminId,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Chat: grup untuk pengalihan admin (C expired bergabung lebih dulu dari B), grup yang akan ditutup, grup dengan
  // admin lain, dan room direct.
  const groupAvatar = await storeFile(t, member.userId, "chat_image");
  const transfer = await insertRoom(t, {
    kind: "group",
    name: "Angkatan 29",
    createdBy: member.userId,
    avatarFileId: groupAvatar.id,
    members: [
      [member.userId, "admin"],
      [expiredPeer.userId, "member"],
      [peer.userId, "member"],
    ],
  });
  const close = await insertRoom(t, {
    kind: "group",
    name: "Panitia Reuni",
    createdBy: member.userId,
    members: [
      [member.userId, "admin"],
      [expiredPeer.userId, "member"],
      [invitee.userId, "invited"],
    ],
  });
  const coAdmin = await insertRoom(t, {
    kind: "group",
    name: "Pengurus Kelas",
    createdBy: peer.userId,
    members: [
      [peer.userId, "admin"],
      [member.userId, "admin"],
    ],
  });
  const direct = await insertRoom(t, {
    kind: "direct",
    createdBy: member.userId,
    members: [
      [member.userId, "member"],
      [peer.userId, "member"],
    ],
  });
  const chatImage = await storeFile(t, member.userId, "chat_image");
  const memberText = await insertMessage(t, {
    roomId: transfer,
    senderId: member.userId,
    body: "Pesan pribadi dari Budi",
    at: new Date(now.getTime() - 2 * HOUR),
  });
  const peerText = await insertMessage(t, {
    roomId: transfer,
    senderId: peer.userId,
    body: "Balasan Ahmad",
    at: new Date(now.getTime() - HOUR),
  });
  const memberImage = await insertMessage(t, {
    roomId: direct,
    senderId: member.userId,
    imageFileId: chatImage.id,
    body: "Foto dari Budi",
    at: new Date(now.getTime() - 3 * HOUR),
  });
  const peerDirect = await insertMessage(t, {
    roomId: direct,
    senderId: peer.userId,
    body: "Pesan direct Ahmad",
    at: new Date(now.getTime() - 30 * 60_000),
  });
  await t.db.insert(messageReactions).values([
    { messageId: memberText, userId: peer.userId, emoji: "👍", createdAt: now },
    { messageId: peerText, userId: member.userId, emoji: "❤", createdAt: now },
  ]);

  // Konten dan komunitas.
  const postId = uuidv7();
  await t.db.insert(posts).values({
    id: postId,
    slug: `berita-uji-${postId.slice(-8)}`,
    title: "Berita uji",
    bodyHtml: "<p>Isi</p>",
    status: "published",
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await t.db.insert(postLikes).values([
    { postId, userId: member.userId, createdAt: now },
    { postId, userId: peer.userId, createdAt: now },
  ]);
  await t.db.insert(blocks).values([
    { blockerId: member.userId, blockedId: expiredPeer.userId, createdAt: now },
    { blockerId: invitee.userId, blockedId: member.userId, createdAt: now },
  ]);
  const byMember = uuidv7();
  const aboutMemberMessage = uuidv7();
  const contextOnly = uuidv7();
  await t.db.insert(reports).values([
    {
      id: byMember,
      reporterId: member.userId,
      targetType: "user",
      targetUserId: peer.userId,
      category: "harassment",
      description: "Saya Budi, saya merasa dilecehkan",
      evidence: {
        captured_at: now.toISOString(),
        messages: [],
        room: null,
        profile: { full_name: "Ahmad Rekan", bio: null, avatar: { file_id: peerAvatar.id } },
        contested_suspension: null,
      },
      dueAt: new Date(now.getTime() + 2 * DAY),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: aboutMemberMessage,
      reporterId: peer.userId,
      targetType: "message",
      targetUserId: member.userId,
      targetMessageId: memberImage,
      roomId: direct,
      category: "spam",
      description: "Spam dari anggota ini",
      memberMessage: "Pesan untuk Budi",
      evidence: {
        captured_at: now.toISOString(),
        messages: [
          {
            message_id: memberImage,
            reported: true,
            sender_user_id: member.userId,
            sender_name: "Budi Penghapus",
            kind: "image",
            body: "Foto dari Budi",
            image: { file_id: chatImage.id },
            created_at: now.toISOString(),
            deleted_since_report: false,
          },
        ],
        room: null,
        profile: null,
        contested_suspension: null,
      },
      dueAt: new Date(now.getTime() + 2 * DAY),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: contextOnly,
      reporterId: invitee.userId,
      targetType: "message",
      targetUserId: peer.userId,
      targetMessageId: peerText,
      roomId: transfer,
      category: "other",
      description: "Konteks percakapan",
      evidence: {
        captured_at: now.toISOString(),
        messages: [
          {
            message_id: peerText,
            reported: true,
            sender_user_id: peer.userId,
            sender_name: "Ahmad Rekan",
            kind: "text",
            body: "Balasan Ahmad",
            image: null,
            created_at: now.toISOString(),
            deleted_since_report: false,
          },
          {
            message_id: memberText,
            reported: false,
            sender_user_id: member.userId,
            sender_name: "Budi Penghapus",
            kind: "text",
            body: "Pesan pribadi dari Budi",
            image: null,
            created_at: now.toISOString(),
            deleted_since_report: false,
          },
        ],
        room: {
          room_id: transfer,
          kind: "group",
          name: "Angkatan 29",
          avatar: { file_id: groupAvatar.id },
          member_count: 3,
        },
        profile: null,
        contested_suspension: null,
      },
      dueAt: new Date(now.getTime() + 2 * DAY),
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Notifikasi, preferensi, token perangkat beserta pengiriman pending.
  const notificationId = uuidv7();
  const deviceId = uuidv7();
  await t.db.insert(notifications).values({
    id: notificationId,
    userId: member.userId,
    category: "payment",
    title: "Pembayaran disetujui",
    body: "Halo Budi",
    data: { route: "/payments" },
    dedupKey: `u:${member.userId}:uji:${notificationId}`,
    createdAt: now,
  });
  await t.db
    .insert(notificationPreferences)
    .values({ userId: member.userId, category: "news", channel: "push", enabled: false, updatedAt: now });
  await t.db.insert(deviceTokens).values({
    id: deviceId,
    userId: member.userId,
    platform: "android",
    token: `fcm-${uuidv7()}`,
    createdAt: now,
    updatedAt: now,
  });
  await t.db.insert(notificationDeliveries).values({
    id: uuidv7(),
    notificationId,
    channel: "push",
    deviceTokenId: deviceId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  // Audit: aktor anggota (data pribadi di after) dan keputusan pengurus atas payment anggota.
  const memberActor = uuidv7();
  const adminOnPayment = uuidv7();
  const identityCorrection = uuidv7();
  await t.db.insert(auditLogs).values([
    {
      // Snapshot koreksi identitas oleh pengurus (MembershipKernel.correctIdentity): angkatan/kelas/nomor anggota.
      id: identityCorrection,
      actorUserId: payer.userId,
      actorAdminId: payer.adminId,
      effectiveRole: "admin",
      action: "member.number_corrected",
      entityType: "alumni",
      entityId: member.userId,
      requestId: "req-uji-koreksi",
      reason: "Koreksi kelas Budi",
      before: { cohort: 29, class_in: 2, class_out: 6, gender: "male", member_number: "29.02.01.1" },
      after: { cohort: 29, class_in: 1, class_out: 6, gender: "male", member_number: member.memberNumber },
      createdAt: now,
    },
    {
      id: memberActor,
      actorUserId: member.userId,
      effectiveRole: "alumni",
      action: "profile.updated",
      entityType: "alumni",
      entityId: member.userId,
      requestId: "req-uji-profil",
      reason: "Ganti nomor Budi",
      before: { phone: "0811111111", city: "Bandung" },
      after: { phone: "081234567890", full_name: "Budi Penghapus", show_phone: true, version: 3 },
      createdAt: now,
    },
    {
      id: adminOnPayment,
      actorUserId: payer.userId,
      actorAdminId: payer.adminId,
      effectiveRole: "admin",
      action: "payment.approved",
      entityType: "payment",
      entityId: registration,
      requestId: "req-uji-bayar",
      reason: "Dana sesuai mutasi",
      before: { status: "pending" },
      after: { status: "paid", amount: "60000.00", transfer_note: "Transfer a.n. Budi Penghapus" },
      createdAt: now,
    },
  ]);

  // Kunci idempotensi dengan respons tersimpan dan challenge OTP lama.
  await t.db.insert(idempotencyKeys).values({
    id: uuidv7(),
    scope: member.userId,
    endpoint: "PATCH /api/v1/me/profile",
    key: uuidv7(),
    payloadHash: "h".repeat(64),
    status: "completed",
    responseStatus: 200,
    responseBody: { full_name: "Budi Penghapus" },
    expiresAt: new Date(now.getTime() + DAY),
    createdAt: now,
    updatedAt: now,
  });
  await t.db.insert(otpCodes).values({
    id: uuidv7(),
    userId: member.userId,
    purpose: "signup",
    codeHmac: "c".repeat(64),
    expiresAt: new Date(now.getTime() - DAY),
    resendAvailableAt: new Date(now.getTime() - DAY),
    consumedAt: new Date(now.getTime() - DAY),
    createdAt: new Date(now.getTime() - DAY),
  });

  return {
    member,
    session,
    peer,
    expiredPeer,
    invitee,
    superAdmin,
    files: {
      avatar,
      chatImage,
      groupAvatar,
      proofPaid,
      proofOld,
      proofReview,
      adminProof,
      proofTicket: proofTicketPaid,
      evidence,
      peerAvatar,
    },
    payments: {
      registration,
      renewalNoProof,
      ticketPaid: ticketPaidPayment,
      ticketNoProof: ticketNoProofPayment,
      ticketWithProof: ticketWithProofPayment,
      ticketPast: ticketPastPayment,
      ownerCancelled,
      ticketSelfCancelled: ticketSelfCancelledPayment,
    },
    events: {
      paid: eventPaid,
      noProof: eventNoProof,
      withProof: eventWithProof,
      past: eventPast,
      selfCancelled: eventSelfCancelled,
    },
    tickets: {
      paid: ticketPaid,
      noProof: ticketNoProof,
      withProof: ticketWithProof,
      past: ticketPast,
      selfCancelled: ticketSelfCancelled,
    },
    adjustments: { refund, correction },
    rooms: { transfer, close, coAdmin, direct },
    messages: { memberText, memberImage, peerText, peerDirect },
    postId,
    reports: { byMember, aboutMemberMessage, contextOnly },
    auditIds: { memberActor, adminOnPayment, identityCorrection },
  };
}

/** Membaca baris users mentah (uji). */
export async function userRow(db: Db, userId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row;
}

/** Teks pribadi milik anggota pada fixture {@link createRichMember} yang tidak boleh tersisa di tabel mana pun (D2). */
export function personalTerms(rich: RichMember): string[] {
  return [
    rich.member.email,
    "Budi Penghapus",
    "081234567890",
    "0811111111",
    "budi.penghapus",
    "Bio pribadi Budi",
    "Transfer a.n. Budi",
    "Sudah transfer, Budi",
    "Transfer dari rekening a.n. pemilik",
    "Koreksi kelas Budi",
    "Peringatan untuk Budi",
    "Ganti nomor Budi",
    "Saya Budi",
    "Pesan untuk Budi",
    "Pesan pribadi dari Budi",
    "Foto dari Budi",
    "Halo Budi",
    "1234567890",
    "Budi sakit",
    "Budi ulang",
  ];
}

/**
 * Pemeriksaan SETIAP tabel skema app (AC F14-3, F14-4, D2): jumlah baris per tabel yang representasi JSON-nya masih
 * memuat salah satu `terms`. Hasil kosong berarti tidak ada data pribadi yang tersisa.
 */
export async function personalDataHits(db: Db, terms: string[]): Promise<Record<string, number>> {
  const tables = rows<{ table_name: string }>(
    await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'app' and table_type = 'BASE TABLE' order by 1`,
    ),
  );
  expect(tables.length).toBeGreaterThanOrEqual(37);
  const hits: Record<string, number> = {};
  const condition = sql.join(
    terms.map((term) => sql`strpos(lower(row_to_json(t)::text), ${term.toLowerCase()}) > 0`),
    sql` or `,
  );
  for (const { table_name: table } of tables) {
    const [row] = rows<{ n: number }>(
      await db.execute(sql`select count(*)::int as n from app.${sql.identifier(table)} t where ${condition}`),
    );
    if ((row?.n ?? 0) > 0) hits[table] = row!.n;
  }
  return hits;
}

/** Menjalankan job penghapusan satu permintaan dalam konteks sistem seperti worker (ARCHITECTURE §4.8). */
export function runDeletion(t: Pick<TestApp, "app">, deletionId: string, options: { force?: boolean } = {}) {
  return runAsSystem(() => t.app.get(AccountDeletionProcessor).run(deletionId, options), {
    jobId: `account.deletion:${uuidv7()}`,
  });
}

/** POST /me/deletion lengkap (pengungkapan -> reautentikasi -> konfirmasi); mengembalikan baris permintaan. */
export async function requestDeletionViaApp(
  t: Pick<TestApp, "app" | "db">,
  session: AlumniSession,
): Promise<{ id: string; requestNumber: string }> {
  const api = httpClient(t.app);
  const disclosure = await api.get("/me/deletion/disclosure", { token: session.accessToken });
  expect(disclosure.statusCode, disclosure.body).toBe(200);
  const res = await api.post(
    "/me/deletion",
    { confirm: true, acknowledged_disclosure_version: disclosure.json().version },
    { token: session.accessToken, headers: await reauthHeader(t, session.accessToken) },
  );
  expect(res.statusCode, res.body).toBe(202);
  const requestNumber = res.json().request_number as string;
  const [row] = await t.db
    .select({ id: accountDeletions.id })
    .from(accountDeletions)
    .where(eq(accountDeletions.requestNumber, requestNumber));
  return { id: row!.id, requestNumber };
}

/**
 * Aplikasi API dari "backup" database (dump data directory PGlite) dan salinan storage berkas, untuk menguji restore
 * (AC F14-6). Sama dengan createTestApp tetapi memuat data directory yang diberikan.
 */
export async function appFromBackup(backup: Blob, storage: MemoryDriver, clock: TestClock): Promise<TestApp> {
  const pg = await pgliteFromTemplate(backup);
  const db = commitAwareDb(drizzle(pg, { schema }) as unknown as Db);
  const mailer = new MemoryMailer();
  const push = new FakePush();
  const rateLimits = new MemoryRateLimitStore();
  const app = await createApp(
    { env: testEnv, db, mailer, clock, push, storage, redis: null },
    { logger: false, rateLimitStore: rateLimits },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const closeApp = app.close.bind(app);
  app.close = async () => {
    await closeApp();
    await pg.close();
  };
  return {
    app,
    db,
    mailer,
    clock,
    push,
    storage,
    jobs: app.get(JobRunner),
    settings: app.get(SettingsService),
    rateLimits,
    pg,
    env: testEnv,
  };
}

/** Salinan isi storage (backup berkas) pada satu titik waktu. */
export function snapshotStorage(storage: MemoryDriver): Map<string, Buffer> {
  return new Map(storage.keys().map((key) => [key, storage.contents(key)!]));
}

export async function restoreStorage(snapshot: Map<string, Buffer>): Promise<MemoryDriver> {
  const storage = new MemoryDriver();
  for (const [key, body] of snapshot)
    await storage.put(key, body, { contentType: "application/octet-stream" });
  return storage;
}

/** Menyalin objek ledger eksternal ke folder disk seperti salinan ledger terbaru pada manifest backup (PRD 5.5). */
export function exportLedger(storage: MemoryDriver): string {
  const dir = mkdtempSync(join(tmpdir(), "kapdh-ledger-"));
  for (const key of storage.keys().filter((k) => k.startsWith(`${LEDGER_PREFIX}/`))) {
    const target = join(dir, ...key.slice(LEDGER_PREFIX.length + 1).split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, storage.contents(key)!);
  }
  return dir;
}

export function readLedger(storage: MemoryDriver, key: string): Record<string, unknown> {
  return JSON.parse(storage.contents(key)!.toString("utf8")) as Record<string, unknown>;
}

export async function deletionRow(db: Db, id: string) {
  const [row] = await db.select().from(accountDeletions).where(eq(accountDeletions.id, id));
  return row!;
}

export { DELETION_STEPS };
