import { banners, events, notifications, pages, posts, tickets } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { createAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  adminSession,
  insertBanner,
  insertCategory,
  insertEvent,
  insertPost,
  memberSession,
  uploadContentMedia,
} from "./support.js";

/**
 * GET /home (F-08, PRD 3.8): banner dalam jendela tanggal dengan target terselesaikan (AC F08-2), event mendatang,
 * berita terbaru, akses cepat KTA/notifikasi, dan keadaan kosong yang sah (AC F08-4).
 */

let t: TestApp;
let imageFileId: string;

beforeAll(async () => {
  t = await createTestApp();
  const admin = await adminSession(t, ["content.manage"]);
  imageFileId = (await uploadContentMedia(t, admin.token, "banner_image")).file_id;
});
afterAll(async () => {
  await t.app.close();
});

type Home = {
  banners: { id: string; title: string; image_url: string; target: Record<string, unknown> }[];
  upcoming_events: Record<string, unknown>[];
  posts: { id: string }[];
  quick_access: Record<string, unknown>;
  generated_at: string;
};

async function home(token: string): Promise<Home> {
  const res = await httpClient(t.app).get("/home", { token });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/home", res) as Home;
}

/** Banner lain dinonaktifkan agar setiap uji melihat keadaan bersih (batas 10 banner Beranda). */
async function resetHome() {
  await t.db.update(banners).set({ active: false });
  await t.db.update(events).set({ status: "done" });
  await t.db.update(posts).set({ status: "archived" });
}

describe("AC F08-4: Beranda kosong tetap sah dan memberi waktu pembaruan", () => {
  it("AC F08-4: tanpa banner/event/berita, Beranda mengembalikan daftar kosong dan generated_at waktu server", async () => {
    const member = await memberSession(t, "verified");
    const body = await home(member.token);
    expect(body).toMatchObject({ banners: [], upcoming_events: [], posts: [] });
    expect(body.generated_at).toBe(t.clock.now().toISOString());
    expect(body.quick_access).toEqual({
      unread_notification_count: 0,
      effective_status: "verified",
      member_number: member.memberNumber,
      expires_at: member.expiresAt!.toISOString(),
    });
  });

  it("PRD 3.8: akses cepat memuat jumlah notifikasi belum dibaca dan status expiring", async () => {
    const member = await memberSession(t, "expiring");
    const now = t.clock.now();
    for (const read of [null, null, now])
      await t.db.insert(notifications).values({
        id: uuidv7(),
        userId: member.userId,
        category: "account",
        title: "Uji",
        dedupKey: `uji:${uuidv7()}`,
        readAt: read,
        createdAt: now,
      });
    expect((await home(member.token)).quick_access).toMatchObject({
      unread_notification_count: 2,
      effective_status: "expiring",
    });
  });
});

