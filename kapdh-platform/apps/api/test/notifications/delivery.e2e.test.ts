import { deviceTokens, notificationDeliveries, outboxEvents, users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DELIVERY_LEASE_MS,
  DELIVERY_MAX_ATTEMPTS,
  deliveryBackoffMs,
} from "../../src/modules/notifications/delivery-policy.js";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  deliveriesOf,
  deliveryOf,
  deliveryService,
  fcmToken,
  inboxCount,
  notify,
  registerDeviceOk,
  tokenRow,
} from "./support.js";

/**
 * Prosesor pengiriman notifikasi (F-13; ARCHITECTURE §4.7, §4.8): `notifications.deliver` (topik outbox
 * notification.created) dan `notifications.retry`. FakePush dan MemoryMailer menggantikan FCM/SMTP.
 */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(() => {
  t.push.clear();
  t.mailer.messages.length = 0;
});
afterAll(async () => {
  await t.app.close();
});

async function memberWithDevice(options: { devices?: number } = {}) {
  const fixture = await createAlumni(t, { status: "verified", fullName: "Ahmad Fauzi" });
  const session = await signInAlumni(t, fixture);
  const tokens: string[] = [];
  for (let i = 0; i < (options.devices ?? 1); i++) {
    const token = fcmToken(`m${i}`);
    // Perangkat kedua memakai sesi login terpisah (keluarga lain), seperti ponsel dan tablet.
    const access = i === 0 ? session.accessToken : (await signInAlumni(t, fixture)).accessToken;
    await registerDeviceOk(t, access, token);
    tokens.push(token);
  }
  return { ...fixture, accessToken: session.accessToken, tokens };
}

async function setPreferences(
  accessToken: string,
  patch: { push?: Record<string, boolean>; email?: Record<string, boolean> },
) {
  const res = await api().put(
    "/notifications/preferences",
    {
      push: { payment: true, membership: true, event: true, news: true, chat: true, ...patch.push },
      email: { payment: true, membership: true, event: true, ...patch.email },
    },
    { token: accessToken },
  );
  expect(res.statusCode, res.body).toBe(200);
}

describe("notifications.deliver (AC F13-1)", () => {
  it("AC F13-1: keputusan pembayaran committed → satu notification_id; push per token aktif + email dijadwalkan dan terkirim", async () => {
    const m = await memberWithDevice({ devices: 2 });
    const paymentId = uuidv7();
    const created = await notify(t, m.userId, {
      category: "payment",
      title: "Pembayaran disetujui",
      body: "Iuran pendaftaran telah disetujui. KTA Anda aktif.",
      route: `/payments/${paymentId}`,
      dedupKey: `payment.decided:${paymentId}`,
    });
    expect(await t.jobs.drainOutbox()).toMatchObject({ dispatched: 1, failed: 0, dead: 0 });

    const rows = await deliveriesOf(t, created.id);
    expect(rows.map((r) => [r.channel, r.status])).toEqual([
      ["email", "sent"],
      ["push", "sent"],
      ["push", "sent"],
    ]);
    for (const row of rows)
      expect(row).toMatchObject({
        attempt: 1,
        providerStatus: "accepted",
        errorClass: null,
        nextRetryAt: null,
      });
    for (const token of m.tokens) {
      const [message] = t.push.to(token);
      expect(message).toEqual({
        token,
        platform: "android",
        title: "Pembayaran disetujui",
        body: "Iuran pendaftaran telah disetujui. KTA Anda aktif.",
        data: {
          notification_id: created.id,
          category: "payment",
          route: `/payments/${paymentId}`,
          deep_link: `kapdh://app/payments/${paymentId}`,
        },
        collapseKey: created.id,
      });
    }
    const [mail] = t.mailer.messagesTo(m.email);
    expect(mail!.subject).toBe("KAPDH: Pembayaran disetujui");
    expect(mail!.text).toContain("Halo, Ahmad Fauzi.");
    expect(mail!.text).toContain(`kapdh://app/payments/${paymentId}`);
  });

  it("AC F13-1, F13-6: outbox/handler/job diulang dan notify ulang dengan kunci dedup sama tidak menggandakan inbox, pengiriman, maupun push", async () => {
    const m = await memberWithDevice();
    const dedupKey = `payment.decided:${uuidv7()}`;
    const created = await notify(t, m.userId, { dedupKey });
    await t.jobs.drainOutbox();
    expect(t.push.sent).toHaveLength(1);
    expect(t.mailer.messages).toHaveLength(1);

    // Dispatcher mengirim ulang event yang sama (crash setelah handler, sebelum status dispatched).
    await t.db
      .update(outboxEvents)
      .set({ status: "pending", nextAttemptAt: t.clock.now(), dispatchedAt: null })
      .where(eq(outboxEvents.dedupKey, `notification.created:${created.id}`));
    expect(await t.jobs.drainOutbox()).toMatchObject({ dispatched: 1 });
    expect(await deliveryService(t).deliver(created.id)).toMatchObject({ claimed: 0 });
    expect(await notify(t, m.userId, { dedupKey })).toEqual({ id: created.id, created: false });
    await t.jobs.drainOutbox();
    await t.jobs.runScheduled("notifications.retry");

    expect(await inboxCount(t, m.userId)).toBe(1);
    expect(await deliveriesOf(t, created.id)).toHaveLength(2);
    expect(t.push.sent).toHaveLength(1);
    expect(t.mailer.messages).toHaveLength(1);
  });

  it("AC F13-1: notifikasi yang sudah tidak ada (akun dihapus) atau penerima nonaktif tidak menghasilkan pengiriman", async () => {
    expect(await deliveryService(t).deliver(uuidv7())).toMatchObject({ claimed: 0 });
    const m = await memberWithDevice();
    await t.db.update(users).set({ status: "disabled" }).where(eq(users.id, m.userId));
    const created = await notify(t, m.userId, { category: "security", title: "Akun dinonaktifkan" });
    await t.jobs.drainOutbox();
    expect(await deliveriesOf(t, created.id)).toEqual([]);
    expect(await inboxCount(t, m.userId)).toBe(1);
  });
});

