import { requirePermission } from "./auth";
import { error, json, type MockRequest, type MockRoute, paginate, type S } from "./http";

/**
 * Tiruan pemantauan pengiriman notifikasi dan outbox (kontrak admin-notifications C7, F-13, AC F13-4, F13-5,
 * PRD 4.5, 5.1):
 * - respons tidak pernah memuat token perangkat, judul/isi notifikasi, email, payload outbox maupun dedup key;
 * - `retryable` = failed DAN target masih sah (penerima aktif, preferensi aktif, token push belum dicabut dan masih
 *   milik penerima); definisi yang sama dipakai filter `retryable`, retry dan hitungan dasbor;
 * - retry pengiriman hanya mengubah failed -> pending (selain itu dilewati beserta alasan, bukan galat);
 * - outbox tanpa `status` hanya failed + dead; retry outbox melewati event yang sedang diklaim dispatcher
 *   (`in_progress`) dan yang statusnya bukan failed/dead.
 * Data contoh bukan bukti AC (PRD 7.3).
 */
type Delivery = S["AdminNotificationDelivery"];
type DeliverySkipReason = S["AdminDeliveryRetrySkipReason"];
type OutboxEvent = S["AdminOutboxEvent"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Jendela hitungan kegagalan pengiriman di dasbor (usulan kontrak: 7 hari). */
export const FAILED_DELIVERY_WINDOW_MS = 7 * DAY;

export const MOCK_DELIVERY_IDS = {
  unregistered: "0199e000-0000-7000-8000-00000000d101",
  unavailable: "0199e000-0000-7000-8000-00000000d102",
  bounceSoft: "0199e000-0000-7000-8000-00000000d103",
  bounceHard: "0199e000-0000-7000-8000-00000000d104",
  reassignedCancelled: "0199e000-0000-7000-8000-00000000d105",
  sentPush: "0199e000-0000-7000-8000-00000000d106",
  sentEmail: "0199e000-0000-7000-8000-00000000d107",
  pendingRetry: "0199e000-0000-7000-8000-00000000d108",
  oldFailure: "0199e000-0000-7000-8000-00000000d109",
  deletedRecipient: "0199e000-0000-7000-8000-00000000d110",
  preferenceCancelled: "0199e000-0000-7000-8000-00000000d111",
  reassignedFailed: "0199e000-0000-7000-8000-00000000d112",
} as const;

export const MOCK_OUTBOX_IDS = {
  deadNotification: "0199e000-0000-7000-8000-00000000e201",
  failedDeletion: "0199e000-0000-7000-8000-00000000e202",
  deadExportLocked: "0199e000-0000-7000-8000-00000000e203",
  pendingCancel: "0199e000-0000-7000-8000-00000000e204",
  dispatchedNotice: "0199e000-0000-7000-8000-00000000e205",
  deadReset: "0199e000-0000-7000-8000-00000000e206",
} as const;

const RECIPIENTS = {
  bayu: {
    user_id: "0199e000-0000-7000-8000-0000000000c3",
    full_name: "Bayu Musthafa Arief",
    member_number: "09.02.01.5",
  },
  ridwan: {
    user_id: "0199e000-0000-7000-8000-0000000000c1",
    full_name: "ridwan",
    member_number: "06.02.01.4",
  },
  arya: {
    user_id: "0199e000-0000-7000-8000-0000000000c2",
    full_name: "Arya Kamandanu",
    member_number: "10.02.01.3",
  },
  sari: {
    user_id: "0199e000-0000-7000-8000-0000000000c5",
    full_name: "Sari Dewi",
    member_number: "11.01.02.8",
  },
} satisfies Record<string, S["AdminDeliveryRecipient"]>;

/** Baris pengiriman beserta alasan server bila kegagalannya tidak dapat dikirim ulang (tidak diekspos). */
interface DeliveryRow {
  delivery: Delivery;
  blockedBy: DeliverySkipReason | null;
}

export interface NotificationRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  idempotencyKey: string | null;
  background: boolean;
  body: Record<string, unknown> | null;
}

/** Log permintaan area notifikasi (uji: parameter filter, Idempotency-Key, header latar). */
export const notificationRequests: NotificationRequestLog[] = [];