describe("AC F08-2: banner hanya dalam jendela tanggal; target tidak tersedia ditangani jelas", () => {
  it("AC F08-2: banner sebelum mulai, sesudah selesai, dan nonaktif tidak tampil; urutan sort_order lalu starts_at turun", async () => {
    await resetHome();
    const member = await memberSession(t);
    const now = t.clock.now().getTime();
    const live1 = await insertBanner(t, imageFileId, { sortOrder: 1, startsAt: new Date(now - 7200_000) });
    const live2 = await insertBanner(t, imageFileId, { sortOrder: 1, startsAt: new Date(now - 3600_000) });
    const live0 = await insertBanner(t, imageFileId, {
      sortOrder: 0,
      startsAt: new Date(now - 3600_000),
      endsAt: new Date(now + 60_000),
    });
    const future = await insertBanner(t, imageFileId, { startsAt: new Date(now + 60_000) });
    const ended = await insertBanner(t, imageFileId, {
      startsAt: new Date(now - 7200_000),
      endsAt: new Date(now),
    });
    const inactive = await insertBanner(t, imageFileId, { active: false });

    const ids = (await home(member.token)).banners.map((b) => b.id);
    expect(ids).toEqual([live0.id, live2.id, live1.id]);
    for (const hidden of [future, ended, inactive]) expect(ids).not.toContain(hidden.id);

    t.clock.advance(60_000);
    const later = (await home(member.token)).banners.map((b) => b.id);
    expect(later).toContain(future.id);
    expect(later).not.toContain(live0.id);
  });

  it("AC F08-2: Beranda menampilkan maksimal 10 banner", async () => {
    await resetHome();
    const member = await memberSession(t);
    for (let i = 0; i < 12; i++) await insertBanner(t, imageFileId, { sortOrder: i });
    expect((await home(member.token)).banners).toHaveLength(10);
  });

  it("AC F08-2: target berita/event/halaman yang tidak tersedia ditandai available=false tanpa rute", async () => {
    await resetHome();
    const member = await memberSession(t);
    const now = t.clock.now().getTime();
    const category = await insertCategory(t, { kind: "post" });
    const visible = await insertPost(t, { categoryId: category.id });
    const archived = await insertPost(t, { status: "archived" });
    const scheduled = await insertPost(t, { publishedAt: new Date(now + 3600_000) });
    const openEvent = await insertEvent(t, { status: "open" });
    const cancelled = await insertEvent(t, { status: "cancelled" });
    const draftEvent = await insertEvent(t, { status: "draft" });
    const endedEvent = await insertEvent(t, {
      status: "closed",
      startsAt: new Date(now - 7200_000),
      endsAt: new Date(now - 3600_000),
      registrationOpensAt: new Date(now - 9 * 3600_000),
      registrationClosesAt: new Date(now - 8 * 3600_000),
    });
    await t.db
      .update(pages)
      .set({
        publishedTitle: "Tentang KAPDH",
        publishedBodyHtml: "<p>x</p>",
        publishedVersion: 1,
        publishedAt: new Date(now - 1000),
      })
      .where(eq(pages.slug, "tentang"));

    const cases: [Parameters<typeof insertBanner>[2], Record<string, unknown>][] = [
      [
        { targetType: "post", targetValue: visible.id },
        { available: true, route: `/news/${visible.slug}` },
      ],
      [
        { targetType: "post", targetValue: archived.id },
        { available: false, route: null },
      ],
      [
        { targetType: "post", targetValue: scheduled.id },
        { available: false, route: null },
      ],
      [
        { targetType: "post", targetValue: uuidv7() },
        { available: false, route: null },
      ],
      [
        { targetType: "event", targetValue: openEvent.id },
        { available: true, route: `/events/${openEvent.id}` },
      ],
      [
        { targetType: "event", targetValue: cancelled.id },
        { available: false, route: null },
      ],
      [
        { targetType: "event", targetValue: draftEvent.id },
        { available: false, route: null },
      ],
      [
        { targetType: "event", targetValue: endedEvent.id },
        { available: false, route: null },
      ],
      [
        { targetType: "page", targetValue: "tentang" },
        { available: true, route: "/legal/tentang" },
      ],
      [
        { targetType: "page", targetValue: "ketentuan" },
        { available: false, route: null },
      ],
      [
        { targetType: "url", targetValue: "https://kapdh.or.id/donasi" },
        { available: true, route: null, url: "https://kapdh.or.id/donasi", external: true },
      ],
      [
        { targetType: "none", targetValue: null },
        { available: true, route: null, url: null, external: false },
      ],
    ];
    const created = [];
    for (const [i, [options]] of cases.entries())
      created.push(await insertBanner(t, imageFileId, { ...options, sortOrder: i }));
    const result = (await home(member.token)).banners;
    expect(result).toHaveLength(10);
    const more = (await home(member.token)).banners;
    expect(more.map((b) => b.id)).toEqual(created.slice(0, 10).map((b) => b.id));
    for (const [i, [, expected]] of cases.slice(0, 10).entries())
      expect(result[i]!.target, `kasus ${i}`).toMatchObject(expected);
    expect(result[0]!.image_url).toBe(`${t.env.API_PUBLIC_URL}/api/v1/files/public/${imageFileId}`);
    // Dua kasus terakhir diperiksa dengan menonaktifkan sepuluh banner pertama.
    await t.db.update(banners).set({ active: false });
    for (const banner of created.slice(10))
      await t.db.update(banners).set({ active: true }).where(eq(banners.id, banner.id));
    const rest = (await home(member.token)).banners;
    for (const [i, [, expected]] of cases.slice(10).entries())
      expect(rest[i]!.target, `kasus ${10 + i}`).toMatchObject(expected);
  });
});

