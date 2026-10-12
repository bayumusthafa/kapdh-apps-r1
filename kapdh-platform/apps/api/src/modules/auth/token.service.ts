import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import { jwtVerify, SignJWT } from "jose";
import type { Clock } from "../../core/adapters/clock.js";
import { CLOCK, ENV } from "../../core/tokens.js";

export type Audience = "mobile" | "admin";
const AUD = {
  mobile: "kapdh-mobile",
  admin: "kapdh-admin",
  mfa: "kapdh-admin-mfa",
  reauth: "kapdh-reauth",
} as const;
export const ACCESS_TTL_SECONDS = 15 * 60; // N-08
export const MFA_TTL_SECONDS = 5 * 60;
/** Token reautentikasi berlaku maksimal 10 menit (ARCHITECTURE §4.3, AC F15-3, F16-1). */
export const REAUTH_TTL_SECONDS = 10 * 60;

export interface AccessClaims {
  userId: string;
  sessionId: string;
  sessionVersion: number;
  audience: Audience;
  mfaLevel: number;
}

export interface ReauthClaims {
  userId: string;
  sessionId: string;
  /** Faktor yang dibuktikan saat reautentikasi: 1 = sandi, 2 = sandi + TOTP (wajib untuk sesi admin). */
  level: number;
  expiresAt: Date;
}

/**
 * JWT HS256 (jose) untuk access token 15 menit (N-08), token tahap sandi admin (AC F02-2), dan token reautentikasi
 * (aud kapdh-reauth, terikat sesi, 10 menit). Audience berbeda mencegah satu jenis token dipakai sebagai jenis lain.
 * Disediakan CoreModule secara global karena AuthGuard memverifikasi token setiap request.
 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  }

  private nowSeconds() {
    return Math.floor(this.clock.now().getTime() / 1000);
  }

  async signAccess(c: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    const iat = this.nowSeconds();
    const exp = iat + ACCESS_TTL_SECONDS;
    const token = await new SignJWT({ sid: c.sessionId, sv: c.sessionVersion, mfa: c.mfaLevel })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(c.userId)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(AUD[c.audience])
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.env.JWT_ISSUER,
        audience: [AUD.mobile, AUD.admin],
        currentDate: this.clock.now(),
        algorithms: ["HS256"],
      });
      if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
      return {
        userId: payload.sub,
        sessionId: payload.sid,
        sessionVersion: Number(payload.sv),
        audience: payload.aud === AUD.admin ? "admin" : "mobile",
        mfaLevel: Number(payload.mfa),
      };
    } catch {
      return null;
    }
  }

  /** Token tahap sandi admin: hanya bisa dipakai di /admin/auth/mfa (AC F02-2). */
  async signMfa(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const iat = this.nowSeconds();
    const exp = iat + MFA_TTL_SECONDS;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(AUD.mfa)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async verifyMfa(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.env.JWT_ISSUER,
        audience: AUD.mfa,
        currentDate: this.clock.now(),
        algorithms: ["HS256"],
      });
      return typeof payload.sub === "string" ? payload.sub : null;
    } catch {
      return null;
    }
  }

  /**
   * Token reautentikasi (POST /auth/reauth) untuk header X-Reauth-Token: terikat user dan sesi, berlaku 10 menit.
   * Sesi yang dicabut otomatis membatalkan token karena AuthGuard memeriksa sesi lebih dulu.
   */
  async signReauth(c: { userId: string; sessionId: string; level: number }): Promise<{
    token: string;
    expiresAt: Date;
  }> {
    const iat = this.nowSeconds();
    const exp = iat + REAUTH_TTL_SECONDS;
    const token = await new SignJWT({ sid: c.sessionId, lvl: c.level })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(c.userId)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(AUD.reauth)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async verifyReauth(token: string): Promise<ReauthClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.env.JWT_ISSUER,
        audience: AUD.reauth,
        currentDate: this.clock.now(),
        algorithms: ["HS256"],
        maxTokenAge: REAUTH_TTL_SECONDS,
      });
      if (
        typeof payload.sub !== "string" ||
        typeof payload.sid !== "string" ||
        typeof payload.exp !== "number"
      )
        return null;
      return {
        userId: payload.sub,
        sessionId: payload.sid,
        level: Number(payload.lvl),
        expiresAt: new Date(payload.exp * 1000),
      };
    } catch {
      return null;
    }
  }
}
