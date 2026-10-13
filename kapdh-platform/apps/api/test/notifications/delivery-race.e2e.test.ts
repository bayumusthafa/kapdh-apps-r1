import { notificationDeliveries } from "@kapdh/database";
import { inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushMessage, PushResult } from "../../src/core/adapters/push.js";
import {
  DELIVERY_LEASE_MS,
  DELIVERY_SEND_TIMEOUT_MS,
  deliveryBackoffMs,
} from "../../src/modules/notifications/delivery-policy.js";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { deliveryOf, deliveryService, fcmToken, notify, registerDeviceOk, tokenRow } from "./support.js";

/**
 * Batch klaim yang dikirim bergiliran (F-13, AC F13-1, F13-4, F13-5; PRD 5.1). Satu klaim memuat banyak baris yang
 * dikirim SEND_CONCURRENCY (4) sekaligus; keadaan saat klaim bisa basi ketika giliran sebuah baris tiba. Regresi:
 * - logout/unregister/perpindahan token/preferensi yang commit setelah klaim tetapi sebelum giliran sebuah baris →
 *   baris itu tidak pernah dikirim (hanya percobaan yang SUDAH berjalan di provider yang lolos, dicatat jujur `sent`);
 * - lease klaim habis selagi baris menunggu giliran (provider lambat) → worker lain mengambil sisanya, worker pertama
 *   melewatinya: tidak ada push ganda;
 * - percobaan yang melewati batas waktu DIBATALKAN (koneksi ditutup) sehingga retry tidak menggandakan email.
 * Berkas terpisah dengan aplikasi sendiri agar job retry hanya melihat baris milik uji ini.
 */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(() => {
  t.push.clear();
  t.mailer.messages.length = 0;
  t.mailer.aborted.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await t.app.close();
});

type Send = (message: PushMessage) => Promise<PushResult>;

/** Menggantikan FakePush.send dengan pembungkus; `original` tetap mencatat pesan ke t.push.sent. */
function wrapPush(wrapper: (message: PushMessage, original: Send) => Promise<PushResult>) {
  const original = t.push.send.bind(t.push) as Send;
  return vi.spyOn(t.push, "send").mockImplementation((message) => wrapper(message, original));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Menunggu kondisi yang dipenuhi proses lain (worker) tanpa jam palsu. */
async function until(condition: () => boolean, label: string) {
  for (let i = 0; i < 2_000 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition(), label).toBe(true);
}

async function memberWithDevice() {
  const fixture = await createAlumni(t, { status: "verified", fullName: "Siti Aminah" });
  const session = await signInAlumni(t, fixture);
  const token = fcmToken("batch");
  await registerDeviceOk(t, session.accessToken, token);
  return { ...fixture, accessToken: session.accessToken, token };
}

/** `count` notifikasi news (push saja) yang sudah dijadwalkan dan jatuh tempo. */
async function scheduledNews(userId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const created = await notify(t, userId, { category: "news", title: `Kabar ${i + 1}`, route: "/news" });
    await deliveryService(t).schedule(created.id);
    ids.push(created.id);
  }
  return ids;
}

async function pushRows(ids: string[]) {
  return t.db.select().from(notificationDeliveries).where(inArray(notificationDeliveries.notificationId, ids));
}