describe("PRD 3.8: event mendatang dan berita terbaru di Beranda", () => {
  it("PRD 3.8: event open/closed yang belum berakhir, urut mulai naik, maksimal 5, label pendaftaran", async () => {
    await resetHome();
    const member = await memberSession(t);
    const now = t.clock.now().getTime();
    const day = 24 * 3600_000;
    const category = await insertCategory(t, { kind: "event", label: "Reuni" });
    const soldOut = await insertEvent(t, {
      startsAt: new Date(now + day),
      seatsTotal: 2,
      heldQuantity: 1,
      paidQuantity: 1,
      categoryId: category.id,
    });
    const free = await insertEvent(t, { startsAt: new Date(now + 2 * day), price: "0.00" });
    const notYet = await insertEvent(t, {
      startsAt: new Date(now + 3 * day),
      registrationOpensAt: new Date(now + day),
      registrationClosesAt: new Date(now + 2 * day),
    });
    const closed = await insertEvent(t, { status: "closed", startsAt: new Date(now + 4 * day) });
    const open = await insertEvent(t, { startsAt: new Date(now + 5 * day) });
    await insertEvent(t, { startsAt: new Date(now + 6 * day) });
    await insertEvent(t, { status: "draft", startsAt: new Date(now + day / 2) });
    await insertEvent(t, { status: "cancelled", startsAt: new Date(now + day / 2) });

    const upcoming = (await home(member.token)).upcoming_events;
    expect(upcoming.map((e) => e.id)).toEqual([soldOut.id, free.id, notYet.id, closed.id, open.id]);
    expect(upcoming[0]).toMatchObject({
      registration_state: "sold_out",
      seats_available: 0,
      is_free: false,
      price: "50000.00",
      category: { id: category.id, label: "Reuni" },
      timezone: "Asia/Jakarta",
      location_name: "Aula Darel Hikmah",
    });
    expect(upcoming[1]).toMatchObject({ registration_state: "open", is_free: true, price: "0.00" });
    expect(upcoming[2]).toMatchObject({ registration_state: "not_yet_open" });
    expect(upcoming[3]).toMatchObject({ registration_state: "closed" });
    expect(upcoming[4]).toMatchObject({ registration_state: "open", seats_available: 100 });
  });

  it("AC F09-2 (proyeksi kursi, aturan tag Events): hold kedaluwarsa yang belum dilepas job dianggap lepas di Beranda", async () => {
    await resetHome();
    const member = await memberSession(t);
    const now = t.clock.now();
    const day = 24 * 3600_000;
    const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
    // Penghitung tersimpan belum dilepas job expiry (held_quantity masih menghitung hold kedaluwarsa).
    const partly = await insertEvent(t, {
      startsAt: at(day),
      seatsTotal: 3,
      heldQuantity: 2,
      paidQuantity: 1,
    });
    const expiredOnly = await insertEvent(t, { startsAt: at(2 * day), seatsTotal: 1, heldQuantity: 1 });
    const stillHeld = await insertEvent(t, {
      startsAt: at(3 * day),
      seatsTotal: 2,
      heldQuantity: 1,
      paidQuantity: 1,
    });
    const holders = await Promise.all(
      Array.from({ length: 4 }, () => createAlumni(t, { status: "verified" })),
    );
    const hold = (eventId: string, userId: string, holdExpiresAt: Date) => ({
      id: uuidv7(),
      eventId,
      userId,
      status: "awaiting_payment" as const,
      totalSnapshot: "50000.00",
      holdExpiresAt,
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(tickets).values([
      hold(partly.id, holders[0]!.userId, at(-60_000)), // kedaluwarsa
      hold(partly.id, holders[1]!.userId, at(3600_000)), // masih aktif
      hold(expiredOnly.id, holders[2]!.userId, now), // tepat hold_expires_at = now: sudah kedaluwarsa
      hold(stillHeld.id, holders[3]!.userId, at(60_000)), // masih aktif
    ]);

    const upcoming = (await home(member.token)).upcoming_events;
    expect(upcoming.map((e) => [e.id, e.seats_available, e.registration_state])).toEqual([
      [partly.id, 1, "open"],
      [expiredOnly.id, 1, "open"],
      [stillHeld.id, 0, "sold_out"],
    ]);
    // Operasi baca tidak pernah menulis: penghitung dan status tiket tetap.
    const [stored] = await t.db.select().from(events).where(eq(events.id, expiredOnly.id));
    expect(stored!.heldQuantity).toBe(1);
    const statuses = await t.db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.eventId, partly.id));
    expect(statuses.map((s) => s.status)).toEqual(["awaiting_payment", "awaiting_payment"]);
  });

  it("AC F08-1: Beranda hanya memuat 5 berita terbaru yang sudah tampil", async () => {
    await resetHome();
    const member = await memberSession(t);
    const base = t.clock.now().getTime() - 3600_000;
    const visible = [];
    for (let i = 0; i < 6; i++) visible.push(await insertPost(t, { publishedAt: new Date(base + i * 1000) }));
    await insertPost(t, { status: "draft" });
    await insertPost(t, { publishedAt: new Date(t.clock.now().getTime() + 60_000) });
    const ids = (await home(member.token)).posts.map((p) => p.id);
    expect(ids).toEqual(
      visible
        .slice(1)
        .map((p) => p.id)
        .reverse(),
    );
  });
});
