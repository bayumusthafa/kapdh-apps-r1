import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { alumni, posts, users } from "@kapdh/database";
import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { JobRegistry } from "../../core/jobs/job-registry.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { DB } from "../../core/tokens.js";

/** Interval job content.announce (ARCHITECTURE §4.8: setiap menit, sekali per berita). */
export const CONTENT_ANNOUNCE_EVERY_MS = 60_000;
/** Berita yang diproses per eksekusi; sisanya diambil eksekusi berikutnya. */
const ANNOUNCE_BATCH = 20;
const TITLE_MAX = 120;
const BODY_MAX = 500;

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

export interface AnnounceResult {
  announced: number;
  notifications: number;
}

/**
 * Job `content.announce` (AC F15-5, kontrak adminPublishPost): ketika published_at berita published tiba dan
 * announced_at masih null, dalam SATU transaksi per berita:
 * 1. klaim `UPDATE posts SET announced_at = now WHERE id = ? AND status = 'published' AND published_at <= now AND
 *    announced_at IS NULL RETURNING` (hanya satu eksekusi/worker yang menang; berita archived atau dibatalkan
 *    jadwalnya tidak pernah cocok sehingga tidak pernah diumumkan atau dihidupkan kembali);
 * 2. notifikasi inbox kategori `news` (rute `/news/{slug}`) untuk alumni berstatus akun active dengan effective_status
 *    verified/expiring saat pengumuman, lewat NotificationService (dedup per pengguna + berita
 *    `news:<post_id>:<user_id>` dan outbox `notification.created` di transaksi yang sama). Push mengikuti preferensi
 *    news di prosesor notifications.deliver; berita tidak memiliki kanal email (ARCHITECTURE §4.7).
 * Kegagalan membatalkan klaim, sehingga eksekusi berikutnya mengulang tanpa notifikasi ganda (dedup).
 * Versi berita (If-Match) tidak berubah karena pengumuman bukan suntingan pengurus.
 */
@Injectable()
export class ContentAnnounceService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobRegistry,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerScheduled({
      name: "content.announce",
      everyMs: CONTENT_ANNOUNCE_EVERY_MS,
      run: async (now, job) => {
        const result = await this.announceDue(now);
        if (result.announced > 0) job.logger.info(result, "pengumuman berita terbit selesai");
      },
    });
  }

  /** Mengumumkan semua berita yang jatuh tempo pada `now` (batch berurutan sampai habis). */
  async announceDue(now: Date): Promise<AnnounceResult> {
    const total: AnnounceResult = { announced: 0, notifications: 0 };
    const skipped = new Set<string>();
    for (;;) {
      const due = await this.db
        .select({ id: posts.id })
        .from(posts)
        .where(and(eq(posts.status, "published"), lte(posts.publishedAt, now), isNull(posts.announcedAt)))
        .orderBy(asc(posts.publishedAt), asc(posts.id))
        .limit(ANNOUNCE_BATCH + skipped.size);
      const pending = due.filter((row) => !skipped.has(row.id));
      if (pending.length === 0) return total;
      for (const { id } of pending) {
        const sent = await this.announce(id, now);
        if (sent === null) skipped.add(id);
        else {
          total.announced++;
          total.notifications += sent;
        }
      }
    }
  }

  /** Satu berita; null bila sudah diklaim eksekusi lain atau tidak lagi memenuhi syarat. */
  private async announce(postId: string, now: Date): Promise<number | null> {
    return this.db.transaction(async (tx) => {
      const [post] = await tx
        .update(posts)
        .set({ announcedAt: now })
        .where(
          and(
            eq(posts.id, postId),
            eq(posts.status, "published"),
            lte(posts.publishedAt, now),
            isNull(posts.announcedAt),
          ),
        )
        .returning({ id: posts.id, slug: posts.slug, title: posts.title, excerpt: posts.excerpt });
      if (!post) return null;
      // Anggota aktif saat pengumuman (PRD 2.2): akun active, tidak suspended, masa aktif belum lewat.
      const recipients = await tx
        .select({ userId: users.id })
        .from(users)
        .innerJoin(alumni, eq(alumni.userId, users.id))
        .where(
          and(
            eq(users.kind, "alumni"),
            eq(users.status, "active"),
            isNull(alumni.suspendedAt),
            gt(alumni.expiresAt, now),
          ),
        )
        .orderBy(asc(users.id));
      let created = 0;
      for (const { userId } of recipients) {
        const result = await this.notifications.notify(tx, {
          userId,
          category: "news",
          title: clip(post.title, TITLE_MAX),
          body: post.excerpt ? clip(post.excerpt, BODY_MAX) : "Berita baru dari KAPDH. Ketuk untuk membaca.",
          route: `/news/${post.slug}`,
          data: { post_id: post.id },
          dedupKey: `news:${post.id}:${userId}`,
        });
        if (result.created) created++;
      }
      await this.audit.write(tx, {
        action: "post.announced",
        entityType: "post",
        entityId: post.id,
        after: { announced_at: now, recipient_count: recipients.length, notifications_created: created },
      });
      return created;
    });
  }
}
