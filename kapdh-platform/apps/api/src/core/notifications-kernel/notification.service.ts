import { Inject, Injectable } from "@nestjs/common";
import type { RealtimePayloads } from "@kapdh/contracts";
import { notifications, users } from "@kapdh/database";
import { and, count, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../adapters/clock.js";
import { afterCommit, assertCommitAware } from "../db/tx.js";
import type { Db, DbOrTx } from "../db/types.js";
import { OutboxService } from "../outbox/outbox.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { CLOCK, DB } from "../tokens.js";
import { deepLinkFor, isNotificationRoute } from "./app-routes.js";

/** Kategori notifikasi (ARCHITECTURE §4.7); `security` dan `account` wajib (tidak dapat dimatikan). */
export const NOTIFICATION_CATEGORIES = [
  "payment",
  "membership",
  "event",
  "news",
  "chat",
  "security",
  "account",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Nilai `data` tambahan: datar dan primitif, tanpa isi chat, bukti bayar, atau kontak (PRD 3.13). */
export type NotificationData = Record<string, string | number | boolean | null>;

export interface NotifyInput {
  userId: string;
  category: NotificationCategory;
  /** Judul singkat (<= 120 karakter), Bahasa Indonesia. */
  title: string;
  /** Isi (<= 500 karakter) tanpa data sensitif; null bila cukup judul. */
  body?: string | null;
  /** Rute aplikasi relatif §8.4 (mis. `/payments/<id>`); divalidasi {@link isNotificationRoute}. */
  route?: string | null;
  /** Penanda tambahan (<= 10 kunci snake_case, <= 1 KB JSON). Kunci `route` dicadangkan. */
  data?: NotificationData;
  /**
   * Kunci dedup per peristiwa (mis. `payment.decided:<payment_id>`). Disimpan sebagai `u:<user_id>:<dedupKey>` karena
   * notifications.dedup_key unik global; peristiwa sama untuk pengguna sama tidak pernah menggandakan inbox walau
   * transaksi/job diulang (AC F13-1, F13-6).
   */
  dedupKey: string;
  /**
   * Bawaan true: outbox `notification.created` diterbitkan sehingga worker mengirim push/email sesuai kategori dan
   * preferensi. false: hanya kotak masuk + event realtime, tanpa outbox (push dan email tidak dijadwalkan), untuk
   * penahanan push yang diketahui modul pemanggil, mis. room chat yang di-mute atau push chat yang dimatikan (kontrak
   * setChatRoomMute dan sendChatMessage; kategori chat tidak memiliki kanal email). Kotak masuk tetap riwayat resmi
   * (AC F13-2).
   */
  externalDelivery?: boolean;
}

export interface NotifyResult {
  /** Id notifikasi baru atau yang sudah ada (dedup); string kosong bila penerima dilewati (lihat `skipped`). */
  id: string;
  /** false bila notifikasi dengan kunci dedup yang sama sudah ada atau penerima dilewati (tanpa outbox/realtime). */
  created: boolean;
  /** `account_closed`: akun penerima deletion_pending/deleted, tidak ada inbox, outbox maupun realtime (F-14, D2). */
  skipped?: "account_closed";
}

/**
 * Keadaan akun yang tidak lagi menerima notifikasi (F-14 AC F14-2/F14-3, D2): sejak permintaan penghapusan, data
 * pribadi baru tidak boleh ditambahkan ke akun yang sedang dihapus. Langkah `notifications` job penghapusan tidak
 * diulang saat retry, sehingga inbox yang dibuat sesudahnya (mis. keputusan payment oleh pengurus selama jendela
 * retry) akan tertinggal pada tombstone.
 */
const CLOSED_ACCOUNT_STATES = ["deletion_pending", "deleted"] as const;

export class NotificationInputError extends Error {
  override name = "NotificationInputError";
}

const DATA_KEY = /^[a-z][a-z0-9_]{0,39}$/;

function validate(input: NotifyInput): void {
  if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(input.category))
    throw new NotificationInputError(`Kategori notifikasi tidak dikenal: ${input.category}`);
  const title = input.title.trim();
  if (title.length === 0 || title.length > 120)
    throw new NotificationInputError("Judul notifikasi wajib 1..120 karakter");
  if (input.body != null && input.body.length > 500)
    throw new NotificationInputError("Isi notifikasi maksimal 500 karakter");
  if (input.route != null && !isNotificationRoute(input.route))
    throw new NotificationInputError("Rute deep link bukan rute aplikasi yang sah (ARCHITECTURE §8.4)");
  if (input.dedupKey.length === 0 || input.dedupKey.length > 200)
    throw new NotificationInputError("dedupKey notifikasi wajib 1..200 karakter");
  const data = input.data ?? {};
  const keys = Object.keys(data);
  if (keys.length > 10) throw new NotificationInputError("data notifikasi maksimal 10 kunci");
  for (const key of keys) {
    const value = data[key];
    if (!DATA_KEY.test(key) || key === "route")
      throw new NotificationInputError(`Kunci data notifikasi tidak valid: ${key}`);
    if (value !== null && !["string", "number", "boolean"].includes(typeof value))
      throw new NotificationInputError(`Nilai data notifikasi ${key} wajib primitif`);
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 1024)
    throw new NotificationInputError("data notifikasi maksimal 1 KB");
}

/**
 * Kernel notifikasi (ARCHITECTURE §4.2, §4.7; F-13). `notify` dipanggil di dalam transaksi perubahan bisnis:
 *   1. baris `notifications` (inbox = riwayat resmi; `ON CONFLICT (dedup_key) DO NOTHING`),
 *   2. outbox `notification.created` pada transaksi yang sama (AC F04-1, F04-5: email/push dikirim worker sesuai
 *      preferensi; kegagalan kanal tidak membatalkan keputusan), kecuali `externalDelivery: false` (hanya inbox),
 *   3. setelah commit: event realtime `notification.created` ke `user:<id>` beserta jumlah belum dibaca.
 * Preferensi push/email TIDAK diperiksa di sini (inbox selalu ditulis, AC F13-2); prosesor `notifications.deliver`
 * yang memilih kanal. Pengecualian: penerima berstatus deletion_pending/deleted dilewati seluruhnya (F-14, D2;
 * hasil `skipped: "account_closed"`).
 *
 *   await withTx(db, (tx) => notifications.notify(tx, {
 *     userId, category: "payment", title: "Pembayaran disetujui", body: "...",
 *     route: `/payments/${paymentId}`, dedupKey: `payment.decided:${paymentId}`,
 *   }));
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async notify(tx: DbOrTx, input: NotifyInput): Promise<NotifyResult> {
    assertCommitAware(tx, "NotificationService.notify");
    validate(input);
    // Akun yang sedang/sudah dihapus tidak menerima inbox, push maupun email baru (F-14, D2). Job penghapusan juga
    // menyapu ulang inbox pada langkah credentials untuk notifikasi yang lolos pemeriksaan ini secara bersamaan.
    const [recipient] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (recipient && (CLOSED_ACCOUNT_STATES as readonly string[]).includes(recipient.status))
      return { id: "", created: false, skipped: "account_closed" };
    const dedupKey = `u:${input.userId}:${input.dedupKey}`;
    const now = this.clock.now();
    const id = uuidv7();
    const route = input.route ?? null;
    const body = input.body?.trim() || null;
    const title = input.title.trim();
    const inserted = await tx
      .insert(notifications)
      .values({
        id,
        userId: input.userId,
        category: input.category,
        title,
        body,
        data: { ...(input.data ?? {}), ...(route ? { route } : {}) },
        dedupKey,
        createdAt: now,
      })
      .onConflictDoNothing({ target: notifications.dedupKey })
      .returning({ id: notifications.id });
    if (inserted.length === 0) {
      const [existing] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.dedupKey, dedupKey))
        .limit(1);
      return { id: existing!.id, created: false };
    }
    if (input.externalDelivery !== false)
      await this.outbox.publish(tx, {
        topic: "notification.created",
        dedupKey: `notification.created:${id}`,
        payload: { notification_id: id, user_id: input.userId },
      });
    afterCommit(async () => {
      const unread = await this.unreadCount(input.userId);
      this.realtime.emitToUser(input.userId, "notification.created", id, {
        id,
        category: input.category,
        title,
        body,
        deep_link: deepLinkFor(route),
        created_at: now.toISOString(),
        unread_count: unread,
      } as RealtimePayloads["notification.created"]);
    });
    return { id, created: true };
  }

  /** Jumlah notifikasi belum dibaca (badge). */
  async unreadCount(userId: string, db: DbOrTx = this.db): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return Number(row?.value ?? 0);
  }
}
