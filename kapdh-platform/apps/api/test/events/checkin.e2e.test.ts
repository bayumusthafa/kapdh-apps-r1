import { alumni, auditLogs, tickets, users } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  adminSession,
  type AdminSession,
  createEventRow,
  DAY,
  HOUR,
  insertTicket,
  type JsonBody,
  memberSession,
  reserve,
  submitProof,
  ticketRow,
} from "./support.js";

/** Check-in QR tiket oleh petugas events.checkin (kontrak adminCheckInTicket; AC F09-5, F09-6, D5, PRD 2.2, 4.5). */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

/** Event yang jendela check-in bawaannya sedang terbuka (mulai 1 jam lagi; D5: dibuka 2 jam sebelum). */
async function liveEvent(options: Parameters<typeof createEventRow>[1] = {}) {
  return createEventRow(t, {
    price: "0.00",
    startsInMs: HOUR,
    registrationClosesBeforeStartMs: 30 * 60_000,
    ...options,
  });
}

async function officer(name = "Petugas Gerbang"): Promise<AdminSession> {
  return adminSession(t, ["events.checkin"], { displayName: name });
}

function scan(admin: AdminSession, eventId: string, qr: string, headers: Record<string, string> = {}) {
  return api().post("/admin/checkin", { event_id: eventId, qr_code: qr }, { token: admin.token, headers });
}