describe("Preferensi dan kategori (AC F13-2)", () => {
  it("AC F13-2: kategori dimatikan → tanpa push/email tetapi inbox tetap; news/chat tanpa email; security/account selalu", async () => {
    const m = await memberWithDevice();
    await setPreferences(m.accessToken, { push: { payment: false }, email: { payment: false } });

    const payment = await notify(t, m.userId, { category: "payment" });
    const news = await notify(t, m.userId, { category: "news", route: "/news/reuni-akbar-2026" });
    const chat = await notify(t, m.userId, {
      category: "chat",
      title: "Pesan baru",
      route: "/chat/invitations",
    });
    const security = await notify(t, m.userId, { category: "security", route: "/account/sessions" });
    const account = await notify(t, m.userId, { category: "account", route: "/restricted" });
    await t.jobs.drainOutbox();

    expect(await deliveriesOf(t, payment.id)).toEqual([]);
    expect((await deliveriesOf(t, news.id)).map((r) => r.channel)).toEqual(["push"]);
    expect((await deliveriesOf(t, chat.id)).map((r) => r.channel)).toEqual(["push"]);
    expect((await deliveriesOf(t, security.id)).map((r) => r.channel)).toEqual(["email", "push"]);
    expect((await deliveriesOf(t, account.id)).map((r) => r.channel)).toEqual(["email", "push"]);
    expect(await inboxCount(t, m.userId)).toBe(5);

    // Email dimatikan, push aktif: hanya push.
    await setPreferences(m.accessToken, { email: { event: false } });
    const event = await notify(t, m.userId, { category: "event", route: "/tickets" });
    await t.jobs.drainOutbox();
    expect((await deliveriesOf(t, event.id)).map((r) => r.channel)).toEqual(["push"]);
  });

  it("AC F13-2: preferensi dimatikan setelah dijadwalkan → pengiriman pending dibatalkan worker (preference_disabled)", async () => {
    const m = await memberWithDevice();
    t.push.failNext(m.tokens[0]!, {
      ok: false,
      errorClass: "unavailable",
      retryable: true,
      deactivateToken: false,
    });
    const created = await notify(t, m.userId, { category: "membership", route: "/kta" });
    await t.jobs.drainOutbox();
    expect((await deliveryOf(t, created.id, "push")).status).toBe("pending");
    await setPreferences(m.accessToken, { push: { membership: false } });
    t.clock.advance(deliveryBackoffMs(1));
    await t.jobs.runScheduled("notifications.retry");
    expect(await deliveryOf(t, created.id, "push")).toMatchObject({
      status: "cancelled",
      errorClass: "preference_disabled",
      nextRetryAt: null,
    });
    expect(t.push.sent).toHaveLength(1);
  });

  it("AC F13-2: push tanpa konfigurasi FCM (DisabledPush) dilewati; inbox dan email tetap", async () => {
    const m = await memberWithDevice();
    t.push.enabled = false;
    try {
      const created = await notify(t, m.userId, { category: "payment" });
      await t.jobs.drainOutbox();
      expect((await deliveriesOf(t, created.id)).map((r) => r.channel)).toEqual(["email"]);
    } finally {
      t.push.enabled = true;
    }
  });
});

