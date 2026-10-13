import { notifications } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import {
  type AlumniFixtureStatus,
  createAdmin,
  createAlumni,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { notify } from "./support.js";

/**
 * Kotak masuk in-app (F-13; kontrak notifications.yaml listNotifications, getNotificationUnreadCount, getNotification,
 * markNotificationsRead): riwayat resmi untuk semua effective_status, deep link aman, dan hanya milik pemanggil.
 */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

async function member(status: AlumniFixtureStatus = "verified") {
  const fixture = await createAlumni(t, { status });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken, refreshToken: session.refreshToken };
}

describe("GET /notifications (AC F13-2)", () => {
  it.each(["unverified", "verified", "expiring", "expired", "suspended"] as const)(
    "AC F13-2: anggota %s tanpa izin push OS (tanpa token perangkat) tetap membuka kotak masuk",
    async (status) => {
      const m = await member(status);
      const created = await notify(t, m.userId, { category: "account", title: "Info akun", route: "/account" });
      const res = await api().get("/notifications", { token: m.token });
      expect(res.statusCode, res.body).toBe(200);
      const body = expectOperation("get", "/notifications", res) as {
        items: { id: string; deep_link: string | null; read_at: string | null }[];
        unread_count: number;
        next_cursor: string | null;
      };
      expect(body.items.map((item) => item.id)).toEqual([created.id]);
      expect(body.items[0]).toMatchObject({ deep_link: "kapdh://app/account", read_at: null });
      expect(body.unread_count).toBe(1);
      expect(body.next_cursor).toBeNull();
    },
  );

  it("AC F13-2: terbaru dahulu, halaman keyset stabil, filter unread_only/category; unread_count atas seluruh inbox", async () => {
    const m = await member();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      t.clock.advance(1000);
      ids.push(
        (await notify(t, m.userId, { category: i % 2 === 0 ? "payment" : "event", title: `Notifikasi ${i}` })).id,
      );
    }
    const newestFirst = [...ids].reverse();
    const first = await api().get("/notifications", { token: m.token, query: { limit: "2" } });
    const page1 = expectOperation("get", "/notifications", first) as {
      items: { id: string }[];
      next_cursor: string;
      unread_count: number;
    };
    expect(page1.items.map((i) => i.id)).toEqual(newestFirst.slice(0, 2));
    expect(page1.unread_count).toBe(5);
    const second = await api().get("/notifications", {
      token: m.token,
      query: { limit: "2", cursor: page1.next_cursor },
    });
    const page2 = expectOperation("get", "/notifications", second) as {
      items: { id: string }[];
      next_cursor: string;
    };
    expect(page2.items.map((i) => i.id)).toEqual(newestFirst.slice(2, 4));
    const third = await api().get("/notifications", {
      token: m.token,
      query: { limit: "2", cursor: page2.next_cursor },
    });
    const page3 = expectOperation("get", "/notifications", third) as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    expect(page3.items.map((i) => i.id)).toEqual(newestFirst.slice(4));
    expect(page3.next_cursor).toBeNull();

    // Filter kategori: hanya event (indeks 1, 3).
    const events = await api().get("/notifications", { token: m.token, query: { category: "event" } });
    expect((events.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([ids[3], ids[1]]);

    // Tandai satu dibaca; unread_only menyembunyikannya, unread_count tetap atas seluruh inbox.
    await api().post("/notifications/read", { ids: [ids[4]] }, { token: m.token });
    const unread = await api().get("/notifications", {
      token: m.token,
      query: { unread_only: "true", category: "payment" },
    });
    const unreadBody = expectOperation("get", "/notifications", unread) as {
      items: { id: string }[];
      unread_count: number;
    };
    expect(unreadBody.items.map((i) => i.id)).toEqual([ids[2], ids[0]]);
    expect(unreadBody.unread_count).toBe(4);
  });

  it("cursor terikat filter: cursor dari filter lain, cursor rusak, limit/kategori tidak valid → 400", async () => {
    const m = await member();
    for (let i = 0; i < 3; i++) {
      t.clock.advance(1000);
      await notify(t, m.userId);
    }
    const first = (await api().get("/notifications", { token: m.token, query: { limit: "1" } })).json() as {
      next_cursor: string;
    };
    const otherFilter = await api().get("/notifications", {
      token: m.token,
      query: { limit: "1", unread_only: "true", cursor: first.next_cursor },
    });
    expect(otherFilter.statusCode).toBe(400);
    expect(expectOperation("get", "/notifications", otherFilter)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { cursor: expect.any(Array) },
    });
    for (const query of [
      { cursor: "bukan-cursor!" },
      { limit: "101" },
      { limit: "0" },
      { category: "promo" },
      { unread_only: "mungkin" },
    ]) {
      const res = await api().get("/notifications", { token: m.token, query });
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
      expectOperation("get", "/notifications", res);
    }
  });

  it("hanya notifikasi milik pemanggil; tanpa token 401; token admin 403", async () => {
    const a = await member();
    const b = await member();
    await notify(t, a.userId);
    const res = await api().get("/notifications", { token: b.token });
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
    expect(expectOperation("get", "/notifications", await api().get("/notifications"))).toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const admin = await createAdmin(t, { role: "super_admin" });
    const adminSession = await signInAdmin(t, admin);
    const forbidden = await api().get("/notifications", { token: adminSession.accessToken });
    expect(forbidden.statusCode).toBe(403);
    expectOperation("get", "/notifications", forbidden);
  });
});

