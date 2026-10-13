import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import type { Db } from "../../core/db/types.js";
import { JobRegistry } from "../../core/jobs/job-registry.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { DB } from "../../core/tokens.js";

const DEDUP_PREFIX = "member.password_reset_initiated:";

/** Dedup notifikasi/outbox per challenge pemulihan (satu pemberitahuan per inisiasi, AC F16-4). */
export function passwordResetDedupKey(challengeId: string): string {
  return `${DEDUP_PREFIX}${challengeId}`;
}

/** Teks notifikasi keamanan: tanpa challenge_id maupun kode (kontrak adminInitiateMemberPasswordReset). */
export const PASSWORD_RESET_NOTICE = {
  title: "Pemulihan sandi dimulai pengurus",
  body:
    "Pengurus KAPDH memulai pemulihan sandi akun Anda dan semua sesi telah dikeluarkan. Buka email terverifikasi Anda " +
    "untuk kode pemulihan. Bila Anda tidak meminta ini, hubungi bantuan KAPDH.",
} as const;

/**
 * Handler topik outbox `member.password_reset_initiated` (ARCHITECTURE §4.7; AC F16-4): memastikan pemberitahuan
 * keamanan untuk inisiasi itu ada di inbox anggota (kategori security, wajib) sehingga email/push pemberitahuan
 * dijadwalkan prosesor notifications.deliver lewat `notification.created`. Idempoten: kunci dedup sama dengan yang
 * ditulis transaksi inisiasi, jadi pengiriman ulang event setelah crash tidak pernah menggandakan inbox. Akun yang
 * sudah dihapus/tidak aktif dilewati (pemberitahuan tidak relevan lagi). Payload hanya id (N-14); tidak ada kode.
 */
@Injectable()
export class PasswordResetNoticeHandler implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobRegistry,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerTopicHandler({
      topic: "member.password_reset_initiated",
      handle: async (event) => {
        if (!event.dedupKey.startsWith(DEDUP_PREFIX)) return;
        await this.ensureNotice(event.payload.user_id, event.dedupKey);
      },
    });
  }

  async ensureNotice(userId: string, dedupKey: string): Promise<boolean> {
    const [user] = await this.db
      .select({ status: users.status, kind: users.kind })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || user.kind !== "alumni" || user.status !== "active") return false;
    const result = await this.db.transaction((tx) =>
      this.notifications.notify(tx, {
        userId,
        category: "security",
        title: PASSWORD_RESET_NOTICE.title,
        body: PASSWORD_RESET_NOTICE.body,
        dedupKey,
      }),
    );
    return result.created;
  }
}
