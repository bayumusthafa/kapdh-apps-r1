import { Inject, Injectable } from "@nestjs/common";
import { otpCodes, sessions, users } from "@kapdh/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { withTx } from "../../core/db/tx.js";
import type { Db, Tx } from "../../core/db/types.js";
import { normalizeEmail } from "../../core/identity/email.js";
import { revokeDeviceTokens } from "../../core/notifications-kernel/device-tokens.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { DeletionRequestService, type UserRow } from "./deletion-request.service.js";

/**
 * Tindakan operator atas status akun alumni `disabled` (PRD 2.2 "disabled: pemulihan yang disetujui"; F-14; kontrak
 * auth.yaml login `next: account_disabled` dan account.yaml verifyWebDeletion `blocked_reason: account_disabled`
 * "pemulihan atau penghapusan melalui kanal bantuan"):
 * - `disable`: active -> disabled (pemblokiran oleh pengurus, mis. akun disalahgunakan);
 * - `enable`: disabled -> active (pemulihan yang disetujui);
 * - `delete`: disabled -> deletion_pending, permintaan penghapusan dari kanal bantuan setelah identitas pemilik
 *   diverifikasi (job dan deletion ledger yang sama dengan F-14).
 */
export type AccountStatusAction = "disable" | "enable" | "delete";

export interface AccountStatusInput {
  email: string;
  action: AccountStatusAction;
  /** Alasan tertulis untuk audit (wajib; mis. nomor tiket bantuan dan dasar persetujuan). */
  reason: string;
  /** Pengurus yang menyetujui tindakan (nama/peran), dicatat pada audit. */
  approvedBy: string;
}

export interface AccountStatusResult {
  userId: string;
  action: AccountStatusAction;
  before: "active" | "disabled";
  after: "active" | "disabled" | "deletion_pending";
  sessionsRevoked: number;
  /** Nomor permintaan penghapusan (`delete`). */
  requestNumber: string | null;
}

/** Penolakan yang aman dicetak CLI (tanpa data pribadi selain yang diketik operator). */
export class AccountStatusRefusedError extends Error {
  override name = "AccountStatusRefusedError";
}

const REQUIRED_STATUS: Readonly<Record<AccountStatusAction, "active" | "disabled">> = {
  disable: "active",
  enable: "disabled",
  delete: "disabled",
};

const TEXT_MAX = 500;

/**
 * Transisi status akun alumni `disabled` untuk operator (runbook docs/runbooks/alumni-account-disabled.md). Tidak ada
 * rute HTTP: dijalankan lewat CLI `account:status` dengan env worker. Setiap tindakan berjalan dalam SATU transaksi
 * dengan baris users terkunci (urutan kunci global users lebih dahulu), transisi bersyarat dari status yang diharapkan,
 * dan audit `account.disabled` / `account.enabled` / `account.deletion_requested` (aktor system, alasan dan penyetuju
 * tercatat; F-17). Hanya akun alumni; identitas admin dikelola lewat PATCH /admin/admins/{adminId}.
 */