describe("GET /notifications/unread-count", () => {
  it("lencana lonceng mengikuti notifikasi baru dan tanda baca", async () => {
    const m = await member();
    const read = async () => {
      const res = await api().get("/notifications/unread-count", { token: m.token });
      expect(res.statusCode).toBe(200);
      return (expectOperation("get", "/notifications/unread-count", res) as { unread_count: number })
        .unread_count;
    };
    expect(await read()).toBe(0);
    const first = await notify(t, m.userId);
    await notify(t, m.userId);
    expect(await read()).toBe(2);
    await api().post("/notifications/read", { ids: [first.id] }, { token: m.token });
    expect(await read()).toBe(1);
    const unauth = await api().get("/notifications/unread-count");
    expect(unauth.statusCode).toBe(401);
    expectOperation("get", "/notifications/unread-count", unauth);
  });
});

describe("GET /notifications/{notificationId} (AC F13-3, F13-5)", () => {
  it("AC F13-3: deep link bentuk kapdh://app + rute §8.4; tidak menandai dibaca", async () => {
    const m = await member();
    const paymentId = uuidv7();
    const created = await notify(t, m.userId, { route: `/payments/${paymentId}`, body: null });
    const res = await api().get(`/notifications/${created.id}`, { token: m.token });
    expect(res.statusCode).toBe(200);
    expect(expectOperation("get", "/notifications/{notificationId}", res)).toMatchObject({
      id: created.id,
      category: "payment",
      body: null,
      deep_link: `kapdh://app/payments/${paymentId}`,
      read_at: null,
    });
    const [row] = await t.db.select().from(notifications).where(eq(notifications.id, created.id));
    expect(row!.readAt).toBeNull();
  });

  it("AC F13-3: rute tersimpan yang tidak sah (URL eksternal, rute sistem) tidak pernah menjadi deep link", async () => {
    const m = await member();
    for (const route of ["https://phishing.test/payments", "/login", "/admin/payments", 42]) {
      const id = uuidv7();
      await t.db.insert(notifications).values({
        id,
        userId: m.userId,
        category: "news",
        title: "Berita",
        data: { route },
        dedupKey: `u:${m.userId}:rusak:${id}`,
        createdAt: t.clock.now(),
      });
      const res = await api().get(`/notifications/${id}`, { token: m.token });
      expect(expectOperation("get", "/notifications/{notificationId}", res)).toMatchObject({ deep_link: null });
    }
  });

  it("AC F13-3, F13-5: setelah logout 401; milik akun lain 404 tanpa membedakan; bukan UUID 400", async () => {
    const owner = await member();
    const other = await member();
    const created = await notify(t, owner.userId);
    const foreign = await api().get(`/notifications/${created.id}`, { token: other.token });
    expect(foreign.statusCode).toBe(404);
    const missing = await api().get(`/notifications/${uuidv7()}`, { token: other.token });
    expect(missing.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: "NOT_FOUND", message: (missing.json() as { message: string }).message });
    expectOperation("get", "/notifications/{notificationId}", foreign);
    const invalid = await api().get("/notifications/bukan-uuid", { token: owner.token });
    expect(invalid.statusCode).toBe(400);
    expectOperation("get", "/notifications/{notificationId}", invalid);

    expect((await api().post("/auth/logout", {}, { token: owner.token })).statusCode).toBe(204);
    const afterLogout = await api().get(`/notifications/${created.id}`, { token: owner.token });
    expect(afterLogout.statusCode).toBe(401);
    expectOperation("get", "/notifications/{notificationId}", afterLogout);
  });
});

