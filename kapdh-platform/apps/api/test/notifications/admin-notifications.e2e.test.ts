import { auditLogs, outboxEvents, users } from "@kapdh/database";
import { and, eq, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { countActionableFailedDeliveries } from "../../src/modules/notifications/delivery-predicates.js";
import { expectOperation } from "../support/contract.js";
import {
  type AdminSessionFixture,
  createAdmin,
  createAlumni,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  deliveryOf,
  expectIndonesianFieldErrors,
  fcmToken,
  inboxCount,
  notify,
  registerDeviceOk,
  tokenRow,
} from "./support.js";

/**
 * Status pengiriman dan outbox untuk pengurus (F-13, PRD 4.5, 5.1; kontrak admin-notifications.yaml): izin
 * notifications.manage, retry terkendali dengan alasan lewati, audit, tanpa token/isi/email/payload di respons.
 */

let t: TestApp;
let manager: AdminSessionFixture;
let managerAdminId: string;
const api = () => httpClient(t.app);
const auth = () => ({ token: manager.accessToken });

beforeAll(async () => {
  t = await createTestApp();
  const admin = await createAdmin(t, { permissions: ["notifications.manage"] });
  managerAdminId = admin.adminId;
  manager = await signInAdmin(t, admin);
});
beforeEach(() => {
  t.push.clear();
  t.mailer.messages.length = 0;
});
afterAll(async () => {
  await t.app.close();
});

async function memberWithDevice() {
  const fixture = await createAlumni(t, { status: "verified", fullName: "Siti Aminah" });
  const session = await signInAlumni(t, fixture);
  const token = fcmToken();
  await registerDeviceOk(t, session.accessToken, token);
  return { ...fixture, accessToken: session.accessToken, token };
}

/** Notifikasi dengan push yang gagal permanen (tanpa menonaktifkan token) → failed & retryable. */
async function failedPush(m: { userId: string; token: string }, category: "payment" | "event" = "payment") {
  t.push.failNext(m.token, { ok: false, errorClass: "auth_error", retryable: false, deactivateToken: false });
  const created = await notify(t, m.userId, {
    category,
    route: category === "event" ? "/events" : "/payments",
  });
  await t.jobs.drainOutbox();
  const push = await deliveryOf(t, created.id, "push");
  expect(push).toMatchObject({ status: "failed", errorClass: "AUTH_ERROR" });
  return { notificationId: created.id, deliveryId: push.id };
}

describe("Otorisasi notifications.manage (AC F15-1)", () => {
  it("AC F15-1: tanpa izin 403, token alumni 403, tanpa sesi 401 untuk keempat operasi", async () => {
    const other = await createAdmin(t, { permissions: ["payments.read", "audit.read"] });
    const otherSession = await signInAdmin(t, other);
    const alumni = await createAlumni(t);
    const alumniSession = await signInAlumni(t, alumni);
    const calls = [
      ["get", "/admin/notifications/deliveries", undefined],
      ["post", "/admin/notifications/deliveries/retry", { delivery_ids: [uuidv7()] }],
      ["get", "/admin/notifications/outbox", undefined],
      ["post", "/admin/notifications/outbox/retry", { event_ids: [uuidv7()] }],
    ] as const;
    for (const [method, path, body] of calls) {
      for (const [token, status] of [
        [otherSession.accessToken, 403],
        [alumniSession.accessToken, 403],
        [undefined, 401],
      ] as const) {
        const res =
          method === "get"
            ? await api().get(path, token ? { token } : {})
            : await api().post(path, body, token ? { token } : {});
        expect(res.statusCode, `${method} ${path}`).toBe(status);
        expectOperation(method, path, res);
      }
    }
  });
});

describe("GET /admin/notifications/deliveries", () => {
  it("daftar per kanal/perangkat dengan penerima minimal; tanpa token, judul/isi, atau email; filter dan total", async () => {
    const m = await memberWithDevice();
    const { notificationId, deliveryId } = await failedPush(m);
    const res = await api().get("/admin/notifications/deliveries", {
      ...auth(),
      query: { notification_id: notificationId },
    });
    expect(res.statusCode).toBe(200);
    const body = expectOperation("get", "/admin/notifications/deliveries", res) as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(body.total).toBe(2);
    const push = body.items.find((item) => item.id === deliveryId)!;
    expect(push).toMatchObject({
      notification_id: notificationId,
      category: "payment",
      channel: "push",
      status: "failed",
      platform: "android",
      attempt: 1,
      error_class: "AUTH_ERROR",
      provider_status: null,
      retryable: true,
      recipient: { user_id: m.userId, full_name: "Siti Aminah", member_number: m.memberNumber },
    });
    const email = body.items.find((item) => item.channel === "email")!;
    expect(email).toMatchObject({
      status: "sent",
      provider_status: "accepted",
      platform: null,
      retryable: false,
    });
    const raw = res.body;
    expect(raw).not.toContain(m.token);
    expect(raw).not.toContain(m.email);
    expect(raw).not.toContain("Pembayaran disetujui");

    const filtered = await api().get("/admin/notifications/deliveries", {
      ...auth(),
      query: {
        status: "failed",
        channel: "push",
        category: "payment",
        error_class: "AUTH_ERROR",
        user_id: m.userId,
        retryable: "true",
      },
    });
    expect((filtered.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([deliveryId]);
    const none = await api().get("/admin/notifications/deliveries", {
      ...auth(),
      query: { user_id: m.userId, retryable: "false", status: "failed" },
    });
    expect((none.json() as { total: number }).total).toBe(0);
  });

  it("urutan, halaman keyset dengan total sesuai filter, rentang waktu; cursor dari filter lain 400", async () => {
    const m = await memberWithDevice();
    const from = t.clock.now();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      t.clock.advance(1000);
      ids.push((await failedPush(m)).deliveryId);
    }
    const query = { user_id: m.userId, channel: "push", from: from.toISOString(), limit: "2" };
    const first = await api().get("/admin/notifications/deliveries", { ...auth(), query });
    const page1 = expectOperation("get", "/admin/notifications/deliveries", first) as {
      items: { id: string }[];
      next_cursor: string;
      total: number;
    };
    expect(page1.total).toBe(3);
    expect(page1.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    const second = await api().get("/admin/notifications/deliveries", {
      ...auth(),
      query: { ...query, cursor: page1.next_cursor },
    });
    const page2 = second.json() as { items: { id: string }[]; next_cursor: string | null; total: number };
    expect(page2.items.map((i) => i.id)).toEqual([ids[0]]);
    expect(page2.next_cursor).toBeNull();
    expect(page2.total).toBe(3);
    const ascending = await api().get("/admin/notifications/deliveries", {
      ...auth(),
      query: { ...query, sort: "created_at_asc", limit: "3" },
    });
    expect((ascending.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(ids);
    const mismatch = await api().get("/admin/notifications/deliveries", {
      ...auth(),
      query: { ...query, sort: "created_at_asc", cursor: page1.next_cursor },
    });
    expect(mismatch.statusCode).toBe(400);
    expectOperation("get", "/admin/notifications/deliveries", mismatch);
    const window = await api().get("/admin/notifications/deliveries", {
      ...auth(),
      query: { user_id: m.userId, channel: "push", to: from.toISOString() },
    });
    expect((window.json() as { total: number }).total).toBe(0);
    for (const bad of <Record<string, string>[]>[
      { status: "dibaca" },
      { channel: "sms" },
      { user_id: "x" },
      { from: "kemarin" },
      { from: t.clock.now().toISOString(), to: from.toISOString() },
      { sort: "acak" },
      { retryable: "mungkin" },
    ]) {
      const res = await api().get("/admin/notifications/deliveries", { ...auth(), query: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expectOperation("get", "/admin/notifications/deliveries", res);
      expectIndonesianFieldErrors(res.json(), JSON.stringify(bad));
    }
  });
});

describe("POST /admin/notifications/deliveries/retry (AC F13-4)", () => {
  it("AC F13-4: hanya failed dengan target sah dijadwalkan ulang; alasan lewati; audit; inbox tidak diduplikasi; worker mengirim ulang", async () => {
    const ok = await memberWithDevice();
    const retryable = await failedPush(ok);

    const revoked = await memberWithDevice();
    t.push.failNext(revoked.token, {
      ok: false,
      errorClass: "unregistered",
      retryable: false,
      deactivateToken: true,
    });
    const revokedNotification = await notify(t, revoked.userId);
    await t.jobs.drainOutbox();
    const revokedDelivery = await deliveryOf(t, revokedNotification.id, "push");

    const reassigned = await memberWithDevice();
    const reassignedFailure = await failedPush(reassigned);
    const newOwner = await createAlumni(t);
    await registerDeviceOk(t, (await signInAlumni(t, newOwner)).accessToken, reassigned.token);

    const gone = await memberWithDevice();
    const goneFailure = await failedPush(gone);
    await t.db.update(users).set({ status: "disabled" }).where(eq(users.id, gone.userId));

    const muted = await memberWithDevice();
    const mutedFailure = await failedPush(muted, "event");
    await api().put(
      "/notifications/preferences",
      {
        push: { payment: true, membership: true, event: false, news: true, chat: true },
        email: { payment: true, membership: true, event: true },
      },
      { token: muted.accessToken },
    );

    const sent = await deliveryOf(t, retryable.notificationId, "email");
    const unknown = uuidv7();
    const ids = [
      retryable.deliveryId,
      revokedDelivery.id,
      reassignedFailure.deliveryId,
      goneFailure.deliveryId,
      mutedFailure.deliveryId,
      sent.id,
      unknown,
    ];
    // Hitungan dasbor memakai definisi yang sama dengan filter retryable (DashboardJobs.failed_delivery_count).
    const since = new Date(0);
    const listed = await api().get("/admin/notifications/deliveries", {
      ...auth(),
      query: { status: "failed", retryable: "true", from: since.toISOString(), limit: "100" },
    });
    const listedBody = listed.json() as { items: { id: string }[]; total: number };
    expect(await countActionableFailedDeliveries(t.db, since)).toBe(listedBody.total);
    const listedIds = listedBody.items.map((item) => item.id);
    expect(listedIds).toContain(retryable.deliveryId);
    for (const id of ids.slice(1)) expect(listedIds).not.toContain(id);

    const key = uuidv7();
    const res = await api().post(
      "/admin/notifications/deliveries/retry",
      { delivery_ids: ids },
      { ...auth(), headers: { "idempotency-key": key } },
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = expectOperation("post", "/admin/notifications/deliveries/retry", res) as {
      requeued: { id: string; status: string; attempt: number; next_retry_at: string; retryable: boolean }[];
      skipped: { delivery_id: string; reason: string }[];
    };
    expect(body.requeued).toEqual([
      expect.objectContaining({
        id: retryable.deliveryId,
        status: "pending",
        attempt: 1,
        next_retry_at: t.clock.now().toISOString(),
        retryable: false,
      }),
    ]);
    expect(body.skipped).toEqual([
      { delivery_id: revokedDelivery.id, reason: "token_revoked" },
      { delivery_id: reassignedFailure.deliveryId, reason: "token_reassigned" },
      { delivery_id: goneFailure.deliveryId, reason: "recipient_unavailable" },
      { delivery_id: mutedFailure.deliveryId, reason: "preference_disabled" },
      { delivery_id: sent.id, reason: "not_failed" },
      { delivery_id: unknown, reason: "not_found" },
    ]);
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "notification.delivery.retried"),
          eq(auditLogs.entityId, retryable.deliveryId),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorAdminId: managerAdminId,
      entityType: "notification_delivery",
      before: { status: "failed", attempt: 1, error_class: "AUTH_ERROR" },
      after: { status: "pending" },
    });

    // Klik ulang dengan Idempotency-Key sama: respons sama tanpa penjadwalan/audit kedua.
    const replay = await api().post(
      "/admin/notifications/deliveries/retry",
      { delivery_ids: ids },
      { ...auth(), headers: { "idempotency-key": key } },
    );
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(body);
    // Tanpa key: pengiriman sudah pending → not_failed.
    const again = await api().post(
      "/admin/notifications/deliveries/retry",
      { delivery_ids: [retryable.deliveryId] },
      auth(),
    );
    expect(again.json()).toEqual({
      requeued: [],
      skipped: [{ delivery_id: retryable.deliveryId, reason: "not_failed" }],
    });

    // Percobaan pertama yang gagal sudah tercatat di FakePush; retry menambah tepat satu kiriman ke pemiliknya.
    expect(t.push.to(ok.token)).toHaveLength(1);
    const reassignedBefore = t.push.to(reassigned.token).length;
    await t.jobs.runScheduled("notifications.retry");
    expect(await deliveryOf(t, retryable.notificationId, "push")).toMatchObject({
      status: "sent",
      attempt: 2,
    });
    expect(t.push.to(ok.token)).toHaveLength(2);
    expect(t.push.to(reassigned.token)).toHaveLength(reassignedBefore);
    expect(await inboxCount(t, ok.userId)).toBe(1);
    expect(
      await t.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "notification.delivery.retried"), inArray(auditLogs.entityId, ids))),
    ).toHaveLength(1);
    expect((await tokenRow(t, revoked.token))!.revokedAt).not.toBeNull();
  });

  it("validasi body dan batas laju per admin (RATE_LIMITED)", async () => {
    for (const body of [
      {},
      { delivery_ids: [] },
      { delivery_ids: ["x"] },
      { delivery_ids: Array.from({ length: 101 }, () => uuidv7()) },
      { delivery_ids: [uuidv7()], extra: 1 },
    ]) {
      const res = await api().post("/admin/notifications/deliveries/retry", body, auth());
      expect(res.statusCode).toBe(400);
      expectOperation("post", "/admin/notifications/deliveries/retry", res);
      expectIndonesianFieldErrors(res.json(), JSON.stringify(body).slice(0, 60));
    }
    const limited = await createAdmin(t, { permissions: ["notifications.manage"] });
    const session = await signInAdmin(t, limited);
    let last = 0;
    for (let i = 0; i < 21; i++)
      last = (
        await api().post(
          "/admin/notifications/deliveries/retry",
          { delivery_ids: [uuidv7()] },
          { token: session.accessToken },
        )
      ).statusCode;
    expect(last).toBe(429);
  });
});

describe("Outbox (PRD 5.1, 5.5)", () => {
  async function outboxEvent(status: "pending" | "dispatched" | "failed" | "dead", lockedMs?: number) {
    const id = uuidv7();
    const now = t.clock.now();
    await t.db.insert(outboxEvents).values({
      id,
      topic: "event.cancelled",
      dedupKey: `uji-outbox:${id}`,
      payload: { event_id: uuidv7() },
      status,
      attempts: status === "dead" ? 10 : status === "failed" ? 2 : 0,
      nextAttemptAt: new Date(now.getTime() + 3600_000),
      lockedUntil: lockedMs === undefined ? null : new Date(now.getTime() + lockedMs),
      lastError: status === "failed" || status === "dead" ? "Error:ECONNRESET" : null,
      requestId: `req-${id}`,
      dispatchedAt: status === "dispatched" ? now : null,
      createdAt: now,
    });
    return id;
  }

  it("tanpa status hanya failed dan dead; in_progress dan retryable mengikuti lease; payload/dedup key tidak diekspos", async () => {
    t.clock.advance(1000);
    const failed = await outboxEvent("failed");
    const dead = await outboxEvent("dead");
    const locked = await outboxEvent("failed", 60_000);
    const pending = await outboxEvent("pending");
    const res = await api().get("/admin/notifications/outbox", { ...auth(), query: { limit: "100" } });
    expect(res.statusCode).toBe(200);
    const body = expectOperation("get", "/admin/notifications/outbox", res) as {
      items: {
        id: string;
        status: string;
        in_progress: boolean;
        retryable: boolean;
        last_error: string | null;
      }[];
      total: number;
    };
    const byId = new Map(body.items.map((item) => [item.id, item]));
    expect(byId.get(failed)).toMatchObject({ status: "failed", in_progress: false, retryable: true });
    expect(byId.get(dead)).toMatchObject({ status: "dead", retryable: true, last_error: "Error:ECONNRESET" });
    expect(byId.get(locked)).toMatchObject({ in_progress: true, retryable: false });
    expect(byId.has(pending)).toBe(false);
    expect(res.body).not.toContain("uji-outbox:");
    expect(res.body).not.toContain("event_id");
    const onlyPending = await api().get("/admin/notifications/outbox", {
      ...auth(),
      query: { status: "pending", topic: "event.cancelled", limit: "100" },
    });
    expect((onlyPending.json() as { items: { id: string }[] }).items.map((i) => i.id)).toContain(pending);
    const sorted = await api().get("/admin/notifications/outbox", {
      ...auth(),
      query: { sort: "next_attempt_at_asc", limit: "1" },
    });
    const sortedBody = expectOperation("get", "/admin/notifications/outbox", sorted) as {
      next_cursor: string;
    };
    const next = await api().get("/admin/notifications/outbox", {
      ...auth(),
      query: { sort: "next_attempt_at_asc", limit: "1", cursor: sortedBody.next_cursor },
    });
    expect(next.statusCode).toBe(200);
    const mismatch = await api().get("/admin/notifications/outbox", {
      ...auth(),
      query: { sort: "created_at_asc", cursor: sortedBody.next_cursor },
    });
    expect(mismatch.statusCode).toBe(400);
  });

  it("retry: failed/dead → pending; lease berlaku in_progress; pending/dispatched not_retryable; audit; dispatcher memproses ulang", async () => {
    const failed = await outboxEvent("failed");
    const dead = await outboxEvent("dead");
    const locked = await outboxEvent("dead", 60_000);
    const dispatched = await outboxEvent("dispatched");
    const unknown = uuidv7();
    const res = await api().post(
      "/admin/notifications/outbox/retry",
      { event_ids: [failed, dead, locked, dispatched, unknown] },
      auth(),
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = expectOperation("post", "/admin/notifications/outbox/retry", res) as {
      requeued: {
        id: string;
        status: string;
        attempts: number;
        last_error: string | null;
        next_attempt_at: string;
      }[];
      skipped: { event_id: string; reason: string }[];
    };
    expect(body.requeued.map((e) => [e.id, e.status])).toEqual([
      [failed, "pending"],
      [dead, "pending"],
    ]);
    expect(body.requeued[1]).toMatchObject({
      attempts: 10,
      last_error: "Error:ECONNRESET",
      next_attempt_at: t.clock.now().toISOString(),
    });
    expect(body.skipped).toEqual([
      { event_id: locked, reason: "in_progress" },
      { event_id: dispatched, reason: "not_retryable" },
      { event_id: unknown, reason: "not_found" },
    ]);
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "outbox.retried"), inArray(auditLogs.entityId, [failed, dead])));
    expect(audits).toHaveLength(2);
    expect(audits.find((a) => a.entityId === dead)).toMatchObject({
      entityType: "outbox_event",
      before: { status: "dead", attempts: 10, topic: "event.cancelled" },
      after: { status: "pending" },
    });
    const [row] = await t.db.select().from(outboxEvents).where(eq(outboxEvents.id, failed));
    expect(row).toMatchObject({ status: "pending", lockedUntil: null });
    for (const body2 of [{}, { event_ids: [] }, { event_ids: ["x"] }]) {
      const bad = await api().post("/admin/notifications/outbox/retry", body2, auth());
      expect(bad.statusCode).toBe(400);
      expectOperation("post", "/admin/notifications/outbox/retry", bad);
      expectIndonesianFieldErrors(bad.json(), JSON.stringify(body2));
    }
  });
});

