import { deviceTokens, sessions } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliveryBackoffMs } from "../../src/modules/notifications/delivery-policy.js";
import { DevicesService } from "../../src/modules/notifications/devices.service.js";
import { expectOperation } from "../support/contract.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  deliveriesOf,
  deliveryOf,
  expectIndonesianFieldErrors,
  fcmToken,
  notify,
  registerDevice,
  registerDeviceOk,
  tokenRow,
} from "./support.js";

/**
 * Token perangkat FCM (F-13, AC F13-4, F13-5; kontrak registerDevice/unregisterDevice): terikat pengguna dan keluarga
 * sesi, dicabut saat sesi berakhir, dan tidak pernah menerima notifikasi akun sebelumnya.
 */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(() => {
  t.push.clear();
});
afterAll(async () => {
  await t.app.close();
});

async function member(status: "verified" | "expired" | "suspended" | "unverified" = "verified") {
  const fixture = await createAlumni(t, { status });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, accessToken: session.accessToken, refreshToken: session.refreshToken };
}

/** Push berikutnya ke token gagal sementara sehingga pengiriman tetap `pending` (menunggu retry). */
function holdNextPush(token: string) {
  t.push.failNext(token, { ok: false, errorClass: "unavailable", retryable: true, deactivateToken: false });
}

