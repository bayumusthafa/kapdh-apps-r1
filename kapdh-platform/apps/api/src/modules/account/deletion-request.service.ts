import { Inject, Injectable } from "@nestjs/common";
import { accountDeletions, otpCodes, sessions, users } from "@kapdh/database";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Actor } from "../../core/context/request-context.js";
import { isCheckViolation } from "../../core/db/errors.js";
import type { Tx } from "../../core/db/types.js";
import { AppException } from "../../core/errors/app-exception.js";
import type { AccountStatus } from "../../core/membership/effective-status.js";
import { revokeDeviceTokens } from "../../core/notifications-kernel/device-tokens.js";
import { OutboxService } from "../../core/outbox/outbox.service.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK } from "../../core/tokens.js";
import { deletionDeadline, newRequestNumber } from "./deletion-policy.js";

export type DeletionRow = typeof accountDeletions.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export const OPEN_DELETION_STATUSES = ["pending", "processing", "failed"] as const;

/** Akun pengurus utama terakhir yang masih dapat login tidak dapat dihapus sebelum pengalihan (PRD 3.14, AC F16-2). */
export const lastSuperAdminConflict = () =>
  new AppException(
    409,
    "VALIDATION_ERROR",
    "Akun ini adalah Super Admin terakhir yang aktif. Alihkan kewenangan Super Admin kepada pengurus lain lebih dahulu.",
    {
      fieldErrors: {
        _: ["Super Admin terakhir memerlukan pengalihan kewenangan sebelum akunnya dihapus (PRD 3.14)."],
      },
    },
  );

/** Memetakan penjaga trigger `admins_last_super_admin_chk` (23514) ke 409 yang jelas; galat lain diteruskan. */
export function mapLastSuperAdmin(error: unknown): never {
  if (isCheckViolation(error, "admins_last_super_admin_chk")) throw lastSuperAdminConflict();
  throw error;
}

export interface CreateDeletionInput {
  source: "app" | "web";
  /** Status akun yang diharapkan saat konfirmasi (`active` termasuk suspended, atau `pending_otp` dari web). */
  expectedStatus: Extract<AccountStatus, "active" | "pending_otp">;
  actor: Pick<Actor, "kind" | "userId" | "adminId" | "adminRole">;
}

/**
 * Transisi permintaan penghapusan (AC F14-1) yang dipakai bersama POST /me/deletion dan POST /public/deletion/confirm.
 * Dipanggil DI DALAM transaksi pemanggil yang SUDAH mengunci baris users (`lockUser`), sehingga semua efek berikut
 * atomik:
 * - transisi bersyarat `users.status <expected> -> deletion_pending` dan session_version naik (token lama mati);
 * - satu baris account_deletions (nomor DEL-YYYY-XXXXXXXX, batas 7 hari; `account_deletions_user_id_open_key`);
 * - semua sesi dicabut, token push dicabut beserta pengiriman pending (AC F13-5), challenge OTP aktif dibatalkan
 *   (pendaftaran pending_otp: kode aktivasi yang sudah terkirim tidak lagi dapat mengaktifkan akun);
 * - audit `account.deletion_requested` dan outbox `account.deletion.requested` (job; email konfirmasi adalah langkah
 *   pertama job);
 * - setelah commit seluruh socket pengguna menerima session.revoked lalu diputus.
 */
@Injectable()
export class DeletionRequestService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Mengunci baris users (FOR NO KEY UPDATE, urutan kunci global users lebih dahulu, kontrak C3). */
  async lockUser(tx: Tx, userId: string): Promise<UserRow | undefined> {
    const [row] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
    return row;
  }

  /** Permintaan terbuka terbaru (pending/processing/failed) milik akun, atau undefined. */
  async openRequest(tx: Tx, userId: string): Promise<DeletionRow | undefined> {
    const [row] = await tx
      .select()
      .from(accountDeletions)
      .where(
        and(
          eq(accountDeletions.userId, userId),
          inArray(accountDeletions.status, [...OPEN_DELETION_STATUSES]),
        ),
      )
      .orderBy(desc(accountDeletions.requestedAt))
      .limit(1);
    return row;
  }

  /**
   * Endpoint hanya meneruskan akun alumni (audience mobile; alur web memberi challenge pengganti untuk akun admin).
   * Penjaga terakhir tetap di database: bila transisi ini pernah dijalankan untuk identitas Super Admin terakhir yang
   * dapat login, trigger `admins_last_super_admin_chk` menolak dan galatnya dipetakan ke 409 yang jelas (PRD 3.14).
   */
  async create(tx: Tx, user: UserRow, input: CreateDeletionInput): Promise<DeletionRow> {
    const now = this.clock.now();
    const moved = await tx
      .update(users)
      .set({ status: "deletion_pending", sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now })
      .where(and(eq(users.id, user.id), eq(users.status, input.expectedStatus)))
      .returning({ id: users.id })
      .catch(mapLastSuperAdmin);
    if (moved.length === 0)
      throw new AppException(410, "OTP_EXPIRED", "Keadaan akun sudah berubah. Ulangi verifikasi email.");

    const deletion = await this.insertRequest(tx, user.id, input.source, now);
    const revoked = await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    const devices = await revokeDeviceTokens(tx, { userId: user.id }, now);
    await tx
      .update(otpCodes)
      .set({ supersededAt: now })
      .where(and(eq(otpCodes.userId, user.id), isNull(otpCodes.consumedAt), isNull(otpCodes.supersededAt)));
    await this.audit.write(tx, {
      actor: input.actor,
      action: "account.deletion_requested",
      entityType: "user",
      entityId: user.id,
      after: {
        request_number: deletion.requestNumber,
        source: input.source,
        status: "deletion_pending",
        sessions_revoked: revoked.length,
        device_tokens_revoked: devices,
      },
    });
    await this.outbox.publish(tx, {
      topic: "account.deletion.requested",
      dedupKey: `account.deletion.requested:${deletion.id}`,
      payload: { deletion_id: deletion.id, user_id: user.id },
    });
    // Ditunda sampai commit (RealtimeService di dalam transaksi): seluruh socket menerima session.revoked lalu putus.
    this.realtime.disconnectUser(user.id, "deletion_requested");
    return deletion;
  }

  /** Menyisipkan permintaan dengan nomor unik (tabrakan nomor acak diulang dengan nomor baru, tanpa sequence kedua). */
  async insertRequest(
    tx: Tx,
    userId: string,
    source: "app" | "web",
    requestedAt: Date,
    fixed?: { id: string; requestNumber: string },
  ): Promise<DeletionRow> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const [row] = await tx
        .insert(accountDeletions)
        .values({
          id: fixed?.id ?? uuidv7(),
          requestNumber: fixed?.requestNumber ?? newRequestNumber(requestedAt),
          userId,
          source,
          status: "pending",
          stepsDone: [],
          requestedAt,
          deadlineAt: deletionDeadline(requestedAt),
          createdAt: this.clock.now(),
          updatedAt: this.clock.now(),
        })
        .onConflictDoNothing({ target: accountDeletions.requestNumber })
        .returning();
      if (row) return row;
      if (fixed) break;
    }
    throw new Error("Nomor permintaan penghapusan tidak dapat dibuat");
  }
}