describe("Pemeriksaan ulang tepat sebelum provider (AC F13-5)", () => {
  it("AC F13-5: logout saat batch klaim sedang dikirim → baris yang belum mulai tidak pernah dikirim ke token yang dicabut", async () => {
    const m = await memberWithDevice();
    const ids = await scheduledNews(m.userId, 8);
    const gate = deferred();
    const firstStarted = deferred();
    let loggedOut = false;
    const startedAfterLogout: string[] = [];
    wrapPush(async (message, original) => {
      if (loggedOut) startedAfterLogout.push(message.data.notification_id!);
      firstStarted.resolve();
      await gate.promise;
      return original(message);
    });

    const run = deliveryService(t).retryDue();
    await firstStarted.promise; // klaim sudah commit: 8 baris di antrean worker, sebagian sedang dikirim
    const logout = await api().post("/auth/logout", {}, { token: m.accessToken });
    expect(logout.statusCode).toBe(204);
    loggedOut = true;
    gate.resolve();
    const summary = await run;

    expect(startedAfterLogout).toEqual([]);
    // Hanya percobaan yang sudah berjalan di provider saat logout (≤ 4 = SEND_CONCURRENCY) yang terkirim.
    const pushed = t.push.to(m.token).map((msg) => msg.data.notification_id);
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    expect(pushed.length).toBeLessThanOrEqual(4);
    expect((await tokenRow(t, m.token))!.revokedAt).not.toBeNull();
    // Riwayat jujur: yang diterima provider tercatat sent; sisanya dibatalkan logout tanpa pernah dikirim.
    for (const row of await pushRows(ids))
      if (pushed.includes(row.notificationId)) expect(row).toMatchObject({ status: "sent", attempt: 1 });
      else expect(row).toMatchObject({ status: "cancelled", errorClass: "token_revoked", sentAt: null });
    expect(summary).toMatchObject({ claimed: 8, sent: pushed.length, skipped: 8 - pushed.length });
  });

  it("AC F13-5: token berpindah akun selama batch berjalan → baris yang belum mulai dibatalkan (token_reassigned), tidak sampai ke akun baru", async () => {
    const a = await memberWithDevice();
    const ids = await scheduledNews(a.userId, 6);
    const b = await createAlumni(t, { status: "verified" });
    const bSession = await signInAlumni(t, b);
    const gate = deferred();
    const firstStarted = deferred();
    let reassigned = false;
    const startedAfterReassign: string[] = [];
    wrapPush(async (message, original) => {
      if (reassigned) startedAfterReassign.push(message.data.notification_id!);
      firstStarted.resolve();
      await gate.promise;
      return original(message);
    });

    const run = deliveryService(t).retryDue();
    await firstStarted.promise;
    // Ponsel yang sama login sebagai B lalu mendaftarkan token FCM yang sama (kontrak C7: token berpindah akun).
    await registerDeviceOk(t, bSession.accessToken, a.token);
    reassigned = true;
    gate.resolve();
    await run;

    expect(startedAfterReassign).toEqual([]);
    const pushed = t.push.to(a.token).map((msg) => msg.data.notification_id!);
    expect(pushed.length).toBeLessThanOrEqual(4);
    for (const row of await pushRows(ids))
      if (pushed.includes(row.notificationId)) expect(row.status).toBe("sent");
      else expect(row).toMatchObject({ status: "cancelled", errorClass: "token_reassigned", sentAt: null });
  });

  it("AC F13-1: token FCM perangkat diperbarui selama batch berjalan → sisa push dikirim ke token baru, bukan token lama", async () => {
    const m = await memberWithDevice();
    const ids = await scheduledNews(m.userId, 8);
    const gate = deferred();
    const firstStarted = deferred();
    wrapPush(async (message, original) => {
      firstStarted.resolve();
      await gate.promise;
      return original(message);
    });

    const run = deliveryService(t).retryDue();
    await firstStarted.promise;
    const renewed = fcmToken("diperbarui");
    await registerDeviceOk(t, m.accessToken, renewed); // keluarga sesi sama: token lama dicabut, pending dipindahkan
    gate.resolve();
    await run;

    const toOld = t.push.to(m.token).map((msg) => msg.data.notification_id!);
    const toNew = t.push.to(renewed).map((msg) => msg.data.notification_id!);
    expect(toOld.length).toBeLessThanOrEqual(4); // hanya yang sudah berjalan di provider saat token diperbarui
    expect(toNew.length).toBeGreaterThanOrEqual(4);
    expect(new Set([...toOld, ...toNew]).size).toBe(8);
    expect(toOld.length + toNew.length).toBe(8);
    expect((await pushRows(ids)).every((row) => row.status === "sent")).toBe(true);
  });

  it("AC F13-2: preferensi kategori dimatikan selama batch berjalan → baris yang belum mulai dibatalkan (preference_disabled)", async () => {
    const m = await memberWithDevice();
    const ids = await scheduledNews(m.userId, 8);
    const gate = deferred();
    const firstStarted = deferred();
    wrapPush(async (message, original) => {
      firstStarted.resolve();
      await gate.promise;
      return original(message);
    });

    const run = deliveryService(t).retryDue();
    await firstStarted.promise;
    const res = await api().put(
      "/notifications/preferences",
      {
        push: { payment: true, membership: true, event: true, news: false, chat: true },
        email: { payment: true, membership: true, event: true },
      },
      { token: m.accessToken },
    );
    expect(res.statusCode, res.body).toBe(200);
    gate.resolve();
    const summary = await run;

    const pushed = t.push.to(m.token).map((msg) => msg.data.notification_id!);
    expect(pushed.length).toBeLessThanOrEqual(4);
    const cancelled = (await pushRows(ids)).filter((row) => !pushed.includes(row.notificationId));
    expect(cancelled.length).toBe(8 - pushed.length);
    for (const row of cancelled) expect(row).toMatchObject({ status: "cancelled", errorClass: "preference_disabled" });
    expect(summary).toMatchObject({ sent: pushed.length, cancelled: 8 - pushed.length });
  });
});