describe("adminCheckInTicket (AC F09-5)", () => {
  it("AC F09-5: tiket paid dalam jendela tercatat sekali beserta petugas dan audit; scan kedua 'Sudah check-in' dengan waktu dan petugas sebelumnya tanpa menambah hitungan", async () => {
    const event = await liveEvent();
    const member = await memberSession(t, "verified", { fullName: "Rahmat Hadir" });
    const ticket = await reserve(t, member, event);
    const gate = await officer();
    const res = await scan(gate, event.id, ticket.qr_code);
    const body = expectOperation("post", "/admin/checkin", res) as JsonBody;
    expect(body).toMatchObject({
      checked_in_at: t.clock.now().toISOString(),
      checked_in_by: { admin_id: gate.adminId, display_name: "Petugas Gerbang" },
      event_checked_in_count: 1,
      event_paid_count: 1,
      ticket: {
        ticket_id: ticket.id,
        status: "paid",
        event: { id: event.id },
        holder: { full_name: "Rahmat Hadir", member_number: member.memberNumber, cohort_code: "KAPDH 29" },
      },
    });
    expect(await ticketRow(t, ticket.id)).toMatchObject({ checkedInByAdminId: gate.adminId });
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ticket.id), eq(auditLogs.action, "ticket.checked_in")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorAdminId: gate.adminId });

    t.clock.advance(5 * 60_000);
    const second = await officer("Petugas Kedua");
    const again = await scan(second, event.id, ticket.qr_code);
    const error = expectOperation("post", "/admin/checkin", again) as JsonBody;
    expect(error).toMatchObject({
      code: "TICKET_ALREADY_CHECKED_IN",
      current: {
        rejection_reason: "already_checked_in",
        ticket: {
          checked_in_at: body.checked_in_at,
          checked_in_by: { admin_id: gate.adminId, display_name: "Petugas Gerbang" },
        },
      },
    });
    expect(error.message).toMatch(/Sudah check-in/);
    expect(error.message).toMatch(/Petugas Gerbang/);
    expect((await ticketRow(t, ticket.id)).checkedInAt!.toISOString()).toBe(body.checked_in_at);
    expect(
      await t.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, ticket.id), eq(auditLogs.action, "ticket.checked_in"))),
    ).toHaveLength(1);
    // Petugas tidak memiliki izin tiket lain: halaman daftar pemindaian menampilkan hitungan terbaru.
    const list = expectOperation(
      "get",
      "/admin/checkin/events",
      await api().get("/admin/checkin/events", { token: second.token }),
    ) as JsonBody;
    expect(list.items.find((e: { id: string }) => e.id === event.id)).toMatchObject({
      checkin_open: true,
      paid_count: 1,
      checked_in_count: 1,
    });
  });

  it("PRD 4.3: Idempotency-Key sama mengembalikan hasil sukses pertama", async () => {
    const event = await liveEvent();
    const ticket = await reserve(t, await memberSession(t), event);
    const gate = await officer();
    const key = uuidv7();
    const first = await scan(gate, event.id, ticket.qr_code, { "idempotency-key": key });
    const replay = await scan(gate, event.id, ticket.qr_code, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json().checked_in_at).toBe(first.json().checked_in_at);
  });

  it("PRD 2.2: anggota expired dengan tiket paid tetap check-in; pemegang suspended ditolak holder_ineligible tanpa alasan privat", async () => {
    const event = await liveEvent({ seatsTotal: 5 });
    const gate = await officer();
    const expired = await memberSession(t, "expired", { fullName: "Anggota Kedaluwarsa" });
    const expiredTicket = await insertTicket(t, {
      eventId: event.id,
      userId: expired.userId,
      status: "paid",
    });
    const ok = await scan(gate, event.id, expiredTicket.qrCode!);
    expect(ok.statusCode, ok.body).toBe(200);
    const suspended = await memberSession(t, "suspended");
    const suspendedTicket = await insertTicket(t, {
      eventId: event.id,
      userId: suspended.userId,
      status: "paid",
    });
    const denied = await scan(gate, event.id, suspendedTicket.qrCode!);
    const body = expectOperation("post", "/admin/checkin", denied) as JsonBody;
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      current: { rejection_reason: "holder_ineligible" },
    });
    expect(JSON.stringify(body)).not.toMatch(/Pelanggaran/);
    const disabled = await memberSession(t);
    const disabledTicket = await insertTicket(t, {
      eventId: event.id,
      userId: disabled.userId,
      status: "paid",
    });
    await t.db.update(users).set({ status: "disabled" }).where(eq(users.id, disabled.userId));
    expect((await scan(gate, event.id, disabledTicket.qrCode!)).json().current.rejection_reason).toBe(
      "holder_ineligible",
    );
    const deletedTicket = await insertTicket(t, { eventId: event.id, userId: null, status: "paid" });
    const deleted = (await scan(gate, event.id, deletedTicket.qrCode!)).json();
    expect(deleted).toMatchObject({
      current: { rejection_reason: "holder_ineligible", ticket: { holder: { full_name: null } } },
    });
    expect(
      (await t.db.select().from(alumni).where(eq(alumni.userId, suspended.userId)))[0]!.suspendedAt,
    ).not.toBeNull();
  });
});