describe("PUT /devices (registerDevice)", () => {
  it.each(["verified", "expired", "suspended", "unverified"] as const)(
    "anggota %s mendaftarkan token: 204 tanpa body; terikat pengguna dan baris sesi aktif keluarganya",
    async (status) => {
      const m = await member(status);
      const token = fcmToken();
      const res = await registerDevice(t, m.accessToken, token, "ios");
      expect(res.statusCode).toBe(204);
      expectOperation("put", "/devices", res);
      const row = await tokenRow(t, token);
      const [session] = await t.db.select().from(sessions).where(eq(sessions.id, row!.sessionId!));
      expect(row).toMatchObject({
        userId: m.userId,
        platform: "ios",
        appVersion: "1.0.0",
        revokedAt: null,
        failureCount: 0,
      });
      expect(session!.revokedAt).toBeNull();
      expect(session!.userId).toBe(m.userId);
    },
  );

  it("validasi: platform, token kosong/berspasi/terlalu panjang, app_version bukan semver, field asing → 400", async () => {
    const m = await member();
    for (const body of [
      { platform: "web", token: fcmToken() },
      { platform: "android", token: "" },
      { platform: "android", token: "token dengan spasi" },
      { platform: "android", token: "x".repeat(4097) },
      { platform: "android", token: fcmToken(), app_version: "v1" },
      { platform: "android", token: fcmToken(), extra: true },
      { token: fcmToken() },
      { platform: "android", token: fcmToken(), app_version: 100 },
      { platform: "android", token: 12345 },
    ]) {
      const res = await api().put("/devices", body, { token: m.accessToken });
      expect(res.statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(expectOperation("put", "/devices", res)).toMatchObject({ code: "VALIDATION_ERROR" });
      expectIndonesianFieldErrors(res.json(), JSON.stringify(body).slice(0, 60));
    }
    const unregister = await api().post(
      "/devices/unregister",
      { token: fcmToken(), extra: 1 },
      { token: m.accessToken },
    );
    expect(unregister.statusCode).toBe(400);
    expect((unregister.json() as { field_errors: Record<string, string[]> }).field_errors._).toContain(
      "Kolom tidak dikenal: extra",
    );
  });

  it("tanpa sesi 401; token admin 403", async () => {
    const unauth = await api().put("/devices", { platform: "android", token: fcmToken() });
    expect(unauth.statusCode).toBe(401);
    expectOperation("put", "/devices", unauth);
    const admin = await createAdmin(t, { role: "super_admin" });
    const session = await signInAdmin(t, admin);
    const forbidden = await registerDevice(t, session.accessToken, fcmToken());
    expect(forbidden.statusCode).toBe(403);
    expectOperation("put", "/devices", forbidden);
  });
});

describe("AC F13-5: keluar atau berganti akun", () => {
  it("AC F13-5: logout mencabut token sesi itu dan membatalkan push pending; notifikasi berikutnya tidak ke perangkat itu", async () => {
    const m = await member();
    const token = fcmToken();
    await registerDeviceOk(t, m.accessToken, token);
    holdNextPush(token);
    const waiting = await notify(t, m.userId, { category: "news", route: "/news" });
    await t.jobs.drainOutbox();
    expect((await deliveryOf(t, waiting.id, "push")).status).toBe("pending");

    expect((await api().post("/auth/logout", {}, { token: m.accessToken })).statusCode).toBe(204);
    expect((await tokenRow(t, token))!.revokedAt).not.toBeNull();
    expect(await deliveryOf(t, waiting.id, "push")).toMatchObject({
      status: "cancelled",
      errorClass: "token_revoked",
    });
    t.clock.advance(deliveryBackoffMs(1));
    await t.jobs.runScheduled("notifications.retry");
    const next = await notify(t, m.userId, { category: "news", route: "/news" });
    await t.jobs.drainOutbox();
    expect(await deliveriesOf(t, next.id)).toEqual([]);
    expect(t.push.to(token)).toHaveLength(1);
    // Access token lama tidak dapat mendaftarkan ulang token setelah logout.
    expect((await registerDevice(t, m.accessToken, token)).statusCode).toBe(401);
  });

  it("AC F13-5: berganti akun di perangkat yang sama tanpa logout server → pending akun lama dibatalkan (token_reassigned); akun baru menerima notifikasinya sendiri", async () => {
    const a = await member();
    const b = await member();
    const token = fcmToken("bersama");
    await registerDeviceOk(t, a.accessToken, token);
    holdNextPush(token);
    const forA = await notify(t, a.userId, { category: "payment", title: "Pembayaran A ditolak" });
    await t.jobs.drainOutbox();
    expect((await deliveryOf(t, forA.id, "push")).status).toBe("pending");

    // B masuk di perangkat yang sama; aplikasi mendaftarkan token FCM yang sama.
    await registerDeviceOk(t, b.accessToken, token);
    expect(await tokenRow(t, token)).toMatchObject({ userId: b.userId, revokedAt: null });
    expect(await deliveryOf(t, forA.id, "push")).toMatchObject({
      status: "cancelled",
      errorClass: "token_reassigned",
    });
    t.clock.advance(deliveryBackoffMs(1));
    await t.jobs.runScheduled("notifications.retry");
    const forB = await notify(t, b.userId, { category: "event", title: "Tiket B terbit", route: "/tickets" });
    await t.jobs.drainOutbox();
    expect((await deliveryOf(t, forB.id, "push")).status).toBe("sent");
    const titles = t.push.to(token).map((msg) => msg.title);
    expect(titles).toEqual(["Pembayaran A ditolak", "Tiket B terbit"]);
    // Pengiriman pertama untuk A gagal SEBELUM perpindahan; tidak ada pengiriman A setelah B mendaftar.
    expect(t.push.to(token).filter((msg) => msg.data.notification_id === forA.id)).toHaveLength(1);
    // Notifikasi baru untuk A tidak lagi menargetkan token itu.
    const laterA = await notify(t, a.userId, { category: "payment" });
    await t.jobs.drainOutbox();
    expect((await deliveriesOf(t, laterA.id)).map((r) => r.channel)).toEqual(["email"]);
  });

  it("AC F13-1: pengguna yang sama mendaftar ulang setelah rotasi refresh atau login baru → pending tidak dibatalkan dan tetap terkirim", async () => {
    const m = await member();
    const token = fcmToken();
    await registerDeviceOk(t, m.accessToken, token);
    holdNextPush(token);
    const waiting = await notify(t, m.userId, { category: "event", route: "/events" });
    await t.jobs.drainOutbox();

    const refreshed = await api().post("/auth/refresh", { refresh_token: m.refreshToken });
    expect(refreshed.statusCode).toBe(200);
    const rotatedAccess = (refreshed.json() as { access_token: string }).access_token;
    await registerDeviceOk(t, rotatedAccess, token);
    const relogin = await signInAlumni(t, m);
    await registerDeviceOk(t, relogin.accessToken, token);
    expect((await deliveryOf(t, waiting.id, "push")).status).toBe("pending");

    // Token kini terikat ke baris sesi aktif keluarga login baru.
    const row = await tokenRow(t, token);
    const [session] = await t.db.select().from(sessions).where(eq(sessions.id, row!.sessionId!));
    expect(session!.revokedAt).toBeNull();
    expect(session!.replacedBy).toBeNull();

    t.clock.advance(deliveryBackoffMs(1));
    await t.jobs.runScheduled("notifications.retry");
    expect(await deliveryOf(t, waiting.id, "push")).toMatchObject({ status: "sent", attempt: 2 });
  });

  it("AC F13-1: token FCM diperbarui → token lama keluarga yang sama dicabut, pending dipindahkan ke token baru tanpa duplikasi", async () => {
    const m = await member();
    const oldToken = fcmToken("lama");
    const newToken = fcmToken("baru");
    await registerDeviceOk(t, m.accessToken, oldToken);
    holdNextPush(oldToken);
    const waiting = await notify(t, m.userId, { category: "membership", route: "/kta" });
    await t.jobs.drainOutbox();
    expect((await deliveryOf(t, waiting.id, "push")).status).toBe("pending");

    await registerDeviceOk(t, m.accessToken, newToken);
    expect((await tokenRow(t, oldToken))!.revokedAt).not.toBeNull();
    const newRow = await tokenRow(t, newToken);
    const moved = await deliveryOf(t, waiting.id, "push");
    expect(moved).toMatchObject({ status: "pending", deviceTokenId: newRow!.id });

    t.clock.advance(deliveryBackoffMs(1));
    await t.jobs.runScheduled("notifications.retry");
    expect(t.push.to(newToken)).toHaveLength(1);
    expect(t.push.to(oldToken)).toHaveLength(1);
    expect((await deliveryOf(t, waiting.id, "push")).status).toBe("sent");
  });

  it("logout semua perangkat mencabut seluruh token akun; token keluarga lain tidak tersentuh oleh logout satu perangkat", async () => {
    const m = await member();
    const phone = fcmToken("ponsel");
    const tablet = fcmToken("tablet");
    await registerDeviceOk(t, m.accessToken, phone);
    const second = await signInAlumni(t, m);
    await registerDeviceOk(t, second.accessToken, tablet);
    expect((await api().post("/auth/logout", {}, { token: second.accessToken })).statusCode).toBe(204);
    expect((await tokenRow(t, tablet))!.revokedAt).not.toBeNull();
    expect((await tokenRow(t, phone))!.revokedAt).toBeNull();
    expect((await api().post("/auth/logout-all", {}, { token: m.accessToken })).statusCode).toBe(204);
    expect((await tokenRow(t, phone))!.revokedAt).not.toBeNull();
  });

  it("AC F13-5: sesi berakhir tanpa logout (kedaluwarsa) → job notifications.device-sweep mencabut tokennya dan membatalkan push pending; keluarga sesi aktif tidak tersentuh", async () => {
    expect(t.jobs.registry.scheduledJob("notifications.device-sweep")?.everyMs).toBe(3_600_000);
    const m = await member();
    const phone = fcmToken("ponsel-lama");
    const tablet = fcmToken("tablet-aktif");
    const orphan = fcmToken("tanpa-sesi");
    await registerDeviceOk(t, m.accessToken, phone);
    const second = await signInAlumni(t, m);
    await registerDeviceOk(t, second.accessToken, tablet);
    const third = await signInAlumni(t, m);
    await registerDeviceOk(t, third.accessToken, orphan);
    // Baris sesi lama dibersihkan sehingga token tidak lagi terikat keluarga mana pun (FK ON DELETE SET NULL).
    await t.db.update(deviceTokens).set({ sessionId: null }).where(eq(deviceTokens.token, orphan));
    holdNextPush(phone);
    const waiting = await notify(t, m.userId, { category: "event", route: "/events" });
    await t.jobs.drainOutbox();
    expect(
      (await deliveriesOf(t, waiting.id)).filter((r) => r.channel === "push").map((r) => r.status),
    ).toEqual(expect.arrayContaining(["pending", "sent"]));

    // Refresh token keluarga ponsel kedaluwarsa (60 hari tanpa membuka aplikasi), tanpa logout.
    const phoneRow = await tokenRow(t, phone);
    const [phoneSession] = await t.db.select().from(sessions).where(eq(sessions.id, phoneRow!.sessionId!));
    await t.db
      .update(sessions)
      .set({ expiresAt: new Date(t.clock.now().getTime() - 1000) })
      .where(eq(sessions.familyId, phoneSession!.familyId));
    // Sebelum sapuan pun sesi yang berakhir tidak dapat mendaftarkan token lagi.
    expect((await registerDevice(t, m.accessToken, phone)).statusCode).toBe(401);

    await t.jobs.runScheduled("notifications.device-sweep");
    expect((await tokenRow(t, phone))!.revokedAt).toEqual(t.clock.now());
    expect((await tokenRow(t, orphan))!.revokedAt).toEqual(t.clock.now());
    expect((await tokenRow(t, tablet))!.revokedAt).toBeNull();
    const phonePush = (await deliveriesOf(t, waiting.id)).find((r) => r.deviceTokenId === phoneRow!.id);
    expect(phonePush).toMatchObject({ status: "cancelled", errorClass: "token_revoked" });

    // Notifikasi berikutnya hanya ke perangkat dengan sesi aktif; sapuan ulang tidak mengubah apa pun.
    const next = await notify(t, m.userId, { category: "event", route: "/events" });
    await t.jobs.drainOutbox();
    const tabletRow = await tokenRow(t, tablet);
    expect(
      (await deliveriesOf(t, next.id)).filter((r) => r.channel === "push").map((r) => r.deviceTokenId),
    ).toEqual([tabletRow!.id]);
    expect(await t.app.get(DevicesService).revokeEndedSessionTokens()).toBe(0);
  });

  it("AC F13-5: sapuan tidak mencabut token yang didaftarkan ulang ke sesi baru setelah dipilih sebagai kandidat", async () => {
    const devices = t.app.get(DevicesService);
    const m = await member();
    const token = fcmToken("login-ulang");
    await registerDeviceOk(t, m.accessToken, token);
    const row = await tokenRow(t, token);
    const [session] = await t.db.select().from(sessions).where(eq(sessions.id, row!.sessionId!));
    await t.db
      .update(sessions)
      .set({ expiresAt: new Date(t.clock.now().getTime() - 1000) })
      .where(eq(sessions.familyId, session!.familyId));
    const candidates = (await devices.findEndedSessionTokens(t.clock.now(), 1000)).filter(
      (c) => c.id === row!.id,
    );
    expect(candidates).toEqual([{ id: row!.id, sessionId: row!.sessionId }]);

    // Bersamaan: anggota masuk lagi dan aplikasi mendaftarkan token yang sama ke keluarga sesi baru.
    const relogin = await signInAlumni(t, m);
    await registerDeviceOk(t, relogin.accessToken, token);
    expect(await devices.revokeUnchangedTokens(candidates, t.clock.now())).toBe(0);
    expect(await tokenRow(t, token)).toMatchObject({ revokedAt: null, userId: m.userId });
    expect((await tokenRow(t, token))!.sessionId).not.toBe(row!.sessionId);
  });
});

describe("POST /devices/unregister (unregisterDevice)", () => {
  it("AC F13-5: hanya token milik pemanggil dicabut dan pending-nya dibatalkan; token lain/asing diabaikan dengan respons sama; berulang 204", async () => {
    const owner = await member();
    const other = await member();
    const token = fcmToken();
    await registerDeviceOk(t, owner.accessToken, token);
    holdNextPush(token);
    const waiting = await notify(t, owner.userId, { category: "event", route: "/events" });
    await t.jobs.drainOutbox();

    const foreign = await api().post("/devices/unregister", { token }, { token: other.accessToken });
    expect(foreign.statusCode).toBe(204);
    expectOperation("post", "/devices/unregister", foreign);
    expect((await tokenRow(t, token))!.revokedAt).toBeNull();
    const unknown = await api().post(
      "/devices/unregister",
      { token: fcmToken() },
      { token: other.accessToken },
    );
    expect(unknown.statusCode).toBe(204);

    for (let i = 0; i < 2; i++) {
      const res = await api().post("/devices/unregister", { token }, { token: owner.accessToken });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
    }
    expect((await tokenRow(t, token))!.revokedAt).not.toBeNull();
    expect(await deliveryOf(t, waiting.id, "push")).toMatchObject({
      status: "cancelled",
      errorClass: "token_revoked",
    });
  });

  it("validasi dan otorisasi: body tidak valid 400; tanpa sesi 401; token admin 403", async () => {
    const m = await member();
    for (const body of [{}, { token: "" }, { token: "a b" }, { token: fcmToken(), platform: "android" }]) {
      const res = await api().post("/devices/unregister", body, { token: m.accessToken });
      expect(res.statusCode).toBe(400);
      expectOperation("post", "/devices/unregister", res);
    }
    const unauth = await api().post("/devices/unregister", { token: fcmToken() });
    expect(unauth.statusCode).toBe(401);
    const admin = await createAdmin(t, { role: "super_admin" });
    const session = await signInAdmin(t, admin);
    const forbidden = await api().post(
      "/devices/unregister",
      { token: fcmToken() },
      { token: session.accessToken },
    );
    expect(forbidden.statusCode).toBe(403);
    expectOperation("post", "/devices/unregister", forbidden);
  });
});

describe("Kerahasiaan token (ARCHITECTURE §2 butir 3)", () => {
  it("token tidak pernah dikembalikan API maupun tersimpan selain di device_tokens", async () => {
    const m = await member();
    const token = fcmToken("rahasia");
    const res = await registerDevice(t, m.accessToken, token);
    expect(res.body).toBe("");
    const rows = await t.db.select().from(deviceTokens).where(eq(deviceTokens.userId, m.userId));
    expect(rows).toHaveLength(1);
  });
});