let deliveries = new Map<string, DeliveryRow>();
let outbox = new Map<string, OutboxEvent>();
const replays = new Map<string, { payload: string; body: unknown }>();
let retryLimited = false;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function delivery(
  id: string,
  partial: Partial<Delivery> & Pick<Delivery, "category" | "channel" | "status" | "created_at">,
  blockedBy: DeliverySkipReason | null = null,
): DeliveryRow {
  const d: Delivery = {
    id,
    notification_id: `0199e000-0000-7000-8000-0000000c${id.slice(-4)}`,
    platform: partial.channel === "push" ? "android" : null,
    attempt: 1,
    next_retry_at: null,
    provider_status: null,
    error_class: null,
    sent_at: null,
    updated_at: partial.created_at,
    recipient: RECIPIENTS.ridwan,
    retryable: false,
    ...partial,
  };
  return { delivery: { ...d, retryable: d.status === "failed" && blockedBy === null }, blockedBy };
}

function deliveryFixtures(): Map<string, DeliveryRow> {
  const D = MOCK_DELIVERY_IDS;
  const rows: DeliveryRow[] = [
    delivery(
      D.unregistered,
      {
        category: "payment",
        channel: "push",
        status: "failed",
        error_class: "UNREGISTERED",
        provider_status: "404",
        recipient: RECIPIENTS.bayu,
        created_at: iso(-3 * HOUR),
        updated_at: iso(-3 * HOUR + MINUTE),
      },
      "token_revoked",
    ),
    delivery(D.unavailable, {
      category: "event",
      channel: "push",
      platform: "ios",
      status: "failed",
      attempt: 5,
      error_class: "UNAVAILABLE",
      provider_status: "503",
      recipient: RECIPIENTS.arya,
      created_at: iso(-20 * HOUR),
      updated_at: iso(-2 * HOUR),
    }),
    delivery(D.bounceSoft, {
      category: "payment",
      channel: "email",
      status: "failed",
      attempt: 3,
      error_class: "bounce_soft",
      provider_status: "452",
      recipient: RECIPIENTS.sari,
      created_at: iso(-2 * DAY),
      updated_at: iso(-1 * DAY),
    }),
    delivery(D.bounceHard, {
      category: "membership",
      channel: "email",
      status: "failed",
      error_class: "bounce_hard",
      provider_status: "550",
      recipient: RECIPIENTS.ridwan,
      created_at: iso(-4 * DAY),
    }),
    delivery(D.reassignedCancelled, {
      category: "chat",
      channel: "push",
      status: "cancelled",
      attempt: 0,
      error_class: "token_reassigned",
      recipient: RECIPIENTS.arya,
      created_at: iso(-5 * HOUR),
    }),
    delivery(D.sentPush, {
      category: "news",
      channel: "push",
      status: "sent",
      provider_status: "accepted",
      sent_at: iso(-6 * HOUR + MINUTE),
      recipient: RECIPIENTS.sari,
      created_at: iso(-6 * HOUR),
    }),
    delivery(D.sentEmail, {
      category: "event",
      channel: "email",
      status: "sent",
      provider_status: "accepted",
      sent_at: iso(-7 * HOUR + MINUTE),
      recipient: RECIPIENTS.bayu,
      created_at: iso(-7 * HOUR),
    }),
    delivery(D.pendingRetry, {
      category: "payment",
      channel: "push",
      platform: "ios",
      status: "pending",
      attempt: 2,
      error_class: "INTERNAL",
      provider_status: "500",
      next_retry_at: iso(4 * MINUTE),
      recipient: RECIPIENTS.ridwan,
      created_at: iso(-30 * MINUTE),
      updated_at: iso(-MINUTE),
    }),
    delivery(D.oldFailure, {
      category: "payment",
      channel: "push",
      status: "failed",
      error_class: "INVALID_ARGUMENT",
      provider_status: "400",
      recipient: RECIPIENTS.sari,
      created_at: iso(-10 * DAY),
    }),
    delivery(
      D.deletedRecipient,
      {
        category: "security",
        channel: "email",
        status: "failed",
        error_class: "timeout",
        recipient: null,
        created_at: iso(-1 * DAY),
      },
      "recipient_unavailable",
    ),
    delivery(D.preferenceCancelled, {
      category: "news",
      channel: "push",
      status: "cancelled",
      attempt: 0,
      error_class: "preference_disabled",
      recipient: RECIPIENTS.ridwan,
      created_at: iso(-8 * HOUR),
    }),
    delivery(
      D.reassignedFailed,
      {
        category: "payment",
        channel: "push",
        status: "failed",
        error_class: "SENDER_ID_MISMATCH",
        provider_status: "403",
        recipient: RECIPIENTS.arya,
        created_at: iso(-9 * HOUR),
      },
      "token_reassigned",
    ),
  ];
  return new Map(rows.map((r) => [r.delivery.id, r]));
}

