import {
  events,
  notificationDeliveries,
  notifications,
  paymentAdjustments,
  payments,
  reports,
  roomMembers,
  rooms,
  tickets,
} from "@kapdh/database";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBusinessDaysJakarta } from "../../src/modules/payments/business-days.js";
import { expectOperation } from "../support/contract.js";
import { type AlumniFixture, createAlumni } from "../support/factories.js";
import { httpClient, type HttpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { type AdminActor, type JsonBody, superAdminActor } from "./helpers.js";

/**
 * Integrasi Fase C (temuan 7 api-admin; kontrak C7 admin-dashboard "satu query ringkasan bersama dengan modul payments,
 * bukan rumus kedua", C6 admin-moderation butir c, C7 admin-notifications retryable): untuk pemanggil yang SAMA, angka
 * dasbor dan lencana sama dengan daftar domain pemiliknya. Data sengaja memuat kasus batas yang dulu berbeda antara
 * rumus modul admin dan modul domain:
 * - payment berbukti yang `review_due_at`-nya TEPAT sama dengan waktu server (payments: lewat batas `<=`),
 * - penyesuaian yang `due_at`-nya tepat sama dengan waktu server,
 * - kegagalan pengiriman ke akun `deletion_pending` (retryable: akun bukan disabled/deleted).
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;

let t: TestApp;
let api: HttpClient;
let now: Date;
let linked: AlumniFixture;
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

const snapshot = {
  kind: "bank",
  provider: "Bank Uji",
  account_number: "7000123456",
  account_holder: "KAPDH",
};

async function payment(
  values: Partial<typeof payments.$inferInsert> & {
    userId: string;
    type: "registration" | "renewal" | "ticket";
  },
) {
  const id = uuidv7();
  await t.db.insert(payments).values({
    id,
    status: "pending",
    amount: "60000.00",
    linesSnapshot: [{ code: values.type, label: "Uji", amount: "60000.00" }],
    methodSnapshot: snapshot,
    settingsVersion: values.type === "ticket" ? null : 1,
    proofVersion: 0,
    createdAt: at(-10 * DAY),
    updatedAt: at(-10 * DAY),
    ...values,
  });
  return id;
}

/** Waktu kirim bukti iuran yang batas review-nya (+1 hari kerja) TEPAT sama dengan `now`. */
function submittedDueExactlyNow(): Date {
  for (let days = 1; days <= 4; days++) {
    const candidate = at(-days * DAY);
    if (addBusinessDaysJakarta(candidate, 1).getTime() === now.getTime()) return candidate;
  }
  throw new Error("Tidak ada waktu kirim yang batasnya tepat sekarang");
}

async function seed(): Promise<void> {
  now = t.clock.now();
  const owner = () => createAlumni(t, { status: "verified" });
  linked = await owner();

  // Pembayaran: tepat di batas, jauh lewat batas, belum lewat batas, tanpa bukti, tiket yang check-in-nya sudah dibuka.
  await payment({
    userId: (await owner()).userId,
    type: "registration",
    proofVersion: 1,
    submittedAt: submittedDueExactlyNow(),
  });
  await payment({
    userId: (await owner()).userId,
    type: "renewal",
    proofVersion: 1,
    submittedAt: at(-6 * DAY),
  });
  await payment({ userId: (await owner()).userId, type: "renewal", proofVersion: 1, submittedAt: at(-HOUR) });
  await payment({ userId: (await owner()).userId, type: "registration" });
  const eventId = uuidv7();
  await t.db.insert(events).values({
    id: eventId,
    title: "Event Uji Antrean",
    startsAt: at(2 * HOUR),
    endsAt: at(5 * HOUR),
    registrationOpensAt: at(-30 * DAY),
    registrationClosesAt: at(HOUR),
    price: "60000.00",
    seatsTotal: 10,
    status: "open",
    locationName: "Aula",
  });
  const ticketOwner = await owner();
  const ticketId = uuidv7();
  await t.db.insert(tickets).values({
    id: ticketId,
    eventId,
    userId: ticketOwner.userId,
    status: "awaiting_review",
    totalSnapshot: "60000.00",
  });
  const paid = await payment({
    userId: ticketOwner.userId,
    type: "ticket",
    ticketId,
    proofVersion: 1,
    submittedAt: at(-HOUR),
  });
  await t.db.insert(paymentAdjustments).values([
    { id: uuidv7(), paymentId: paid, kind: "correction", amount: "1000.00", reason: "Uji", dueAt: now },
    { id: uuidv7(), paymentId: paid, kind: "correction", amount: "1000.00", reason: "Uji", dueAt: at(DAY) },
  ]);

  // Laporan: terbuka, ditinjau, tepat jatuh tempo, terhadap alumni tertaut pemanggil (tersembunyi), grup yang
  // diikutinya (tersembunyi), dan grup lain (terlihat).
  const reporter = (await owner()).userId;
  const target = (await owner()).userId;
  const report = (values: Partial<typeof reports.$inferInsert>) => ({
    id: uuidv7(),
    reporterId: reporter,
    targetType: "user" as const,
    targetUserId: target,
    category: "spam" as const,
    dueAt: at(DAY),
    createdAt: at(-HOUR),
    updatedAt: at(-HOUR),
    ...values,
  });
  const joined = uuidv7();
  const other = uuidv7();
  await t.db.insert(rooms).values([
    { id: joined, kind: "group", name: "Grup Tertaut", createdBy: linked.userId },
    { id: other, kind: "group", name: "Grup Lain", createdBy: reporter },
  ]);
  await t.db.insert(roomMembers).values([
    { roomId: joined, userId: linked.userId, role: "admin", status: "joined", joinedAt: at(-DAY) },
    { roomId: other, userId: reporter, role: "admin", status: "joined", joinedAt: at(-DAY) },
  ]);
  await t.db
    .insert(reports)
    .values([
      report({}),
      report({ status: "in_review", claimedAt: at(-HOUR) }),
      report({ priority: "urgent", category: "violence_threat", dueAt: now }),
      report({ targetUserId: linked.userId }),
      report({ targetType: "room", targetUserId: null, roomId: joined }),
      report({ targetType: "room", targetUserId: null, roomId: other }),
    ]);

  // Pengiriman gagal: akun aktif dan akun deletion_pending (keduanya retryable), serta di luar jendela 7 hari.
  const leaving = await createAlumni(t, { status: "verified", accountStatus: "deletion_pending" });
  for (const [userId, createdAt] of [
    [reporter, at(-DAY)],
    [leaving.userId, at(-DAY)],
    [reporter, at(-8 * DAY)],
  ] as const) {
    const notificationId = uuidv7();
    await t.db.insert(notifications).values({
      id: notificationId,
      userId,
      category: "payment",
      title: "Uji",
      dedupKey: `u:${userId}:${notificationId}`,
      createdAt,
    });
    await t.db
      .insert(notificationDeliveries)
      .values({ id: uuidv7(), notificationId, channel: "email", status: "failed", createdAt });
  }
}

beforeAll(async () => {
  t = await createTestApp();
  api = httpClient(t.app);
  await seed();
});
afterAll(async () => {
  await t.app.close();
});

async function getOk(
  actor: AdminActor,
  path: string,
  template: string = path.split("?")[0]!,
): Promise<JsonBody> {
  const res = await api.get(path, { token: actor.token });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", template, res) as JsonBody;
}

describe("AC F15-1: hitungan dasbor = daftar domain untuk pemanggil yang sama (satu rumus, kontrak C7/C6)", () => {
  it("AC F15-1: antrean pembayaran dasbor = GET /admin/payments/summary = total filter stage=awaiting_review&overdue=true", async () => {
    const root = await superAdminActor(t);
    const dashboard = (await getOk(root, "/admin/dashboard")).payments;
    const summary = await getOk(root, "/admin/payments/summary");
    const overdueList = await getOk(root, "/admin/payments?stage=awaiting_review&overdue=true&limit=100");

    // Batas tepat sekarang ikut lewat batas (iuran tepat di batas, iuran 6 hari, tiket yang check-in-nya dibuka).
    expect(summary.overdue_count).toBe(3);
    expect(summary.adjustments_overdue_count).toBe(1);
    for (const key of [
      "awaiting_review_count",
      "overdue_count",
      "awaiting_transfer_count",
      "awaiting_review_by_type",
      "adjustments_pending_count",
      "adjustments_overdue_count",
    ])
      expect(dashboard[key], key).toEqual(summary[key]);
    expect(overdueList.total).toBe(summary.overdue_count);
    const byType = dashboard.overdue_by_type as Record<string, number>;
    expect(byType).toEqual({ registration: 1, renewal: 1, ticket: 1 });
    expect(Object.values(byType).reduce((a, b) => a + b, 0)).toBe(dashboard.overdue_count);
  });

  it("AC F15-1, C6 butir c: laporan dasbor dan lencana = counts GET /admin/reports untuk pengurus bertaut alumni", async () => {
    const root = await superAdminActor(t, { linkedAlumniUserId: linked.userId });
    const moderation = (await getOk(root, "/admin/dashboard")).moderation;
    const counts = (await getOk(root, "/admin/reports")).counts;
    const badges = await getOk(root, "/admin/dashboard/badges");

    expect(moderation.open_count).toBe(4);
    expect(moderation.open_count).toBe(counts.open + counts.in_review);
    expect(moderation.urgent_count).toBe(counts.urgent);
    expect(moderation.overdue_count).toBe(counts.overdue);
    expect(badges.reports_open).toBe(moderation.open_count);
  });

  it("AC F15-1, AC F13-4: kegagalan pengiriman dasbor = total daftar status=failed&retryable=true sejak failed_delivery_since", async () => {
    const root = await superAdminActor(t);
    const jobs = (await getOk(root, "/admin/dashboard")).jobs;
    const since = encodeURIComponent(jobs.failed_delivery_since as string);
    const list = await getOk(
      root,
      `/admin/notifications/deliveries?status=failed&retryable=true&from=${since}&limit=100`,
    );
    expect(jobs.failed_delivery_count).toBe(2);
    expect(list.total).toBe(jobs.failed_delivery_count);
  });
});
