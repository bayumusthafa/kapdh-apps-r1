import { auditLogs, files, notifications, outboxEvents, paymentAdjustments, payments, tickets } from "@kapdh/database";
import { and, eq, like } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventsJobsService } from "../../src/modules/events/events-jobs.service.js";
import { expectOperation } from "../support/contract.js";
import { multipartBody, testJpeg } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  adminSession,
  type AdminSession,
  createCategory,
  createEventRow,
  DAY,
  decidePayment,
  eventRow,
  HOUR,
  insertTicket,
  type JsonBody,
  memberSession,
  paidTicket,
  reserve,
  submitProof,
  ticketRow,
} from "./support.js";

/**
 * Pengelolaan event oleh pengurus (kontrak admin-events.yaml; F-09, F-15, AC F09-7, F15-2, F15-4, F13-6, PRD 4.4, D6).
 */

let t: TestApp;
let manager: AdminSession;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

async function freshManager(permissions: AdminSession["permissions"] = ["events.manage"]) {
  manager = await adminSession(t, permissions);
  return manager;
}

function eventBody(overrides: Record<string, unknown> = {}) {
  const now = t.clock.now().getTime();
  return {
    title: "  Camping Alumni KAPDH  ",
    description: "Kemah bersama alumni.",
    location_name: "Bumi Perkemahan Cibubur",
    location_url: "https://maps.example.test/cibubur",
    starts_at: new Date(now + 20 * DAY).toISOString(),
    ends_at: new Date(now + 21 * DAY).toISOString(),
    registration_opens_at: new Date(now + HOUR).toISOString(),
    registration_closes_at: new Date(now + 19 * DAY).toISOString(),
    price: "150000.00",
    seats_total: 36,
    ...overrides,
  };
}

