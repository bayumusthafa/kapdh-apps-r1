import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { notifications } from "@kapdh/database";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import type { Db } from "../../core/db/types.js";
import { notFound } from "../../core/errors/app-exception.js";
import { deepLinkFor, isNotificationRoute } from "../../core/notifications-kernel/app-routes.js";
import {
  type NotificationCategory,
  NotificationService,
} from "../../core/notifications-kernel/notification.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { decodeKeyset, encodeKeyset, exactIso, filterFingerprint, keysetAfterExact } from "./keyset.js";

type InboxNotification = components["schemas"]["InboxNotification"];
type NotificationPage = components["schemas"]["NotificationPage"];
type MarkNotificationsReadResult = components["schemas"]["MarkNotificationsReadResult"];

type NotificationRow = typeof notifications.$inferSelect;

/**
 * Rute deep link aman dari `notifications.data.route` (ARCHITECTURE §4.7, §8.4): hanya rute aplikasi relatif yang
 * lolos {@link isNotificationRoute}; data rusak atau rute di luar katalog menjadi null (notifikasi informasi saja), jadi
 * klien tidak pernah menerima URL eksternal atau rute sistem (AC F13-3).
 */
export function safeRoute(data: unknown): string | null {
  const route = (data as { route?: unknown } | null)?.route;
  return typeof route === "string" && isNotificationRoute(route) ? route : null;
}

/** Baris inbox → InboxNotification (kontrak notifications.yaml). */
export function toInboxNotification(row: NotificationRow): InboxNotification {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    deep_link: deepLinkFor(safeRoute(row.data)),
    read_at: row.readAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export interface InboxListQuery {
  unreadOnly: boolean;
  category: NotificationCategory | undefined;
  cursor: string | undefined;
  limit: number;
}

export type MarkReadInput = { ids: string[] } | { all: true; upTo: Date | null };

/**
 * Kotak masuk in-app = riwayat resmi (F-13, AC F13-1, F13-2). Hanya notifikasi milik pemanggil; notifikasi milik akun
 * lain tidak pernah dibedakan dari "tidak ada" (404, N-09). Tersedia untuk semua effective_status yang memiliki sesi
 * (unverified, expired, suspended; PRD 2.2).
 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly kernel: NotificationService,
  ) {}

  /** Terbaru dahulu, keyset (created_at, id) menurun (indeks notifications_user_id_created_at_id_idx, PRD 6.5). */
  async list(userId: string, query: InboxListQuery): Promise<NotificationPage> {
    const fingerprint = filterFingerprint({
      scope: "inbox",
      unread_only: query.unreadOnly,
      category: query.category ?? null,
    });
    const after = query.cursor ? decodeKeyset(query.cursor, fingerprint) : null;
    const rows = await this.db
      .select({ row: notifications, ts: exactIso(notifications.createdAt) })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          query.unreadOnly ? isNull(notifications.readAt) : undefined,
          query.category ? eq(notifications.category, query.category) : undefined,
          after ? keysetAfterExact(notifications.createdAt, notifications.id, after, "desc") : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(({ row }) => toInboxNotification(row)),
      next_cursor: hasMore && last ? encodeKeyset({ ts: last.ts, id: last.row.id }, fingerprint) : null,
      unread_count: await this.kernel.unreadCount(userId),
    };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.kernel.unreadCount(userId);
  }

  /** Satu notifikasi milik pemanggil (pemeriksaan sebelum membuka deep link push, AC F13-3, F13-5); tidak menandai baca. */
  async get(userId: string, notificationId: string): Promise<InboxNotification> {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .limit(1);
    if (!row) throw notFound("Notifikasi tidak ditemukan.");
    return toInboxNotification(row);
  }

  /**
   * Menandai dibaca: `ids` (milik pemanggil; id lain diabaikan, N-09) atau `all` dengan batas `up_to` (inklusif, presisi
   * milidetik seperti created_at yang dikirim API) agar notifikasi yang datang setelah layar dimuat tidak ikut ditandai.
   * Idempoten alami: read_at yang sudah terisi tidak diubah.
   */
  async markRead(userId: string, input: MarkReadInput): Promise<MarkNotificationsReadResult> {
    const now = this.clock.now();
    const scope =
      "ids" in input
        ? inArray(notifications.id, input.ids)
        : input.upTo
          ? sql`${notifications.createdAt} < (${input.upTo.toISOString()}::timestamptz + interval '1 millisecond')`
          : undefined;
    const updated = await this.db
      .update(notifications)
      .set({ readAt: now })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), scope))
      .returning({ id: notifications.id });
    return { updated_count: updated.length, unread_count: await this.kernel.unreadCount(userId) };
  }
}