describe("POST /notifications/read", () => {
  it("ids milik sendiri ditandai sekali (idempoten); id akun lain diabaikan tanpa galat (N-09)", async () => {
    const m = await member();
    const other = await member();
    const mine = await notify(t, m.userId);
    const theirs = await notify(t, other.userId);
    const res = await api().post("/notifications/read", { ids: [mine.id, theirs.id] }, { token: m.token });
    expect(res.statusCode).toBe(200);
    expect(expectOperation("post", "/notifications/read", res)).toEqual({ updated_count: 1, unread_count: 0 });
    const again = await api().post("/notifications/read", { ids: [mine.id] }, { token: m.token });
    expect(again.json()).toEqual({ updated_count: 0, unread_count: 0 });
    const [foreign] = await t.db.select().from(notifications).where(eq(notifications.id, theirs.id));
    expect(foreign!.readAt).toBeNull();
    const [own] = await t.db.select().from(notifications).where(eq(notifications.id, mine.id));
    expect(own!.readAt).toEqual(t.clock.now());
  });

  it("all dengan up_to: notifikasi yang datang setelah layar dimuat tidak ikut ditandai", async () => {
    const m = await member();
    const before = await notify(t, m.userId);
    const shown = (
      (await api().get(`/notifications/${before.id}`, { token: m.token })).json() as { created_at: string }
    ).created_at;
    t.clock.advance(5_000);
    const later = await notify(t, m.userId);
    const res = await api().post("/notifications/read", { all: true, up_to: shown }, { token: m.token });
    expect(expectOperation("post", "/notifications/read", res)).toEqual({ updated_count: 1, unread_count: 1 });
    const [laterRow] = await t.db.select().from(notifications).where(eq(notifications.id, later.id));
    expect(laterRow!.readAt).toBeNull();
    const all = await api().post("/notifications/read", { all: true }, { token: m.token });
    expect(all.json()).toEqual({ updated_count: 1, unread_count: 0 });
  });

  it("kombinasi tidak valid → 400 VALIDATION_ERROR", async () => {
    const m = await member();
    const id = uuidv7();
    for (const body of [
      {},
      { ids: [] },
      { ids: [id], all: true },
      { all: false },
      { ids: [id], up_to: "2026-10-13T00:00:00Z" },
      { ids: [id, id] },
      { ids: ["bukan-uuid"] },
      { all: true, up_to: "kemarin" },
      { all: true, extra: 1 },
      { ids: Array.from({ length: 101 }, () => uuidv7()) },
    ]) {
      const res = await api().post("/notifications/read", body, { token: m.token });
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(expectOperation("post", "/notifications/read", res)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    const admin = await createAdmin(t, { role: "super_admin" });
    const session = await signInAdmin(t, admin);
    const forbidden = await api().post("/notifications/read", { all: true }, { token: session.accessToken });
    expect(forbidden.statusCode).toBe(403);
    expectOperation("post", "/notifications/read", forbidden);
  });
});