function outboxEvent(
  id: string,
  partial: Partial<OutboxEvent> & Pick<OutboxEvent, "topic" | "status" | "created_at">,
): OutboxEvent {
  const e: OutboxEvent = {
    id,
    attempts: 0,
    next_attempt_at: partial.created_at,
    in_progress: false,
    last_error: null,
    request_id: `req-${id.slice(-6)}`,
    dispatched_at: null,
    retryable: false,
    ...partial,
  };
  return { ...e, retryable: (e.status === "failed" || e.status === "dead") && !e.in_progress };
}

function outboxFixtures(): Map<string, OutboxEvent> {
  const O = MOCK_OUTBOX_IDS;
  const list: OutboxEvent[] = [
    outboxEvent(O.deadNotification, {
      topic: "notification.created",
      status: "dead",
      attempts: 10,
      last_error: "Antrean pengiriman tidak tersedia (ECONNREFUSED).",
      created_at: iso(-26 * HOUR),
      next_attempt_at: iso(-20 * HOUR),
    }),
    outboxEvent(O.failedDeletion, {
      topic: "account.deletion.requested",
      status: "failed",
      attempts: 3,
      last_error: "Batas waktu koneksi basis data.",
      created_at: iso(-2 * HOUR),
      next_attempt_at: iso(8 * MINUTE),
    }),
    outboxEvent(O.deadExportLocked, {
      topic: "audit.export.requested",
      status: "dead",
      attempts: 10,
      in_progress: true,
      last_error: "Worker berhenti saat memproses.",
      created_at: iso(-30 * HOUR),
      next_attempt_at: iso(-29 * HOUR),
    }),
    outboxEvent(O.pendingCancel, {
      topic: "event.cancelled",
      status: "pending",
      created_at: iso(-3 * MINUTE),
    }),
    outboxEvent(O.dispatchedNotice, {
      topic: "admin.security_notice",
      status: "dispatched",
      attempts: 1,
      dispatched_at: iso(-50 * MINUTE),
      created_at: iso(-HOUR),
    }),
    outboxEvent(O.deadReset, {
      topic: "member.password_reset_initiated",
      status: "dead",
      attempts: 10,
      last_error: "Layanan email menolak permintaan (421).",
      created_at: iso(-3 * DAY),
      next_attempt_at: iso(-2 * DAY),
    }),
  ];
  return new Map(list.map((e) => [e.id, e]));
}

export function reset(): void {
  deliveries = deliveryFixtures();
  outbox = outboxFixtures();
  replays.clear();
  retryLimited = false;
  notificationRequests.length = 0;
}
reset();

function log(req: MockRequest): void {
  notificationRequests.push({
    method: req.method,
    path: req.path,
    query: Object.fromEntries(req.url.searchParams.entries()),
    idempotencyKey: req.headers.get("Idempotency-Key"),
    background: req.headers.get("X-Background-Request") === "1",
    body: req.body,
  });
}

function bad(fe: Record<string, string[]>): Response {
  return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", { field_errors: fe });
}

function idem(req: MockRequest): { response: Response | null; remember: (body: unknown) => void } {
  const key = req.headers.get("Idempotency-Key");
  const payload = JSON.stringify([req.path, req.body]);
  const prior = key ? replays.get(key) : undefined;
  if (prior)
    return {
      response:
        prior.payload === payload
          ? json(200, prior.body)
          : error(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah dipakai untuk permintaan lain."),
      remember: () => undefined,
    };
  return { response: null, remember: (body) => key && replays.set(key, { payload, body }) };
}

/** Validasi rentang waktu `from` inklusif / `to` eksklusif (UTC). */
function range(p: URLSearchParams, fe: Record<string, string[]>): { from: number | null; to: number | null } {
  const parse = (name: "from" | "to") => {
    const raw = p.get(name);
    if (raw === null) return null;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) fe[name] = ["Format waktu tidak valid."];
    return Number.isNaN(t) ? null : t;
  };
  return { from: parse("from"), to: parse("to") };
}

