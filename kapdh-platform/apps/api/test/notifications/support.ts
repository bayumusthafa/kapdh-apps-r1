/**
 * Helper uji modul notifications (F-13): membuat notifikasi lewat kernel (seperti modul domain yang memanggil
 * NotificationService.notify di transaksi bisnisnya), mendaftarkan perangkat lewat endpoint nyata, dan membaca baris
 * pengiriman/token.
 */
import { deviceTokens, notificationDeliveries, notifications } from "@kapdh/database";
import { and, asc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import {
  NotificationService,
  type NotifyInput,
} from "../../src/core/notifications-kernel/notification.service.js";
import { NotificationDeliveryService } from "../../src/modules/notifications/delivery.service.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";

export type NotifyFixture = Partial<Omit<NotifyInput, "userId">>;

/** Notifikasi baru (inbox + outbox notification.created) dalam transaksi system, seperti keputusan domain. */
export async function notify(t: TestApp, userId: string, input: NotifyFixture = {}) {
  const service = t.app.get(NotificationService);
  return runAsSystem(() =>
    withTx(t.db, (tx) =>
      service.notify(tx, {
        userId,
        category: input.category ?? "payment",
        title: input.title ?? "Pembayaran disetujui",
        body: input.body === undefined ? "Iuran Anda telah disetujui pengurus." : input.body,
        route: input.route === undefined ? `/payments/${uuidv7()}` : input.route,
        data: input.data,
        dedupKey: input.dedupKey ?? `uji:${uuidv7()}`,
      }),
    ),
  );
}

/** PUT /devices dengan access token anggota; mengembalikan respons. */
export async function registerDevice(
  t: TestApp,
  accessToken: string,
  token: string,
  platform: "android" | "ios" = "android",
) {
  return httpClient(t.app).put(
    "/devices",
    { platform, token, app_version: "1.0.0" },
    { token: accessToken },
  );
}

export async function registerDeviceOk(t: TestApp, accessToken: string, token: string) {
  const res = await registerDevice(t, accessToken, token);
  expect(res.statusCode, res.body).toBe(204);
}

export function deliveryService(t: TestApp): NotificationDeliveryService {
  return t.app.get(NotificationDeliveryService);
}

/** Pengiriman satu notifikasi, urut nama kanal (email, push) lalu id. */
export async function deliveriesOf(t: TestApp, notificationId: string) {
  const rows = await t.db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.notificationId, notificationId))
    .orderBy(asc(notificationDeliveries.id));
  return rows.sort((a, b) => a.channel.localeCompare(b.channel));
}

export async function deliveryOf(t: TestApp, notificationId: string, channel: "push" | "email") {
  const rows = await t.db
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.notificationId, notificationId),
        eq(notificationDeliveries.channel, channel),
      ),
    );
  expect(rows, `pengiriman ${channel} untuk ${notificationId}`).toHaveLength(1);
  return rows[0]!;
}

export async function tokenRow(t: TestApp, token: string) {
  const [row] = await t.db.select().from(deviceTokens).where(eq(deviceTokens.token, token));
  return row;
}

export async function inboxCount(t: TestApp, userId: string) {
  return (await t.db.select().from(notifications).where(eq(notifications.userId, userId))).length;
}

/** Token FCM sintetis unik. */
export function fcmToken(label = "perangkat"): string {
  return `fcm-${label}-${uuidv7()}`;
}
