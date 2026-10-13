import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import { type JWTPayload, jwtVerify, SignJWT } from "jose";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../adapters/clock.js";
import type { SessionAudience } from "../guards/auth-context.js";
import { CLOCK, ENV } from "../tokens.js";

/** Token sekali pakai turunan OTP (kontrak C1 kepala auth.yaml): reset sandi dan konfirmasi hapus akun web (F-14). */
export type OneTimeTokenPurpose = "password_reset" | "web_deletion";

const AUD = {
  mobile: "kapdh-mobile",
  admin: "kapdh-admin",
  mfa: "kapdh-admin-mfa",
  enroll: "kapdh-admin-enroll",
  reauth: "kapdh-reauth",
  password_reset: "kapdh-password-reset",
  web_deletion: "kapdh-web-deletion",
} as const;
export const ACCESS_TTL_SECONDS = 15 * 60; // N-08
export const MFA_TTL_SECONDS = 5 * 60;
/**
 * Token pendaftaran TOTP admin dari penerimaan undangan (kontrak C1 admin-auth.yaml, F-16, PRD 8.2): 30 menit sejak
 * penerimaan, tidak diperpanjang dan tidak dapat diterbitkan ulang.
 */
export const ADMIN_ENROLL_TTL_SECONDS = 30 * 60;
/** Token reautentikasi berlaku maksimal 10 menit (ARCHITECTURE §4.3, AC F15-3, F16-1). */
export const REAUTH_TTL_SECONDS = 10 * 60;
/** Token sekali pakai turunan OTP berumur maksimal 10 menit (kontrak C1 auth.yaml, account.yaml). */
export const ONE_TIME_TTL_SECONDS = 10 * 60;

/** Klaim terdaftar JWT dan klaim inti token sekali pakai; tidak boleh ditimpa klaim pengikat pemanggil. */
const RESERVED_CLAIMS = new Set(["iss", "sub", "aud", "exp", "nbf", "iat", "jti", "cid", "typ"]);

export interface AccessClaims {
  userId: string;
  /** Id BARIS sesi (berganti setiap rotasi refresh). Keluarga sesi dibaca dari database (SessionRow.familyId). */
  sessionId: string;
  sessionVersion: number;
  audience: SessionAudience;
  mfaLevel: number;
}

export interface ReauthClaims {
  userId: string;
  /**
   * Keluarga sesi (`sessions.family_id` = Session.id kontrak C1), klaim `sid`. Terikat KELUARGA, bukan baris, sehingga
   * rotasi refresh 15 menit di tengah alur sensitif tidak membatalkan reautentikasi (kontrak reauthenticate).
   */
  familyId: string;
  /** Faktor yang dibuktikan saat reautentikasi: 1 = sandi, 2 = sandi + TOTP/backup code (wajib untuk sesi admin). */
  level: number;
  issuedAt: Date;
  expiresAt: Date;
}

/** Klaim token tahap sandi admin (aud kapdh-admin-mfa, AC F02-2). */
export interface MfaClaims {
  userId: string;
  /** Id unik token (`jti`): token dikonsumsi sekali setelah sesi admin berhasil dibuat (kontrak adminVerifyMfa). */
  tokenId: string;
  expiresAt: Date;
}