describe("Lease klaim dan provider lambat (PRD 5.1, AC F13-1)", () => {
  it("AC F13-1: lease klaim habis selagi baris menunggu giliran → worker lain mengambil sisanya; tidak ada push ganda", async () => {
    const m = await memberWithDevice();
    const ids = await scheduledNews(m.userId, 32);
    const claimedAt = t.clock.now().getTime();
    // Provider lambat: setiap putaran 4 kiriman paralel memakan 59 detik (di bawah batas waktu percobaan 60 detik).
    const SLOW_ROUNDS = Math.ceil(DELIVERY_LEASE_MS / 59_000); // 6 putaran → jam melewati lease klaim
    let phase: "lambat" | "tahan" | "lewat" = "lambat";
    let round = deferred();
    let inRound = 0;
    let slowSends = 0;
    let held = 0;
    const gate = deferred();
    wrapPush(async (message, original) => {
      if (phase === "lambat") {
        const current = round;
        slowSends++;
        if (++inRound === 4) {
          inRound = 0;
          round = deferred();
          t.clock.advance(59_000);
          if (slowSends === SLOW_ROUNDS * 4) phase = "tahan";
          current.resolve();
        }
        await current.promise;
      } else if (phase === "tahan") {
        held++;
        await gate.promise;
      }
      return original(message);
    });

    const first = deliveryService(t).retryDue();
    await until(() => held === 4, "empat percobaan putaran berikutnya sedang berjalan di provider");
    expect(t.clock.now().getTime() - claimedAt).toBeGreaterThan(DELIVERY_LEASE_MS);
    phase = "lewat";
    // Worker lain (job notifications.retry berikutnya / replika worker) berjalan selagi worker pertama masih mengirim.
    const second = await deliveryService(t).retryDue();
    gate.resolve();
    const firstSummary = await first;

    const pushed = t.push.to(m.token).map((msg) => msg.data.notification_id!);
    expect(pushed).toHaveLength(32);
    expect(new Set(pushed).size).toBe(32);
    const rows = await pushRows(ids);
    expect(rows.every((row) => row.status === "sent")).toBe(true);
    // Worker pertama: 24 terkirim lambat + 4 yang sedang berjalan; 4 sisanya sudah diklaim ulang (attempt 2) → dilewati.
    expect(firstSummary).toMatchObject({ claimed: 32, sent: 28, skipped: 4 });
    expect(second).toMatchObject({ claimed: 4, sent: 4 });
    expect(rows.filter((row) => row.attempt === 2)).toHaveLength(4);
  });
});

describe("Batas waktu percobaan membatalkan provider (AC F13-4)", () => {
  it("AC F13-4: email yang macet melewati batas waktu DIBATALKAN (koneksi ditutup) → retry mengirim tepat sekali dengan Message-ID stabil", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const realSetTimeout = globalThis.setTimeout;
    // Batas waktu percobaan (60 detik) dipersingkat hanya untuk timer itu; timer lain tidak berubah.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => realSetTimeout(handler, ms === DELIVERY_SEND_TIMEOUT_MS ? 30 : ms, ...args)) as unknown as typeof setTimeout);
    const hold = t.mailer.holdNext(); // server SMTP lambat: belum membalas akhir DATA
    const created = await notify(t, member.userId, { category: "payment" });

    const delivering = deliveryService(t).deliver(created.id);
    const signal = await hold.started;
    expect(await delivering).toMatchObject({ claimed: 1, retried: 1 });
    vi.mocked(globalThis.setTimeout).mockRestore();

    expect(signal?.aborted).toBe(true);
    const first = await deliveryOf(t, created.id, "email");
    expect(first).toMatchObject({ status: "pending", errorClass: "timeout", attempt: 1 });
    // Server "membalas" setelah koneksi ditutup: pesan tidak pernah diterima.
    hold.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.mailer.messagesTo(member.email)).toHaveLength(0);
    expect(t.mailer.aborted.map((mail) => mail.dedupKey)).toEqual([first.id]);

    t.clock.advance(deliveryBackoffMs(1));
    await t.jobs.runScheduled("notifications.retry");
    const mails = t.mailer.messagesTo(member.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.dedupKey).toBe(first.id); // Message-ID sama pada setiap percobaan pengiriman ini
    expect(await deliveryOf(t, created.id, "email")).toMatchObject({ status: "sent", attempt: 2, errorClass: null });
  });
});