function ids(body: Record<string, unknown> | null, field: string, fe: Record<string, string[]>): string[] {
  const raw = body?.[field];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) {
    fe[field] = ["Pilih 1 sampai 100 baris."];
    return [];
  }
  if (!raw.every((v) => typeof v === "string" && UUID.test(v))) fe[field] = ["Id tidak valid."];
  else if (new Set(raw).size !== raw.length) fe[field] = ["Id tidak boleh berulang."];
  return raw as string[];
}

/** Hitungan bersama dasbor/lencana (definisi sama dengan filter daftar, kontrak DashboardJobs). */
export function notificationJobCounts(now = Date.now()): {
  failed_delivery_count: number;
  failed_delivery_since: string;
  failed_outbox_count: number;
  dead_outbox_count: number;
  oldest_pending_outbox_at: string | null;
} {
  const since = now - FAILED_DELIVERY_WINDOW_MS;
  const events = [...outbox.values()];
  return {
    failed_delivery_count: [...deliveries.values()].filter(
      (r) => r.delivery.retryable && Date.parse(r.delivery.created_at) >= since,
    ).length,
    failed_delivery_since: new Date(since).toISOString(),
    failed_outbox_count: events.filter((e) => e.status === "failed").length,
    dead_outbox_count: events.filter((e) => e.status === "dead").length,
    oldest_pending_outbox_at:
      events
        .filter((e) => e.status === "pending")
        .map((e) => e.created_at)
        .sort()[0] ?? null,
  };
}

/** Kendali server tiruan untuk uji dan dev:mock. */
export const mockNotifications = {
  delivery(id: string): Delivery | undefined {
    return deliveries.get(id)?.delivery;
  },
  outboxEvent(id: string): OutboxEvent | undefined {
    return outbox.get(id);
  },
  /** Batas retry per admin tercapai: permintaan retry berikutnya 429 RATE_LIMITED. */
  limitRetries(): void {
    retryLimited = true;
  },
  /** Worker mengirim semua pengiriman pending (meniru FCM/email accepted). */
  deliverPending(): void {
    for (const [id, row] of deliveries) {
      if (row.delivery.status !== "pending") continue;
      const at = new Date().toISOString();
      deliveries.set(id, {
        ...row,
        delivery: {
          ...row.delivery,
          status: "sent",
          attempt: row.delivery.attempt + 1,
          next_retry_at: null,
          provider_status: "accepted",
          error_class: null,
          sent_at: at,
          updated_at: at,
          retryable: false,
        },
      });
    }
  },
};

function rateLimited(): Response {
  return error(429, "RATE_LIMITED", "Terlalu banyak permintaan kirim ulang. Coba lagi nanti.", {
    retry_after_seconds: 60,
  });
}

