import { hkdfSync } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { UUID_PATTERN } from "../validation/validate.js";
import { FILE_PURPOSES, type FilePurpose } from "./purposes.js";

/** Umur maksimum URL berkas privat (PRD 5.4: <= 10 menit). */
export const FILE_URL_MAX_TTL_SECONDS = 600;
/** Umur bawaan; cukup untuk memuat gambar/PDF setelah layar dibuka. */
export const FILE_URL_DEFAULT_TTL_SECONDS = 300;
/** Panjang maksimum token di path `/files/content/{token}` (lihat maxParamLength di bootstrap). */
export const FILE_TOKEN_MAX_LENGTH = 1024;

const ISSUER = "kapdh-api";
const AUDIENCE = "kapdh-file";

/**
 * Kepada siapa URL diterbitkan. `sessionId` null = penampil anonim (mis. foto pada verifikasi KTA publik); bila
 * terikat sesi, `sessionVersion` ikut ditandatangani sehingga logout semua perangkat/suspend (session_version naik)
 * langsung mematikan URL yang beredar.
 */
export interface FileTokenSubject {
  userId: string | null;
  sessionId: string | null;
  sessionVersion?: number | null;
}

export interface FileTokenClaims {
  fileId: string;
  purpose: FilePurpose;
  userId: string | null;
  sessionId: string | null;
  sessionVersion: number | null;
  expiresAt: Date;
}

/**
 * Kunci HMAC token URL diturunkan (HKDF-SHA256) dari FILE_URL_SECRET dengan label khusus, sehingga secret mentah tidak
 * dipakai langsung dan pemakaian lain di masa depan memakai label berbeda.
 */
export function deriveFileUrlKey(secret: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, "kapdh-files", "kapdh-file-url-v1", 32));
}

/**
 * Token URL berkas privat (PRD 5.4): JWT HS256 terikat id berkas + purpose + penerima (user, sesi, session_version),
 * berumur <= 10 menit. TTL tidak menggantikan otorisasi: token hanya diterbitkan setelah kebijakan akses lolos, dan
 * saat dipakai sesi penerima diperiksa ulang (belum dicabut, session_version sama, akun aktif).
 */
export async function signFileToken(
  key: Uint8Array,
  claims: { fileId: string; purpose: FilePurpose } & FileTokenSubject,
  now: Date,
  ttlSeconds: number,
): Promise<{ token: string; expiresAt: Date }> {
  if (claims.sessionId !== null && (claims.userId === null || !Number.isInteger(claims.sessionVersion)))
    throw new Error("Token berkas terikat sesi wajib memuat userId dan sessionVersion");
  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), FILE_URL_MAX_TTL_SECONDS);
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttl;
  const token = await new SignJWT({
    fid: claims.fileId,
    pur: claims.purpose,
    sid: claims.sessionId,
    sv: claims.sessionId === null ? null : claims.sessionVersion,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.userId ?? "anonymous")
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Token sah → klaim; rusak/diubah/kedaluwarsa/umur > 10 menit → null. */
export async function verifyFileToken(
  key: Uint8Array,
  token: string,
  now: Date,
): Promise<FileTokenClaims | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > FILE_TOKEN_MAX_LENGTH) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
      currentDate: now,
      maxTokenAge: FILE_URL_MAX_TTL_SECONDS,
      requiredClaims: ["sub", "iat", "exp", "fid", "pur"],
    });
    const { fid, pur, sid, sv, sub, exp, iat } = payload as {
      fid?: unknown;
      pur?: unknown;
      sid?: unknown;
      sv?: unknown;
      sub?: string;
      exp?: number;
      iat?: number;
    };
    const anonymous = sub === "anonymous";
    const sessionBound = typeof sid === "string";
    if (
      typeof fid !== "string" ||
      !UUID_PATTERN.test(fid) ||
      typeof pur !== "string" ||
      !(FILE_PURPOSES as readonly string[]).includes(pur) ||
      (sid !== null && sid !== undefined && !sessionBound) ||
      (sessionBound && !UUID_PATTERN.test(sid)) ||
      (sessionBound && (typeof sv !== "number" || !Number.isInteger(sv))) ||
      typeof sub !== "string" ||
      (!anonymous && !UUID_PATTERN.test(sub)) ||
      (anonymous && sessionBound) ||
      exp === undefined ||
      iat === undefined ||
      exp - iat > FILE_URL_MAX_TTL_SECONDS
    )
      return null;
    return {
      fileId: fid,
      purpose: pur as FilePurpose,
      userId: anonymous ? null : sub,
      sessionId: sessionBound ? sid : null,
      sessionVersion: sessionBound ? (sv as number) : null,
      expiresAt: new Date(exp * 1000),
    };
  } catch {
    return null;
  }
}
