import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { alumni, notifications, payments, users } from "@kapdh/database";
import { and, asc, eq, exists, gt, gte, isNull, lt, lte, not, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../../core/db/types.js";
import { JobRegistry } from "../../core/jobs/job-registry.js";
import { formatDateWib } from "../../core/membership/format.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { DB } from "../../core/tokens.js";

const DAY_MS = 24 * 3600_000;
/** Pengingat dikirim saat masa aktif tersisa <= 30 hari (expiring, AC F07-5, D4). */
export const EXPIRY_REMINDER_WINDOW_MS = 30 * DAY_MS;
/**
 * Pemberitahuan "masa KTA berakhir" hanya untuk periode yang habis dalam 30 hari terakhir (Usulan): job yang baru
 * dipasang atau worker yang lama mati tidak mengirim pemberitahuan usang untuk keanggotaan yang habis jauh sebelumnya.
 */
export const EXPIRED_NOTICE_LOOKBACK_MS = 30 * DAY_MS;
export const EXPIRY_REMINDERS_JOB = "membership.expiry-reminders";
/** Setiap jam (ARCHITECTURE §4.8). */
export const EXPIRY_REMINDERS_EVERY_MS = 3600_000;
const BATCH_SIZE = 200;
/** Batas per eksekusi agar satu jalan job tetap singkat; sisa diproses jadwal berikutnya. */
const MAX_PER_RUN = 5_000;

/** Kunci dedup satu notifikasi per periode (periode dikenali dari expires_at; renewal = periode baru). */
const EXPIRING_KEY_PREFIX = "membership.expiring:";
const EXPIRED_KEY_PREFIX = "membership.expired:";
export function expiringDedupKey(expiresAt: Date): string {
  return `${EXPIRING_KEY_PREFIX}${expiresAt.getTime()}`;
}
export function expiredDedupKey(expiresAt: Date): string {
  return `${EXPIRED_KEY_PREFIX}${expiresAt.getTime()}`;
}

/**
 * Penyaring awal (hemat transaksi): kandidat yang sudah memiliki notifikasi periode ini dilewati. Bentuknya sama dengan
 * kunci NotificationService (`u:<user_id>:<dedupKey>`, epoch milidetik expires_at). Kebenaran tidak bergantung pada
 * penyaring ini: notify tetap idempoten lewat notifications_dedup_key_key.
 */
function notNotified(prefix: string): SQL {
  return sql`not exists (select 1 from ${notifications} where ${notifications.dedupKey} = 'u:' || ${alumni.userId}::text || ':' || ${prefix}::text || (floor(extract(epoch from ${alumni.expiresAt}) * 1000))::bigint::text)`;
}

interface NoticeText {
  title: string;
  body: string;
  dedupKey: string;
}

export interface ExpiryRunResult {
  reminders: number;
  expiredNotices: number;
}

/**
 * Job `membership.expiry-reminders` (AC F07-5, F13-6; ARCHITECTURE §4.8): setiap jam, untuk akun alumni aktif yang
 * tidak disuspend,
 * - pengingat kategori membership saat sisa masa aktif <= 30 hari (expiring), kecuali iuran renewal sedang menunggu
 *   verifikasi pengurus;
 * - pemberitahuan sekali saat masa aktif habis (now >= expires_at) dalam jendela 30 hari terakhir.
 * Satu notifikasi per periode lewat kunci dedup per pengguna + expires_at (notifications.dedup_key unik): job yang
 * diulang, dijalankan bersamaan di dua worker, atau terlambat tidak pernah menggandakan inbox/outbox. Setiap kandidat
 * dinilai ulang pada data terkini di dalam transaksi notifikasinya (PRD 5.1), sehingga renewal, suspend atau
 * penonaktifan yang terjadi setelah kandidat dipilih tidak menghasilkan notifikasi usang. Hak akses tidak bergantung
 * pada job ini (AC F07-3: status selalu dihitung dari timestamp).
 */
@Injectable()
export class ExpiryRemindersService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobRegistry,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerScheduled({
      name: EXPIRY_REMINDERS_JOB,
      everyMs: EXPIRY_REMINDERS_EVERY_MS,
      run: async (now, job) => {
        const result = await this.run(now);
        if (result.reminders > 0 || result.expiredNotices > 0)
          job.logger.info(
            { reminders: result.reminders, expired_notices: result.expiredNotices },
            "pengingat masa keanggotaan dikirim",
          );
      },
    });
  }

  async run(now: Date): Promise<ExpiryRunResult> {
    const reminders = await this.sweep(
      and(
        gt(alumni.expiresAt, now),
        lte(alumni.expiresAt, new Date(now.getTime() + EXPIRY_REMINDER_WINDOW_MS)),
        // Iuran renewal yang sudah dikirim buktinya dan menunggu verifikasi tidak perlu diingatkan.
        not(
          exists(
            this.db
              .select({ one: sql`1` })
              .from(payments)
              .where(
                and(
                  eq(payments.userId, alumni.userId),
                  eq(payments.type, "renewal"),
                  eq(payments.status, "pending"),
                  gt(payments.proofVersion, 0),
                ),
              ),
          ),
        ),
      )!,
      notNotified(EXPIRING_KEY_PREFIX),
      (expiresAt) => ({
        title: "Masa KTA segera berakhir",
        body: `KTA Anda berlaku sampai ${formatDateWib(expiresAt)}. Perpanjang sekarang agar keanggotaan tetap aktif.`,
        dedupKey: expiringDedupKey(expiresAt),
      }),
    );
    const expiredNotices = await this.sweep(
      and(
        lte(alumni.expiresAt, now),
        gt(alumni.expiresAt, new Date(now.getTime() - EXPIRED_NOTICE_LOOKBACK_MS)),
      )!,
      notNotified(EXPIRED_KEY_PREFIX),
      (expiresAt) => ({
        title: "Masa KTA telah berakhir",
        body: `Keanggotaan Anda berakhir pada ${formatDateWib(expiresAt)}. Perpanjang untuk kembali menjadi anggota aktif.`,
        dedupKey: expiredDedupKey(expiresAt),
      }),
    );
    return { reminders, expiredNotices };
  }

  /**
   * Memproses kandidat berurutan keyset (expires_at, user_id) dalam batch; setiap notifikasi pada transaksinya
   * sendiri (inbox + outbox notification.created atomik, AC F04-1). `eligible` (jendela periode dan syarat jenis
   * notifikasi) dinilai saat memilih kandidat DAN dinilai ulang per kandidat di dalam transaksinya, karena di antara
   * keduanya renewal dapat disetujui, anggota disuspend/dinonaktifkan, atau bukti renewal dikirim
   * ({@link deliverIfStillDue}). `prefilter` hanya penghemat (dedup). Mengembalikan jumlah notifikasi BARU.
   */
  private async sweep(
    eligible: SQL,
    prefilter: SQL,
    message: (expiresAt: Date) => NoticeText,
  ): Promise<number> {
    let created = 0;
    let processed = 0;
    let cursor: { expiresAt: Date; userId: string } | null = null;
    while (processed < MAX_PER_RUN) {
      const after: SQL | undefined = cursor
        ? or(
            gt(alumni.expiresAt, cursor.expiresAt),
            and(eq(alumni.expiresAt, cursor.expiresAt), gt(alumni.userId, cursor.userId)),
          )
        : undefined;
      const batch: { userId: string; expiresAt: Date | null }[] = await this.db
        .select({ userId: alumni.userId, expiresAt: alumni.expiresAt })
        .from(alumni)
        .innerJoin(users, eq(users.id, alumni.userId))
        .where(
          and(
            eq(users.kind, "alumni"),
            eq(users.status, "active"),
            isNull(alumni.suspendedAt),
            eligible,
            prefilter,
            after,
          ),
        )
        .orderBy(asc(alumni.expiresAt), asc(alumni.userId))
        .limit(BATCH_SIZE);
      for (const row of batch) {
        if (await this.deliverIfStillDue(row.userId, row.expiresAt!, eligible, message)) created++;
      }
      processed += batch.length;
      if (batch.length < BATCH_SIZE) break;
      const last: { userId: string; expiresAt: Date | null } = batch[batch.length - 1]!;
      cursor = { expiresAt: last.expiresAt!, userId: last.userId };
    }
    return created;
  }

  /**
   * Satu kandidat dalam transaksinya sendiri (AC F07-5, PRD 5.1): baris users lalu alumni dikunci FOR SHARE menurut
   * URUTAN KUNCI kernel (users → alumni, kontrak C3/C5; tidak deadlock dengan persetujuan renewal, suspend,
   * penonaktifan atau penghapusan akun yang mengunci FOR NO KEY UPDATE/FOR UPDATE), lalu kondisi kandidat dinilai ulang
   * pada data TERKINI: akun alumni aktif, tidak disuspend, `expires_at` masih periode yang sama, dan `eligible` masih
   * terpenuhi. Bila tidak, notifikasi wajib yang tidak dapat ditarik ini tidak dikirim (mis. "segera berakhir" untuk
   * tanggal lama setelah renewal disetujui). Perubahan yang commit setelah transaksi ini terserialisasi sesudah
   * notifikasi, sehingga isi notifikasi selalu benar pada saat dibuat. Mengembalikan true bila notifikasi BARU dibuat.
   */
  private async deliverIfStillDue(
    userId: string,
    expiresAt: Date,
    eligible: SQL,
    message: (expiresAt: Date) => NoticeText,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.kind, "alumni"), eq(users.status, "active")))
        .for("share");
      if (!owner) return false;
      const [current] = await tx
        .select({ userId: alumni.userId })
        .from(alumni)
        .where(
          and(
            eq(alumni.userId, userId),
            isNull(alumni.suspendedAt),
            // Periode sama (presisi milidetik seperti kunci dedup): renewal = periode baru dengan notifikasinya sendiri.
            gte(alumni.expiresAt, expiresAt),
            lt(alumni.expiresAt, new Date(expiresAt.getTime() + 1)),
            eligible,
          ),
        )
        .for("share");
      if (!current) return false;
      const text = message(expiresAt);
      const result = await this.notifications.notify(tx, {
        userId,
        category: "membership",
        title: text.title,
        body: text.body,
        route: "/renewal",
        dedupKey: text.dedupKey,
      });
      return result.created;
    });
  }
}