export const routes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/notifications/deliveries",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "notifications.manage");
      if (denied) return denied;
      const p = req.url.searchParams;
      const fe: Record<string, string[]> = {};
      const { from, to } = range(p, fe);
      const userId = p.get("user_id");
      if (userId !== null && !UUID.test(userId)) fe.user_id = ["Id penerima harus UUID."];
      const notificationId = p.get("notification_id");
      if (notificationId !== null && !UUID.test(notificationId))
        fe.notification_id = ["Id notifikasi harus UUID."];
      if (Object.keys(fe).length > 0) return bad(fe);
      const status = p.get("status");
      const channel = p.get("channel");
      const category = p.get("category");
      const errorClass = p.get("error_class");
      const retryable = p.get("retryable");
      const sort = p.get("sort") ?? "created_at_desc";
      const items = [...deliveries.values()]
        .map((r) => r.delivery)
        .filter((d) => !status || d.status === status)
        .filter((d) => !channel || d.channel === channel)
        .filter((d) => !category || d.category === category)
        .filter((d) => !errorClass || d.error_class === errorClass)
        .filter((d) => !userId || d.recipient?.user_id === userId)
        .filter((d) => !notificationId || d.notification_id === notificationId)
        .filter((d) => retryable === null || String(d.retryable) === retryable)
        .filter((d) => from === null || Date.parse(d.created_at) >= from)
        .filter((d) => to === null || Date.parse(d.created_at) < to)
        .sort((a, b) => {
          if (sort === "created_at_asc") return a.created_at.localeCompare(b.created_at);
          if (sort === "updated_at_desc") return b.updated_at.localeCompare(a.updated_at);
          return b.created_at.localeCompare(a.created_at);
        });
      return json(200, paginate(items, req.url) satisfies S["AdminNotificationDeliveryPage"]);
    },
  },
  {
    method: "POST",
    path: "/admin/notifications/deliveries/retry",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "notifications.manage");
      if (denied) return denied;
      const replay = idem(req);
      if (replay.response) return replay.response;
      const fe: Record<string, string[]> = {};
      const list = ids(req.body, "delivery_ids", fe);
      if (Object.keys(fe).length > 0) return bad(fe);
      if (retryLimited) return rateLimited();
      const result: S["AdminDeliveryRetryResult"] = { requeued: [], skipped: [] };
      const at = new Date().toISOString();
      for (const id of list) {
        const row = deliveries.get(id);
        let reason: DeliverySkipReason | null = null;
        if (!row) reason = "not_found";
        else if (row.delivery.status !== "failed") reason = "not_failed";
        else if (row.blockedBy) reason = row.blockedBy;
        if (reason || !row) {
          result.skipped.push({ delivery_id: id, reason: reason ?? "not_found" });
          continue;
        }
        // UPDATE bersyarat WHERE status='failed': pending, dijadwalkan segera, attempt tetap (riwayat terlihat).
        const next: Delivery = {
          ...row.delivery,
          status: "pending",
          next_retry_at: at,
          updated_at: at,
          retryable: false,
        };
        deliveries.set(id, { ...row, delivery: next });
        result.requeued.push(next);
      }
      replay.remember(result);
      return json(200, result);
    },
  },
  {
    method: "GET",
    path: "/admin/notifications/outbox",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "notifications.manage");
      if (denied) return denied;
      const p = req.url.searchParams;
      const fe: Record<string, string[]> = {};
      const { from, to } = range(p, fe);
      if (Object.keys(fe).length > 0) return bad(fe);
      const status = p.get("status");
      const topic = p.get("topic");
      const sort = p.get("sort") ?? "created_at_desc";
      const items = [...outbox.values()]
        // Tanpa status: hanya event yang perlu tindakan (failed + dead).
        .filter((e) => (status ? e.status === status : e.status === "failed" || e.status === "dead"))
        .filter((e) => !topic || e.topic === topic)
        .filter((e) => from === null || Date.parse(e.created_at) >= from)
        .filter((e) => to === null || Date.parse(e.created_at) < to)
        .sort((a, b) => {
          if (sort === "created_at_asc") return a.created_at.localeCompare(b.created_at);
          if (sort === "next_attempt_at_asc") return a.next_attempt_at.localeCompare(b.next_attempt_at);
          return b.created_at.localeCompare(a.created_at);
        });
      return json(200, paginate(items, req.url) satisfies S["AdminOutboxEventPage"]);
    },
  },
  {
    method: "POST",
    path: "/admin/notifications/outbox/retry",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "notifications.manage");
      if (denied) return denied;
      const replay = idem(req);
      if (replay.response) return replay.response;
      const fe: Record<string, string[]> = {};
      const list = ids(req.body, "event_ids", fe);
      if (Object.keys(fe).length > 0) return bad(fe);
      if (retryLimited) return rateLimited();
      const result: S["AdminOutboxRetryResult"] = { requeued: [], skipped: [] };
      const at = new Date().toISOString();
      for (const id of list) {
        const e = outbox.get(id);
        if (!e) {
          result.skipped.push({ event_id: id, reason: "not_found" });
          continue;
        }
        if (e.status !== "failed" && e.status !== "dead") {
          result.skipped.push({ event_id: id, reason: "not_retryable" });
          continue;
        }
        // Lease dispatcher yang masih berlaku tidak diputus.
        if (e.in_progress) {
          result.skipped.push({ event_id: id, reason: "in_progress" });
          continue;
        }
        const next: OutboxEvent = { ...e, status: "pending", next_attempt_at: at, retryable: false };
        outbox.set(id, next);
        result.requeued.push(next);
      }
      replay.remember(result);
      return json(200, result);
    },
  },
];