describe("Kelas galat FCM dan retry (AC F13-4, R5)", () => {
  it("AC F13-4: UNREGISTERED → token dinonaktifkan, pengiriman failed, pending lain dibatalkan; notifikasi berikutnya tidak ke token itu", async () => {
    const m = await memberWithDevice();
    const token = m.tokens[0]!;
    // Pengiriman lain yang masih menunggu retry pada token yang sama.
    t.push.failNext(token, { ok: false, errorClass: "unavailable", retryable: true, deactivateToken: false });
    const waiting = await notify(t, m.userId, { category: "event", route: "/tickets" });
    await t.jobs.drainOutbox();
    expect((await deliveryOf(t, waiting.id, "push")).status).toBe("pending");

    t.push.failNext(token, {
      ok: false,
      errorClass: "unregistered",
      retryable: false,
      deactivateToken: true,
    });
    const created = await notify(t, m.userId);
    await t.jobs.drainOutbox();
    expect(await deliveryOf(t, created.id, "push")).toMatchObject({
      status: "failed",
      errorClass: "UNREGISTERED",
      attempt: 1,
      nextRetryAt: null,
      sentAt: null,
    });
    expect(await deliveryOf(t, waiting.id, "push")).toMatchObject({
      status: "cancelled",
      errorClass: "token_revoked",
    });
    const row = await tokenRow(t, token);
    expect(row!.revokedAt).toEqual(t.clock.now());
    expect(row).toMatchObject({ failureClass: "UNREGISTERED", failureCount: 2 });
    // Email tetap terkirim (kanal lain tidak terpengaruh).
    expect((await deliveryOf(t, created.id, "email")).status).toBe("sent");

    const next = await notify(t, m.userId);
    await t.jobs.drainOutbox();
    expect((await deliveriesOf(t, next.id)).map((r) => r.channel)).toEqual(["email"]);
  });

  it("AC F13-4: INVALID_ARGUMENT karena token menonaktifkan token; INVALID_ARGUMENT payload gagal tanpa menonaktifkan", async () => {
    const m = await memberWithDevice();
    const token = m.tokens[0]!;
    t.push.failNext(token, {
      ok: false,
      errorClass: "invalid_argument",
      retryable: false,
      deactivateToken: false,
    });
    const payload = await notify(t, m.userId);
    await t.jobs.drainOutbox();
    expect(await deliveryOf(t, payload.id, "push")).toMatchObject({
      status: "failed",
      errorClass: "INVALID_ARGUMENT",
    });
    expect((await tokenRow(t, token))!.revokedAt).toBeNull();

    t.push.failNext(token, {
      ok: false,
      errorClass: "invalid_argument",
      retryable: false,
      deactivateToken: true,
    });
    const invalidToken = await notify(t, m.userId);
    await t.jobs.drainOutbox();
    expect((await deliveryOf(t, invalidToken.id, "push")).status).toBe("failed");
    expect((await tokenRow(t, token))!.revokedAt).not.toBeNull();
  });

  it("AC F13-4: 429/5xx/jaringan → retry dengan backoff eksponensial tanpa menonaktifkan token; setelah batas → failed", async () => {
    const m = await memberWithDevice();
    const token = m.tokens[0]!;
    const classes = [
      "quota_exceeded",
      "unavailable",
      "internal",
      "network",
      "unavailable",
      "quota_exceeded",
    ] as const;
    for (const errorClass of classes)
      t.push.failNext(token, { ok: false, errorClass, retryable: true, deactivateToken: false });
    const created = await notify(t, m.userId);
    await t.jobs.drainOutbox();
    for (let attempt = 1; attempt < DELIVERY_MAX_ATTEMPTS; attempt++) {
      const row = await deliveryOf(t, created.id, "push");
      expect(row, `percobaan ${attempt}`).toMatchObject({ status: "pending", attempt });
      expect(row.nextRetryAt!.getTime() - t.clock.now().getTime()).toBe(deliveryBackoffMs(attempt));
      expect((await tokenRow(t, token))!.revokedAt).toBeNull();
      // Belum jatuh tempo: job retry tidak mengirim.
      t.clock.advance(deliveryBackoffMs(attempt) - 1000);
      await t.jobs.runScheduled("notifications.retry");
      expect(t.push.to(token)).toHaveLength(attempt);
      t.clock.advance(1000);
      await t.jobs.runScheduled("notifications.retry");
    }
    expect(await deliveryOf(t, created.id, "push")).toMatchObject({
      status: "failed",
      attempt: DELIVERY_MAX_ATTEMPTS,
      errorClass: "QUOTA_EXCEEDED",
      nextRetryAt: null,
    });
    expect(t.push.to(token)).toHaveLength(DELIVERY_MAX_ATTEMPTS);
    expect(await tokenRow(t, token)).toMatchObject({
      revokedAt: null,
      failureClass: "QUOTA_EXCEEDED",
      failureCount: DELIVERY_MAX_ATTEMPTS,
    });
  });

  it("AC F13-4: Retry-After FCM dihormati; sukses setelah retry mereset penghitung kegagalan token", async () => {
    const m = await memberWithDevice();
    const token = m.tokens[0]!;
    t.push.failNext(token, {
      ok: false,
      errorClass: "quota_exceeded",
      retryable: true,
      deactivateToken: false,
      retryAfterSeconds: 600,
    });
    const created = await notify(t, m.userId);
    await t.jobs.drainOutbox();
    const pending = await deliveryOf(t, created.id, "push");
    expect(pending.nextRetryAt!.getTime() - t.clock.now().getTime()).toBe(600_000);
    t.clock.advance(600_000);
    await t.jobs.runScheduled("notifications.retry");
    expect(await deliveryOf(t, created.id, "push")).toMatchObject({
      status: "sent",
      attempt: 2,
      providerStatus: "accepted",
      errorClass: null,
    });
    expect(await tokenRow(t, token)).toMatchObject({ failureCount: 0, failureClass: null, revokedAt: null });
  });

  it("status sent berarti diterima provider (accepted), bukan dibaca: read_at inbox tetap kosong", async () => {
    const m = await memberWithDevice();
    const created = await notify(t, m.userId);
    await t.jobs.drainOutbox();
    const push = await deliveryOf(t, created.id, "push");
    expect(push).toMatchObject({ status: "sent", providerStatus: "accepted" });
    expect(push.providerMessageId).toMatch(/^projects\/uji\/messages\//);
    expect(push.sentAt).toEqual(t.clock.now());
    const res = await api().get(`/notifications/${created.id}`, { token: m.accessToken });
    expect((res.json() as { read_at: string | null }).read_at).toBeNull();
  });
});

describe("Email transaksional (F-13)", () => {
  it("bounce permanen → failed tanpa retry; timeout → retry lalu terkirim", async () => {
    const m = await memberWithDevice();
    t.mailer.failNext(Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 }));
    const bounced = await notify(t, m.userId, { category: "membership", route: "/kta" });
    await t.jobs.drainOutbox();
    expect(await deliveryOf(t, bounced.id, "email")).toMatchObject({
      status: "failed",
      errorClass: "bounce_hard",
      attempt: 1,
    });

    t.mailer.failNext(Object.assign(new Error("koneksi habis waktu"), { code: "ETIMEDOUT" }));
    const timeout = await notify(t, m.userId, { category: "event", route: "/events" });
    await t.jobs.drainOutbox();
    expect(await deliveryOf(t, timeout.id, "email")).toMatchObject({
      status: "pending",
      errorClass: "timeout",
    });
    t.clock.advance(deliveryBackoffMs(1));
    await t.jobs.runScheduled("notifications.retry");
    expect(await deliveryOf(t, timeout.id, "email")).toMatchObject({
      status: "sent",
      attempt: 2,
      errorClass: null,
      providerStatus: "accepted",
    });
    expect(t.mailer.messagesTo(m.email)).toHaveLength(1);
  });
});