@Injectable()
export class AccountStatusService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly requests: DeletionRequestService,
  ) {}

  async apply(input: AccountStatusInput): Promise<AccountStatusResult> {
    const reason = input.reason.trim();
    const approvedBy = input.approvedBy.trim();
    if (!reason || reason.length > TEXT_MAX)
      throw new AccountStatusRefusedError(`Alasan wajib diisi (maksimal ${TEXT_MAX} karakter).`);
    if (!approvedBy || approvedBy.length > TEXT_MAX)
      throw new AccountStatusRefusedError(`Penyetuju wajib diisi (maksimal ${TEXT_MAX} karakter).`);
    const email = normalizeEmail(input.email);
    const required = REQUIRED_STATUS[input.action];

    return withTx(this.db, async (tx) => {
      const [found] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), eq(users.kind, "alumni")))
        .limit(1);
      const user = found ? await this.requests.lockUser(tx, found.id) : undefined;
      if (!user || user.kind !== "alumni")
        throw new AccountStatusRefusedError("Akun alumni dengan email itu tidak ditemukan.");
      if (user.status !== required)
        throw new AccountStatusRefusedError(
          `Status akun saat ini ${user.status}; tindakan ${input.action} hanya untuk akun ${required}.`,
        );
      switch (input.action) {
        case "disable":
          return this.disable(tx, user, reason, approvedBy);
        case "enable":
          return this.enable(tx, user, reason, approvedBy);
        case "delete":
          return this.requestDeletion(tx, user, reason, approvedBy);
      }
    });
  }

  /**
   * active -> disabled: session_version naik, semua sesi dicabut, token push dicabut (beserta pengiriman pending),
   * challenge OTP aktif dibatalkan, lalu setelah commit socket menerima session.revoked `account_disabled` (PRD 2.2:
   * tanpa sesi dan API biasa). Login berikutnya dijawab `next: account_disabled` tanpa sesi.
   */
  private async disable(
    tx: Tx,
    user: UserRow,
    reason: string,
    approvedBy: string,
  ): Promise<AccountStatusResult> {
    const now = this.clock.now();
    await tx
      .update(users)
      .set({ status: "disabled", sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now })
      .where(and(eq(users.id, user.id), eq(users.status, "active")));
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
      action: "account.disabled",
      entityType: "user",
      entityId: user.id,
      reason,
      before: { status: "active" },
      after: {
        status: "disabled",
        approved_by: approvedBy,
        channel: "operator_cli",
        sessions_revoked: revoked.length,
        // Bukan `*_tokens_*`: kunci bersegmen token dibuang penyaring audit (sanitize.ts).
        push_devices_revoked: devices,
      },
    });
    this.realtime.disconnectUser(user.id, "account_disabled");
    return {
      userId: user.id,
      action: "disable",
      before: "active",
      after: "disabled",
      sessionsRevoked: revoked.length,
      requestNumber: null,
    };
  }

  /** disabled -> active (pemulihan yang disetujui, PRD 2.2). Pemilik masuk ulang dengan sandinya sendiri. */
  private async enable(
    tx: Tx,
    user: UserRow,
    reason: string,
    approvedBy: string,
  ): Promise<AccountStatusResult> {
    await tx
      .update(users)
      .set({ status: "active", updatedAt: this.clock.now() })
      .where(and(eq(users.id, user.id), eq(users.status, "disabled")));
    await this.audit.write(tx, {
      action: "account.enabled",
      entityType: "user",
      entityId: user.id,
      reason,
      before: { status: "disabled" },
      after: { status: "active", approved_by: approvedBy, channel: "operator_cli" },
    });
    return {
      userId: user.id,
      action: "enable",
      before: "disabled",
      after: "active",
      sessionsRevoked: 0,
      requestNumber: null,
    };
  }

  /**
   * disabled -> deletion_pending lewat transisi permintaan yang sama dengan POST /me/deletion dan
   * /public/deletion/confirm (AC F14-1): satu permintaan sumber `web` (kanal di luar aplikasi), batas 7 hari, outbox
   * job `account.deletion` (email konfirmasi ke alamat akun adalah langkah pertama job) dan entri deletion ledger.
   * Audit `account.deletion_requested` dari transisi itu ditambah catatan alasan/penyetuju operator.
   */
  private async requestDeletion(
    tx: Tx,
    user: UserRow,
    reason: string,
    approvedBy: string,
  ): Promise<AccountStatusResult> {
    const deletion = await this.requests.create(tx, user, {
      source: "web",
      expectedStatus: "disabled",
      actor: { kind: "system", userId: null, adminId: null, adminRole: null },
    });
    await this.audit.write(tx, {
      action: "account.deletion_requested_by_operator",
      entityType: "user",
      entityId: user.id,
      reason,
      before: { status: "disabled" },
      after: {
        status: "deletion_pending",
        request_number: deletion.requestNumber,
        approved_by: approvedBy,
        channel: "operator_cli",
      },
    });
    return {
      userId: user.id,
      action: "delete",
      before: "disabled",
      after: "deletion_pending",
      sessionsRevoked: 0,
      requestNumber: deletion.requestNumber,
    };
  }
}