async function uploadCover(token: string) {
  const body = multipartBody([
    { name: "file", filename: "cover.jpg", contentType: "image/jpeg", data: await testJpeg() },
  ]);
  return t.app.inject({
    method: "POST",
    url: "/api/v1/admin/event-covers",
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${token}` },
  });
}

describe("Buat, ubah, hapus event (F-15, AC F15-2, F15-4)", () => {
  it("F-15: unggah cover (event_cover publik) lalu buat event draft dengan kategori aktif; audit event.created", async () => {
    await freshManager();
    const cover = await uploadCover(manager.token);
    const media = expectOperation("post", "/admin/event-covers", cover) as JsonBody;
    expect(cover.statusCode).toBe(201);
    expect(media).toMatchObject({ mime: "image/jpeg", url: expect.stringContaining(`/files/public/${media.file_id}`) });
    const category = await createCategory(t, { label: "Kemah" });
    const res = await api().post(
      "/admin/events",
      eventBody({ category_id: category.id, cover_file_id: media.file_id }),
      { token: manager.token },
    );
    const event = expectOperation("post", "/admin/events", res) as JsonBody;
    expect(res.statusCode).toBe(201);
    expect(event).toMatchObject({
      title: "Camping Alumni KAPDH",
      status: "draft",
      timezone: "Asia/Jakarta",
      category: { id: category.id },
      cover_file_id: media.file_id,
      cover_url: media.url,
      seats_available: 36,
      held_quantity: 0,
      paid_quantity: 0,
      has_tickets: false,
      min_seats_total: 1,
      checkin_opens_at: null,
      created_by: { admin_id: manager.adminId, display_name: "Pengurus Event Uji" },
      allowed_actions: ["edit", "publish", "delete"],
      version: "1",
    });
    expect(event.effective_checkin_opens_at).toBe(new Date(Date.parse(event.starts_at) - 2 * HOUR).toISOString());
    const [file] = await t.db.select().from(files).where(eq(files.id, media.file_id));
    expect(file!.attachedAt).not.toBeNull();
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, event.id), eq(auditLogs.action, "event.created")));
    expect(audit).toMatchObject({ actorAdminId: manager.adminId });
    // Draft tidak terlihat anggota.
    const member = await memberSession(t);
    expect((await api().get(`/events/${event.id}`, { token: member.token })).statusCode).toBe(404);
  });

  it("F-15: validasi server — jadwal, zona waktu, tautan https, kategori nonaktif, cover milik orang lain → 400 field_errors", async () => {
    await freshManager();
    const now = t.clock.now().getTime();
    const bad = await api().post(
      "/admin/events",
      eventBody({
        ends_at: new Date(now + 19 * DAY).toISOString(),
        registration_closes_at: new Date(now + 22 * DAY).toISOString(),
        timezone: "Mars/Olympus",
        checkin_opens_at: new Date(now + 20 * DAY).toISOString(),
      }),
      { token: manager.token },
    );
    const error = expectOperation("post", "/admin/events", bad) as JsonBody;
    expect(Object.keys(error.field_errors).sort()).toEqual([
      "checkin_closes_at",
      "ends_at",
      "registration_closes_at",
      "timezone",
    ]);
    const http = await api().post("/admin/events", eventBody({ location_url: "http://maps.test" }), {
      token: manager.token,
    });
    expect(http.json().field_errors.location_url).toBeDefined();
    const inactive = await createCategory(t, { active: false });
    const category = await api().post("/admin/events", eventBody({ category_id: inactive.id }), {
      token: manager.token,
    });
    expect(category.json().field_errors.category_id).toBeDefined();
    const other = await adminSession(t, ["events.manage"]);
    const cover = (await uploadCover(other.token)).json();
    const foreign = await api().post("/admin/events", eventBody({ cover_file_id: cover.file_id }), {
      token: manager.token,
    });
    expect(foreign.json().field_errors.cover_file_id).toBeDefined();
    const empty = await api().patch(`/admin/events/${uuidv7()}`, {}, { token: manager.token, headers: { "if-match": "1" } });
    expect(empty.statusCode).toBe(400);
  });

  it("AC F15-4, PRD 4.4: ubah dengan If-Match; versi usang 409 dengan current; harga baru tidak mengubah tiket/payment yang sudah dibuat", async () => {
    await freshManager();
    const event = await createEventRow(t, { price: "75000.00" });
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    const res = await api().patch(
      `/admin/events/${event.id}`,
      { price: "90000.00", title: "Reuni Akbar 2026", description: null },
      { token: manager.token, headers: { "if-match": "1" } },
    );
    const updated = expectOperation("patch", "/admin/events/{eventId}", res) as JsonBody;
    expect(updated).toMatchObject({ price: "90000.00", title: "Reuni Akbar 2026", description: null, version: "2" });
    expect((await ticketRow(t, ticket.id)).totalSnapshot).toBe("75000.00");
    const [payment] = await t.db.select().from(payments).where(eq(payments.ticketId, ticket.id));
    expect(payment!.amount).toBe("75000.00");
    const stale = await api().patch(
      `/admin/events/${event.id}`,
      { title: "Bentrok" },
      { token: manager.token, headers: { "if-match": "1" } },
    );
    expect(expectOperation("patch", "/admin/events/{eventId}", stale)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { id: event.id, version: "2", title: "Reuni Akbar 2026" },
    });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, event.id), eq(auditLogs.action, "event.updated")));
    expect(audit!.before).toMatchObject({ price: "75000.00", title: "Reuni Akbar Uji", version: 1 });
    expect(audit!.after).toMatchObject({ price: "90000.00", version: 2 });
  });

  it("AC F15-2: kuota tidak boleh di bawah held + paid (409 VALIDATION_ERROR dengan current); hold kedaluwarsa dilepas lebih dahulu", async () => {
    await freshManager();
    const event = await createEventRow(t, { seatsTotal: 5, price: "0.00" });
    await reserve(t, await memberSession(t), event);
    await reserve(t, await memberSession(t), event);
    const lapsed = await insertTicket(t, {
      eventId: event.id,
      userId: (await memberSession(t)).userId,
      status: "awaiting_payment",
      total: "0.00",
      holdExpiresAt: new Date(t.clock.now().getTime() - 1000),
    });
    const detail = (await api().get(`/admin/events/${event.id}`, { token: manager.token })).json();
    expect(detail).toMatchObject({ held_quantity: 0, paid_quantity: 2, min_seats_total: 2, seats_available: 3 });
    const below = await api().patch(
      `/admin/events/${event.id}`,
      { seats_total: 1 },
      { token: manager.token, headers: { "if-match": detail.version } },
    );
    expect(expectOperation("patch", "/admin/events/{eventId}", below)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { seats_total: expect.any(Array) },
      current: { id: event.id, min_seats_total: 2 },
    });
    expect(below.statusCode).toBe(409);
    const ok = await api().patch(
      `/admin/events/${event.id}`,
      { seats_total: 2 },
      { token: manager.token, headers: { "if-match": detail.version } },
    );
    expect(ok.json()).toMatchObject({ seats_total: 2, seats_available: 0 });
    expect((await ticketRow(t, lapsed.id)).status).toBe("expired");
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 0, paidQuantity: 2 });
  });

  it("AC F15-2: event bertiket tidak dapat dihapus (409, gunakan pembatalan); tanpa tiket 204 dan cover dibuang; done/cancelled tidak dapat diubah", async () => {
    await freshManager();
    const withTickets = await createEventRow(t, { price: "0.00" });
    const member = await memberSession(t);
    const ticket = await reserve(t, member, withTickets);
    await api().post(`/me/tickets/${ticket.id}/cancel`, { expected_refund_eligible: false }, {
      token: member.token,
      headers: { "if-match": ticket.version },
    });
    const refused = await api().delete(`/admin/events/${withTickets.id}`, {
      token: manager.token,
      headers: { "if-match": "1" },
    });
    expect(expectOperation("delete", "/admin/events/{eventId}", refused)).toMatchObject({
      code: "VALIDATION_ERROR",
      current: { has_tickets: true },
    });
    expect(refused.statusCode).toBe(409);
    const list = (await api().get("/admin/events", { token: manager.token, query: { q: "Reuni" } })).json();
    expect(list.items.find((e: { id: string }) => e.id === withTickets.id)).toMatchObject({ has_tickets: true });

    const cover = (await uploadCover(manager.token)).json();
    const created = (await api().post("/admin/events", eventBody({ cover_file_id: cover.file_id }), { token: manager.token })).json();
    const removed = await api().delete(`/admin/events/${created.id}`, {
      token: manager.token,
      headers: { "if-match": created.version },
    });
    expect(removed.statusCode).toBe(204);
    expect((await api().get(`/admin/events/${created.id}`, { token: manager.token })).statusCode).toBe(404);
    const [file] = await t.db.select().from(files).where(eq(files.id, cover.file_id));
    expect(file!.status).toBe("deleted");

    for (const status of ["done", "cancelled"] as const) {
      const event = await createEventRow(t, { status });
      const res = await api().patch(`/admin/events/${event.id}`, { title: "Ubah" }, {
        token: manager.token,
        headers: { "if-match": "1" },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("Status event (PRD 4.4)", () => {
  it("PRD 4.4: draft → open → closed → open; status sama 200 tanpa audit sebelum If-Match; transisi ilegal 400; replay key", async () => {
    await freshManager();
    const created = (await api().post("/admin/events", eventBody(), { token: manager.token })).json();
    const set = (status: string, version: string, key?: string) =>
      api().post(`/admin/events/${created.id}/status`, { status }, {
        token: manager.token,
        headers: { "if-match": version, ...(key ? { "idempotency-key": key } : {}) },
      });
    const close = await set("closed", "1");
    expect(expectOperation("post", "/admin/events/{eventId}/status", close)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { status: expect.any(Array) },
    });
    const key = uuidv7();
    const published = await set("open", "1", key);
    expect(expectOperation("post", "/admin/events/{eventId}/status", published)).toMatchObject({
      status: "open",
      version: "2",
      allowed_actions: ["edit", "close", "cancel", "delete"],
    });
    const replay = await set("open", "1", key);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    // Status sama tanpa key yang sama: 200 tanpa VERSION_CONFLICT palsu.
    const same = await set("open", "1");
    expect(same.statusCode).toBe(200);
    expect(same.json().version).toBe("2");
    const closed = await set("closed", "2");
    expect(closed.json()).toMatchObject({ status: "closed", allowed_actions: ["edit", "reopen", "cancel", "delete"] });
    const stale = await set("open", "2");
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT", current: { version: "3" } });
    expect((await set("open", "3")).json().status).toBe("open");
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.id), eq(auditLogs.action, "event.status_changed")));
    expect(audits).toHaveLength(3);
    // Member melihat event yang sudah terbit.
    const member = await memberSession(t);
    expect((await api().get(`/events/${created.id}`, { token: member.token })).statusCode).toBe(200);
    // Buka kembali sesudah batas tutup daftar ditolak.
    const past = await createEventRow(t, { status: "closed", startsInMs: 2 * HOUR, registrationClosesBeforeStartMs: 3 * HOUR });
    const reopen = await api().post(`/admin/events/${past.id}/status`, { status: "open" }, {
      token: manager.token,
      headers: { "if-match": "1" },
    });
    expect(reopen.statusCode).toBe(400);
  });
});

describe("Pembatalan event (AC F09-7, D6)", () => {
  it("AC F09-7: seluruh tiket aktif dibatalkan, QR tidak berlaku, refund penuh untuk paid berbayar, payment berbukti tetap di antrean, penghitung 0, histori tetap, notifikasi peserta lewat outbox", async () => {
    await freshManager();
    const treasurer = await adminSession(t, ["payments.read", "payments.decide"]);
    const event = await createEventRow(t, { seatsTotal: 10 });
    const paidMember = await memberSession(t);
    const paid = await paidTicket(t, paidMember, event, treasurer);
    const reviewMember = await memberSession(t);
    const inReview = await reserve(t, reviewMember, event);
    await submitProof(t, reviewMember, inReview.payment.id);
    const holdMember = await memberSession(t);
    const held = await reserve(t, holdMember, event);
    const lapsed = await insertTicket(t, {
      eventId: event.id,
      userId: (await memberSession(t)).userId,
      status: "awaiting_payment",
      total: "75000.00",
      holdExpiresAt: new Date(t.clock.now().getTime() - 1000),
    });
    const checker = await adminSession(t, ["events.checkin"]);
    const detail = (await api().get(`/admin/events/${event.id}`, { token: manager.token })).json();
    const res = await api().post(
      `/admin/events/${event.id}/cancel`,
      { reason: "Cuaca ekstrem di lokasi" },
      { token: manager.token, headers: { "if-match": detail.version } },
    );
    const result = expectOperation("post", "/admin/events/{eventId}/cancel", res) as JsonBody;
    expect(result).toMatchObject({
      tickets_cancelled: 3,
      payments_cancelled: 1,
      payments_in_review: 1,
      refunds_created: 1,
      refund_total: "75000.00",
      event: {
        status: "cancelled",
        cancel_reason: "Cuaca ekstrem di lokasi",
        held_quantity: 0,
        paid_quantity: 0,
        allowed_actions: [],
      },
    });
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 0, paidQuantity: 0, status: "cancelled" });
    expect(await ticketRow(t, paid.id)).toMatchObject({ status: "cancelled", cancelledBy: "system" });
    expect(await ticketRow(t, inReview.id)).toMatchObject({ status: "cancelled", cancelledBy: "system" });
    expect(await ticketRow(t, held.id)).toMatchObject({ status: "cancelled", cancelledBy: "admin" });
    expect((await ticketRow(t, lapsed.id)).status).toBe("expired");
    const [paidPayment] = await t.db.select().from(payments).where(eq(payments.ticketId, paid.id));
    expect(paidPayment!.status).toBe("paid");
    const [refund] = await t.db
      .select()
      .from(paymentAdjustments)
      .where(eq(paymentAdjustments.paymentId, paidPayment!.id));
    expect(refund).toMatchObject({ kind: "refund", status: "pending", amount: "75000.00" });
    const [reviewPayment] = await t.db.select().from(payments).where(eq(payments.ticketId, inReview.id));
    expect(reviewPayment!.status).toBe("pending");
    // QR seluruh tiket tidak berlaku (detail anggota dan check-in).
    const mine = (await api().get(`/me/tickets/${paid.id}`, { token: paidMember.token })).json();
    expect(mine).toMatchObject({ status: "cancelled", qr_code: null, refunds: [{ status: "pending" }] });
    const scan = await api().post("/admin/checkin", { event_id: event.id, qr_code: paid.qr_code }, { token: checker.token });
    expect(scan.json()).toMatchObject({ code: "VALIDATION_ERROR", current: { rejection_reason: "event_cancelled" } });
    // Outbox + fanout notifikasi (idempoten bila diulang).
    const [outbox] = await t.db.select().from(outboxEvents).where(eq(outboxEvents.dedupKey, `event.cancelled:${event.id}`));
    expect(outbox).toBeDefined();
    await t.jobs.drainOutbox();
    await t.app.get(EventsJobsService).fanoutCancellation(event.id);
    const notes = await t.db
      .select()
      .from(notifications)
      .where(like(notifications.dedupKey, `%event.cancelled:${event.id}`));
    expect(notes.map((n) => n.userId).sort()).toEqual(
      [paidMember.userId, reviewMember.userId, holdMember.userId].sort(),
    );
    expect(notes.every((n) => n.category === "event")).toBe(true);
    // Approve payment berbukti sesudah event dibatalkan → paid + refund sistem, tiket tetap cancelled (D6).
    const approve = await decidePayment(t, treasurer, inReview.payment.id, "approve");
    expect(approve.json()).toMatchObject({ status: "paid", adjustments: [{ kind: "refund", status: "pending" }] });
    expect((await ticketRow(t, inReview.id)).status).toBe("cancelled");
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 0, paidQuantity: 0 });
    // Event cancelled tidak dapat dibatalkan lagi; histori tetap dapat dibaca.
    const again = await api().post(`/admin/events/${event.id}/cancel`, { reason: "Ulang" }, {
      token: manager.token,
      headers: { "if-match": result.event.version },
    });
    expect(again.statusCode).toBe(400);
    expect(await t.db.select().from(tickets).where(eq(tickets.eventId, event.id))).toHaveLength(4);
    const audit = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, event.id), eq(auditLogs.action, "event.cancelled")));
    expect(audit).toHaveLength(1);
  });
});

describe("Statistik dan tiket event (F-15, PRD 1.6)", () => {
  it("PRD 1.6: statistik kursi, check-in, pendapatan kotor/bersih dan refund", async () => {
    await freshManager();
    const treasurer = await adminSession(t, ["payments.read", "payments.decide"]);
    const event = await createEventRow(t, { price: "50000.00" });
    const a = await memberSession(t);
    const b = await memberSession(t);
    const ticketA = await paidTicket(t, a, event, treasurer);
    await paidTicket(t, b, event, treasurer);
    await reserve(t, await memberSession(t), event);
    await api().post(`/me/tickets/${ticketA.id}/cancel`, { expected_refund_eligible: true }, {
      token: a.token,
      headers: { "if-match": ticketA.version },
    });
    const res = await api().get(`/admin/events/${event.id}/stats`, { token: manager.token });
    expect(expectOperation("get", "/admin/events/{eventId}/stats", res)).toMatchObject({
      event_id: event.id,
      seats_total: 10,
      seats_available: 8,
      awaiting_payment_count: 1,
      awaiting_review_count: 0,
      paid_count: 1,
      checked_in_count: 0,
      expired_count: 0,
      cancelled_count: 1,
      gross_revenue: "100000.00",
      refunds_pending_amount: "50000.00",
      refunds_completed_amount: "0.00",
      net_revenue: "100000.00",
    });
    expect((await api().get(`/admin/events/${uuidv7()}/stats`, { token: manager.token })).statusCode).toBe(404);
  });

  it("F-15: tabel tiket dengan filter status (proyeksi), check-in, kata kunci, urutan, total; pemegang terhapus anonim; can_refund", async () => {
    await freshManager();
    const event = await createEventRow(t, { price: "0.00" });
    const siti = await memberSession(t, "verified", { fullName: "Siti Aminah" });
    const budi = await memberSession(t, "verified", { fullName: "Budi Santoso" });
    const ticketSiti = await reserve(t, siti, event);
    await reserve(t, budi, event);
    const anonymous = await insertTicket(t, { eventId: event.id, userId: null, status: "paid" });
    await insertTicket(t, {
      eventId: event.id,
      userId: (await memberSession(t)).userId,
      status: "awaiting_payment",
      holdExpiresAt: new Date(t.clock.now().getTime() - 1000),
    });
    const res = await api().get(`/admin/events/${event.id}/tickets`, { token: manager.token });
    const page = expectOperation("get", "/admin/events/{eventId}/tickets", res) as JsonBody;
    expect(page.total).toBe(4);
    const anon = page.items.find((x: { id: string }) => x.id === anonymous.id);
    expect(anon).toMatchObject({
      holder: { user_id: null, full_name: null, member_number: null },
      holder_eligible: false,
    });
    const sitiRow = page.items.find((x: { id: string }) => x.id === ticketSiti.id);
    expect(sitiRow).toMatchObject({
      status: "paid",
      holder: { user_id: siti.userId, full_name: "Siti Aminah", member_number: siti.memberNumber, cohort_code: "KAPDH 29" },
      holder_eligible: true,
      payment: null,
      refunds: [],
      can_refund: false,
      review_overdue: false,
    });
    const expired = (await api().get(`/admin/events/${event.id}/tickets`, { token: manager.token, query: { status: "expired" } })).json();
    expect(expired.total).toBe(1);
    const byName = (await api().get(`/admin/events/${event.id}/tickets`, { token: manager.token, query: { q: "siti" } })).json();
    expect(byName.items.map((x: { id: string }) => x.id)).toEqual([ticketSiti.id]);
    const byNumber = (
      await api().get(`/admin/events/${event.id}/tickets`, { token: manager.token, query: { q: siti.memberNumber! } })
    ).json();
    expect(byNumber.total).toBe(1);
    const sorted = (
      await api().get(`/admin/events/${event.id}/tickets`, { token: manager.token, query: { sort: "holder_name_asc", limit: "2" } })
    ).json();
    const rest = (
      await api().get(`/admin/events/${event.id}/tickets`, {
        token: manager.token,
        query: { sort: "holder_name_asc", limit: "2", cursor: sorted.next_cursor },
      })
    ).json();
    const order = [...sorted.items, ...rest.items].map((x: { holder: { full_name: string | null } }) => x.holder.full_name);
    expect(order.slice(0, 2)).toEqual([null, "Alumni Uji"]);
    expect(order.slice(2)).toEqual(["Budi Santoso", "Siti Aminah"]);
    const notChecked = (
      await api().get(`/admin/events/${event.id}/tickets`, { token: manager.token, query: { checked_in: "true" } })
    ).json();
    expect(notChecked.total).toBe(0);
  });
});

describe("Pembatalan tiket oleh pengurus (D6, PRD 2.2, 2.3)", () => {
  it("PRD 2.3: refund=true tanpa payments.decide → 403; tiket akun alumni tertaut pemanggil → 403; keduanya sebelum perubahan", async () => {
    const treasurer = await adminSession(t, ["payments.read", "payments.decide"]);
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const ticket = await paidTicket(t, member, event, treasurer);
    await freshManager(["events.manage"]);
    const list = (await api().get(`/admin/events/${event.id}/tickets`, { token: manager.token })).json();
    expect(list.items[0]).toMatchObject({ can_refund: false });
    const noPermission = await api().post(
      `/admin/events/${event.id}/tickets/${ticket.id}/cancel`,
      { reason: "Anggota disuspend", refund: true },
      { token: manager.token, headers: { "if-match": ticket.version } },
    );
    expect(expectOperation("post", "/admin/events/{eventId}/tickets/{ticketId}/cancel", noPermission)).toMatchObject({
      code: "FORBIDDEN",
    });
    const linked = await adminSession(t, ["events.manage", "payments.decide"], { linkedAlumniUserId: member.userId });
    const own = await api().post(
      `/admin/events/${event.id}/tickets/${ticket.id}/cancel`,
      { reason: "Konflik", refund: true },
      { token: linked.token, headers: { "if-match": ticket.version } },
    );
    expect(own.json().code).toBe("FORBIDDEN");
    const linkedList = (await api().get(`/admin/events/${event.id}/tickets`, { token: linked.token })).json();
    expect(linkedList.items[0].can_refund).toBe(false);
    expect((await ticketRow(t, ticket.id)).status).toBe("paid");
  });

  it("D6, PRD 2.2: pengurus berwenang membatalkan tiket paid dengan refund (dicatat atas nama pengurus) dan notifikasi pemegang", async () => {
    const treasurer = await adminSession(t, ["payments.read", "payments.decide"]);
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const ticket = await paidTicket(t, member, event, treasurer);
    const decider = await adminSession(t, ["events.manage", "payments.decide"], { displayName: "Bendahara Event" });
    const list = (await api().get(`/admin/events/${event.id}/tickets`, { token: decider.token })).json();
    expect(list.items[0]).toMatchObject({ can_refund: true, payment: { status: "paid" } });
    const res = await api().post(
      `/admin/events/${event.id}/tickets/${ticket.id}/cancel`,
      { reason: "Anggota disuspend pengurus", refund: true },
      { token: decider.token, headers: { "if-match": ticket.version } },
    );
    const body = expectOperation("post", "/admin/events/{eventId}/tickets/{ticketId}/cancel", res) as JsonBody;
    expect(body).toMatchObject({
      status: "cancelled",
      cancelled_by: "admin",
      cancel_reason: "Anggota disuspend pengurus",
      refunds: [{ status: "pending", amount: "75000.00" }],
      can_refund: false,
    });
    const [payment] = await t.db.select().from(payments).where(eq(payments.ticketId, ticket.id));
    const [refund] = await t.db.select().from(paymentAdjustments).where(eq(paymentAdjustments.paymentId, payment!.id));
    expect(refund!.createdByAdminId).toBe(decider.adminId);
    expect((await eventRow(t, event.id)).paidQuantity).toBe(0);
    const [note] = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, `u:${member.userId}:ticket.cancelled:${ticket.id}`));
    expect(note).toMatchObject({ category: "event" });
    expect((note!.data as { route: string }).route).toBe(`/tickets/${ticket.id}`);
  });

  it("PRD 4.4: awaiting_review → 409 PAYMENT_STATE_CONFLICT; refund=true untuk tiket belum lunas → 400; awaiting_payment dibatalkan tanpa refund", async () => {
    await freshManager(["events.manage", "payments.decide"]);
    const event = await createEventRow(t);
    const reviewer = await memberSession(t);
    const review = await reserve(t, reviewer, event);
    await submitProof(t, reviewer, review.payment.id);
    const current = (await api().get(`/me/tickets/${review.id}`, { token: reviewer.token })).json();
    const conflict = await api().post(
      `/admin/events/${event.id}/tickets/${review.id}/cancel`,
      { reason: "Uji", refund: false },
      { token: manager.token, headers: { "if-match": current.version } },
    );
    expect(conflict.json()).toMatchObject({ code: "PAYMENT_STATE_CONFLICT", current: { status: "awaiting_review" } });
    const holder = await memberSession(t);
    const held = await reserve(t, holder, event);
    const refundUnpaid = await api().post(
      `/admin/events/${event.id}/tickets/${held.id}/cancel`,
      { reason: "Uji", refund: true },
      { token: manager.token, headers: { "if-match": held.version } },
    );
    expect(refundUnpaid.statusCode).toBe(400);
    const ok = await api().post(
      `/admin/events/${event.id}/tickets/${held.id}/cancel`,
      { reason: "Reservasi tidak valid", refund: false },
      { token: manager.token, headers: { "if-match": held.version } },
    );
    expect(ok.json()).toMatchObject({ status: "cancelled", payment: { status: "cancelled" } });
    const wrongEvent = await api().post(
      `/admin/events/${uuidv7()}/tickets/${held.id}/cancel`,
      { reason: "Uji", refund: false },
      { token: manager.token, headers: { "if-match": "1" } },
    );
    expect(wrongEvent.statusCode).toBe(404);
  });
});

describe("Daftar event pengurus dan kategori (guideline p14)", () => {
  it("F-15: filter status/kategori/kata kunci, urutan dan paging dengan total; kategori event aktif dan nonaktif", async () => {
    await freshManager();
    const category = await createCategory(t, { label: "Seminar" });
    const tag = `Seminar-${uuidv7().slice(-6)}`;
    const a = await createEventRow(t, { title: `${tag} A`, startsInMs: 5 * DAY, categoryId: category.id });
    const b = await createEventRow(t, { title: `${tag} B`, startsInMs: 15 * DAY, status: "draft" });
    const c = await createEventRow(t, { title: `${tag} C`, startsInMs: 25 * DAY });
    const page1 = (await api().get("/admin/events", { token: manager.token, query: { q: tag, limit: "2" } })).json();
    expect(page1.total).toBe(3);
    expect(page1.items.map((e: { id: string }) => e.id)).toEqual([c.id, b.id]);
    const page2 = expectOperation(
      "get",
      "/admin/events",
      await api().get("/admin/events", { token: manager.token, query: { q: tag, limit: "2", cursor: page1.next_cursor } }),
    ) as JsonBody;
    expect(page2.items.map((e: { id: string }) => e.id)).toEqual([a.id]);
    const titles = (await api().get("/admin/events", { token: manager.token, query: { q: tag, sort: "title_asc" } })).json();
    expect(titles.items.map((e: { id: string }) => e.id)).toEqual([a.id, b.id, c.id]);
    const drafts = (await api().get("/admin/events", { token: manager.token, query: { q: tag, status: "draft" } })).json();
    expect(drafts.items.map((e: { id: string }) => e.id)).toEqual([b.id]);
    const byCategory = (
      await api().get("/admin/events", { token: manager.token, query: { category_id: category.id } })
    ).json();
    expect(byCategory.items.map((e: { id: string }) => e.id)).toEqual([a.id]);
    const mismatch = await api().get("/admin/events", {
      token: manager.token,
      query: { q: tag, sort: "title_asc", cursor: page1.next_cursor },
    });
    expect(mismatch.statusCode).toBe(400);
    await createCategory(t, { label: "Arsip", active: false });
    const cats = expectOperation(
      "get",
      "/admin/event-categories",
      await api().get("/admin/event-categories", { token: manager.token }),
    ) as JsonBody;
    expect(cats.items.some((x: { label: string; active: boolean }) => x.label === "Arsip" && !x.active)).toBe(true);
    expect(cats.items.every((x: { label: string }) => x.label !== "Berita")).toBe(true);
  });
});