describe("Penolakan check-in yang dapat ditindaklanjuti (AC F09-6)", () => {
  it("AC F09-6: QR event lain, menunggu pembayaran/review, expired (termasuk hold lewat), cancelled, tidak dikenal", async () => {
    const event = await liveEvent({ price: "75000.00", seatsTotal: 10 });
    const other = await liveEvent({ title: "Event Lain Uji" });
    const gate = await officer();
    const otherTicket = await reserve(t, await memberSession(t), other);
    const wrong = await scan(gate, event.id, otherTicket.qr_code);
    const wrongBody = expectOperation("post", "/admin/checkin", wrong) as JsonBody;
    expect(wrongBody).toMatchObject({
      code: "VALIDATION_ERROR",
      current: {
        rejection_reason: "other_event",
        ticket: { event: { id: other.id, title: "Event Lain Uji" } },
      },
    });
    expect(wrongBody.message).toMatch(/Event Lain Uji/);
    const reasons: [string, string, string][] = [];
    for (const status of ["awaiting_payment", "awaiting_review", "expired", "cancelled"] as const) {
      const row = await insertTicket(t, {
        eventId: event.id,
        userId: (await memberSession(t)).userId,
        status,
        total: "75000.00",
      });
      // Tiket non-paid tidak memiliki QR; QR disisipkan agar pemindaian dapat menguji alasannya.
      const qr = uuidv7().replace(/-/g, "");
      await t.db.update(tickets).set({ qrCode: qr }).where(eq(tickets.id, row.id));
      const res = (await scan(gate, event.id, qr)).json();
      reasons.push([status, res.code, res.current.rejection_reason]);
    }
    expect(reasons).toEqual([
      ["awaiting_payment", "PAYMENT_STATE_CONFLICT", "ticket_awaiting_payment"],
      ["awaiting_review", "PAYMENT_STATE_CONFLICT", "ticket_awaiting_review"],
      ["expired", "RESERVATION_EXPIRED", "ticket_expired"],
      ["cancelled", "VALIDATION_ERROR", "ticket_cancelled"],
    ]);
    const unknown = await scan(gate, event.id, "bukan-qr-kapdh");
    expect(expectOperation("post", "/admin/checkin", unknown)).toMatchObject({ code: "NOT_FOUND" });
    const noEvent = await scan(gate, uuidv7(), otherTicket.qr_code);
    expect(noEvent.statusCode).toBe(404);
    const invalid = await api().post("/admin/checkin", { event_id: "x", qr_code: "" }, { token: gate.token });
    expect(expectOperation("post", "/admin/checkin", invalid)).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("D5: di luar jendela (terlalu awal / sesudah selesai) ditolak dengan jendela efektif; override jendela event dihormati", async () => {
    const gate = await officer();
    const early = await createEventRow(t, {
      price: "0.00",
      startsInMs: 5 * HOUR,
      registrationClosesBeforeStartMs: HOUR,
    });
    const ticket = await reserve(t, await memberSession(t), early);
    const tooEarly = (await scan(gate, early.id, ticket.qr_code)).json();
    expect(tooEarly).toMatchObject({
      code: "VALIDATION_ERROR",
      current: {
        rejection_reason: "too_early",
        checkin_opens_at: new Date(early.startsAt.getTime() - 2 * HOUR).toISOString(),
        checkin_closes_at: early.endsAt.toISOString(),
      },
    });
    const custom = await createEventRow(t, {
      price: "0.00",
      startsInMs: 5 * HOUR,
      registrationClosesBeforeStartMs: HOUR,
      checkinOpensAt: new Date(t.clock.now().getTime() - HOUR),
      checkinClosesAt: new Date(t.clock.now().getTime() + HOUR),
    });
    const customTicket = await reserve(t, await memberSession(t), custom);
    expect((await scan(gate, custom.id, customTicket.qr_code)).statusCode).toBe(200);
    t.clock.advance(5 * HOUR + 4 * HOUR + 1000);
    const lateGate = await officer();
    const tooLate = (await scan(lateGate, early.id, ticket.qr_code)).json();
    expect(tooLate.current.rejection_reason).toBe("too_late");
    t.clock.advance(-(9 * HOUR + 1000));
  });

  it("AC F09-6, D5: tiket berbukti yang belum diputus belum memiliki QR; daftar pemindaian hanya event yang check-in-nya dibuka <= 24 jam", async () => {
    const event = await liveEvent({ price: "75000.00", seatsTotal: 5 });
    const gate = await officer();
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    await submitProof(t, member, ticket.payment.id);
    expect((await ticketRow(t, ticket.id)).status).toBe("awaiting_review");
    expect((await ticketRow(t, ticket.id)).qrCode).toBeNull();
    const list = (await api().get("/admin/checkin/events", { token: gate.token })).json();
    expect(list.items.some((e: { id: string }) => e.id === event.id)).toBe(true);
    // Event yang check-in-nya dibuka > 24 jam lagi tidak ditampilkan.
    const far = await createEventRow(t, { startsInMs: 5 * DAY });
    const later = (await api().get("/admin/checkin/events", { token: gate.token })).json();
    expect(later.items.some((e: { id: string }) => e.id === far.id)).toBe(false);
  });

  it("D5, AC F09-6: override check-in yang ditutup sesudah acara selesai ditolak saat dibuat/diubah; baris lama dipotong di ends_at sehingga jendela yang ditampilkan sama dengan yang ditegakkan", async () => {
    const manager = await adminSession(t, ["events.manage"]);
    const now = t.clock.now().getTime();
    const startsAt = now + 10 * DAY;
    const body = {
      title: "Kajian Malam Uji",
      starts_at: new Date(startsAt).toISOString(),
      ends_at: new Date(startsAt + 2 * HOUR).toISOString(),
      registration_opens_at: new Date(now + HOUR).toISOString(),
      registration_closes_at: new Date(now + 9 * DAY).toISOString(),
      checkin_opens_at: new Date(startsAt - HOUR).toISOString(),
      price: "0.00",
      seats_total: 20,
    };
    const tooLate = await api().post(
      "/admin/events",
      { ...body, checkin_closes_at: new Date(startsAt + 4 * HOUR).toISOString() },
      { token: manager.token },
    );
    const error = expectOperation("post", "/admin/events", tooLate) as JsonBody;
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(error.field_errors)).toEqual(["checkin_closes_at"]);
    // Tepat saat acara selesai masih boleh; memajukan ends_at sebelum tutup check-in tersimpan ditolak.
    const exact = await api().post(
      "/admin/events",
      { ...body, checkin_closes_at: body.ends_at },
      { token: manager.token },
    );
    expect(exact.statusCode, exact.body).toBe(201);
    const created = exact.json();
    const shorten = await api().patch(
      `/admin/events/${created.id}`,
      { ends_at: new Date(startsAt + HOUR).toISOString() },
      { token: manager.token, headers: { "if-match": String(created.version) } },
    );
    expect(shorten.statusCode, shorten.body).toBe(400);
    expect(Object.keys(shorten.json().field_errors)).toEqual(["checkin_closes_at"]);

    // Baris lama dengan override sesudah ends_at: jendela efektif berhenti di ends_at di semua tampilan.
    const legacy = await liveEvent({
      checkinOpensAt: new Date(now - HOUR),
      checkinClosesAt: new Date(now + 7 * HOUR), // acara selesai now + 5 jam
    });
    const ends = legacy.endsAt.toISOString();
    const detail = (await api().get(`/admin/events/${legacy.id}`, { token: manager.token })).json();
    expect(detail).toMatchObject({ effective_checkin_closes_at: ends });
    const holder = await memberSession(t);
    const ticket = await reserve(t, holder, legacy);
    expect(ticket.checkin_closes_at).toBe(ends);
    const gate = await officer();
    const listed = (await api().get("/admin/checkin/events", { token: gate.token })).json();
    expect(listed.items.find((e: { id: string }) => e.id === legacy.id)).toMatchObject({
      checkin_closes_at: ends,
    });
    // Sesudah acara selesai, baik sebelum maupun sesudah events.lifecycle menandai done: too_late dengan jendela
    // yang sama dengan yang ditampilkan, dan event tidak lagi ada di daftar pemindaian.
    const shift = 5 * HOUR + 10 * 60_000;
    t.clock.advance(shift);
    const lateGate = await officer();
    const beforeJob = (await scan(lateGate, legacy.id, ticket.qr_code)).json();
    expect(beforeJob.current).toMatchObject({ rejection_reason: "too_late", checkin_closes_at: ends });
    const list = (await api().get("/admin/checkin/events", { token: lateGate.token })).json();
    expect(list.items.some((e: { id: string }) => e.id === legacy.id)).toBe(false);
    await t.jobs.runScheduled("events.lifecycle");
    const afterJob = (await scan(lateGate, legacy.id, ticket.qr_code)).json();
    expect(afterJob.current).toMatchObject({ rejection_reason: "too_late", checkin_closes_at: ends });
    t.clock.advance(-shift);
  });
});