describe("Payload layar kunci (F-13)", () => {
  it("push hanya membawa judul, isi ringkas dan rute; kontak disamarkan; data tanpa isi", async () => {
    const m = await memberWithDevice();
    const roomId = uuidv7();
    const created = await notify(t, m.userId, {
      category: "chat",
      title: "Pesan baru dari Budi",
      body: "Budi mengirim pesan. Hubungi budi@contoh.test atau 0812 3456 7890",
      route: `/chat/${roomId}`,
      data: { room_kind: "direct" },
    });
    await t.jobs.drainOutbox();
    const [message] = t.push.to(m.tokens[0]!);
    expect(message!.body).toBe("Budi mengirim pesan. Hubungi [disembunyikan] atau [disembunyikan]");
    expect(message!.data).toEqual({
      notification_id: created.id,
      category: "chat",
      route: `/chat/${roomId}`,
      deep_link: `kapdh://app/chat/${roomId}`,
    });
    expect(JSON.stringify(message!.data)).not.toContain("budi@");

    const noBody = await notify(t, m.userId, { category: "membership", body: null, route: null });
    await t.jobs.drainOutbox();
    const [plain] = t.push.to(m.tokens[0]!).filter((msg) => msg.data.notification_id === noBody.id);
    expect(plain).toMatchObject({
      body: "Ketuk untuk melihat detail di aplikasi KAPDH.",
      data: { notification_id: noBody.id, category: "membership" },
    });
    expect(plain!.data).not.toHaveProperty("route");
  });
});

