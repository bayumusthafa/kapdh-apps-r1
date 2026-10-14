import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { BaseEnv } from "@kapdh/config";
import { admins, auditLogs, outboxEvents, users } from "@kapdh/database";
import { and, eq, gt } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import type { MailMessage, Mailer } from "../../core/adapters/mailer.js";
import type { Db } from "../../core/db/types.js";
import { adminInviteTokenHash, newAdminInviteToken } from "../../core/identity/crypto.js";
import { maskEmail } from "../../core/identity/email.js";
import type { JobContext, OutboxEvent } from "../../core/jobs/job-registry.js";
import { JobRegistry } from "../../core/jobs/job-registry.js";
import { CLOCK, DB, ENV, MAILER } from "../../core/tokens.js";
import { adminInvitationLink, invitationMail, securityNoticeMail } from "./admin-mail.js";

/**
 * Handler outbox email pengurus (F-16, PRD 3.16; ARCHITECTURE §4.7) yang dijalankan worker:
 *
 * - `admin.invitation.requested`: token undangan sekali pakai DIBUAT DI SINI dan hanya hash-nya disimpan, dengan
 *   UPDATE bersyarat ronde undangan (status invited dan invite_expires_at sama persis dengan event). Event usang
 *   (undangan sudah diganti, dibatalkan, diterima, atau kedaluwarsa) tidak mengirim apa pun. Token tidak pernah ada di
 *   outbox, respons API, audit, atau log (ARCHITECTURE §2.3). Pengiriman gagal diulang outbox dan setiap percobaan
 *   menerbitkan token baru, sehingga hanya tautan di email terakhir yang berlaku.
 * - `admin.security_notice`: pemberitahuan keamanan ke email login admin; `email_changed` ke alamat lama yang dibaca
 *   dari `before.email` entri audit perubahan (payload outbox tanpa PII, N-14).
 *
 * Pengiriman ulang (outbox at-least-once, PRD 5.1): worker yang mati setelah server SMTP menerima pesan tetapi sebelum
 * event ditandai `dispatched`, atau balasan SMTP yang hilang setelah akhir DATA, membuat handler dijalankan lagi.
 * Penanda "sudah terkirim" tidak menutup celah itu (penanda ditulis SESUDAH SMTP menerima, celahnya sama dengan
 * finalisasi outbox), sehingga dedup dilakukan di sisi penerima seperti notifikasi F-13: pemberitahuan keamanan
 * memakai Message-ID stabil per event outbox ({@link securityNoticeDedupKey}), isi sama, dan salinan ulang dikenali
 * penerima sebagai pesan yang sama. Email undangan SENGAJA tanpa Message-ID stabil: setiap percobaan memuat token
 * sekali pakai BARU dan token lama tidak berlaku lagi, sehingga Message-ID yang sama justru membuat penerima membuang
 * salinan terbaru (satu-satunya tautan yang berlaku) dan menyimpan tautan yang sudah ditolak (410).
 */
@Injectable()
export class AdminMailJob implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: BaseEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly jobs: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.jobs.registerTopicHandler({
      topic: "admin.invitation.requested",
      handle: (event, ctx) => this.invitation(event, ctx),
    });
    this.jobs.registerTopicHandler({
      topic: "admin.security_notice",
      handle: (event, ctx) => this.securityNotice(event, ctx),
    });
  }

  async invitation(event: OutboxEvent<"admin.invitation.requested">, ctx: JobContext): Promise<void> {
    const now = this.clock.now();
    const round = new Date(event.payload.invite_expires_at);
    const token = newAdminInviteToken();
    const [admin] = await this.db
      .update(admins)
      .set({ inviteTokenHash: adminInviteTokenHash(token) })
      .where(
        and(
          eq(admins.id, event.payload.admin_id),
          eq(admins.status, "invited"),
          eq(admins.inviteExpiresAt, round),
          gt(admins.inviteExpiresAt, now),
        ),
      )
      .returning({
        userId: admins.userId,
        displayName: admins.displayName,
        activatedAt: admins.activatedAt,
        inviteExpiresAt: admins.inviteExpiresAt,
      });
    if (!admin) {
      ctx.logger.info({ admin_id: event.payload.admin_id }, "undangan admin usang; email tidak dikirim");
      return;
    }
    const [account] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, admin.userId))
      .limit(1);
    if (!account) return;
    // Tanpa dedupKey (lihat kepala kelas): isi berbeda setiap percobaan karena token baru.
    await this.deliver(
      invitationMail({
        to: account.email,
        displayName: admin.displayName,
        link: adminInvitationLink(this.env.ADMIN_ORIGIN, token),
        expiresAt: admin.inviteExpiresAt ?? round,
        recovery: admin.activatedAt !== null,
      }),
    );
  }

  async securityNotice(event: OutboxEvent<"admin.security_notice">, ctx: JobContext): Promise<void> {
    const { admin_id: adminId, kind, audit_id: auditId } = event.payload;
    const [admin] = await this.db
      .select({ displayName: admins.displayName, email: users.email })
      .from(admins)
      .innerJoin(users, eq(users.id, admins.userId))
      .where(eq(admins.id, adminId))
      .limit(1);
    if (!admin) return;
    let to = admin.email;
    let maskedNewEmail: string | null = null;
    if (kind === "email_changed") {
      if (!auditId) return;
      const [entry] = await this.db
        .select({ before: auditLogs.before })
        .from(auditLogs)
        .where(
          and(eq(auditLogs.id, auditId), eq(auditLogs.entityType, "admin"), eq(auditLogs.entityId, adminId)),
        )
        .limit(1);
      const previous = (entry?.before as { email?: unknown } | null | undefined)?.email;
      if (typeof previous !== "string" || previous === admin.email) {
        ctx.logger.warn({ admin_id: adminId }, "alamat lama pengalihan email admin tidak ditemukan");
        return;
      }
      to = previous;
      maskedNewEmail = maskEmail(admin.email);
    }
    // Waktu perubahan = waktu event outbox ditulis (transaksi yang sama dengan perubahan), bukan waktu percobaan kirim:
    // tetap benar setelah backoff dan isi pengiriman ulang sama persis dengan salinan pertama.
    const [origin] = await this.db
      .select({ createdAt: outboxEvents.createdAt })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, event.id))
      .limit(1);
    const at = origin?.createdAt ?? this.clock.now();
    await this.deliver({
      ...securityNoticeMail({ to, displayName: admin.displayName, kind, at, maskedNewEmail }),
      dedupKey: securityNoticeDedupKey(event.id),
    });
  }

  /**
   * Mengirim lewat {@link Mailer.send} (antarmuka terpadu: galat SMTP diteruskan sehingga outbox mengulang lalu
   * menandai event `dead`). Pengganti Mailer yang tidak menyediakan `send` saat runtime (mis. tiruan uji lama yang
   * di-cast) gagal jelas, bukan diam-diam membuang email undangan.
   */
  private async deliver(message: MailMessage): Promise<void> {
    if (typeof (this.mailer as Partial<Mailer>).send !== "function")
      throw new Error("Mailer tidak mendukung email transaksional (Mailer.send)");
    await this.mailer.send(message);
  }
}

/**
 * Kunci pesan pemberitahuan keamanan admin = id baris outbox (stabil di setiap pengiriman ulang event yang sama, unik
 * antar-event karena dedup_key outbox UNIQUE). SmtpMailer menjadikannya Message-ID `<kunci.notifikasi@domain>`.
 */
export function securityNoticeDedupKey(outboxEventId: string): string {
  return `admin-security-notice.${outboxEventId}`;
}
