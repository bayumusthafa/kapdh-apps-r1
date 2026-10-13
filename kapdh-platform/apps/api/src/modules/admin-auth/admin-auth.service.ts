import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import { type components, PERMISSION_VALUES } from "@kapdh/contracts";
import { admins, auditLogs, mfaTotp, sessions, users } from "@kapdh/database";
import { and, desc, eq, lt, min, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { tryCtx } from "../../core/context/request-context.js";
import type { Db } from "../../core/db/types.js";
import { AppException, unauthenticated } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { backupCodeHash, decryptSecret, matchTotpStep } from "../../core/identity/crypto.js";
import { LOGIN_WINDOW_MS, PasswordVerifier } from "../../core/identity/password-verifier.js";
import { type IssuedSession, SessionIssuer } from "../../core/identity/session-issuer.js";
import { TokenService } from "../../core/identity/token.service.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB, ENV } from "../../core/tokens.js";

type AdminLoginResponse = components["schemas"]["AdminLoginResponse"];
type AdminProfile = components["schemas"]["AdminProfile"];

/** Kontrak adminVerifyMfa: 429 setelah 5 kegagalan kode dalam 15 menit per admin (AC F02-2). */
export const MFA_FAILS_LIMIT = 5;

/**
 * Penanda internal kode MFA salah (TOTP tidak cocok/diputar ulang, backup code tidak dikenal). Diubah menjadi 400
 * VALIDATION_ERROR dengan sisa percobaan setelah transaksi dibatalkan (kontrak adminVerifyMfa).
 */
class WrongMfaCode extends Error {
  constructor(readonly field: "totp_code" | "backup_code") {
    super("kode MFA salah");
  }
}

/**
 * Login admin dua tahap dan profil admin (F-02 admin, F-16; ARCHITECTURE §4.1 modul admin-auth). Pemeriksaan sandi
 * (PasswordVerifier) dan penerbitan sesi (SessionIssuer) memakai primitif core yang sama dengan login alumni.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly passwords: PasswordVerifier,
    private readonly sessionIssuer: SessionIssuer,
    private readonly tokens: TokenService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  /** Admin `active` dengan TOTP terverifikasi (AC F02-2, F-16): satu-satunya yang boleh tahap sandi admin. */
  private async adminCanLogin(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ status: admins.status, totpVerifiedAt: mfaTotp.verifiedAt })
      .from(admins)
      .leftJoin(mfaTotp, eq(mfaTotp.userId, admins.userId))
      .where(eq(admins.userId, userId))
      .limit(1);
    return row?.status === "active" && row.totpVerifiedAt !== null;
  }

  /**
   * Tahap sandi admin (AC F02-2; kontrak adminLogin). Hanya admin `active` dengan TOTP terverifikasi yang memperoleh
   * mfa_token (5 menit, hanya untuk POST /admin/auth/mfa). Admin `invited`/`disabled` atau tanpa TOTP terverifikasi
   * mendapat 401 yang sama dengan sandi salah dan dicatat ke batas kegagalan yang sama, sehingga sandi bocor tidak
   * cukup untuk mendaftarkan autentikator penyerang; pendaftaran TOTP hanya lewat token penerimaan undangan (F-16).
   */
  async adminLogin(emailRaw: string, password: string): Promise<AdminLoginResponse> {
    const user = await this.passwords.verify(
      emailRaw,
      password,
      "admin",
      async (account) => account.status === "active" && (await this.adminCanLogin(account.id)),
    );
    const mfa = await this.tokens.signMfa(user.id);
    return {
      mfa_token: mfa.token,
      mfa_expires_at: mfa.expiresAt.toISOString(),
      totp_enrollment_required: false,
    };
  }

  /**
   * Tahap TOTP admin (AC F02-2; kontrak adminVerifyMfa). Satu jatah kegagalan `mfa:<user>` dicadangkan ATOMIK
   * sebelum kode dinilai, sehingga permintaan paralel dengan mfa_token yang sama menilai paling banyak 5 kode per
   * 15 menit (pola lama peek → nilai → hit dapat dilewati). Baris mfa_totp dikunci sehingga percobaan bersamaan
   * berurutan: kode TOTP hanya berlaku untuk langkah waktu yang lebih baru dari last_used_step (anti replay, RFC 6238
   * §5.2) dan backup code dikonsumsi atomik sekali pakai. Kode salah → 400 VALIDATION_ERROR pada field kode dengan
   * sisa percobaan (mfa_token tetap berlaku; jatah tetap tercatat); kode benar atau 401 (mfa_token tidak sah, admin/akun
   * tidak lagi aktif, TOTP tidak terverifikasi) mengembalikan jatah; 429 setelah 5 kegagalan dalam 15 menit.
   */
  async adminVerifyMfa(
    mfaToken: string,
    totpCode: string | undefined,
    backupCode: string | undefined,
  ): Promise<IssuedSession> {
    const unauth = unauthenticated("Sesi masuk tidak berlaku lagi. Masuk kembali.");
    const userId = await this.tokens.verifyMfa(mfaToken);
    if (!userId) throw unauth;
    const ip = tryCtx()?.ip ?? null;
    const slot = await this.limits.reserveOrThrow(
      `mfa:${userId}`,
      MFA_FAILS_LIMIT,
      LOGIN_WINDOW_MS,
      "Terlalu banyak percobaan kode. Coba lagi nanti.",
    );
    const now = this.clock.now();
    try {
      const issued = await this.db.transaction(async (tx) => {
        const [totpRow] = await tx.select().from(mfaTotp).where(eq(mfaTotp.userId, userId)).for("update");
        const user = await tx.query.users.findFirst({ where: eq(users.id, userId) });
        const admin = await tx.query.admins.findFirst({ where: eq(admins.userId, userId) });
        // Keadaan token/admin tidak sah → 401 (kembali ke login), bukan galat kode.
        if (
          !totpRow?.verifiedAt ||
          !user ||
          user.status !== "active" ||
          user.kind !== "admin" ||
          admin?.status !== "active"
        )
          throw unauth;

        let method: "totp" | "backup_code";
        if (totpCode) {
          const step = matchTotpStep(
            decryptSecret(totpRow.secretEncrypted, this.env.TOTP_ENC_KEY),
            totpCode,
            now,
          );
          if (step === null || (totpRow.lastUsedStep !== null && step <= totpRow.lastUsedStep))
            throw new WrongMfaCode("totp_code");
          await tx
            .update(mfaTotp)
            .set({ lastUsedStep: step, updatedAt: now })
            .where(eq(mfaTotp.userId, userId));
          method = "totp";
        } else if (backupCode) {
          const hash = backupCodeHash(this.env.OTP_HMAC_SECRET, backupCode);
          const consumed = await tx
            .update(mfaTotp)
            .set({ backupCodeHashes: sql`${mfaTotp.backupCodeHashes} - ${hash}::text`, updatedAt: now })
            .where(
              and(
                eq(mfaTotp.userId, userId),
                sql`${mfaTotp.backupCodeHashes} @> ${JSON.stringify([hash])}::jsonb`,
              ),
            )
            .returning({ userId: mfaTotp.userId });
          if (consumed.length === 0) throw new WrongMfaCode("backup_code");
          method = "backup_code";
        } else throw new WrongMfaCode("totp_code");

        await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
        const session = await this.sessionIssuer.issue(tx, {
          userId,
          audience: "admin",
          mfaLevel: 2,
          deviceName: "Web admin",
        });
        await this.audit.write(tx, {
          actor: { kind: "admin", userId, adminId: admin.id, adminRole: admin.role },
          action: "admin.login",
          entityType: "admin",
          entityId: admin.id,
          after: { mfa_method: method },
        });
        return session;
      });
      // Kode benar: bukan kegagalan.
      await slot.release();
      return issued;
    } catch (e) {
      if (!(e instanceof WrongMfaCode)) {
        // Tidak ada kode yang dinilai (401 keadaan, galat infrastruktur): jatah dikembalikan.
        await slot.release();
        throw e;
      }
      // Kegagalan kode juga dihitung ke batas login per IP (D1) tanpa menggerbang tahap ini.
      if (ip) await this.limits.hit(`login-ip:${ip}`, LOGIN_WINDOW_MS);
      // Galat formulir: tetap di layar MFA dengan sisa percobaan (kontrak adminVerifyMfa); mfa_token tetap berlaku.
      const left = Math.max(0, MFA_FAILS_LIMIT - slot.count);
      const message =
        left > 0
          ? `Kode salah. Sisa percobaan ${left}.`
          : "Kode salah. Batas percobaan tercapai; coba lagi dalam 15 menit.";
      throw new AppException(400, "VALIDATION_ERROR", message, { fieldErrors: { [e.field]: [message] } });
    }
  }

  /**
   * Profil admin dari AuthContext yang dievaluasi guard pada request ini (izin dari database, AC F15-1, F16-3), plus
   * email login, penanda akun alumni tertaut (konflik kepentingan PRD 2.3), sisa backup code, dan waktu login berhasil
   * SEBELUM sesi ini (audit `admin.login` terbaru yang lebih awal dari awal keluarga sesi pemanggil; F-02, N-08).
   */
  async adminProfile(auth: AuthContext): Promise<AdminProfile> {
    const [row] = await this.db
      .select({
        id: admins.id,
        displayName: admins.displayName,
        role: admins.role,
        status: admins.status,
        permissionsVersion: admins.permissionsVersion,
        linkedAlumniUserId: admins.linkedAlumniUserId,
        email: users.email,
        backupCodeHashes: mfaTotp.backupCodeHashes,
      })
      .from(admins)
      .innerJoin(users, eq(users.id, admins.userId))
      .leftJoin(mfaTotp, eq(mfaTotp.userId, admins.userId))
      .where(eq(admins.id, auth.adminId!))
      .limit(1);
    if (!row || row.status !== "active") throw new AppException(403, "FORBIDDEN", "Akun admin tidak aktif.");
    const [family] = await this.db
      .select({ startedAt: min(sessions.createdAt) })
      .from(sessions)
      .where(eq(sessions.familyId, auth.familyId));
    const startedAt = family?.startedAt ?? null;
    const [previous] = startedAt
      ? await this.db
          .select({ at: auditLogs.createdAt })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.actorAdminId, row.id),
              eq(auditLogs.action, "admin.login"),
              lt(auditLogs.createdAt, startedAt),
            ),
          )
          .orderBy(desc(auditLogs.createdAt))
          .limit(1)
      : [];
    return {
      admin_id: row.id,
      display_name: row.displayName,
      email: row.email,
      role: row.role,
      permissions: PERMISSION_VALUES.filter((p) => auth.permissions.has(p)),
      permissions_version: row.permissionsVersion,
      has_linked_alumni: row.linkedAlumniUserId !== null,
      backup_codes_remaining: Math.min(10, row.backupCodeHashes?.length ?? 0),
      previous_login_at: previous?.at.toISOString() ?? null,
    };
  }
}
