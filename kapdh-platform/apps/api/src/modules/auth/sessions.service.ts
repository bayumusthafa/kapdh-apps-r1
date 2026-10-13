import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components } from "@kapdh/contracts";
import { mfaTotp, sessions, users } from "@kapdh/database";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db, Tx } from "../../core/db/types.js";
import { AppException, notFound, unauthenticated } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { backupCodeHash, decryptSecret, matchTotpStep } from "../../core/identity/crypto.js";
import { LOGIN_WINDOW_MS, PasswordVerifier } from "../../core/identity/password-verifier.js";
import { TokenService } from "../../core/identity/token.service.js";
import { revokeDeviceTokens } from "../../core/notifications-kernel/device-tokens.js";
import { decodeCursor, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK, DB, ENV } from "../../core/tokens.js";

type Session = components["schemas"]["Session"];
type SessionPage = components["schemas"]["SessionPage"];
type ReauthResponse = components["schemas"]["ReauthResponse"];

/** Kontrak reauthenticate: 5 kegagalan dalam 15 menit per sesi (keluarga) menghasilkan 429. */
export const REAUTH_FAILS_LIMIT = 5;

export interface ReauthInput {
  password: string;
  totp_code?: string;
  backup_code?: string;
}

type CredentialField = "password" | "totp_code" | "backup_code";

/** Penanda internal kredensial reautentikasi salah; diubah menjadi 400 dengan sisa percobaan setelah rollback. */
class WrongCredential extends Error {
  constructor(readonly field: CredentialField) {
    super("kredensial reautentikasi salah");
  }
}

const CREDENTIAL_LABEL: Readonly<Record<CredentialField, string>> = {
  password: "Sandi salah",
  totp_code: "Kode autentikator salah",
  backup_code: "Backup code salah",
};

const cursorSchema = z.object({ created_at: z.coerce.date(), id: z.uuid() });