/** Klaim token pendaftaran TOTP admin (aud kapdh-admin-enroll, kontrak C1 adminAcceptInvitation). */
export interface AdminEnrollClaims {
  userId: string;
  /** Identitas admin (`adm`). */
  adminId: string;
  /** Pengikat HMAC password_hash yang disimpan saat penerimaan undangan (`bnd`). */
  binding: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface OneTimeClaims {
  userId: string;
  /** Challenge OTP yang sudah dikonsumsi (klaim `cid`). */
  challengeId: string;
  /** Klaim pengikat keadaan akun yang dikirim saat menandatangani (mis. `bnd`, `sv`, `st`). */
  bindings: Record<string, string | number>;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * JWT HS256 (jose) untuk access token 15 menit (N-08), token tahap sandi admin (AC F02-2), token pendaftaran TOTP
 * admin (aud kapdh-admin-enroll, 30 menit, F-16), token reautentikasi
 * (aud kapdh-reauth, terikat KELUARGA sesi, 10 menit) dan token sekali pakai turunan OTP (aud kapdh-password-reset /
 * kapdh-web-deletion, 10 menit). Audience berbeda mencegah satu jenis token dipakai sebagai jenis lain. Milik core
 * (ARCHITECTURE §4.2) karena AuthGuard dan gateway realtime memverifikasi token setiap request; hanya tersedia di
 * runtime API (worker tidak memegang JWT_ACCESS_SECRET).
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

  private async sign(
    claims: JWTPayload,
    subject: string,
    audience: string,
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: Date }> {
    const iat = this.nowSeconds();
    const exp = iat + ttlSeconds;
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subject)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(audience)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  private async verify(
    token: string,
    audience: string | string[],
    maxTokenAge?: number,
  ): Promise<JWTPayload | null> {
    if (typeof token !== "string" || token.length === 0 || token.length > 4096) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.env.JWT_ISSUER,
        audience,
        currentDate: this.clock.now(),
        algorithms: ["HS256"],
        ...(maxTokenAge === undefined ? {} : { maxTokenAge }),
      });
      return typeof payload.sub === "string" ? payload : null;
    } catch {
      return null;
    }
  }

  signAccess(c: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    return this.sign(
      { sid: c.sessionId, sv: c.sessionVersion, mfa: c.mfaLevel },
      c.userId,
      AUD[c.audience],
      ACCESS_TTL_SECONDS,
    );
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    const payload = await this.verify(token, [AUD.mobile, AUD.admin]);
    if (!payload || typeof payload.sid !== "string") return null;
    return {
      userId: payload.sub!,
      sessionId: payload.sid,
      sessionVersion: Number(payload.sv),
      audience: payload.aud === AUD.admin ? "admin" : "mobile",
      mfaLevel: Number(payload.mfa),
    };
  }

  /**
   * Token tahap sandi admin: hanya bisa dipakai di POST /admin/auth/mfa (AC F02-2). Membawa `jti` acak sehingga modul
   * admin-auth dapat mengonsumsinya sekali setelah sesi dibuat (kontrak adminVerifyMfa).
   */
  signMfa(userId: string): Promise<{ token: string; expiresAt: Date }> {
    return this.sign({ jti: uuidv7() }, userId, AUD.mfa, MFA_TTL_SECONDS);
  }

  /** Klaim token tahap sandi admin, atau null bila rusak/kedaluwarsa/audience lain/tanpa `jti`. */
  async verifyMfaClaims(token: string): Promise<MfaClaims | null> {
    const payload = await this.verify(token, AUD.mfa, MFA_TTL_SECONDS);
    if (!payload || typeof payload.jti !== "string" || typeof payload.exp !== "number") return null;
    return { userId: payload.sub!, tokenId: payload.jti, expiresAt: new Date(payload.exp * 1000) };
  }

  async verifyMfa(token: string): Promise<string | null> {
    return (await this.verifyMfaClaims(token))?.userId ?? null;
  }

  /**
   * Token pendaftaran TOTP admin (kontrak C1 adminAcceptInvitation): audience `kapdh-admin-enroll`, 30 menit, `sub`
   * akun, `adm` admin, `bnd` HMAC password_hash baru. Satu-satunya kredensial POST /admin/auth/totp/enroll dan
   * /confirm; ditolak di /admin/auth/mfa (audience lain) dan 403 MFA_REQUIRED di API admin (AuthGuard).
   */
  signAdminEnroll(input: {
    userId: string;
    adminId: string;
    binding: string;
  }): Promise<{ token: string; expiresAt: Date }> {
    return this.sign(
      { adm: input.adminId, bnd: input.binding },
      input.userId,
      AUD.enroll,
      ADMIN_ENROLL_TTL_SECONDS,
    );
  }

  async verifyAdminEnroll(token: string): Promise<AdminEnrollClaims | null> {
    const payload = await this.verify(token, AUD.enroll, ADMIN_ENROLL_TTL_SECONDS);
    if (
      !payload ||
      typeof payload.adm !== "string" ||
      typeof payload.bnd !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    )
      return null;
    return {
      userId: payload.sub!,
      adminId: payload.adm,
      binding: payload.bnd,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    };
  }

  /**
   * Token reautentikasi (POST /auth/reauth) untuk header X-Reauth-Token: `sub` = pengguna, `sid` = family_id sesi
   * pemanggil (AuthContext.familyId, BUKAN id baris), `lvl` = tingkat faktor, berlaku 10 menit sejak `iat`
   * (kontrak C1 reauthenticate). Keluarga yang dicabut otomatis membatalkan token karena AuthGuard memeriksa sesi lebih
   * dulu.
   */
  signReauth(c: { userId: string; familyId: string; level: number }): Promise<{
    token: string;
    expiresAt: Date;
  }> {
    return this.sign({ sid: c.familyId, lvl: c.level }, c.userId, AUD.reauth, REAUTH_TTL_SECONDS);
  }

  async verifyReauth(token: string): Promise<ReauthClaims | null> {
    const payload = await this.verify(token, AUD.reauth, REAUTH_TTL_SECONDS);
    if (
      !payload ||
      typeof payload.sid !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number"
    )
      return null;
    return {
      userId: payload.sub!,
      familyId: payload.sid,
      level: Number(payload.lvl),
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    };
  }

  /**
   * Token sekali pakai turunan OTP (kontrak C1): audience `kapdh-password-reset` atau `kapdh-web-deletion`, `sub` akun,
   * `cid` challenge OTP yang sudah dikonsumsi, ditambah klaim pengikat keadaan akun dari pemanggil (reset sandi: `bnd`
   * = HMAC password_hash; hapus akun web: `sv` session_version dan `st` status). Berumur 10 menit. Sifat sekali pakai
   * dijamin pemanggil lewat transisi keadaan atomik yang membatalkan pengikat; token tidak pernah dicatat.
   *
   *   const { token } = await tokens.signOneTime("web_deletion", { userId, challengeId, bindings: { sv: 3, st: "active" } });
   *   const claims = await tokens.verifyOneTime(token, "web_deletion"); // null bila rusak/kedaluwarsa/audience lain
   */
  signOneTime(
    purpose: OneTimeTokenPurpose,
    input: { userId: string; challengeId: string; bindings?: Record<string, string | number> },
  ): Promise<{ token: string; expiresAt: Date }> {
    const bindings = input.bindings ?? {};
    for (const name of Object.keys(bindings))
      if (RESERVED_CLAIMS.has(name)) throw new Error(`klaim pengikat ${name} bertabrakan dengan klaim inti`);
    return this.sign(
      { ...bindings, cid: input.challengeId },
      input.userId,
      AUD[purpose],
      ONE_TIME_TTL_SECONDS,
    );
  }

  async verifyOneTime(token: string, purpose: OneTimeTokenPurpose): Promise<OneTimeClaims | null> {
    const payload = await this.verify(token, AUD[purpose], ONE_TIME_TTL_SECONDS);
    if (
      !payload ||
      typeof payload.cid !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    )
      return null;
    const bindings: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(payload))
      if (!RESERVED_CLAIMS.has(name) && (typeof value === "string" || typeof value === "number"))
        bindings[name] = value;
    return {
      userId: payload.sub!,
      challengeId: payload.cid,
      bindings,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    };
  }
}
