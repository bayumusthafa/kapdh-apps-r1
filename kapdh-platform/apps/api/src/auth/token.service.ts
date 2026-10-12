import { Inject, Injectable } from "@nestjs/common";
import type { ServerEnv } from "@kapdh/config";
import { jwtVerify, SignJWT } from "jose";
import { CLOCK, type Clock } from "../infra/clock.js";
import { ENV } from "../infra/tokens.js";

export type Audience = "mobile" | "admin";
const AUD = { mobile: "kapdh-mobile", admin: "kapdh-admin", mfa: "kapdh-admin-mfa" } as const;
export const ACCESS_TTL_SECONDS = 15 * 60; // N-08
export const MFA_TTL_SECONDS = 5 * 60;

export interface AccessClaims {
  userId: string;
  sessionId: string;
  sessionVersion: number;
  audience: Audience;
  mfaLevel: number;
}

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(ENV) private readonly env: ServerEnv,
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
      return {
        userId: String(payload.sub),
        sessionId: String(payload.sid),
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
      return String(payload.sub);
    } catch {
      return null;
    }
  }
}
