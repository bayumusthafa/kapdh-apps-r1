import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components } from "@kapdh/contracts";
import { mfaTotp, sessions, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { fieldError, forbidden, unauthenticated } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { PasswordVerifier } from "../../core/identity/password-verifier.js";
import { OutboxService } from "../../core/outbox/outbox.service.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK, DB, ENV } from "../../core/tokens.js";
import { newBackupCodeSet } from "./admin-auth.shared.js";

type AdminBackupCodes = components["schemas"]["AdminBackupCodes"];

/**
 * Kredensial admin yang sedang masuk (F-02, AC F02-4, N-08): pembuatan ulang backup code (perlu reautentikasi sandi +
 * TOTP, header X-Reauth-Token) dan ganti sandi dengan sandi lama. Setiap perubahan diaudit tanpa nilai rahasia dan
 * mengirim email pemberitahuan keamanan lewat outbox `admin.security_notice` dalam transaksi yang sama (AC F17-1).
 */
@Injectable()
export class AdminCredentialsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly passwords: PasswordVerifier,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Buat ulang 10 backup code (kontrak adminRegenerateBackupCodes): seluruh hash lama diganti 10 HMAC baru dengan
   * satu UPDATE bersyarat (TOTP terverifikasi), sehingga kode lama yang belum terpakai langsung tidak berlaku. Kode
   * mentah hanya ada di respons ini.
   */
  async regenerateBackupCodes(auth: AuthContext): Promise<AdminBackupCodes> {
    const now = this.clock.now();
    const backup = newBackupCodeSet(this.env.OTP_HMAC_SECRET);
    await this.db.transaction(async (tx) => {
      const [previous] = await tx
        .select({ hashes: mfaTotp.backupCodeHashes })
        .from(mfaTotp)
        .where(eq(mfaTotp.userId, auth.userId))
        .for("update");
      const replaced = await tx
        .update(mfaTotp)
        .set({ backupCodeHashes: backup.hashes, updatedAt: now })
        .where(and(eq(mfaTotp.userId, auth.userId), isNotNull(mfaTotp.verifiedAt)))
        .returning({ userId: mfaTotp.userId });
      // Sesi admin mfa_level 2 selalu memiliki TOTP terverifikasi; selain itu data rusak → tolak tanpa perubahan.
      if (replaced.length === 0) throw forbidden("Autentikator belum terdaftar untuk akun ini.");
      await this.audit.write(tx, {
        action: "admin.backup_codes_regenerated",
        entityType: "admin",
        entityId: auth.adminId,
        before: { backup_codes_remaining: previous?.hashes.length ?? 0 },
        after: { backup_codes_remaining: backup.codes.length },
      });
      await this.outbox.publish(tx, {
        topic: "admin.security_notice",
        dedupKey: `admin.security_notice:backup_codes_regenerated:${auth.adminId}:${uuidv7()}`,
        payload: { admin_id: auth.adminId!, kind: "backup_codes_regenerated" },
      });
    });
    return { backup_codes: backup.codes, generated_at: now.toISOString() };
  }

  /**
   * Ganti sandi admin (kontrak adminChangePassword, AC F02-4). Sandi lama dinilai dengan jatah kegagalan login yang
   * dicadangkan ATOMIK (PasswordVerifier.beginAttempt: per email dan per IP); salah → 400
   * `field_errors.current_password` dan tetap dihitung (429 setelah ambang). Hash baru dihitung di luar transaksi.
   * Dalam satu transaksi: password_hash diganti dengan UPDATE bersyarat pada hash yang baru dinilai (ganti sandi
   * bersamaan tidak saling menimpa), seluruh sesi admin lain dicabut (keluarga sesi pemanggil tetap), audit
   * `admin.password_changed` tanpa nilai sandi, dan email pemberitahuan keamanan lewat outbox. Socket keluarga sesi
   * yang dicabut diputus setelah commit.
   */
  async changePassword(auth: AuthContext, currentPassword: string, newPassword: string): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
    if (!user || user.status !== "active") throw unauthenticated();
    const attempt = await this.passwords.beginAttempt(user.email);
    let matches: boolean;
    try {
      matches = await this.passwords.comparePassword(currentPassword, user.passwordHash);
    } catch (error) {
      await attempt.cancel().catch(() => undefined);
      throw error;
    }
    // Sandi lama salah: jatah tetap tercatat sebagai kegagalan login (kontrak adminChangePassword).
    if (!matches) throw fieldError("current_password", "Sandi saat ini salah.");
    await attempt.succeeded();
    if (await this.passwords.comparePassword(newPassword, user.passwordHash))
      throw fieldError("new_password", "Sandi baru harus berbeda dari sandi saat ini.");
    const passwordHash = await bcrypt.hash(newPassword, this.env.BCRYPT_COST);
    const now = this.clock.now();

    await this.db.transaction(async (tx) => {
      const changed = await tx
        .update(users)
        .set({ passwordHash, updatedAt: now })
        .where(
          and(eq(users.id, user.id), eq(users.status, "active"), eq(users.passwordHash, user.passwordHash)),
        )
        .returning({ id: users.id });
      // Sandi sudah diganti permintaan lain sejak dinilai: sandi lama yang dikirim tidak lagi berlaku.
      if (changed.length === 0) throw fieldError("current_password", "Sandi saat ini salah.");
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(
          and(eq(sessions.userId, user.id), ne(sessions.familyId, auth.familyId), isNull(sessions.revokedAt)),
        )
        .returning({ familyId: sessions.familyId });
      const families = [...new Set(revoked.map((r) => r.familyId))];
      await this.audit.write(tx, {
        action: "admin.password_changed",
        entityType: "admin",
        entityId: auth.adminId,
        after: { other_sessions_revoked: families.length },
      });
      await this.outbox.publish(tx, {
        topic: "admin.security_notice",
        dedupKey: `admin.security_notice:password_changed:${auth.adminId}:${uuidv7()}`,
        payload: { admin_id: auth.adminId!, kind: "password_changed" },
      });
      // Ditunda sampai commit (RealtimeService di dalam transaksi): socket sesi lain menerima session.revoked.
      for (const familyId of families) this.realtime.disconnectSession(familyId, "password_changed");
    });
  }
}