/**
 * Sesi perangkat (F-02, N-08; kontrak listSessions, revokeSession) dan reautentikasi untuk tindakan sensitif
 * (F-14, AC F15-3, F16-1; kontrak reauthenticate). Satu "sesi" yang terlihat klien = satu KELUARGA sesi
 * (`sessions.family_id`), stabil selama rotasi refresh.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly passwords: PasswordVerifier,
    private readonly tokens: TokenService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  private now() {
    return this.clock.now();
  }

  /**
   * Daftar keluarga sesi milik pemanggil yang masih memiliki baris belum dicabut dan belum kedaluwarsa, untuk audience
   * pemanggil (alumni → mobile, admin → web admin). `created_at` = awal keluarga (baris tertua), `last_seen_at` =
   * aktivitas terakhir di keluarga, perangkat/platform/versi/kedaluwarsa dari baris aktif terbaru. Keyset
   * (`created_at` desc, `id` desc) di atas nilai yang tidak berubah selama paging. Tanpa token, hash, maupun IP (N-14).
   */
  async list(auth: AuthContext, query: unknown): Promise<SessionPage> {
    const page = parsePageQuery(query);
    const after = page.cursor ? decodeCursor(page.cursor, cursorSchema) : null;
    const now = this.now();
    // Parameter waktu diikat lewat kolom (encoder Drizzle) agar sama di postgres-js dan PGlite.
    const live = and(isNull(sessions.revokedAt), gt(sessions.expiresAt, now))!;
    const startedAt = sql<Date>`min(${sessions.createdAt})`;
    const latestLive = (
      column: typeof sessions.deviceName | typeof sessions.platform | typeof sessions.appVersion,
    ) =>
      sql<
        string | null
      >`(array_agg(${column} order by ${sessions.createdAt} desc) filter (where ${live}))[1]`;
    const rows = await this.db
      .select({
        familyId: sessions.familyId,
        startedAt: startedAt.mapWith(sessions.createdAt),
        lastSeenAt: sql<Date>`max(${sessions.lastSeenAt})`.mapWith(sessions.lastSeenAt),
        expiresAt: sql<Date>`max(${sessions.expiresAt}) filter (where ${live})`.mapWith(sessions.expiresAt),
        deviceName: latestLive(sessions.deviceName),
        platform: latestLive(sessions.platform),
        appVersion: latestLive(sessions.appVersion),
      })
      .from(sessions)
      .where(and(eq(sessions.userId, auth.userId), eq(sessions.audience, auth.audience)))
      .groupBy(sessions.familyId)
      .having(
        and(
          sql`bool_or(${live})`,
          after
            ? sql`(${startedAt}, ${sessions.familyId}) < (${after.created_at.toISOString()}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(startedAt), desc(sessions.familyId))
      .limit(page.limit + 1);
    return pageOf(rows, page.limit, {
      cursorOf: (row) => ({ created_at: row.startedAt, id: row.familyId }),
      toItem: (row): Session => ({
        id: row.familyId,
        audience: auth.audience,
        device_name: row.deviceName,
        platform: (row.platform as Session["platform"]) ?? null,
        app_version: row.appVersion,
        created_at: row.startedAt.toISOString(),
        last_seen_at: row.lastSeenAt.toISOString(),
        expires_at: row.expiresAt.toISOString(),
        current: row.familyId === auth.familyId,
      }),
    });
  }

  /**
   * Mencabut satu keluarga sesi milik pemanggil (kontrak revokeSession): baris aktifnya dikunci, seluruh baris
   * keluarga dicabut, token push sesi itu dinonaktifkan (pengiriman pending dibatalkan, AC F13-5), audit, dan setelah
   * commit socketnya diputus (`session.revoked`). 404 bila tidak ada, sudah dicabut/kedaluwarsa, atau milik pengguna
   * lain (tidak dibedakan, N-09). Mencabut sesi saat ini sama dengan logout.
   */
  async revoke(auth: AuthContext, familyId: string): Promise<{ current: boolean }> {
    const now = this.now();
    const current = familyId === auth.familyId;
    await this.db.transaction(async (tx) => {
      const live = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.familyId, familyId),
            eq(sessions.userId, auth.userId),
            eq(sessions.audience, auth.audience),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now),
          ),
        )
        .for("no key update");
      if (live.length === 0) throw notFound("Sesi tidak ditemukan.");
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(
          and(eq(sessions.familyId, familyId), eq(sessions.userId, auth.userId), isNull(sessions.revokedAt)),
        );
      await revokeDeviceTokens(tx, { userId: auth.userId, familyIds: [familyId] }, now);
      await this.audit.write(tx, {
        action: "session.revoked",
        entityType: "user",
        entityId: auth.userId,
        after: { session_id: familyId, current },
      });
      this.realtime.disconnectSession(familyId, current ? "logout" : "session_revoked");
    });
    return { current };
  }

  /**
   * Reautentikasi (kontrak reauthenticate; ARCHITECTURE §4.3). Satu jatah kegagalan `reauth:<keluarga>` dicadangkan
   * atomik SEBELUM kredensial dinilai (5 per 15 menit per sesi; berhasil → jatah dikembalikan). Alumni: sandi. Admin:
   * sandi DAN tepat satu dari kode TOTP (langkah harus lebih baru dari mfa_totp.last_used_step, baris dikunci; anti
   * replay RFC 6238 §5.2) atau backup code (dikonsumsi atomik sekali pakai). Kredensial salah → 400 VALIDATION_ERROR
   * pada field-nya dengan sisa percobaan. Berhasil: `reauthenticated_at` keluarga diperbarui, audit, dan token
   * X-Reauth-Token 10 menit terikat pengguna + KELUARGA sesi (`sid`) dengan tingkat 2 untuk admin.
   */
  async reauthenticate(auth: AuthContext, input: ReauthInput): Promise<ReauthResponse> {
    const admin = auth.audience === "admin";
    if (admin && !!input.totp_code === !!input.backup_code) {
      const message = "Masukkan tepat satu: kode autentikator atau backup code.";
      throw new AppException(400, "VALIDATION_ERROR", message, { fieldErrors: { totp_code: [message] } });
    }
    const slot = await this.limits.reserveOrThrow(
      `reauth:${auth.familyId}`,
      REAUTH_FAILS_LIMIT,
      LOGIN_WINDOW_MS,
      "Terlalu banyak percobaan konfirmasi identitas. Coba lagi dalam 15 menit.",
    );
    const now = this.now();
    try {
      const user = await this.db.query.users.findFirst({ where: eq(users.id, auth.userId) });
      if (!user || user.status !== "active") throw unauthenticated();
      if (!(await this.passwords.comparePassword(input.password, user.passwordHash)))
        throw new WrongCredential("password");
      await this.db.transaction(async (tx) => {
        const method = admin ? await this.verifySecondFactor(tx, auth.userId, input, now) : "password";
        await tx
          .update(sessions)
          .set({ reauthenticatedAt: now })
          .where(and(eq(sessions.familyId, auth.familyId), isNull(sessions.revokedAt)));
        await this.audit.write(tx, {
          action: "session.reauthenticated",
          entityType: "user",
          entityId: auth.userId,
          after: { method, audience: auth.audience },
        });
      });
    } catch (error) {
      if (!(error instanceof WrongCredential)) {
        // Tidak ada kredensial yang dinilai tuntas: jatah dikembalikan.
        await slot.release();
        throw error;
      }
      const left = Math.max(0, REAUTH_FAILS_LIMIT - slot.count);
      const message =
        left > 0
          ? `${CREDENTIAL_LABEL[error.field]}. Sisa percobaan ${left}.`
          : `${CREDENTIAL_LABEL[error.field]}. Batas percobaan tercapai; coba lagi dalam 15 menit.`;
      throw new AppException(400, "VALIDATION_ERROR", message, { fieldErrors: { [error.field]: [message] } });
    }
    await slot.release();
    const token = await this.tokens.signReauth({
      userId: auth.userId,
      familyId: auth.familyId,
      level: admin ? 2 : 1,
    });
    return { reauth_token: token.token, expires_at: token.expiresAt.toISOString() };
  }

  /** Faktor kedua admin di dalam transaksi reautentikasi (baris mfa_totp dikunci; F-02, F-16). */
  private async verifySecondFactor(
    tx: Tx,
    userId: string,
    input: ReauthInput,
    now: Date,
  ): Promise<"totp" | "backup_code"> {
    const [row] = await tx.select().from(mfaTotp).where(eq(mfaTotp.userId, userId)).for("update");
    if (!row?.verifiedAt)
      throw new AppException(403, "MFA_REQUIRED", "Autentikator belum terdaftar. Hubungi Super Admin.");
    if (input.totp_code) {
      const step = matchTotpStep(
        decryptSecret(row.secretEncrypted, this.env.TOTP_ENC_KEY),
        input.totp_code,
        now,
      );
      if (step === null || (row.lastUsedStep !== null && step <= row.lastUsedStep))
        throw new WrongCredential("totp_code");
      await tx.update(mfaTotp).set({ lastUsedStep: step, updatedAt: now }).where(eq(mfaTotp.userId, userId));
      return "totp";
    }
    const hash = backupCodeHash(this.env.OTP_HMAC_SECRET, input.backup_code ?? "");
    const consumed = await tx
      .update(mfaTotp)
      .set({ backupCodeHashes: sql`${mfaTotp.backupCodeHashes} - ${hash}::text`, updatedAt: now })
      .where(
        and(eq(mfaTotp.userId, userId), sql`${mfaTotp.backupCodeHashes} @> ${JSON.stringify([hash])}::jsonb`),
      )
      .returning({ userId: mfaTotp.userId });
    if (consumed.length === 0) throw new WrongCredential("backup_code");
    return "backup_code";
  }
}