describe("Klaim worker: lease, pembatalan saat klaim (kontrak C7)", () => {
  it("pengiriman yang sedang diklaim (lease) tidak diklaim worker lain; setelah lease habis diklaim ulang", async () => {
    const m = await memberWithDevice();
    const created = await notify(t, m.userId, { category: "news", route: "/news" });
    await deliveryService(t).schedule(created.id);
    // Simulasi worker lain yang sudah mengklaim lalu mati sebelum mencatat hasil.
    await t.db
      .update(notificationDeliveries)
      .set({ attempt: 1, nextRetryAt: new Date(t.clock.now().getTime() + DELIVERY_LEASE_MS) })
      .where(eq(notificationDeliveries.notificationId, created.id));
    await t.jobs.runScheduled("notifications.retry");
    expect(t.push.sent).toHaveLength(0);
    t.clock.advance(DELIVERY_LEASE_MS);
    await t.jobs.runScheduled("notifications.retry");
    expect(await deliveryOf(t, created.id, "push")).toMatchObject({ status: "sent", attempt: 2 });
    expect(t.push.sent).toHaveLength(1);
    await t.jobs.drainOutbox();
    expect(t.push.sent).toHaveLength(1);
  });

  it("penerima dinonaktifkan atau token dicabut setelah dijadwalkan → dibatalkan saat klaim, tidak dikirim", async () => {
    const a = await memberWithDevice();
    const b = await memberWithDevice();
    const forA = await notify(t, a.userId, { category: "account", route: "/account" });
    const forB = await notify(t, b.userId, { category: "event", route: "/events" });
    await deliveryService(t).schedule(forA.id);
    await deliveryService(t).schedule(forB.id);
    await t.db.update(users).set({ status: "disabled" }).where(eq(users.id, a.userId));
    await t.db
      .update(deviceTokens)
      .set({ revokedAt: t.clock.now() })
      .where(eq(deviceTokens.token, b.tokens[0]!));
    await t.jobs.runScheduled("notifications.retry");
    expect((await deliveriesOf(t, forA.id)).map((r) => [r.channel, r.status, r.errorClass])).toEqual([
      ["email", "cancelled", "recipient_unavailable"],
      ["push", "cancelled", "recipient_unavailable"],
    ]);
    expect(await deliveryOf(t, forB.id, "push")).toMatchObject({
      status: "cancelled",
      errorClass: "token_revoked",
    });
    expect((await deliveryOf(t, forB.id, "email")).status).toBe("sent");
    expect(t.push.sent).toHaveLength(0);
  });

  it("dua putaran retry bersamaan tidak mengirim pengiriman yang sama dua kali", async () => {
    const m = await memberWithDevice({ devices: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const created = await notify(t, m.userId, { category: "news", route: "/news" });
      await deliveryService(t).schedule(created.id);
      ids.push(created.id);
    }
    await Promise.all([
      t.jobs.runScheduled("notifications.retry"),
      t.jobs.runScheduled("notifications.retry"),
      deliveryService(t).sendDue(),
    ]);
    expect(t.push.sent).toHaveLength(12);
    const keys = t.push.sent.map((msg) => `${msg.token}:${msg.data.notification_id}`);
    expect(new Set(keys).size).toBe(12);
  });
});

describe("Pendaftaran job (ARCHITECTURE §4.8)", () => {
  it("handler topik notification.created dan job notifications.retry (setiap menit) terdaftar", () => {
    expect(t.jobs.registry.topics()).toContain("notification.created");
    expect(t.jobs.registry.scheduledJob("notifications.retry")?.everyMs).toBe(60_000);
  });
});