describe("Pesan validasi berbahasa Indonesia (ARCHITECTURE §2.9, PRD 5.2)", () => {
  it("filter kosong/berulang, body bukan daftar id, id berulang dan kolom asing → field_errors berbahasa Indonesia", async () => {
    const id = uuidv7();
    const cases: {
      label: string;
      method: "get" | "post";
      path: string;
      call: () => ReturnType<ReturnType<typeof api>["get"]>;
      field: string;
      message: string;
    }[] = [
      {
        label: "error_class kosong",
        method: "get",
        path: "/admin/notifications/deliveries",
        call: () => api().get("/admin/notifications/deliveries?error_class=", auth()),
        field: "error_class",
        message: "Wajib diisi bila dikirim",
      },
      {
        label: "error_class berulang",
        method: "get",
        path: "/admin/notifications/deliveries",
        call: () => api().get("/admin/notifications/deliveries?error_class=a&error_class=b", auth()),
        field: "error_class",
        message: "Harus berupa satu nilai teks",
      },
      {
        label: "from berulang",
        method: "get",
        path: "/admin/notifications/deliveries",
        call: () =>
          api().get(
            "/admin/notifications/deliveries?from=2026-10-01T00:00:00Z&from=2026-10-02T00:00:00Z",
            auth(),
          ),
        field: "from",
        message: "Gunakan format tanggal-waktu ISO 8601",
      },
      {
        label: "topic kosong",
        method: "get",
        path: "/admin/notifications/outbox",
        call: () => api().get("/admin/notifications/outbox?topic=", auth()),
        field: "topic",
        message: "Wajib diisi bila dikirim",
      },
      {
        label: "delivery_ids bukan daftar",
        method: "post",
        path: "/admin/notifications/deliveries/retry",
        call: () => api().post("/admin/notifications/deliveries/retry", { delivery_ids: id }, auth()),
        field: "delivery_ids",
        message: "Harus berupa daftar id",
      },
      {
        label: "kolom asing",
        method: "post",
        path: "/admin/notifications/deliveries/retry",
        call: () =>
          api().post("/admin/notifications/deliveries/retry", { delivery_ids: [id], ekstra: 1 }, auth()),
        field: "_",
        message: "Kolom tidak dikenal: ekstra",
      },
      {
        label: "event_ids berulang",
        method: "post",
        path: "/admin/notifications/outbox/retry",
        call: () => api().post("/admin/notifications/outbox/retry", { event_ids: [id, id] }, auth()),
        field: "event_ids",
        message: "event_ids tidak boleh berulang",
      },
      {
        label: "body bukan objek",
        method: "post",
        path: "/admin/notifications/outbox/retry",
        call: () => api().post("/admin/notifications/outbox/retry", [id], auth()),
        field: "_",
        message: "Body harus berupa objek JSON",
      },
    ];
    for (const c of cases) {
      const res = await c.call();
      expect(res.statusCode, c.label).toBe(400);
      const body = expectOperation(c.method, c.path, res) as { field_errors: Record<string, string[]> };
      expect(body.field_errors[c.field], c.label).toContain(c.message);
      expectIndonesianFieldErrors(body, c.label);
    }
  });
});
