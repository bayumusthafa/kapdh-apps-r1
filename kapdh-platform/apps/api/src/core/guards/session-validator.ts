import { Inject, Injectable } from "@nestjs/common";
import { sessions, users } from "@kapdh/database";
import { eq, inArray } from "drizzle-orm";
import { type AccessClaims, TokenService } from "../../modules/auth/token.service.js";
import type { Clock } from "../adapters/clock.js";
import type { Db } from "../db/types.js";
import type { SessionRevokedReason } from "../realtime/envelope.js";
import { CLOCK, DB } from "../tokens.js";

/** Baris sesi + akun terbaru yang dibutuhkan pemeriksaan sesi (HTTP dan socket). */
export interface SessionRow {
  sessionId: string;
  sessionUserId: string;
  sessionAudience: string;
  revokedAt: Date | null;
  expiresAt: Date;
  lastSeenAt: Date;
  lastActivityAt: Date;
  userStatus: string;
  userKind: string;
  sessionVersion: number;
}

export interface ValidatedSession {
  claims: AccessClaims;
  row: SessionRow;
}

/**
 * Validasi sesi bersama AuthGuard (HTTP) dan gateway realtime (handshake + validasi ulang berkala), sehingga keduanya
 * menolak keadaan yang sama (ARCHITECTURE §4.3, §4.9): token sah (aud/exp), sesi belum dicabut/kedaluwarsa, milik
 * user dan audience yang sama, session_version cocok (logout semua/suspend menaikkannya), akun `active` dengan jenis
 * yang sesuai audience. Idle timeout admin dan izin tetap di AuthGuard.
 */
@Injectable()
export class SessionValidator {
  constructor(
    private readonly tokens: TokenService,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  verifyToken(token: string): Promise<AccessClaims | null> {
    return this.tokens.verifyAccess(token);
  }

  /** Sesi dan akun terbaru untuk claims, atau null bila tidak lagi sah. */
  async loadActiveSession(claims: AccessClaims, now = this.clock.now()): Promise<SessionRow | null> {
    const found = await this.rows([claims.sessionId]);
    const row = found.get(claims.sessionId);
    return row && this.isActive(row, claims, now) ? row : null;
  }

  /** Token + keadaan database; null bila salah satunya tidak sah. */
  async authenticate(token: string): Promise<ValidatedSession | null> {
    if (!token || token.length > 4096) return null;
    const claims = await this.verifyToken(token);
    if (!claims) return null;
    const row = await this.loadActiveSession(claims);
    return row ? { claims, row } : null;
  }

  /**
   * Validasi ulang banyak sesi sekaligus (socket berkala). Hasil per sesi: null bila masih sah, atau alasan
   * `session.revoked` yang dikirim ke klien sebelum diputus.
   */
  async revalidate(
    entries: readonly { sessionId: string; userId: string; sessionVersion: number; audience: AccessClaims["audience"] }[],
    now = this.clock.now(),
  ): Promise<Map<string, SessionRevokedReason | null>> {
    const found = await this.rows(entries.map((e) => e.sessionId));
    const result = new Map<string, SessionRevokedReason | null>();
    for (const entry of entries) {
      const row = found.get(entry.sessionId);
      const claims: AccessClaims = {
        userId: entry.userId,
        sessionId: entry.sessionId,
        sessionVersion: entry.sessionVersion,
        audience: entry.audience,
        mfaLevel: 1,
      };
      if (row && this.isActive(row, claims, now)) result.set(entry.sessionId, null);
      else if (row?.userStatus === "disabled") result.set(entry.sessionId, "account_disabled");
      else if (row?.userStatus === "deletion_pending" || row?.userStatus === "deleted")
        result.set(entry.sessionId, "deletion_requested");
      else result.set(entry.sessionId, "session_revoked");
    }
    return result;
  }

  private isActive(row: SessionRow, claims: AccessClaims, now: Date): boolean {
    return (
      !row.revokedAt &&
      row.expiresAt > now &&
      row.sessionUserId === claims.userId &&
      row.sessionAudience === claims.audience &&
      row.sessionVersion === claims.sessionVersion &&
      // Hanya akun aktif: pending_otp, disabled, deletion_pending, dan deleted tidak memakai API biasa (PRD 2.2).
      row.userStatus === "active" &&
      row.userKind === (claims.audience === "admin" ? "admin" : "alumni")
    );
  }

  private async rows(sessionIds: readonly string[]): Promise<Map<string, SessionRow>> {
    const ids = [...new Set(sessionIds)];
    if (ids.length === 0) return new Map();
    const found = await this.db
      .select({
        sessionId: sessions.id,
        sessionUserId: sessions.userId,
        sessionAudience: sessions.audience,
        revokedAt: sessions.revokedAt,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        lastActivityAt: sessions.lastActivityAt,
        userStatus: users.status,
        userKind: users.kind,
        sessionVersion: users.sessionVersion,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(ids.length === 1 ? eq(sessions.id, ids[0]!) : inArray(sessions.id, ids));
    return new Map(found.map((row) => [row.sessionId, row]));
  }
}
