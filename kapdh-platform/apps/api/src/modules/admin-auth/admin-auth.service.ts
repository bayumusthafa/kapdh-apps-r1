import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import { type components, PERMISSION_VALUES } from "@kapdh/contracts";
import { admins, auditLogs, mfaTotp, sessions, users } from "@kapdh/database";
import { and, desc, eq, lt, min, ne, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { tryCtx } from "../../core/context/request-context.js";
import type { Db } from "../../core/db/types.js";
import { AppException, unauthenticated } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { backupCodeHash, decryptSecret, matchTotpStep } from "../../core/identity/crypto.js";
import { normalizeEmail } from "../../core/identity/email.js";
import { LOGIN_WINDOW_MS, PasswordVerifier, type UserRow } from "../../core/identity/password-verifier.js";
import { type IssuedSession, SessionIssuer } from "../../core/identity/session-issuer.js";
import { MFA_TTL_SECONDS, TokenService } from "../../core/identity/token.service.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB, ENV } from "../../core/tokens.js";
import {
  type AdminAuthFailureStage,
  auditAuthFailure,
  auditMfaLockout,
  MFA_FAILS_LIMIT,
  MFA_WINDOW_MS,
  mfaTokenBinding,
  safeEqualText,
  WrongMfaCode,
  wrongCodeError,
} from "./admin-auth.shared.js";

type AdminLoginResponse = components["schemas"]["AdminLoginResponse"];
type AdminProfile = components["schemas"]["AdminProfile"];

export { MFA_FAILS_LIMIT } from "./admin-auth.shared.js";

/**
 * Kunci konsumsi mfa_token (klaim `jti`) di store rate limit (memori di dev/test, Redis di production) dengan umur
 * sepanjang masa berlaku token: token yang sudah menghasilkan sesi tidak dapat dipakai lagi (kontrak adminVerifyMfa).
 */
const mfaTokenKey = (tokenId: string) => `mfa-token:${tokenId}`;
const MFA_TOKEN_TTL_MS = MFA_TTL_SECONDS * 1000;

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

  /**
   * Audit `admin.auth_failed` tahap sandi (F-17) bila email milik identitas admin (users.kind admin, belum terhapus).
   * Email yang tidak dikenal tidak diaudit: tidak ada entitas admin, dan email acak tidak boleh menjadi jalan
   * membanjiri log append-only. Kueri yang sama dijalankan untuk setiap 401 sehingga waktu respons tidak membedakan
   * email terdaftar (anti enumerasi, PRD 2.5).
   */
  private async auditPasswordFailure(emailRaw: string): Promise<void> {
    const [row] = await this.db
      .select({ adminId: admins.id })
      .from(users)
      .innerJoin(admins, eq(admins.userId, users.id))
      .where(
        and(eq(users.email, normalizeEmail(emailRaw)), eq(users.kind, "admin"), ne(users.status, "deleted")),
      )
      .limit(1);
    if (row) await this.auditFailure(row.adminId, "password");
  }

  private auditFailure(adminId: string, stage: AdminAuthFailureStage): Promise<void> {
    return auditAuthFailure({ db: this.db, audit: this.audit, limits: this.limits }, adminId, stage);
  }

  /** mfa_token yang `jti`-nya sudah dikonsumsi oleh sesi yang terbentuk (kontrak adminVerifyMfa: sekali pakai). */
  private async mfaTokenSpent(tokenId: string): Promise<boolean> {
    return (await this.limits.peek(mfaTokenKey(tokenId), 1, MFA_TOKEN_TTL_MS)) > 0;
  }

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
   * Kegagalan untuk email milik identitas admin diaudit `admin.auth_failed` (tahap password, dibatasi per jendela).
   */
  async adminLogin(emailRaw: string, password: string): Promise<AdminLoginResponse> {
    let user: UserRow;
    try {
      user = await this.passwords.verify(
        emailRaw,
        password,
        "admin",
        async (account) => account.status === "active" && (await this.adminCanLogin(account.id)),
      );
    } catch (error) {
      // F-17: kegagalan tahap sandi untuk identitas admin yang ada diaudit (dibatasi per jendela); 429 tidak menilai
      // sandi sehingga tidak diaudit ulang.
      if (error instanceof AppException && error.status === 401) await this.auditPasswordFailure(emailRaw);
      throw error;
    }
    // Token diikat ke kredensial yang BARU dinilai (baris users yang dibaca sebelum bcrypt): ganti/reset sandi atau
    // logout semua yang commit sesudahnya membuat tahap TOTP menolak token ini (AC F02-4, F02-6, N-08).
    const mfa = await this.tokens.signMfa(user.id, {
      sessionVersion: user.sessionVersion,
      credential: mfaTokenBinding(this.env.OTP_HMAC_SECRET, user.passwordHash),
    });
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
   * §5.2) dan backup code dikonsumsi atomik sekali pakai (penghapusan jsonb bersyarat). Kode salah → 400
   * VALIDATION_ERROR pada field kode dengan sisa percobaan (mfa_token tetap berlaku; jatah tetap tercatat); kode benar
   * atau 401 (mfa_token tidak sah/sudah dipakai, admin/akun tidak lagi aktif, TOTP tidak terverifikasi) mengembalikan
   * jatah; 429 setelah 5 kegagalan dalam 15 menit.
   *
   * mfa_token SEKALI PAKAI: token yang `jti`-nya sudah dikonsumsi ditolak 401 SEBELUM jatah kegagalan dicadangkan dan
   * sebelum kode apa pun dinilai, sehingga pemegang token bekas (tanpa sandi) tidak dapat menghabiskan jatah 5 kode
   * per 15 menit milik admin (PRD 2.5: batas tidak boleh membuat akun dikunci pihak lain), dan pengulangan permintaan
   * yang responsnya hilang diarahkan kembali ke login (401), bukan "Kode salah". Setelah kode benar, `jti` dikonsumsi
   * atomik di dalam transaksi (seluruh kunci sudah dipegang) sebelum sesi dibuat; pemakaian bersamaan yang kalah
   * ditolak 401 dan transaksinya dibatalkan, sehingga kode/backup code yang sempat dinilai tidak terbuang. Kode salah
   * yang dinilai bersamaan dengan pemenang juga menjadi 401 dan jatahnya dikembalikan.
   *
   * Kunci baris mengikuti urutan identitas admin (admins → users → mfa_totp, lihat admin-auth.shared.ts) sehingga
   * login yang berjalan bersamaan dengan reset MFA/pemulihan C7 atau undangan ulang CLI menunggu, bukan deadlock.
   */
  async adminVerifyMfa(
    mfaToken: string,
    totpCode: string | undefined,
    backupCode: string | undefined,
  ): Promise<IssuedSession> {
    const unauth = unauthenticated("Sesi masuk tidak berlaku lagi. Masuk kembali.");
    const claims = await this.tokens.verifyMfaClaims(mfaToken);
    if (!claims) throw unauth;
    if (await this.mfaTokenSpent(claims.tokenId)) throw unauth;
    const userId = claims.userId;
    const ip = tryCtx()?.ip ?? null;
    const slot = await this.limits.reserveOrThrow(
      `mfa:${userId}`,
      MFA_FAILS_LIMIT,
      MFA_WINDOW_MS,
      "Terlalu banyak percobaan kode. Coba lagi nanti.",
    );
    const now = this.clock.now();
    try {
      const issued = await this.db.transaction(async (tx) => {
        // Urutan kunci admins → users → mfa_totp. admins FOR SHARE: status admin tetap sampai commit (reset C7
        // menunggu); users FOR NO KEY UPDATE: last_login_at diperbarui di transaksi ini; mfa_totp FOR UPDATE:
        // percobaan kode bersamaan berurutan.
        const [admin] = await tx.select().from(admins).where(eq(admins.userId, userId)).for("share");
        const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
        const [totpRow] = await tx.select().from(mfaTotp).where(eq(mfaTotp.userId, userId)).for("update");
        // Keadaan token/admin tidak sah → 401 (kembali ke login), bukan galat kode. Kredensial yang dinilai di tahap
        // sandi wajib masih berlaku di bawah kunci baris users (AC F02-4, F02-6, N-08): sandi diganti/direset (`bnd`)
        // atau session_version naik (logout semua, pemulihan) sejak mfa_token terbit → 401 tanpa sesi. Ganti sandi
        // yang berlomba menunggu kunci ini (UPDATE users) atau sudah commit sehingga terlihat di sini.
        if (
          !totpRow?.verifiedAt ||
          !user ||
          user.status !== "active" ||
          user.kind !== "admin" ||
          admin?.status !== "active" ||
          user.sessionVersion !== claims.sessionVersion ||
          !safeEqualText(mfaTokenBinding(this.env.OTP_HMAC_SECRET, user.passwordHash), claims.credential)
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
            throw new WrongMfaCode("totp_code", admin.id);
          // Anti replay: langkah dicatat dengan UPDATE bersyarat (baris sudah terkunci; predikat menjaga invarian).
          const advanced = await tx
            .update(mfaTotp)
            .set({ lastUsedStep: step, updatedAt: now })
            .where(
              and(
                eq(mfaTotp.userId, userId),
                sql`(${mfaTotp.lastUsedStep} is null or ${mfaTotp.lastUsedStep} < ${step})`,
              ),
            )
            .returning({ userId: mfaTotp.userId });
          if (advanced.length === 0) throw new WrongMfaCode("totp_code", admin.id);
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
          if (consumed.length === 0) throw new WrongMfaCode("backup_code", admin.id);
          method = "backup_code";
        } else throw new WrongMfaCode("totp_code", admin.id);

        // Kode benar: mfa_token dikonsumsi sekali (atomik di store; pemakaian kedua → 401, transaksi dibatalkan).
        const reused = await this.limits.consume(mfaTokenKey(claims.tokenId), 1, MFA_TOKEN_TTL_MS);
        if (reused > 0) throw unauth;

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
          after: {
            mfa_method: method,
            ...(method === "backup_code"
              ? { backup_codes_remaining: totpRow.backupCodeHashes.length - 1 }
              : {}),
          },
        });
        return session;
      });
      // Kode benar: bukan kegagalan.
      await slot.release();
      return issued;
    } catch (e) {
      if (!(e instanceof WrongMfaCode)) {
        // Tidak ada kode yang dinilai salah (401 keadaan/token, galat infrastruktur): jatah dikembalikan.
        await slot.release();
        throw e;
      }
      // mfa_token dikonsumsi permintaan lain yang menang selagi kode ini dinilai: token tidak sah lagi (401), bukan
      // kegagalan kode; jatah dikembalikan.
      if (await this.mfaTokenSpent(claims.tokenId)) {
        await slot.release();
        throw unauth;
      }
      // Kegagalan kode juga dihitung ke batas login per IP (D1) tanpa menggerbang tahap ini.
      if (ip) await this.limits.hit(`login-ip:${ip}`, LOGIN_WINDOW_MS);
      // F-17: kegagalan kode pertama dalam jendela diaudit; kegagalan ke-5 mengunci tahap kode (satu audit/penguncian).
      await this.auditFailure(e.adminId, "mfa");
      if (slot.count === MFA_FAILS_LIMIT) await auditMfaLockout(this.db, this.audit, e.adminId, "login");
      // Galat formulir: tetap di layar MFA dengan sisa percobaan (kontrak adminVerifyMfa); mfa_token tetap berlaku.
      throw wrongCodeError(e.field, slot.count);
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
