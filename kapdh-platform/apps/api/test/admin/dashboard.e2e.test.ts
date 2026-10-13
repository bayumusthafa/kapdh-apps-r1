import type { Permission } from "@kapdh/contracts";
import {
  deviceTokens,
  events,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  outboxEvents,
  paymentAdjustments,
  payments,
  reports,
  roomMembers,
  rooms,
  sessions,
  tickets,
} from "@kapdh/database";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import {
  type AlumniFixture,
  type CreateAlumniOptions,
  createAdmin,
  createAlumni,
  signInAlumni,
} from "../support/factories.js";
import { httpClient, type HttpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { type AdminActor, adminActor, signInActor, superAdminActor } from "./helpers.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

let t: TestApp;
let api: HttpClient;
let now: Date;
const members: AlumniFixture[] = [];
let linkedForModerator: AlumniFixture;
let linkedActiveAdmin: AlumniFixture;
const ids = {
  p1: "",
  p2: "",
  p3: "",
  p5: "",
  p6: "",
  p7: "",
  e1: "",
  e3: "",
  e4: "",
  e5: "",
  r2: "",
};

const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

async function member(options: CreateAlumniOptions = {}): Promise<AlumniFixture> {
  const fixture = await createAlumni(t, options);
  members.push(fixture);
  return fixture;
}

const snapshot = { kind: "bank", provider: "Bank Uji", account_number: "7000123456", account_holder: "KAPDH (uji)" };

async function payment(values: Partial<typeof payments.$inferInsert> & { userId: string; type: "registration" | "renewal" | "ticket" }) {
  const id = uuidv7();
  await t.db.insert(payments).values({
    id,
    status: "pending",
    amount: values.type === "registration" ? "60000.00" : values.type === "renewal" ? "10000.00" : "50000.00",
    linesSnapshot: [{ code: values.type, label: "Uji", amount: "0.00" }],
    methodSnapshot: snapshot,
    settingsVersion: values.type === "ticket" ? null : 1,
    proofVersion: 0,
    createdAt: at(-4 * DAY),
    updatedAt: at(-4 * DAY),
    ...values,
  });
  return id;
}

async function event(values: Partial<typeof events.$inferInsert> & { title: string; startsAt: Date }) {
  const id = uuidv7();
  await t.db.insert(events).values({
    id,
    endsAt: new Date(values.startsAt.getTime() + 3 * HOUR),
    registrationOpensAt: at(-30 * DAY),
    registrationClosesAt: new Date(values.startsAt.getTime() - HOUR),
    price: "50000.00",
    seatsTotal: 10,
    status: "open",
    locationName: "Aula Pesantren",
    ...values,
  });
  return id;
}

async function ticket(values: Partial<typeof tickets.$inferInsert> & { eventId: string; userId: string; status: "awaiting_review" | "paid" }) {
  const id = uuidv7();
  await t.db.insert(tickets).values({
    id,
    totalSnapshot: "50000.00",
    qrCode: values.status === "paid" ? `qr-${id}` : null,
    ...values,
  });
  return id;
}

/**
 * Data dasbor yang diketahui jumlahnya (aplikasi uji tersendiri): Clock uji Selasa 09.00 WIB.
 *
 * Pembayaran: P1 registration berbukti 2 hari lalu (lewat batas +1 hari kerja), P2 renewal berbukti 1 jam lalu, P3 tiket
 * berbukti yang check-in event-nya sudah dibuka (lewat batas), P4 registration tanpa bukti; paid P5 (1 hari lalu),
 * P6 tiket (2 jam lalu), P7 renewal pemilik terhapus (3 hari lalu). Penyesuaian: satu pending lewat due_at, satu
 * pending belum, satu completed.
 */
async function seed(): Promise<void> {
  now = t.clock.now();
  const p1Owner = await member({ status: "unverified" });
  const p2Owner = await member({ status: "expiring" });
  const p3Owner = await member({ status: "verified" });
  const p4Owner = await member({ status: "unverified" });
  const p5Owner = await member({ status: "verified", fullName: "Pemilik Lima" });
  const p6Owner = await member({ status: "verified", fullName: "Pemilik Enam" });
  const p7Owner = await member({ status: "verified", accountStatus: "deleted", fullName: "Sudah Dihapus" });
  await member({ status: "expired" });
  await member({ status: "suspended" });
  await member({ status: "pending_otp" });
  await member({ status: "verified", accountStatus: "disabled" });
  await member({ status: "verified", accountStatus: "deletion_pending", deletion: { status: "failed" } });
  linkedForModerator = await member({ status: "verified", fullName: "Alumni Moderator" });
  linkedActiveAdmin = await member({ status: "verified", fullName: "Alumni Pengurus" });
  await createAdmin(t, { linkedAlumniUserId: linkedActiveAdmin.userId });

  // Event: E1 mulai 1 jam lagi (check-in sudah dibuka), E2 draf, E3 closed 10 hari lagi, E4 selesai, E5 40 hari lagi.
  ids.e1 = await event({ title: "Mancing Bareng Alumni", startsAt: at(HOUR), heldQuantity: 1, paidQuantity: 1 });
  await event({ title: "Draf Rahasia", startsAt: at(5 * DAY), status: "draft" });
  ids.e3 = await event({ title: "Reuni Akbar", startsAt: at(10 * DAY), status: "closed", seatsTotal: 5 });
  ids.e4 = await event({
    title: "Kajian Lalu",
    startsAt: at(-5 * DAY),
    status: "done",
    registrationOpensAt: at(-40 * DAY),
  });
  ids.e5 = await event({ title: "Muktamar", startsAt: at(40 * DAY) });
  const reviewTicket = await ticket({ eventId: ids.e1, userId: p3Owner.userId, status: "awaiting_review" });
  const paidTicket = await ticket({
    eventId: ids.e1,
    userId: p6Owner.userId,
    status: "paid",
    checkedInAt: at(-10 * 60_000),
  });

  ids.p1 = await payment({ userId: p1Owner.userId, type: "registration", proofVersion: 1, submittedAt: at(-2 * DAY) });
  ids.p2 = await payment({ userId: p2Owner.userId, type: "renewal", proofVersion: 1, submittedAt: at(-HOUR) });
  ids.p3 = await payment({
    userId: p3Owner.userId,
    type: "ticket",
    ticketId: reviewTicket,
    proofVersion: 1,
    submittedAt: at(-3 * DAY),
  });
  await payment({ userId: p4Owner.userId, type: "registration" });
  ids.p5 = await payment({
    userId: p5Owner.userId,
    type: "registration",
    status: "paid",
    proofVersion: 1,
    submittedAt: at(-2 * DAY),
    decidedAt: at(-DAY),
  });
  ids.p6 = await payment({
    userId: p6Owner.userId,
    type: "ticket",
    ticketId: paidTicket,
    status: "paid",
    proofVersion: 1,
    submittedAt: at(-DAY),
    decidedAt: at(-2 * HOUR),
  });
  ids.p7 = await payment({
    userId: p7Owner.userId,
    type: "renewal",
    status: "paid",
    proofVersion: 1,
    submittedAt: at(-4 * DAY),
    decidedAt: at(-3 * DAY),
  });
  await t.db.insert(paymentAdjustments).values([
    { id: uuidv7(), paymentId: ids.p5, kind: "refund", amount: "60000.00", reason: "Uji", dueAt: at(-HOUR) },
    { id: uuidv7(), paymentId: ids.p6, kind: "correction", amount: "1000.00", reason: "Uji", dueAt: at(5 * DAY) },
    {
      id: uuidv7(),
      paymentId: ids.p7,
      kind: "correction",
      amount: "1000.00",
      reason: "Uji",
      status: "completed",
      completedAt: at(-HOUR),
    },
  ]);

  // Laporan: R1 open, R2 urgent lewat target (tertua), R3 in_review, R4 resolved, R5 terhadap alumni tertaut moderator.
  const reporter = p5Owner.userId;
  const report = (values: Partial<typeof reports.$inferInsert>) => ({
    id: uuidv7(),
    reporterId: reporter,
    targetType: "user" as const,
    targetUserId: p6Owner.userId,
    category: "spam" as const,
    dueAt: at(DAY),
    createdAt: at(-HOUR),
    updatedAt: at(-HOUR),
    ...values,
  });
  ids.r2 = uuidv7();
  await t.db.insert(reports).values([
    report({}),
    report({ id: ids.r2, priority: "urgent", category: "violence_threat", dueAt: at(-HOUR), createdAt: at(-2 * DAY) }),
    report({ status: "in_review", claimedAt: at(-HOUR) }),
    report({ status: "resolved", action: "warn", resolutionNote: "Diperingatkan", resolvedAt: at(-HOUR) }),
    report({ targetUserId: linkedForModerator.userId, createdAt: at(-30 * 60_000) }),
  ]);
  // Laporan grup tanpa subjek: anggota joined grup itu dianggap pihak terlapor (C6 admin-moderation butir a).
  const joinedRoom = uuidv7();
  const otherRoom = uuidv7();
  await t.db.insert(rooms).values([
    { id: joinedRoom, kind: "group", name: "Grup Angkatan", createdBy: linkedForModerator.userId },
    { id: otherRoom, kind: "group", name: "Grup Lain", createdBy: p5Owner.userId },
  ]);
  await t.db.insert(roomMembers).values([
    { roomId: joinedRoom, userId: linkedForModerator.userId, role: "admin", status: "joined", joinedAt: at(-DAY) },
    { roomId: otherRoom, userId: p5Owner.userId, role: "admin", status: "joined", joinedAt: at(-DAY) },
  ]);
  await t.db.insert(reports).values([
    report({ targetType: "room", targetUserId: null, roomId: joinedRoom }),
    report({ targetType: "room", targetUserId: null, roomId: otherRoom }),
  ]);

  // Pengiriman notifikasi: D1 email gagal (dapat ditindak), D2 push gagal token dicabut, D3 email gagal 8 hari lalu,
  // D4 push gagal token aktif milik penerima (dapat ditindak), D5 email gagal tetapi preferensi email dimatikan.
  const recipient = p5Owner.userId;
  const notification = async (category: "payment" | "event", createdAt: Date) => {
    const id = uuidv7();
    await t.db.insert(notifications).values({
      id,
      userId: recipient,
      category,
      title: "Uji",
      dedupKey: `u:${recipient}:${id}`,
      createdAt,
    });
    return id;
  };
  const live = uuidv7();
  const revoked = uuidv7();
  await t.db.insert(deviceTokens).values([
    { id: live, userId: recipient, platform: "android", token: `tok-${live}` },
    { id: revoked, userId: recipient, platform: "ios", token: `tok-${revoked}`, revokedAt: at(-HOUR) },
  ]);
  await t.db
    .insert(notificationPreferences)
    .values({ userId: recipient, category: "event", channel: "email", enabled: false });
  const n1 = await notification("payment", at(-DAY));
  const n2 = await notification("payment", at(-8 * DAY));
  const n3 = await notification("event", at(-DAY));
  await t.db.insert(notificationDeliveries).values([
    { id: uuidv7(), notificationId: n1, channel: "email", status: "failed", createdAt: at(-DAY) },
    { id: uuidv7(), notificationId: n1, channel: "push", deviceTokenId: revoked, status: "failed", createdAt: at(-DAY) },
    { id: uuidv7(), notificationId: n2, channel: "email", status: "failed", createdAt: at(-8 * DAY) },
    { id: uuidv7(), notificationId: n1, channel: "push", deviceTokenId: live, status: "failed", createdAt: at(-DAY) },
    { id: uuidv7(), notificationId: n3, channel: "email", status: "failed", createdAt: at(-DAY) },
  ]);
  await t.db.insert(outboxEvents).values([
    { id: uuidv7(), topic: "event.cancelled", dedupKey: `uji-f-${uuidv7()}`, payload: {}, status: "failed" },
    { id: uuidv7(), topic: "event.cancelled", dedupKey: `uji-d-${uuidv7()}`, payload: {}, status: "dead" },
    { id: uuidv7(), topic: "event.cancelled", dedupKey: `uji-d-${uuidv7()}`, payload: {}, status: "dead" },
    {
      id: uuidv7(),
      topic: "event.cancelled",
      dedupKey: `uji-p-${uuidv7()}`,
      payload: {},
      status: "pending",
      nextAttemptAt: at(DAY),
      createdAt: at(-2 * HOUR),
    },
  ]);
}

beforeAll(async () => {
  t = await createTestApp();
  api = httpClient(t.app);
  await seed();
});
afterAll(async () => {
  await t.app.close();
});

async function dashboard(actor: AdminActor) {
  const res = await api.get("/admin/dashboard", { token: actor.token });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/admin/dashboard", res) as Record<string, any>;
}

async function badges(actor: AdminActor) {
  const res = await api.get("/admin/dashboard/badges", { token: actor.token, headers: { "x-background-request": "1" } });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/admin/dashboard/badges", res) as Record<string, number>;
}

describe("AC F15-1: bagian dasbor sesuai izin (bagian tanpa izin dihilangkan, bukan null/nol)", () => {
  it.each<[string, Permission[], string[], string[]]>([
    ["admin pembayaran tanpa izin konten", ["payments.read", "payments.decide"], ["payments"], []],
    ["anggota", ["members.read"], ["members"], []],
    ["check-in saja", ["events.checkin"], ["upcoming_events"], []],
    ["pengelola event", ["events.manage"], ["events", "upcoming_events"], []],
    ["moderator", ["moderation.read"], ["moderation"], ["reports_open"]],
    ["pemantau notifikasi", ["notifications.manage"], ["jobs"], ["failed_jobs"]],
    ["tanpa izin", [], [], []],
    ["konten dan pengaturan", ["content.manage", "settings.manage", "audit.read"], [], []],
  ])("AC F15-1: %s hanya menerima bagian %j", async (_, permissions, sections, badgeKeys) => {
    const actor = await adminActor(t, { permissions });
    const body = await dashboard(actor);
    expect(Object.keys(body).sort()).toEqual(["generated_at", ...sections].sort());
    expect(body.generated_at).toBe(t.clock.now().toISOString());
    expect(Object.keys(await badges(actor)).sort()).toEqual([...badgeKeys].sort());
  });

  it("AC F15-1: Super Admin menerima seluruh bagian dan seluruh lencana", async () => {
    const root = await superAdminActor(t);
    const body = await dashboard(root);
    expect(Object.keys(body).sort()).toEqual(
      ["generated_at", "payments", "members", "events", "upcoming_events", "moderation", "jobs"].sort(),
    );
    expect(Object.keys(await badges(root)).sort()).toEqual(["failed_jobs", "reports_open"]);
  });

  it("token aplikasi alumni 403 FORBIDDEN; tanpa token 401", async () => {
    const someone = await createAlumni(t, { status: "verified" });
    members.push(someone);
    const session = await signInAlumni(t, someone);
    for (const path of ["/admin/dashboard", "/admin/dashboard/badges"]) {
      const res = await api.get(path, { token: session.accessToken });
      expect(res.statusCode, path).toBe(403);
      expect(expectOperation("get", path, res)).toMatchObject({ code: "FORBIDDEN" });
      expect((await api.get(path)).statusCode).toBe(401);
    }
  });
});

describe("Isi bagian dasbor (F-15, PRD 3.15, guideline hlm. 12)", () => {
  it("F-04/F-15: antrean pembayaran, lewat batas iuran (+1 hari kerja) dan tiket (pembukaan check-in), penyesuaian D6, transaksi", async () => {
    const body = await dashboard(await adminActor(t, { permissions: ["payments.read"] }));
    expect(body.payments).toMatchObject({
      awaiting_review_count: 3,
      awaiting_review_by_type: { registration: 1, renewal: 1, ticket: 1 },
      oldest_submitted_at: at(-3 * DAY).toISOString(),
      overdue_count: 2,
      overdue_by_type: { registration: 1, renewal: 0, ticket: 1 },
      awaiting_transfer_count: 1,
      adjustments_pending_count: 2,
      adjustments_overdue_count: 1,
      paid_total_amount: "120000.00",
      paid_count: 3,
    });
    expect(body.payments.recent_transactions).toEqual([
      {
        payment_id: ids.p6,
        type: "ticket",
        event_title: "Mancing Bareng Alumni",
        member: expect.objectContaining({ full_name: "Pemilik Enam" }),
        amount: "50000.00",
        paid_at: at(-2 * HOUR).toISOString(),
      },
      {
        payment_id: ids.p5,
        type: "registration",
        event_title: null,
        member: expect.objectContaining({ full_name: "Pemilik Lima" }),
        amount: "60000.00",
        paid_at: at(-DAY).toISOString(),
      },
      {
        // Pemilik terhapus: identitas tidak ditampilkan (D2).
        payment_id: ids.p7,
        type: "renewal",
        event_title: null,
        member: { user_id: null, full_name: null, member_number: null },
        amount: "10000.00",
        paid_at: at(-3 * DAY).toISOString(),
      },
    ]);
  });

  it("F-15: total alumni aktif, partisi effective_status, pengguna terbaru dengan label admin tertaut", async () => {
    const body = await dashboard(await adminActor(t, { permissions: ["members.read"] }));
    const active = members.filter((m) => m.accountStatus === "active" && m.status !== "pending_otp");
    const tally = (status: string) => active.filter((m) => m.status === status).length;
    expect(body.members).toMatchObject({
      total_alumni: active.length,
      status_counts: {
        unverified: tally("unverified"),
        verified: tally("verified"),
        expiring: tally("expiring"),
        expired: tally("expired"),
        suspended: tally("suspended"),
      },
      active_count: tally("verified") + tally("expiring"),
    });
    expect(body.members.latest_members.length).toBeLessThanOrEqual(10);
    const listed = new Map(body.members.latest_members.map((m: { user_id: string }) => [m.user_id, m]));
    expect(listed.get(linkedActiveAdmin.userId)).toMatchObject({ linked_admin: true, effective_status: "verified" });
    expect(listed.get(linkedForModerator.userId)).toMatchObject({ linked_admin: false });
    // Akun nonaktif, dihapus, deletion_pending dan pending_otp tidak tampil.
    const hidden = members.filter((m) => m.accountStatus !== "active" || m.status === "pending_otp").map((m) => m.userId);
    for (const id of hidden) expect(listed.has(id)).toBe(false);
  });

  it("F-09/F-15: tiket terjual, penjualan per event (bukan draf, terbaru dahulu), event mendatang 30 hari", async () => {
    const body = await dashboard(await adminActor(t, { permissions: ["events.manage"] }));
    expect(body.events.tickets_sold_count).toBe(1);
    expect(body.events.ticket_sales.map((e: { event_id: string }) => e.event_id)).toEqual([
      ids.e5,
      ids.e3,
      ids.e1,
      ids.e4,
    ]);
    expect(body.events.ticket_sales[2]).toMatchObject({
      title: "Mancing Bareng Alumni",
      status: "open",
      seats_total: 10,
      sold_count: 1,
      held_count: 1,
      seats_available: 8,
      awaiting_review_count: 1,
      timezone: "Asia/Jakarta",
    });
    expect(body.upcoming_events.map((e: { event_id: string }) => e.event_id)).toEqual([ids.e1, ids.e3]);
    expect(body.upcoming_events[0]).toMatchObject({ checked_in_count: 1, sold_count: 1, location_name: "Aula Pesantren" });
  });

  it("F-12: laporan terbuka/mendesak/lewat target; laporan terhadap alumni tertaut pemanggil tidak dihitung (C6 butir c)", async () => {
    const moderator = await adminActor(t, {
      permissions: ["moderation.read"],
      linkedAlumniUserId: linkedForModerator.userId,
    });
    const body = await dashboard(moderator);
    // R1, R2, R3 dan laporan grup yang tidak diikutinya; laporan terhadap alumninya dan grupnya tidak terlihat.
    expect(body.moderation).toEqual({
      open_count: 4,
      urgent_count: 1,
      overdue_count: 1,
      oldest_open_created_at: at(-2 * DAY).toISOString(),
    });
    expect(await badges(moderator)).toEqual({ reports_open: 4 });
    // Pengurus tanpa tautan alumni melihat seluruh laporan aktif (resolved tidak dihitung).
    const other = await adminActor(t, { permissions: ["moderation.read"] });
    expect((await dashboard(other)).moderation.open_count).toBe(6);
  });

  it("PRD 3.15, 5.5: job gagal yang dapat ditindak (7 hari, retryable) + outbox dead; failed/pending/penghapusan informasi", async () => {
    const actor = await adminActor(t, { permissions: ["notifications.manage"] });
    const body = await dashboard(actor);
    expect(body.jobs).toEqual({
      failed_delivery_count: 2,
      failed_delivery_since: at(-7 * DAY).toISOString(),
      failed_outbox_count: 1,
      dead_outbox_count: 2,
      oldest_pending_outbox_at: at(-2 * HOUR).toISOString(),
      failed_account_deletion_count: 1,
    });
    expect(await badges(actor)).toEqual({ failed_jobs: 4 });
  });
});

describe("AC F02-5: polling dasbor dengan X-Background-Request tidak memperpanjang idle timeout", () => {
  it("AC F02-5: request latar tidak memperbarui last_activity_at; muat ulang pengguna memperbaruinya", async () => {
    const actor = await adminActor(t, { permissions: ["payments.read"] });
    const sid = String(decodeJwt(actor.token).sid);
    const activity = async () =>
      (await t.db.select({ at: sessions.lastActivityAt }).from(sessions).where(eq(sessions.id, sid)))[0]!.at.getTime();
    const before = await activity();
    t.clock.advance(60_000);
    const background = await api.get("/admin/dashboard", { token: actor.token, headers: { "x-background-request": "1" } });
    expect(background.statusCode).toBe(200);
    expect(await activity()).toBe(before);
    await api.get("/admin/dashboard", { token: actor.token });
    expect(await activity()).toBe(t.clock.now().getTime());
    // Hanya polling latar selama 31 menit: sesi berakhir (idle 30 menit).
    t.clock.advance(31 * 60_000);
    const expired = await api.get("/admin/dashboard", { token: actor.token, headers: { "x-background-request": "1" } });
    expect(expired.statusCode).toBe(401);
    const again = await signInActor(t, actor.admin);
    expect((await api.get("/admin/dashboard", { token: again.token })).statusCode).toBe(200);
  });
});
