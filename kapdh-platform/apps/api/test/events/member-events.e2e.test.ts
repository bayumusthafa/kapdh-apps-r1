import { blocks } from "@kapdh/database";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  createCategory,
  createEventRow,
  DAY,
  HOUR,
  insertTicket,
  type JsonBody,
  memberSession,
  relogin,
  reserve,
} from "./support.js";

/**
 * Event dan tiket sisi anggota (kontrak events.yaml: listEventCategories, listEvents, getEvent, listEventParticipants,
 * listMyTickets, getMyTicket; F-09, PRD 2.2, 3.10, 4.4, D5, D6).
 */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

describe("Kategori dan daftar event (guideline p8)", () => {
  it("F-09: kategori event aktif saja, urut sort_order lalu label; kategori berita tidak ikut", async () => {
    await createCategory(t, { label: "Zakat", sortOrder: 2 });
    const first = await createCategory(t, { label: "Reuni", sortOrder: 1 });
    await createCategory(t, { label: "Nonaktif", active: false });
    await createCategory(t, { label: "Berita", kind: "post" });
    const member = await memberSession(t);
    const res = await api().get("/event-categories", { token: member.token });
    const body = expectOperation("get", "/event-categories", res) as JsonBody;
    const labels = body.items.map((item: { label: string }) => item.label);
    expect(labels).toContain("Reuni");
    expect(labels).not.toContain("Nonaktif");
    expect(labels).not.toContain("Berita");
    expect(labels.indexOf("Reuni")).toBeLessThan(labels.indexOf("Zakat"));
    expect(body.items.find((item: { id: string }) => item.id === first.id)).toEqual({
      id: first.id,
      slug: first.slug,
      label: "Reuni",
    });
  });

  it("F-09: mendatang urut mulai naik (draft tidak tampil, cancelled tetap tampil), lampau urut turun; filter kategori dan kata kunci; paging stabil", async () => {
    const category = await createCategory(t, { label: "Kajian" });
    const tag = `Kajian-${uuidv7().slice(-6)}`;
    const soon = await createEventRow(t, {
      title: `${tag} Pekan Ini`,
      startsInMs: 2 * DAY,
      categoryId: category.id,
    });
    const later = await createEventRow(t, {
      title: `${tag} Bulan Depan`,
      startsInMs: 30 * DAY,
      categoryId: category.id,
    });
    const cancelled = await createEventRow(t, {
      title: `${tag} Batal`,
      startsInMs: 5 * DAY,
      status: "cancelled",
    });
    await createEventRow(t, { title: `${tag} Draft`, status: "draft" });
    const done = await createEventRow(t, { title: `${tag} Lalu`, startsInMs: -5 * DAY, status: "done" });
    const member = await memberSession(t);
    const upcoming = expectOperation(
      "get",
      "/events",
      await api().get("/events", { token: member.token, query: { q: tag } }),
    ) as JsonBody;
    expect(upcoming.items.map((e: { id: string }) => e.id)).toEqual([soon.id, cancelled.id, later.id]);
    expect(upcoming.items[1]).toMatchObject({ registration_state: "cancelled", status: "cancelled" });
    expect(upcoming.items[0]).toMatchObject({
      category: { id: category.id, label: "Kajian" },
      price: "75000.00",
      is_free: false,
      seats_total: 10,
      seats_available: 10,
      registration_state: "open",
      my_ticket_status: null,
      cover_url: null,
      timezone: "Asia/Jakarta",
    });
    const past = (
      await api().get("/events", { token: member.token, query: { q: tag, period: "past" } })
    ).json();
    expect(past.items.map((e: { id: string }) => e.id)).toEqual([done.id]);
    const byCategory = (
      await api().get("/events", { token: member.token, query: { q: tag, category_id: category.id } })
    ).json();
    expect(byCategory.items.map((e: { id: string }) => e.id)).toEqual([soon.id, later.id]);
    // Paging keyset: dua halaman tanpa duplikasi; cursor periode lain ditolak.
    const page1 = (await api().get("/events", { token: member.token, query: { q: tag, limit: "2" } })).json();
    expect(page1.items).toHaveLength(2);
    const page2 = (
      await api().get("/events", {
        token: member.token,
        query: { q: tag, limit: "2", cursor: page1.next_cursor },
      })
    ).json();
    expect(page2.items.map((e: { id: string }) => e.id)).toEqual([later.id]);
    expect(page2.next_cursor).toBeNull();
    const mismatch = await api().get("/events", {
      token: member.token,
      query: { q: tag, period: "past", cursor: page1.next_cursor },
    });
    expect(expectOperation("get", "/events", mismatch)).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("F-09: label pendaftaran not_yet_open, closed, sold_out dihitung server; my_ticket_status memakai tiket terbaru", async () => {
    const member = await memberSession(t);
    const notYet = await createEventRow(t, { registrationOpensInMs: DAY });
    const closedByTime = await createEventRow(t, {
      startsInMs: 2 * HOUR,
      registrationClosesBeforeStartMs: 3 * HOUR,
    });
    const full = await createEventRow(t, { seatsTotal: 1, price: "0.00" });
    await reserve(t, await memberSession(t), full);
    const mine = await createEventRow(t);
    await reserve(t, member, mine);
    const states = async (id: string) => (await api().get(`/events/${id}`, { token: member.token })).json();
    expect(await states(notYet.id)).toMatchObject({
      registration_state: "not_yet_open",
      reservation_blocked_reason: "not_yet_open",
    });
    expect(await states(closedByTime.id)).toMatchObject({
      registration_state: "closed",
      reservation_blocked_reason: "closed",
    });
    expect(await states(full.id)).toMatchObject({
      registration_state: "sold_out",
      seats_available: 0,
      reservation_blocked_reason: "sold_out",
    });
    expect(await states(mine.id)).toMatchObject({
      my_ticket_status: "awaiting_payment",
      reservation_blocked_reason: "has_active_ticket",
      can_reserve: false,
      my_ticket: { status: "awaiting_payment", payment_status: "pending" },
    });
  });
});

describe("Detail event (PRD 2.2, D5, D6)", () => {
  it("D5, D6: jendela check-in bawaan 2 jam sebelum mulai sampai selesai; aturan refund H-3 dan ringkasan teks", async () => {
    const event = await createEventRow(t, { startsInMs: 10 * DAY });
    const member = await memberSession(t);
    const res = await api().get(`/events/${event.id}`, { token: member.token });
    const body = expectOperation("get", "/events/{eventId}", res) as JsonBody;
    expect(body).toMatchObject({
      description: "Acara uji.\nBaris kedua.",
      checkin_opens_at: new Date(event.startsAt.getTime() - 2 * HOUR).toISOString(),
      checkin_closes_at: event.endsAt.toISOString(),
      hold_hours: 24,
      participant_count: 0,
      cancelled_at: null,
      can_reserve: true,
      reservation_blocked_reason: null,
      my_ticket: null,
      cancellation_policy: {
        self_cancel_until: event.startsAt.toISOString(),
        full_refund_until: new Date(event.startsAt.getTime() - 3 * DAY).toISOString(),
        refund_processing_business_days: 7,
      },
    });
    expect(body.cancellation_policy.summary).toMatch(/\(H-3\) untuk refund penuh/);
    expect(body.cancellation_policy.summary).toMatch(/WIB/);
    const free = await createEventRow(t, { price: "0.00" });
    const freeBody = (await api().get(`/events/${free.id}`, { token: member.token })).json();
    expect(freeBody).toMatchObject({ is_free: true, cancellation_policy: { full_refund_until: null } });
    expect(freeBody.cancellation_policy.summary).toMatch(/tidak ada refund/);
    // Override jendela check-in.
    const opens = new Date(event.startsAt.getTime() - 5 * HOUR);
    const custom = await createEventRow(t, {
      checkinOpensAt: opens,
      checkinClosesAt: new Date(opens.getTime() + HOUR),
    });
    expect((await api().get(`/events/${custom.id}`, { token: member.token })).json()).toMatchObject({
      checkin_opens_at: opens.toISOString(),
    });
  });

  it("N-09: draft atau id tidak dikenal → 404; id bukan UUID → 400", async () => {
    const member = await memberSession(t);
    const draft = await createEventRow(t, { status: "draft" });
    expect(
      expectOperation(
        "get",
        "/events/{eventId}",
        await api().get(`/events/${draft.id}`, { token: member.token }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect((await api().get(`/events/${uuidv7()}`, { token: member.token })).statusCode).toBe(404);
    expect((await api().get("/events/bukan-uuid", { token: member.token })).statusCode).toBe(400);
  });

  it("PRD 2.2: anggota expired/unverified hanya membuka event yang tiketnya ia pegang (can_reserve=false, membership_required); selain itu 403 tanpa membedakan event ada", async () => {
    const event = await createEventRow(t, { price: "0.00" });
    const expired = await memberSession(t, "expired");
    await insertTicket(t, { eventId: event.id, userId: expired.userId, status: "paid" });
    const own = await api().get(`/events/${event.id}`, { token: expired.token });
    expect(expectOperation("get", "/events/{eventId}", own)).toMatchObject({
      can_reserve: false,
      reservation_blocked_reason: "membership_required",
      my_ticket: { status: "paid" },
    });
    const other = await createEventRow(t);
    const denied = await api().get(`/events/${other.id}`, { token: expired.token });
    expect(expectOperation("get", "/events/{eventId}", denied)).toMatchObject({
      code: "MEMBERSHIP_REQUIRED",
    });
    expect((await api().get(`/events/${uuidv7()}`, { token: expired.token })).json().code).toBe(
      "MEMBERSHIP_REQUIRED",
    );
    const unverified = await memberSession(t, "unverified");
    expect((await api().get(`/events/${event.id}`, { token: unverified.token })).json().code).toBe(
      "MEMBERSHIP_REQUIRED",
    );
  });
});

describe("Peserta (PRD 3.10, AC F10-2, F10-3)", () => {
  it("AC F10-2: hanya pemegang tiket paid yang tampil di direktori dan tidak saling memblokir; tanpa kontak", async () => {
    const event = await createEventRow(t, { price: "0.00", seatsTotal: 20 });
    const viewer = await memberSession(t, "verified", { fullName: "Penonton Uji" });
    const visible = await memberSession(t, "verified", { fullName: "Budi Hadir" });
    const expiring = await memberSession(t, "expiring", { fullName: "Ahmad Hadir" });
    const hidden = await memberSession(t, "verified", {
      fullName: "Citra Tersembunyi",
      showInDirectory: false,
    });
    const expired = await memberSession(t, "expired", { fullName: "Dodi Kedaluwarsa" });
    const suspended = await memberSession(t, "suspended", { fullName: "Eka Ditangguhkan" });
    const blocker = await memberSession(t, "verified", { fullName: "Fajar Memblokir" });
    const blocked = await memberSession(t, "verified", { fullName: "Gita Diblokir" });
    const pending = await memberSession(t, "verified", { fullName: "Hana Menunggu" });
    for (const holder of [visible, expiring, hidden, expired, suspended, blocker, blocked])
      await insertTicket(t, { eventId: event.id, userId: holder.userId, status: "paid" });
    await insertTicket(t, { eventId: event.id, userId: pending.userId, status: "awaiting_payment" });
    const now = t.clock.now();
    await t.db.insert(blocks).values([
      { blockerId: blocker.userId, blockedId: viewer.userId, createdAt: now },
      { blockerId: viewer.userId, blockedId: blocked.userId, createdAt: now },
    ]);
    const res = await api().get(`/events/${event.id}/participants`, { token: viewer.token });
    const body = expectOperation("get", "/events/{eventId}/participants", res) as JsonBody;
    expect(body.items.map((p: { full_name: string }) => p.full_name)).toEqual(["Ahmad Hadir", "Budi Hadir"]);
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "avatar_url",
      "cohort",
      "cohort_code",
      "full_name",
      "user_id",
    ]);
    expect(body.items[1]).toMatchObject({ user_id: visible.userId, cohort: 29, cohort_code: "KAPDH 29" });
    const page = (
      await api().get(`/events/${event.id}/participants`, { token: viewer.token, query: { limit: "1" } })
    ).json();
    expect(page.items).toHaveLength(1);
    const next = (
      await api().get(`/events/${event.id}/participants`, {
        token: viewer.token,
        query: { limit: "1", cursor: page.next_cursor },
      })
    ).json();
    expect(next.items[0].full_name).toBe("Budi Hadir");
    // Detail event tetap menghitung semua kursi terkonfirmasi.
    expect((await api().get(`/events/${event.id}`, { token: viewer.token })).json().participant_count).toBe(
      7,
    );
    const draft = await createEventRow(t, { status: "draft" });
    expect((await api().get(`/events/${draft.id}/participants`, { token: viewer.token })).statusCode).toBe(
      404,
    );
  });
});

describe("Tiket saya (PRD 2.2, 4.4)", () => {
  it("F-09: view=active (urut mulai event) dan history (urut dibuat turun); hold lewat tampil expired di history", async () => {
    const member = await memberSession(t);
    const soon = await createEventRow(t, { startsInMs: 2 * DAY, price: "0.00" });
    const later = await createEventRow(t, { startsInMs: 20 * DAY });
    const lapsing = await createEventRow(t);
    const cancelledEvent = await createEventRow(t, { status: "cancelled" });
    const laterTicket = await reserve(t, member, later);
    const soonTicket = await reserve(t, member, soon);
    const lapsed = await insertTicket(t, {
      eventId: lapsing.id,
      userId: member.userId,
      status: "awaiting_payment",
      total: "75000.00",
      holdExpiresAt: new Date(t.clock.now().getTime() - 1000),
    });
    const cancelled = await insertTicket(t, {
      eventId: cancelledEvent.id,
      userId: member.userId,
      status: "cancelled",
    });
    const active = expectOperation(
      "get",
      "/me/tickets",
      await api().get("/me/tickets", { token: member.token }),
    ) as JsonBody;
    expect(active.items.map((x: { id: string }) => x.id)).toEqual([soonTicket.id, laterTicket.id]);
    expect(active.items[0]).toMatchObject({ status: "paid", payment_status: null, event: { id: soon.id } });
    const history = (
      await api().get("/me/tickets", { token: member.token, query: { view: "history" } })
    ).json();
    expect(history.items.map((x: { id: string }) => x.id)).toEqual([cancelled.id, lapsed.id]);
    expect(history.items[1]).toMatchObject({ status: "expired" });
    const bad = await api().get("/me/tickets", { token: member.token, query: { view: "semua" } });
    expect(expectOperation("get", "/me/tickets", bad)).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("PRD 2.2: anggota expired tetap melihat tiket paid beserta QR; tiket pengguna lain 404 (N-09)", async () => {
    const event = await createEventRow(t, { price: "0.00" });
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    // Masa keanggotaan berakhir sesudah membayar tiket.
    t.clock.advance(400 * DAY);
    await relogin(t, member);
    const res = await api().get(`/me/tickets/${ticket.id}`, { token: member.token });
    const body = expectOperation("get", "/me/tickets/{ticketId}", res) as JsonBody;
    expect(body.qr_code).toBe(ticket.qr_code);
    t.clock.advance(-400 * DAY);
    await relogin(t, member);
    const stranger = await memberSession(t);
    const other = await api().get(`/me/tickets/${ticket.id}`, { token: stranger.token });
    expect(expectOperation("get", "/me/tickets/{ticketId}", other)).toMatchObject({ code: "NOT_FOUND" });
  });
});
