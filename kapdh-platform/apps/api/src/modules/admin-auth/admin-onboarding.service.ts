import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import { type components, type Permission, PERMISSION_VALUES } from "@kapdh/contracts";
import { adminPermissions, admins, mfaTotp, sessions, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { type Actor, tryCtx } from "../../core/context/request-context.js";
import type { Db, Tx } from "../../core/db/types.js";
import { AppException, forbidden, unauthenticated } from "../../core/errors/app-exception.js";
import {
  adminInviteTokenHash,
  decryptSecret,
  encryptSecret,
  matchTotpStep,
  newTotpSecret,
} from "../../core/identity/crypto.js";
import { maskEmail } from "../../core/identity/email.js";
import { type IssuedSession, SessionIssuer } from "../../core/identity/session-issuer.js";
import { type AdminEnrollClaims, TokenService } from "../../core/identity/token.service.js";
import { OutboxService } from "../../core/outbox/outbox.service.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB, ENV } from "../../core/tokens.js";
import {
  auditAuthFailure,
  auditMfaLockout,
  enrollmentBinding,
  MFA_FAILS_LIMIT,
  MFA_WINDOW_MS,
  newBackupCodeSet,
  otpauthUri,
  safeEqualText,
  TOTP_ISSUER,
  WrongMfaCode,
  wrongCodeError,
} from "./admin-auth.shared.js";

type AdminInvitationPreview = components["schemas"]["AdminInvitationPreview"];
type AdminLoginResponse = components["schemas"]["AdminLoginResponse"];
type AdminTotpEnrollment = components["schemas"]["AdminTotpEnrollment"];

const INVITE_WINDOW_MS = 15 * 60_000;
/** Usulan D1: pratinjau undangan per IP per 15 menit (token 256 bit; batas ini menahan penyalahgunaan, bukan tebakan). */
const INVITE_PREVIEWS_PER_IP = 30;
/** Usulan D1: penerimaan undangan per IP per 15 menit; dicadangkan SEBELUM bcrypt sandi baru (PRD 5.1). */
const INVITE_ACCEPTS_PER_IP = 10;
/** Usulan D1: pembuatan secret TOTP per admin per 15 menit (/totp/enroll boleh diulang selama token berlaku). */
const ENROLL_STARTS_PER_ADMIN = 10;

/** Galat undangan tidak berlaku: tidak dikenal, kedaluwarsa, sudah dipakai, dibatalkan (tidak dibedakan, kontrak C1). */
const invitationGone = () =>
  new AppException(410, "OTP_EXPIRED", "Undangan tidak berlaku lagi. Minta undangan baru ke Super Admin.");

/** Token pendaftaran tidak berlaku atau admin tidak lagi dalam pendaftaran (kontrak /totp/enroll langkah 1 dan 3). */
const enrollmentGone = () =>
  unauthenticated("Sesi aktivasi tidak berlaku lagi. Minta undangan ulang ke Super Admin.");

/** Kontrak /totp/enroll langkah 2: aktivasi sudah selesai, UI mengarahkan ke /login. */
const activationDone = () => forbidden("Aktivasi sudah selesai. Masuk dengan sandi dan kode autentikator.");

interface EnrollmentState {
  admin: typeof admins.$inferSelect;
  user: typeof users.$inferSelect;
  totp: typeof mfaTotp.$inferSelect | undefined;
  actor: Pick<Actor, "kind" | "userId" | "adminId" | "adminRole">;
}

export interface ConfirmedEnrollment {
  session: IssuedSession;
  backupCodes: string[];
  generatedAt: Date;
}

/**
 * Onboarding admin tertutup (F-16, PRD 8.2 langkah 3; kontrak C1 admin-auth.yaml langkah 2-5): pratinjau undangan,
 * penerimaan undangan dengan token sekali pakai (sandi awal acak diganti), pendaftaran TOTP dengan token pendaftaran
 * 30 menit, lalu konfirmasi kode pertama yang mengaktifkan admin (`invited` → `active`), menerbitkan backup code dan
 * sesi admin mfa_level 2. Tidak ada akses API admin sebelum TOTP terbukti (AC F02-2). Token undangan, sandi, secret
 * TOTP dan backup code tidak pernah dicatat di log maupun audit (ARCHITECTURE §2 butir 3).
 */
@Injectable()
export class AdminOnboardingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tokens: TokenService,
    private readonly sessionIssuer: SessionIssuer,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private ipKey(scope: string): string {
    return `${scope}:${tryCtx()?.ip ?? "unknown"}`;
  }

  /** Izin yang berlaku setelah aktivasi: super_admin seluruh izin (ARCHITECTURE §4.5), admin dari admin_permissions. */
  private async permissionsOf(adminId: string, role: string): Promise<Permission[]> {
    if (role === "super_admin") return [...PERMISSION_VALUES];
    const rows = await this.db
      .select({ permission: adminPermissions.permission })
      .from(adminPermissions)
      .where(eq(adminPermissions.adminId, adminId));
    const granted = new Set(rows.map((r) => r.permission));
    return PERMISSION_VALUES.filter((p) => granted.has(p));
  }

  // ------------------------------------------------------------------ undangan (langkah 2-3)

  /**
   * Pratinjau undangan (kontrak adminPreviewInvitation): TIDAK mengonsumsi token. Hanya hash token yang dicari
   * (`admins.invite_token_hash`). Tidak dikenal, kedaluwarsa, sudah dipakai, atau akun tidak aktif → 410 yang sama.
   */
  async previewInvitation(inviteToken: string): Promise<AdminInvitationPreview> {
    await this.limits.consumeOrThrow(
      this.ipKey("admin-invite-preview"),
      INVITE_PREVIEWS_PER_IP,
      INVITE_WINDOW_MS,
      "Terlalu banyak percobaan membuka undangan. Coba lagi nanti.",
    );
    const now = this.clock.now();
    const inviter = alias(admins, "inviter");
    const [row] = await this.db
      .select({
        id: admins.id,
        role: admins.role,
        status: admins.status,
        displayName: admins.displayName,
        inviteExpiresAt: admins.inviteExpiresAt,
        email: users.email,
        userStatus: users.status,
        invitedBy: inviter.displayName,
      })
      .from(admins)
      .innerJoin(users, eq(users.id, admins.userId))
      .leftJoin(inviter, eq(inviter.id, admins.invitedByAdminId))
      .where(eq(admins.inviteTokenHash, adminInviteTokenHash(inviteToken)))
      .limit(1);
    if (
      !row ||
      row.status !== "invited" ||
      row.userStatus !== "active" ||
      !row.inviteExpiresAt ||
      row.inviteExpiresAt <= now
    )
      throw invitationGone();
    return {
      email_masked: maskEmail(row.email),
      display_name: row.displayName,
      role: row.role,
      permissions: await this.permissionsOf(row.id, row.role),
      // Bootstrap CLI (PRD 8.2) tidak memiliki pengundang.
      invited_by_display_name: row.invitedBy ?? null,
      expires_at: row.inviteExpiresAt.toISOString(),
    };
  }

  /**
   * Penerimaan undangan (kontrak adminAcceptInvitation, PRD 8.2 langkah 3). Hash bcrypt sandi baru dihitung SEBELUM
   * transaksi (tidak menahan kunci selama bcrypt). Dalam satu transaksi dengan baris admin terkunci (admins lalu
   * users, urutan penjaga Super Admin terakhir): token diverifikasi (hash sama, belum kedaluwarsa, status `invited`,
   * akun aktif) lalu dikonsumsi dengan UPDATE bersyarat, sandi awal acak diganti, email dianggap terverifikasi, sisa
   * pendaftaran TOTP lama (secret yang belum/tidak sah untuk admin `invited`) dihapus, dan audit
   * `admin.invitation_accepted` ditulis. Admin TETAP `invited` sampai /totp/confirm berhasil. Penerimaan kedua yang
   * kalah balapan melihat hash sudah kosong → 410.
   */
  async acceptInvitation(inviteToken: string, password: string): Promise<AdminLoginResponse> {
    await this.limits.consumeOrThrow(
      this.ipKey("admin-invite-accept"),
      INVITE_ACCEPTS_PER_IP,
      INVITE_WINDOW_MS,
      "Terlalu banyak percobaan menerima undangan. Coba lagi nanti.",
    );
    const tokenHash = adminInviteTokenHash(inviteToken);
    const now = this.clock.now();
    // Penyaringan murah tanpa kunci sebelum bcrypt: token yang jelas tidak berlaku tidak menghabiskan CPU.
    const [candidate] = await this.db
      .select({ id: admins.id, status: admins.status, inviteExpiresAt: admins.inviteExpiresAt })
      .from(admins)
      .where(eq(admins.inviteTokenHash, tokenHash))
      .limit(1);
    if (
      !candidate ||
      candidate.status !== "invited" ||
      !candidate.inviteExpiresAt ||
      candidate.inviteExpiresAt <= now
    )
      throw invitationGone();
    const passwordHash = await bcrypt.hash(password, this.env.BCRYPT_COST);

    return this.db.transaction(async (tx) => {
      const [admin] = await tx.select().from(admins).where(eq(admins.id, candidate.id)).for("update");
      if (
        !admin ||
        admin.status !== "invited" ||
        admin.inviteTokenHash !== tokenHash ||
        !admin.inviteExpiresAt ||
        admin.inviteExpiresAt <= now
      )
        throw invitationGone();
      const [user] = await tx.select().from(users).where(eq(users.id, admin.userId)).for("update");
      if (!user || user.status !== "active" || user.kind !== "admin") throw invitationGone();

      // Token dikonsumsi (sekali pakai): predikat hash menjaga invarian walau baris sudah terkunci.
      const consumed = await tx
        .update(admins)
        .set({
          inviteTokenHash: null,
          inviteExpiresAt: null,
          updatedAt: now,
          version: sql`${admins.version} + 1`,
        })
        .where(
          and(eq(admins.id, admin.id), eq(admins.status, "invited"), eq(admins.inviteTokenHash, tokenHash)),
        )
        .returning({ id: admins.id });
      if (consumed.length === 0) throw invitationGone();
      // session_version naik dan sesi yang mungkin tersisa dicabut: admin `invited` tidak pernah memiliki sesi hidup
      // (AC F02-2; pertahanan berlapis di samping pencabutan saat pemulihan/undangan ulang).
      await tx
        .update(users)
        .set({
          passwordHash,
          emailVerifiedAt: user.emailVerifiedAt ?? now,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(users.id, user.id));
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
      // Admin `invited` belum memiliki autentikator sah: secret dari pendaftaran yang tidak selesai (atau sisa sebelum
      // undangan ulang) dibuang sehingga /totp/confirm hanya menerima secret yang dibuat dengan token pendaftaran ini.
      await tx.delete(mfaTotp).where(eq(mfaTotp.userId, user.id));
      await this.audit.write(tx, {
        actor: { kind: "admin", userId: user.id, adminId: admin.id, adminRole: admin.role },
        action: "admin.invitation_accepted",
        entityType: "admin",
        entityId: admin.id,
        before: { status: "invited", invite_expires_at: admin.inviteExpiresAt.toISOString() },
        // Nama kunci sengaja tanpa segmen rahasia (password/totp/credential dibuang penyaring audit,
        // core/audit/sanitize.ts); penggantian sandi awal tersirat dari tindakan ini (kontrak adminAcceptInvitation).
        after: { status: "invited", invitation_consumed: true, mfa_enrollment_required: true },
      });
      const enroll = await this.tokens.signAdminEnroll({
        userId: user.id,
        adminId: admin.id,
        binding: enrollmentBinding(this.env.OTP_HMAC_SECRET, passwordHash),
      });
      return {
        mfa_token: enroll.token,
        mfa_expires_at: enroll.expiresAt.toISOString(),
        totp_enrollment_required: true,
      };
    });
  }

  // ------------------------------------------------------------------ pendaftaran TOTP (langkah 4-5)

  /**
   * Urutan pemeriksaan /totp/enroll dan /totp/confirm (kontrak C1) dengan baris admins, users, lalu mfa_totp terkunci
   * (urutan kunci identitas admin, admin-auth.shared.ts; users ikut dikunci karena confirm memperbarui last_login_at):
   *   1. token: klaim sah (diperiksa pemanggil), admin subjek ada dan milik akun `sub`, pengikat HMAC sama dengan
   *      password_hash saat ini → selain itu 401;
   *   2. admin `active` dengan TOTP terverifikasi → 403 "Aktivasi sudah selesai";
   *   3. admin masih `invited`, tanpa undangan ulang (`invite_token_hash` kosong), akun users `active` → selain itu 401.
   */
  private async lockEnrollment(tx: Tx, claims: AdminEnrollClaims): Promise<EnrollmentState> {
    const [admin] = await tx.select().from(admins).where(eq(admins.id, claims.adminId)).for("update");
    if (!admin || admin.userId !== claims.userId) throw enrollmentGone();
    const [user] = await tx.select().from(users).where(eq(users.id, admin.userId)).for("no key update");
    if (
      !user ||
      !safeEqualText(enrollmentBinding(this.env.OTP_HMAC_SECRET, user.passwordHash), claims.binding)
    )
      throw enrollmentGone();
    const [totp] = await tx.select().from(mfaTotp).where(eq(mfaTotp.userId, user.id)).for("update");
    if (admin.status === "active" && totp?.verifiedAt) throw activationDone();
    if (
      admin.status !== "invited" ||
      admin.inviteTokenHash !== null ||
      user.status !== "active" ||
      user.kind !== "admin"
    )
      throw enrollmentGone();
    return {
      admin,
      user,
      totp,
      actor: { kind: "admin", userId: user.id, adminId: admin.id, adminRole: admin.role },
    };
  }

  /**
   * Mulai pendaftaran TOTP (kontrak adminStartTotpEnrollment): secret baru 160 bit, disimpan terenkripsi AES-256-GCM
   * (TOTP_ENC_KEY) di mfa_totp dengan `verified_at` kosong, menggantikan secret belum terverifikasi sebelumnya. Boleh
   * diulang selama token berlaku tanpa memperpanjangnya. Secret hanya ada di respons ini.
   */
  async startEnrollment(enrollToken: string): Promise<AdminTotpEnrollment> {
    const claims = await this.tokens.verifyAdminEnroll(enrollToken);
    if (!claims) throw enrollmentGone();
    await this.limits.consumeOrThrow(
      `admin-enroll-start:${claims.adminId}`,
      ENROLL_STARTS_PER_ADMIN,
      INVITE_WINDOW_MS,
      "Terlalu banyak percobaan membuat kode QR. Coba lagi nanti.",
    );
    const now = this.clock.now();
    const secret = newTotpSecret();
    const secretEncrypted = encryptSecret(secret, this.env.TOTP_ENC_KEY);
    const email = await this.db.transaction(async (tx) => {
      const state = await this.lockEnrollment(tx, claims);
      await tx
        .insert(mfaTotp)
        .values({
          userId: state.user.id,
          secretEncrypted,
          verifiedAt: null,
          lastUsedStep: null,
          backupCodeHashes: [],
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: mfaTotp.userId,
          set: {
            secretEncrypted,
            verifiedAt: null,
            lastUsedStep: null,
            backupCodeHashes: [],
            updatedAt: now,
          },
        });
      await this.audit.write(tx, {
        actor: state.actor,
        action: "admin.mfa_enrollment_started",
        entityType: "admin",
        entityId: state.admin.id,
        after: { method: "totp", replaced_unverified: state.totp !== undefined },
      });
      return state.user.email;
    });
    return {
      secret,
      otpauth_uri: otpauthUri(secret, email),
      issuer: TOTP_ISSUER,
      account_name: email,
      algorithm: "SHA1",
      digits: 6,
      period_seconds: 30,
    };
  }

  /**
   * Konfirmasi kode TOTP pertama (kontrak adminConfirmTotpEnrollment). Satu jatah kegagalan per admin dicadangkan
   * ATOMIK sebelum kode dinilai (5 per 15 menit). Dalam satu transaksi dengan baris admin dan mfa_totp terkunci:
   * kode diverifikasi terhadap secret yang belum terverifikasi (±1 langkah, langkah dicatat untuk anti replay), TOTP
   * ditandai `verified_at` dan 10 backup code baru (hanya HMAC) disimpan dengan UPDATE bersyarat, admin `invited` →
   * `active` + `activated_at` dengan UPDATE bersyarat, audit `admin.mfa_enrolled`, `admin.activated` dan `admin.login`
   * (login pertama, dasar previous_login_at), email pemberitahuan keamanan lewat outbox, dan sesi admin mfa_level 2.
   * Konfirmasi bersamaan berurutan pada kunci baris admin: yang kalah melihat langkah 2 (403).
   */
  async confirmEnrollment(enrollToken: string, totpCode: string): Promise<ConfirmedEnrollment> {
    const claims = await this.tokens.verifyAdminEnroll(enrollToken);
    if (!claims) throw enrollmentGone();
    const slot = await this.limits.reserveOrThrow(
      `admin-enroll-confirm:${claims.adminId}`,
      MFA_FAILS_LIMIT,
      MFA_WINDOW_MS,
      "Terlalu banyak percobaan kode. Coba lagi nanti.",
    );
    const now = this.clock.now();
    try {
      const confirmed = await this.db.transaction(async (tx): Promise<ConfirmedEnrollment> => {
        const state = await this.lockEnrollment(tx, claims);
        const totp = state.totp;
        if (!totp || totp.verifiedAt)
          throw new AppException(400, "VALIDATION_ERROR", "Pindai kode QR terlebih dahulu.", {
            fieldErrors: {
              totp_code: ["Pendaftaran autentikator belum dimulai. Pindai kode QR terlebih dahulu."],
            },
          });
        const step = matchTotpStep(decryptSecret(totp.secretEncrypted, this.env.TOTP_ENC_KEY), totpCode, now);
        if (step === null || (totp.lastUsedStep !== null && step <= totp.lastUsedStep))
          throw new WrongMfaCode("totp_code", state.admin.id);

        const backup = newBackupCodeSet(this.env.OTP_HMAC_SECRET);
        const verified = await tx
          .update(mfaTotp)
          .set({ verifiedAt: now, lastUsedStep: step, backupCodeHashes: backup.hashes, updatedAt: now })
          .where(and(eq(mfaTotp.userId, state.user.id), isNull(mfaTotp.verifiedAt)))
          .returning({ userId: mfaTotp.userId });
        if (verified.length === 0) throw activationDone();
        const activated = await tx
          .update(admins)
          .set({
            status: "active",
            activatedAt: now,
            updatedAt: now,
            version: sql`${admins.version} + 1`,
          })
          .where(
            and(eq(admins.id, state.admin.id), eq(admins.status, "invited"), isNull(admins.inviteTokenHash)),
          )
          .returning({ id: admins.id });
        if (activated.length === 0) throw enrollmentGone();
        await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, state.user.id));

        const session = await this.sessionIssuer.issue(tx, {
          userId: state.user.id,
          audience: "admin",
          mfaLevel: 2,
          deviceName: "Web admin",
        });
        const base = { actor: state.actor, entityType: "admin", entityId: state.admin.id } as const;
        await this.audit.write(tx, {
          ...base,
          action: "admin.mfa_enrolled",
          after: { method: "totp", backup_codes_issued: backup.codes.length },
        });
        await this.audit.write(tx, {
          ...base,
          action: "admin.activated",
          before: { status: "invited" },
          after: { status: "active", activated_at: now.toISOString(), role: state.admin.role },
        });
        await this.audit.write(tx, {
          ...base,
          action: "admin.login",
          after: { mfa_method: "totp", first_login: true },
        });
        await this.outbox.publish(tx, {
          topic: "admin.security_notice",
          dedupKey: `admin.security_notice:activated:${state.admin.id}:${uuidv7()}`,
          payload: { admin_id: state.admin.id, kind: "activated" },
        });
        return { session, backupCodes: backup.codes, generatedAt: now };
      });
      await slot.release();
      return confirmed;
    } catch (e) {
      if (!(e instanceof WrongMfaCode)) {
        // Tidak ada kode yang dinilai salah (401/403 keadaan, belum enroll, galat infrastruktur): jatah dikembalikan.
        await slot.release();
        throw e;
      }
      // F-17: kegagalan kode pertama dalam jendela diaudit; kegagalan ke-5 mengunci konfirmasi selama 15 menit (satu
      // audit per penguncian).
      await auditAuthFailure(
        { db: this.db, audit: this.audit, limits: this.limits },
        e.adminId,
        "enrollment",
      );
      if (slot.count === MFA_FAILS_LIMIT) await auditMfaLockout(this.db, this.audit, e.adminId, "enrollment");
      throw wrongCodeError(e.field, slot.count);
    }
  }
}
