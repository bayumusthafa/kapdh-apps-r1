import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { sessions, users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../adapters/clock.js";
import { tryCtx } from "../context/request-context.js";
import type { DbOrTx } from "../db/types.js";
import { CLOCK } from "../tokens.js";
import { randomToken, sha256 } from "./crypto.js";
import type { SessionAudience } from "../guards/auth-context.js";
import { TokenService } from "./token.service.js";

type TokenPair = components["schemas"]["TokenPair"];

const HOUR_MS = 3600_000;
/** TTL refresh (D1, dikunci pengembang Tahap 0): mobile 60 hari, admin 12 jam. */
export const REFRESH_TTL_MS: Readonly<Record<SessionAudience, number>> = {
  mobile: 60 * 24 * HOUR_MS,
  admin: 12 * HOUR_MS,
};

export interface IssuedSession {
  pair: TokenPair;
  /** Refresh token mentah (hanya hash-nya disimpan); admin menerimanya lewat cookie HttpOnly. */
  refreshToken: string;
  refreshExpiresAt: Date;
  /** Id baris sesi baru (klaim `sid` access token). */
  sessionId: string;
  /** Keluarga sesi (Session.id kontrak C1): sama untuk semua baris hasil rotasi refresh. */
  familyId: string;
}

export interface IssueSessionInput {
  userId: string;
  audience: SessionAudience;
  /** 1 = sandi, 2 = sandi + TOTP (admin wajib 2, AC F02-2). */
  mfaLevel: number;
  deviceName?: string;
  /** Diisi pada rotasi refresh (keluarga yang sama); kosong = keluarga baru. */
  familyId?: string;
}

/**
 * Penerbit sesi bersama (ARCHITECTURE §4.2): aktivasi OTP dan login alumni (modul auth), tahap TOTP admin (modul
 * admin-auth), dan rotasi refresh. Satu baris `sessions` per penerbitan (hash refresh token, audience, tingkat MFA,
 * platform/versi aplikasi dari konteks request, waktu dari Clock), lalu access token 15 menit dengan session_version
 * terkini (AC F02-6). Dipanggil di dalam transaksi pemanggil bersama audit/pembaruan akun.
 */
@Injectable()
export class SessionIssuer {
  constructor(
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async issue(tx: DbOrTx, input: IssueSessionInput): Promise<IssuedSession> {
    const now = this.clock.now();
    const [user] = await tx
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    const context = tryCtx();
    const sessionId = uuidv7();
    const familyId = input.familyId ?? uuidv7();
    const refreshToken = randomToken();
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS[input.audience]);
    const admin = input.audience === "admin";
    await tx.insert(sessions).values({
      id: sessionId,
      userId: input.userId,
      familyId,
      refreshHash: sha256(refreshToken),
      audience: input.audience,
      mfaLevel: input.mfaLevel,
      deviceName: input.deviceName ?? null,
      // Daftar sesi perangkat (F-02): platform dari X-App-Platform; web admin = web.
      platform: admin ? "web" : (context?.appPlatform ?? null),
      appVersion: admin ? null : (context?.appVersion ?? null),
      lastSeenAt: now,
      lastActivityAt: now,
      expiresAt: refreshExpiresAt,
      createdAt: now,
    });
    const access = await this.tokens.signAccess({
      userId: input.userId,
      sessionId,
      sessionVersion: user?.sessionVersion ?? 1,
      audience: input.audience,
      mfaLevel: input.mfaLevel,
    });
    return {
      sessionId,
      familyId,
      refreshToken,
      refreshExpiresAt,
      pair: {
        access_token: access.token,
        access_expires_at: access.expiresAt.toISOString(),
        ...(admin ? {} : { refresh_token: refreshToken, refresh_expires_at: refreshExpiresAt.toISOString() }),
      },
    };
  }
}
